import 'server-only';

import type {
  Prisma,
  SignatureEventType,
  SignatureMethod,
  SignatureOtpChannel,
} from '@prisma/client';

import { audit } from '@/lib/audit';
import { can } from '@/lib/auth/rbac';
import { randomToken } from '@/lib/auth/jwt';
import type { SessionUser } from '@/lib/auth/session';
import {
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  generateOtpCode,
  hashOtpCode,
  verifyOtpCode,
} from '@/lib/auth/signature-otp';
import {
  issueSignatureSession,
  sessionRef,
  type SignatureSessionClaims,
} from '@/lib/auth/signature-session';
import { sha256Hex } from '@/lib/crypto';
import { prisma, type Tx } from '@/lib/db';
import { sendEmail } from '@/lib/email/client';
import {
  signatureCompletedEmail,
  signatureDeclinedInternalEmail,
  signatureInvitationEmail,
  signatureOtpEmail,
} from '@/lib/email/templates';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/lib/errors';
import { logger } from '@/lib/logger';
import {
  buildEmbeddedVisual,
  inspectPdf,
  inspectSignaturePng,
  validatePlacement,
  type Placement,
} from '@/lib/pdf/signature-artifacts';
import { renderEvidencePdf } from '@/lib/pdf/render';
import {
  CURRENT_CONSENT_VERSION,
  DEFAULT_CONSENT_LOCALE,
  consentHash,
  consentText,
  isConsentLocale,
  isConsentVersion,
} from '@/lib/signature/consent';
import { sendSms } from '@/lib/sms/client';
import { readLocalBytes, readStoredBytes, uploadBuffer } from '@/lib/storage';
import { absoluteUrl } from '@/lib/utils';
import type {
  CreateDocumentSignatureRequestInput,
  SignatureCompleteInput,
} from '@/lib/validation/signatures';

import {
  issuePublicToken,
  resolvePublicToken,
  revokeTokensFor,
  tokenRejectionError,
} from './access-token.service';
import { documentVisibilityWhere } from './document.service';
import { notifyStaff } from './notification.service';

const log = logger('signatur');

/**
 * Elektronische Unterzeichnung — der Kern.
 *
 * Entwurf und Begründung in `docs/SIGNATUR_GATE4A.md`. Die Regeln, an denen
 * hier alles hängt:
 *
 *  • Eine Unterschrift bezieht sich auf **Bytes**. Beim Anlegen wird die
 *    Prüfsumme des Originals eingefroren (Hash A); vor dem Abschluss werden
 *    die Bytes erneut gelesen und gehasht. Weicht das ab, bricht der
 *    Abschluss ab — es gibt keinen „trotzdem"-Pfad.
 *  • Das Original wird **nie** überschrieben. `EMBEDDED_VISUAL` erzeugt ein
 *    neues Artefakt (Hash B); `DETACHED_EVIDENCE` erzeugt gar keins — nur
 *    das Protokoll (Hash C). Kein Dokument enthält seinen eigenen Hash.
 *  • Der rohe Zugangstoken existiert im Link und im Tausch-Aufruf, sonst
 *    nirgends: nicht in Pfaden, nicht im Protokoll, nicht in Ereignissen.
 *  • Ablage und Datenbank sind nicht atomar. Der Abschluss ist deshalb eine
 *    kleine Zustandsmaschine (`PENDING → FINALIZING → COMPLETED`) mit
 *    deterministischen Artefaktpfaden, damit jede Wiederholung dasselbe
 *    Ergebnis reproduziert statt ein zweites zu erzeugen.
 *  • Ereignisse werden angehängt. Es gibt keine Funktion, die eines ändert
 *    oder löscht — und die Datenbank lehnt es ohnehin ab.
 */

// ---------------------------------------------------------------------------
//  Gemeinsames
// ---------------------------------------------------------------------------

export interface AnfrageKontext {
  ip: string | null;
  ipSource: string;
  userAgent: string | null;
}

const REQUEST_ACTIVE = ['PENDING', 'FINALIZING'] as const;
const PARTICIPANT_OPEN = ['PENDING', 'VIEWED', 'VERIFIED'] as const;
/** Nach dieser Zeit gilt ein FINALIZING als hängengeblieben und darf übernommen werden. */
const FINALIZING_STALE_MS = 10 * 60 * 1000;
/** Ergebnislink: 30 Tage — nicht 90; verlängern kann die Verwaltung. */
const RESULT_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Ein Ereignis anhängen. Die einzige Schreibfunktion für `signature_events`.
 *
 * Nie mit Geheimnissen: kein Token, kein Code, kein Cookie, kein Bild.
 * `details` ist klein und trägt eine Fassungsnummer (`v`), damit spätere
 * Leser wissen, wie sie es deuten.
 */
export async function appendSignatureEvent(
  client: Tx | typeof prisma,
  params: {
    requestId: string;
    participantId?: string | null;
    type: SignatureEventType;
    ctx?: AnfrageKontext | null;
    sessionJti?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await client.signatureEvent.create({
    data: {
      requestId: params.requestId,
      participantId: params.participantId ?? null,
      type: params.type,
      ipAddress: params.ctx?.ip ?? null,
      ipSource: params.ctx?.ipSource ?? null,
      clientReportedUserAgent: params.ctx?.userAgent ?? null,
      sessionRef: params.sessionJti ? sessionRef(params.sessionJti) : null,
      details: params.details ? ({ v: 1, ...params.details } as Prisma.InputJsonObject) : undefined,
    },
  });
}

/** Die Bytes eines Artefakts — über die Ablage, sonst über die eine Altbestandsadresse. */
async function artefaktBytes(asset: {
  url: string;
  storedFile: { id: string; path: string; driver: 'LOCAL' | 'SUPABASE' } | null;
}): Promise<Buffer | null> {
  if (asset.storedFile) return readStoredBytes(asset.storedFile);
  const treffer = /^\/api\/files\/blob\/([A-Za-z0-9_-]+)$/.exec(asset.url);
  return treffer ? readLocalBytes(treffer[1]!) : null;
}

/**
 * Ein erzeugtes Artefakt ablegen und als privates `FileAsset` registrieren.
 *
 * Der Pfad ist deterministisch (`signatures/<Vorgang>/<Art>.pdf`): Beim
 * eingebauten Speicher ersetzt ein zweiter Versuch die Zeile statt eine
 * neue anzulegen; beim externen wird mit `upsert` überschrieben. Das ist der
 * Grund, warum eine Wiederholung nie `signed-2.pdf` erzeugt.
 */
async function artefaktAblegen(params: {
  organizationId: string;
  requestId: string;
  art: 'signed' | 'evidence' | 'signature';
  suffix?: string;
  bytes: Buffer;
  contentType: 'application/pdf' | 'image/png';
  filename: string;
  uploadedById?: string | null;
}): Promise<{ assetId: string; checksum: string }> {
  const dateiname = params.suffix ? `${params.art}-${params.suffix}` : params.art;
  const path = `${params.organizationId}/signatures/${params.requestId}/${dateiname}.${params.contentType === 'application/pdf' ? 'pdf' : 'png'}`;
  const stored = await uploadBuffer({
    organizationId: params.organizationId,
    path,
    content: params.bytes,
    contentType: params.contentType,
    upsert: true,
  });
  const checksum = stored.checksum ?? sha256Hex(params.bytes);

  // Deterministisch auch auf der fachlichen Ebene: gibt es zu diesem Pfad
  // schon ein Asset (abgebrochener Vorlauf), wird es wiederverwendet.
  const vorhanden = await prisma.fileAsset.findFirst({
    where: { organizationId: params.organizationId, path, scope: 'SIGNATURE' },
    select: { id: true },
  });
  if (vorhanden) {
    await prisma.fileAsset.update({
      where: { id: vorhanden.id },
      data: {
        url: stored.publicUrl,
        sizeBytes: params.bytes.byteLength,
        checksum,
        storedFileId: stored.storedFileId ?? null,
      },
    });
    return { assetId: vorhanden.id, checksum };
  }

  const asset = await prisma.fileAsset.create({
    data: {
      organizationId: params.organizationId,
      scope: 'SIGNATURE',
      path,
      url: stored.publicUrl,
      filename: params.filename,
      mimeType: params.contentType,
      sizeBytes: params.bytes.byteLength,
      checksum,
      isPublic: false,
      storedFileId: stored.storedFileId ?? null,
      uploadedById: params.uploadedById ?? null,
    },
    select: { id: true },
  });
  return { assetId: asset.id, checksum };
}

function verschleiert(email: string): string {
  const [name, domain] = email.split('@');
  if (!name || !domain) return '…';
  return `${name.slice(0, 1)}…${name.slice(-1)}@${domain}`;
}

// ---------------------------------------------------------------------------
//  Verwaltung: anlegen, senden, abbrechen, lesen
// ---------------------------------------------------------------------------

function assertSignaturberechtigung(session: SessionUser, permission: 'signature:create' | 'signature:cancel' | 'signature:read') {
  if (!can(session.role, permission)) {
    throw new ForbiddenError('Für diese Handlung fehlt die Berechtigung.');
  }
}

/**
 * Das Recht am Vorgang ersetzt nicht das Recht am Ursprung. Wer
 * Führungsdokumente nicht lesen darf (heute: die Betriebsleitung), darf auch
 * keines zur Unterschrift senden oder dessen Vorgänge sehen — sonst wäre
 * `signature:create` ein Umweg um `document:read`. 404, nicht 403: Die
 * Existenz des Dokuments soll nicht durchsickern.
 */
function assertDokumentLesbar(session: SessionUser): void {
  if (!can(session.role, 'document:read') && !can(session.role, 'document:read_own')) {
    throw new NotFoundError('Dokument');
  }
}

/**
 * Eine Dokumentfassung zur Unterzeichnung anlegen — der Referenzfluss.
 *
 * Reihenfolge: Sichtbarkeit des Dokuments (dieselbe Regel wie beim Lesen),
 * Fassung bestimmen, Bytes laden, Hash A bilden, PDF prüfen (Seitenzahl,
 * Signaturstrukturen), Modus entscheiden, Position validieren, Vorgang und
 * Teilnehmer anlegen. Der Vorgang bindet **diese** Fassung; eine spätere
 * N+1 ändert daran nichts.
 */
export async function createDocumentSignatureRequest(
  session: SessionUser,
  organizationId: string,
  documentId: string,
  input: CreateDocumentSignatureRequestInput,
  ctx: AnfrageKontext,
): Promise<{ id: string; publicId: string; status: string }> {
  assertSignaturberechtigung(session, 'signature:create');
  assertDokumentLesbar(session);

  const document = await prisma.managedDocument.findFirst({
    where: { ...documentVisibilityWhere(session, organizationId), id: documentId },
    include: {
      currentVersion: { include: { file: { include: { storedFile: true } } } },
    },
  });
  if (!document) throw new NotFoundError('Dokument');

  const version = input.version
    ? await prisma.documentVersion.findFirst({
        where: { documentId, version: input.version },
        include: { file: { include: { storedFile: true } } },
      })
    : document.currentVersion;
  if (!version) throw new NotFoundError('Fassung');
  if (version.file.organizationId !== organizationId) throw new NotFoundError('Fassung');
  if (version.file.mimeType !== 'application/pdf') {
    throw new BusinessRuleError('Nur PDF-Fassungen können elektronisch unterzeichnet werden.');
  }

  const bytes = await artefaktBytes(version.file);
  if (!bytes) throw new BusinessRuleError('Die Datei dieser Fassung ist nicht auffindbar.');

  // Hash A — aus den Bytes, nicht aus einer gespeicherten Prüfsumme.
  const hashA = sha256Hex(bytes);
  if (version.file.checksum && version.file.checksum !== hashA) {
    throw new BusinessRuleError(
      'Die gespeicherte Prüfsumme dieser Fassung stimmt nicht mit der Datei überein. Der Vorgang wird nicht angelegt.',
    );
  }

  const befund = await inspectPdf(bytes);
  if (befund.encrypted) throw new BusinessRuleError('Verschlüsselte PDF-Dateien können nicht unterzeichnet werden.');
  if (befund.pageCount < 1) throw new BusinessRuleError('Das PDF enthält keine Seiten.');

  /**
   * `EMBEDDED_VISUAL` nur, wenn die Prüfung nichts findet — und selbst dann
   * ist „nichts gefunden" kein Beweis, nur die Voraussetzung. Hochgeladene
   * Dokumente bekommen die Vorgabe `DETACHED_EVIDENCE`; wer einbetten will,
   * hat es ausdrücklich gewählt und bekommt die Ablehnung zu sehen, wenn
   * etwas nach einer vorhandenen Signatur aussieht.
   */
  const artifactMode = input.artifactMode;
  if (artifactMode === 'EMBEDDED_VISUAL' && (befund.hasSignatureFields || befund.hasSignatureStructures)) {
    throw new BusinessRuleError(
      'Dieses PDF enthält Strukturen, die auf eine vorhandene Signatur hindeuten. Ein Einbetten würde sie zerstören — bitte den Modus „Protokoll ohne Einbettung" wählen.',
    );
  }
  if (input.placement && artifactMode !== 'EMBEDDED_VISUAL') {
    throw new ValidationError('Eine sichtbare Position gibt es nur beim Einbetten.');
  }
  if (input.placement) validatePlacement(input.placement, befund);
  // Vor dem Anlegen, nicht danach: Ein Vorgang, der wegen einer fehlenden
  // Nummer nie versendet werden kann, darf gar nicht erst entstehen.
  if (input.assuranceLevel === 'LINK_PLUS_SMS_CODE' && input.participants.some((p) => !p.phone)) {
    throw new ValidationError('Für die Bestätigung per SMS braucht jede Person eine Mobilnummer.');
  }

  const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
  const title = input.title ?? document.title;

  const request = await prisma.$transaction(async (tx) => {
    const created = await tx.signatureRequest.create({
      data: {
        organizationId,
        publicId: randomToken(16),
        status: 'DRAFT',
        providerType: 'INTERNAL_EVIDENCE',
        artifactMode,
        assuranceLevel: input.assuranceLevel,
        title,
        documentVersionId: version.id,
        originalArtifactId: version.file.id,
        originalDocumentHash: hashA,
        consentVersion: CURRENT_CONSENT_VERSION,
        consentLocale: DEFAULT_CONSENT_LOCALE,
        placementPage: input.placement?.page ?? null,
        placementX: input.placement?.x ?? null,
        placementY: input.placement?.y ?? null,
        placementWidth: input.placement?.width ?? null,
        placementHeight: input.placement?.height ?? null,
        createdById: session.id,
        expiresAt,
        participants: {
          create: input.participants.map((p, i) => ({
            order: i + 1,
            role: 'SIGNER',
            nameSnapshot: p.name,
            emailSnapshot: p.email.toLowerCase(),
            phoneSnapshot: p.phone ?? null,
          })),
        },
      },
      select: { id: true, publicId: true },
    });
    await appendSignatureEvent(tx, {
      requestId: created.id,
      type: 'REQUEST_CREATED',
      ctx,
      details: {
        source: 'DocumentVersion',
        documentVersionId: version.id,
        version: version.version,
        artifactMode,
        assuranceLevel: input.assuranceLevel,
        originalHash: hashA,
        signatureCheck: {
          acroFormSignatureFields: befund.hasSignatureFields,
          signatureStructures: befund.hasSignatureStructures,
          // Ausdrücklich: Das ist eine Suche nach Feldern, keine Validierung.
          note: 'Suche nach AcroForm-Signaturfeldern und /Sig- bzw. /ByteRange-Strukturen; keine kryptografische Prüfung.',
        },
      },
    });
    return created;
  });

  await audit.created({
    organizationId,
    userId: session.id,
    entity: 'SignatureRequest',
    entityId: request.id,
    summary: `Unterzeichnung „${title}" angelegt (${artifactMode}, ${input.assuranceLevel})`,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  if (input.send) {
    await sendSignatureRequest(session, organizationId, request.id, ctx);
    return { ...request, status: 'PENDING' };
  }
  return { ...request, status: 'DRAFT' };
}

/**
 * Versenden: je Teilnehmer ein eigener Token, Einladung, Status PENDING.
 *
 * Alte aktive Tokens desselben Teilnehmers werden widerrufen — ein erneuter
 * Versand entwertet den ersten Link, damit nicht zwei gültige Schlüssel in
 * zwei Postfächern liegen.
 */
export async function sendSignatureRequest(
  session: SessionUser,
  organizationId: string,
  requestId: string,
  ctx: AnfrageKontext,
): Promise<void> {
  assertSignaturberechtigung(session, 'signature:create');
  const request = await prisma.signatureRequest.findFirst({
    where: { id: requestId, organizationId },
    include: { participants: { orderBy: { order: 'asc' } } },
  });
  if (!request) throw new NotFoundError('Unterzeichnungsvorgang');
  if (request.status !== 'DRAFT' && request.status !== 'PENDING') {
    throw new BusinessRuleError('Dieser Vorgang kann nicht mehr versendet werden.');
  }

  const absender = `${session.firstName} ${session.lastName}`.trim();

  for (const p of request.participants) {
    if (p.role !== 'SIGNER' || p.status === 'SIGNED' || p.status === 'DECLINED') continue;

    await revokeTokensFor({ purpose: 'SIGNATURE_ACCESS', resourceId: p.id, revokedById: session.id });
    const link = await issuePublicToken({
      organizationId,
      purpose: 'SIGNATURE_ACCESS',
      resourceId: p.id,
      createdById: session.id,
      expiresAt: request.expiresAt,
    });

    /**
     * Der Token steht im **Fragment**. Ein Browser schickt den Teil nach `#`
     * nie an den Server — er landet in keinem Zugriffsprotokoll, keinem
     * Referrer und keiner Proxy-Zeile. Die Seite `/signieren` liest ihn
     * lokal, tauscht ihn einmal gegen eine Sitzung und löscht ihn sofort aus
     * der Adresszeile.
     */
    const signUrl = `${absoluteUrl('/signieren')}#t=${link.raw}`;

    await sendEmail({
      to: p.emailSnapshot,
      ...signatureInvitationEmail({
        name: p.nameSnapshot,
        title: request.title,
        senderName: absender || 'Clenaris',
        signUrl,
        expiresAt: request.expiresAt,
        requiresCode:
          request.assuranceLevel === 'LINK_PLUS_EMAIL_CODE'
            ? 'email'
            : request.assuranceLevel === 'LINK_PLUS_SMS_CODE'
              ? 'sms'
              : 'none',
      }),
      templateKey: 'signature_invitation',
      entity: 'SignatureRequest',
      entityId: request.id,
    });

    await appendSignatureEvent(prisma, {
      requestId: request.id,
      participantId: p.id,
      type: 'LINK_ISSUED',
      ctx,
      details: { tokenId: link.record.id, sentTo: verschleiert(p.emailSnapshot), expiresAt: request.expiresAt.toISOString() },
    });
  }

  await prisma.signatureRequest.update({
    where: { id: request.id },
    data: { status: 'PENDING', sentAt: request.sentAt ?? new Date() },
  });
}

export async function cancelSignatureRequest(
  session: SessionUser,
  organizationId: string,
  requestId: string,
  reason: string | undefined,
  ctx: AnfrageKontext,
): Promise<void> {
  assertSignaturberechtigung(session, 'signature:cancel');
  const request = await prisma.signatureRequest.findFirst({
    where: { id: requestId, organizationId },
    include: { participants: { select: { id: true } } },
  });
  if (!request) throw new NotFoundError('Unterzeichnungsvorgang');

  /**
   * Abgeschlossen ist abgeschlossen. Ein Vorgang mit Beweis wird nicht
   * abgebrochen und nicht gelöscht; wer ihn fachlich entwerten will, legt
   * einen neuen an und verweist (`supersededById`).
   */
  if (request.status === 'COMPLETED') {
    throw new BusinessRuleError('Ein abgeschlossener Vorgang kann nicht abgebrochen werden. Legen Sie bei Bedarf einen neuen an.');
  }
  if (request.status === 'CANCELLED' || request.status === 'DECLINED' || request.status === 'EXPIRED') {
    throw new BusinessRuleError('Dieser Vorgang ist bereits beendet.');
  }

  await prisma.$transaction(async (tx) => {
    const uebergang = await tx.signatureRequest.updateMany({
      where: { id: request.id, status: { in: ['DRAFT', 'PENDING', 'FINALIZING'] } },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: session.id },
    });
    if (uebergang.count === 0) throw new BusinessRuleError('Dieser Vorgang ist bereits beendet.');

    // Tokens widerrufen ⇒ jede Sitzung darauf ist wertlos; Codes entwerten.
    for (const p of request.participants) {
      await revokeTokensFor({ tx, purpose: 'SIGNATURE_ACCESS', resourceId: p.id, revokedById: session.id });
      await tx.signatureOtpChallenge.updateMany({
        where: { participantId: p.id, usedAt: null, invalidatedAt: null },
        data: { invalidatedAt: new Date() },
      });
    }
    await appendSignatureEvent(tx, {
      requestId: request.id,
      type: 'CANCELLED',
      ctx,
      details: { by: 'admin', reason: reason ?? null },
    });
  });

  await audit.updated({
    organizationId,
    userId: session.id,
    entity: 'SignatureRequest',
    entityId: request.id,
    summary: `Unterzeichnung „${request.title}" abgebrochen`,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

export async function listSignatureRequestsForDocument(
  session: SessionUser,
  organizationId: string,
  documentId: string,
) {
  assertSignaturberechtigung(session, 'signature:read');
  assertDokumentLesbar(session);
  // Sichtbarkeit des Dokuments gilt auch für seine Vorgänge.
  const document = await prisma.managedDocument.findFirst({
    where: { ...documentVisibilityWhere(session, organizationId), id: documentId },
    select: { id: true },
  });
  if (!document) throw new NotFoundError('Dokument');

  return prisma.signatureRequest.findMany({
    where: { organizationId, documentVersion: { documentId } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      publicId: true,
      status: true,
      artifactMode: true,
      assuranceLevel: true,
      title: true,
      createdAt: true,
      sentAt: true,
      expiresAt: true,
      completedAt: true,
      originalDocumentHash: true,
      signedArtifactHash: true,
      evidenceArtifactHash: true,
      documentVersion: { select: { version: true } },
      participants: {
        orderBy: { order: 'asc' },
        select: { id: true, nameSnapshot: true, emailSnapshot: true, status: true, viewedAt: true, verifiedAt: true, signedAt: true, declinedAt: true },
      },
    },
  });
}

export async function getSignatureRequestAdmin(session: SessionUser, organizationId: string, requestId: string) {
  assertSignaturberechtigung(session, 'signature:read');
  const request = await prisma.signatureRequest.findFirst({
    where: { id: requestId, organizationId },
    include: {
      participants: { orderBy: { order: 'asc' } },
      events: { orderBy: { at: 'asc' } },
      documentVersion: { select: { id: true, version: true, documentId: true } },
      originalArtifact: { select: { id: true, filename: true, checksum: true } },
      signedArtifact: { select: { id: true, filename: true, checksum: true } },
      evidenceArtifact: { select: { id: true, filename: true, checksum: true } },
    },
  });
  if (!request) throw new NotFoundError('Unterzeichnungsvorgang');
  if (request.documentVersion) {
    assertDokumentLesbar(session);
    const sichtbar = await prisma.managedDocument.findFirst({
      where: { ...documentVisibilityWhere(session, organizationId), id: request.documentVersion.documentId },
      select: { id: true },
    });
    if (!sichtbar) throw new NotFoundError('Unterzeichnungsvorgang');
  }
  return request;
}

/** A, B und C aus den tatsächlich gespeicherten Bytes nachrechnen. */
export async function verifySignatureIntegrity(session: SessionUser, organizationId: string, requestId: string) {
  assertSignaturberechtigung(session, 'signature:read');
  const request = await prisma.signatureRequest.findFirst({
    where: { id: requestId, organizationId },
    include: {
      originalArtifact: { include: { storedFile: true } },
      signedArtifact: { include: { storedFile: true } },
      evidenceArtifact: { include: { storedFile: true } },
    },
  });
  if (!request) throw new NotFoundError('Unterzeichnungsvorgang');

  const pruefe = async (
    asset: { url: string; storedFile: { id: string; path: string; driver: 'LOCAL' | 'SUPABASE' } | null } | null,
    erwartet: string | null,
  ) => {
    if (!asset || !erwartet) return { status: 'fehlt' as const };
    const bytes = await artefaktBytes(asset);
    if (!bytes) return { status: 'fehlt' as const, erwartet };
    const tatsaechlich = sha256Hex(bytes);
    return tatsaechlich === erwartet
      ? { status: 'ok' as const, hash: erwartet }
      : { status: 'abweichung' as const, erwartet, tatsaechlich };
  };

  return {
    original: await pruefe(request.originalArtifact, request.originalDocumentHash),
    signed: request.artifactMode === 'EMBEDDED_VISUAL'
      ? await pruefe(request.signedArtifact, request.signedArtifactHash)
      : { status: 'nicht_vorgesehen' as const },
    evidence: await pruefe(request.evidenceArtifact, request.evidenceArtifactHash),
  };
}

// ---------------------------------------------------------------------------
//  Öffentlich: Tausch, Sitzung, Ansicht
// ---------------------------------------------------------------------------

/**
 * Der Tausch: roher Token → Sitzung. Der einzige Ort, an dem der rohe Wert
 * den Server erreicht — im Körper eines POST, nie im Pfad.
 */
export async function exchangeSignatureToken(
  raw: string,
  ctx: AnfrageKontext,
): Promise<{ publicId: string; sessionToken: string; expiresAt: Date; scope: 'sign' | 'result' }> {
  // Beide Zwecke werden getrennt versucht; ein Ergebnis-Link öffnet keinen
  // Unterzeichnungsablauf und umgekehrt.
  for (const [purpose, scope] of [
    ['SIGNATURE_ACCESS', 'sign'],
    ['SIGNATURE_RESULT_VIEW', 'result'],
  ] as const) {
    const aufgeloest = await resolvePublicToken({ raw, purpose });
    if (!aufgeloest.ok) {
      if (aufgeloest.reason !== 'UNKNOWN') throw tokenRejectionError(aufgeloest.reason, 'Unterzeichnungslink');
      continue;
    }

    const participant = await prisma.signatureParticipant.findFirst({
      where: { id: aufgeloest.token.resourceId, request: { organizationId: aufgeloest.token.organizationId } },
      include: { request: { select: { id: true, publicId: true, status: true, expiresAt: true } } },
    });
    if (!participant) throw new NotFoundError('Unterzeichnungslink');

    if (scope === 'sign') {
      if (!REQUEST_ACTIVE.includes(participant.request.status as never) && participant.request.status !== 'COMPLETED') {
        throw new NotFoundError('Unterzeichnungslink');
      }
      if (participant.request.expiresAt.getTime() < Date.now() && participant.status !== 'SIGNED') {
        throw new NotFoundError('Unterzeichnungslink — der Link ist abgelaufen');
      }
    } else if (participant.request.status !== 'COMPLETED') {
      throw new NotFoundError('Unterzeichnungslink');
    }

    const sitzung = await issueSignatureSession({
      scope,
      requestId: participant.request.id,
      participantId: participant.id,
      tokenId: aufgeloest.token.record.id,
    });

    await appendSignatureEvent(prisma, {
      requestId: participant.request.id,
      participantId: participant.id,
      type: scope === 'sign' ? 'LINK_EXCHANGED' : 'RESULT_VIEWED',
      ctx,
      sessionJti: sitzung.jti,
      details: { tokenId: aufgeloest.token.record.id },
    });

    return { publicId: participant.request.publicId, sessionToken: sitzung.token, expiresAt: sitzung.expiresAt, scope };
  }

  throw new NotFoundError('Unterzeichnungslink');
}

/**
 * Die eine Prüfung, die jede sensible Route vor allem anderen macht.
 *
 * Das Cookie sagt, welche Zeilen zu prüfen sind — mehr nicht. Geprüft wird
 * in der Datenbank: Vorgang existiert und passt zur Adresse, Teilnehmer
 * gehört dazu, Organisation stimmt, Vorgang aktiv, Teilnehmer offen, nicht
 * abgelaufen, der zugrunde liegende Token nicht widerrufen. Damit wirkt ein
 * Abbruch sofort auf jede bestehende Sitzung.
 */
async function sitzungPruefen(
  claims: SignatureSessionClaims | null,
  publicId: string,
  erwarteterScope: 'sign' | 'result',
  opts: { offenNoetig?: boolean } = {},
) {
  if (!claims || claims.scope !== erwarteterScope) throw new NotFoundError('Unterzeichnungsvorgang');

  const request = await prisma.signatureRequest.findFirst({
    where: { id: claims.req, publicId },
    include: {
      participants: { orderBy: { order: 'asc' } },
      originalArtifact: { include: { storedFile: true } },
      signedArtifact: { include: { storedFile: true } },
      evidenceArtifact: { include: { storedFile: true } },
      documentVersion: { select: { version: true, document: { select: { title: true } } } },
    },
  });
  if (!request) throw new NotFoundError('Unterzeichnungsvorgang');

  const participant = request.participants.find((p) => p.id === claims.part);
  if (!participant) throw new NotFoundError('Unterzeichnungsvorgang');

  const token = await prisma.publicAccessToken.findFirst({
    where: { id: claims.tok, resourceId: participant.id, organizationId: request.organizationId },
    select: { revokedAt: true, expiresAt: true, purpose: true },
  });
  if (!token || token.revokedAt) throw new NotFoundError('Unterzeichnungsvorgang');
  if (erwarteterScope === 'sign' && token.purpose !== 'SIGNATURE_ACCESS') throw new NotFoundError('Unterzeichnungsvorgang');
  if (erwarteterScope === 'result' && token.purpose !== 'SIGNATURE_RESULT_VIEW') throw new NotFoundError('Unterzeichnungsvorgang');

  if (opts.offenNoetig) {
    if (request.status !== 'PENDING') throw new BusinessRuleError('Dieser Vorgang ist nicht mehr offen.');
    if (!PARTICIPANT_OPEN.includes(participant.status as never)) {
      throw new BusinessRuleError('Für diese Person ist der Vorgang bereits beendet.');
    }
    if (request.expiresAt.getTime() < Date.now()) throw new BusinessRuleError('Dieser Vorgang ist abgelaufen.');
  }

  return { request, participant };
}

export async function loadSigningContext(claims: SignatureSessionClaims | null, publicId: string) {
  const { request, participant } = await sitzungPruefen(claims, publicId, 'sign');
  const text = consentText(
    isConsentVersion(request.consentVersion) ? request.consentVersion : CURRENT_CONSENT_VERSION,
    isConsentLocale(request.consentLocale) ? request.consentLocale : DEFAULT_CONSENT_LOCALE,
  );
  return {
    request: {
      publicId: request.publicId,
      title: request.title,
      status: request.status,
      artifactMode: request.artifactMode,
      assuranceLevel: request.assuranceLevel,
      expiresAt: request.expiresAt,
      documentVersion: request.documentVersion?.version ?? null,
      consent: { text, version: request.consentVersion, locale: request.consentLocale },
    },
    participant: {
      name: participant.nameSnapshot,
      email: verschleiert(participant.emailSnapshot),
      phone: participant.phoneSnapshot ? `…${participant.phoneSnapshot.slice(-3)}` : null,
      status: participant.status,
      requiresCode: request.assuranceLevel !== 'LINK_ONLY',
      verified: participant.verifiedAt !== null,
      signedAt: participant.signedAt,
      declinedAt: participant.declinedAt,
    },
  };
}

/** Die Originalbytes — für den Viewer. Ein Ereignis je Sitzung, nicht je Abruf. */
export async function getSigningDocument(
  claims: SignatureSessionClaims | null,
  publicId: string,
  ctx: AnfrageKontext,
): Promise<{ bytes: Buffer; filename: string }> {
  const { request, participant } = await sitzungPruefen(claims, publicId, 'sign');
  const bytes = await artefaktBytes(request.originalArtifact);
  if (!bytes) throw new NotFoundError('Dokument');

  /**
   * PDF.js fragt beim Rendern mehrfach. Gezählt wird das Ansehen einmal je
   * Sitzung: Gibt es zu dieser `sessionRef` schon ein DOCUMENT_VIEWED, wird
   * keines angehängt. Der erste Blick setzt ausserdem `viewedAt`.
   */
  const ref = sessionRef(claims!.jti);
  const gesehen = await prisma.signatureEvent.findFirst({
    where: { requestId: request.id, participantId: participant.id, type: 'DOCUMENT_VIEWED', sessionRef: ref },
    select: { id: true },
  });
  if (!gesehen) {
    await appendSignatureEvent(prisma, {
      requestId: request.id,
      participantId: participant.id,
      type: 'DOCUMENT_VIEWED',
      ctx,
      sessionJti: claims!.jti,
      details: { originalHash: request.originalDocumentHash },
    });
    await prisma.signatureParticipant.updateMany({
      where: { id: participant.id, status: 'PENDING' },
      data: { status: 'VIEWED', viewedAt: new Date() },
    });
    await prisma.signatureParticipant.updateMany({
      where: { id: participant.id, viewedAt: null },
      data: { viewedAt: new Date() },
    });
  }

  return { bytes, filename: request.originalArtifact.filename };
}

// ---------------------------------------------------------------------------
//  Öffentlich: Bestätigungscode
// ---------------------------------------------------------------------------

export async function requestSignatureOtp(
  claims: SignatureSessionClaims | null,
  publicId: string,
  ctx: AnfrageKontext,
): Promise<{ channel: SignatureOtpChannel; sentTo: string; resendAfter: Date }> {
  const { request, participant } = await sitzungPruefen(claims, publicId, 'sign', { offenNoetig: true });
  if (request.assuranceLevel === 'LINK_ONLY') {
    throw new BusinessRuleError('Für diesen Vorgang ist kein Bestätigungscode vorgesehen.');
  }
  if (participant.verifiedAt) throw new BusinessRuleError('Der Code wurde bereits bestätigt.');

  const channel: SignatureOtpChannel = request.assuranceLevel === 'LINK_PLUS_SMS_CODE' ? 'SMS' : 'EMAIL';
  const ziel = channel === 'SMS' ? participant.phoneSnapshot : participant.emailSnapshot;
  if (!ziel) throw new BusinessRuleError('Für diese Person ist keine Mobilnummer hinterlegt.');

  const letzte = await prisma.signatureOtpChallenge.findFirst({
    where: { participantId: participant.id },
    orderBy: { createdAt: 'desc' },
    select: { resendAfter: true },
  });
  if (letzte && letzte.resendAfter.getTime() > Date.now()) {
    throw new BusinessRuleError('Bitte warten Sie kurz, bevor Sie einen neuen Code anfordern.');
  }

  const code = generateOtpCode();
  const now = Date.now();

  const challenge = await prisma.$transaction(async (tx) => {
    // Ein neuer Code entwertet alle offenen — es gilt immer nur der letzte.
    await tx.signatureOtpChallenge.updateMany({
      where: { participantId: participant.id, usedAt: null, invalidatedAt: null },
      data: { invalidatedAt: new Date(now) },
    });
    const angelegt = await tx.signatureOtpChallenge.create({
      data: {
        participantId: participant.id,
        channel,
        sentTo: ziel,
        codeHash: 'ausstehend',
        maxAttempts: OTP_MAX_ATTEMPTS,
        expiresAt: new Date(now + OTP_TTL_MS),
        resendAfter: new Date(now + OTP_RESEND_COOLDOWN_MS),
        sessionRef: sessionRef(claims!.jti),
      },
      select: { id: true },
    });
    // Der Hash braucht die Kennung — deshalb erst anlegen, dann setzen.
    await tx.signatureOtpChallenge.update({
      where: { id: angelegt.id },
      data: { codeHash: await hashOtpCode(angelegt.id, code) },
    });
    await appendSignatureEvent(tx, {
      requestId: request.id,
      participantId: participant.id,
      type: 'OTP_REQUESTED',
      ctx,
      sessionJti: claims!.jti,
      details: { channel, sentTo: channel === 'SMS' ? `…${ziel.slice(-3)}` : verschleiert(ziel) },
    });
    return angelegt;
  });

  if (channel === 'SMS') {
    await sendSms({
      to: ziel,
      body: `Ihr Clenaris-Bestätigungscode: ${code} (10 Minuten gültig). Nie weitergeben.`,
      entity: 'SignatureRequest',
      entityId: request.id,
    });
  } else {
    await sendEmail({
      to: ziel,
      ...signatureOtpEmail({ name: participant.nameSnapshot, code, title: request.title }),
      templateKey: 'signature_otp',
      entity: 'SignatureRequest',
      entityId: request.id,
    });
  }

  log.info('Bestätigungscode zugestellt', { requestId: request.id, participantId: participant.id, channel, challengeId: challenge.id });

  return {
    channel,
    sentTo: channel === 'SMS' ? `…${ziel.slice(-3)}` : verschleiert(ziel),
    resendAfter: new Date(now + OTP_RESEND_COOLDOWN_MS),
  };
}

export async function verifySignatureOtp(
  claims: SignatureSessionClaims | null,
  publicId: string,
  code: string,
  ctx: AnfrageKontext,
): Promise<void> {
  const { request, participant } = await sitzungPruefen(claims, publicId, 'sign', { offenNoetig: true });
  if (participant.verifiedAt) return;

  const challenge = await prisma.signatureOtpChallenge.findFirst({
    where: { participantId: participant.id, usedAt: null, invalidatedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  const fehlschlag = async (grund: string) => {
    await appendSignatureEvent(prisma, {
      requestId: request.id,
      participantId: participant.id,
      type: 'OTP_FAILED',
      ctx,
      sessionJti: claims!.jti,
      details: { reason: grund },
    });
    throw new BusinessRuleError('Der Code ist ungültig oder abgelaufen. Bitte einen neuen anfordern.');
  };

  if (!challenge) return fehlschlag('keine_offene_challenge');
  if (challenge.expiresAt.getTime() < Date.now()) return fehlschlag('abgelaufen');
  if (challenge.attempts >= challenge.maxAttempts) return fehlschlag('versuche_erschoepft');

  /**
   * Der Versuch wird **vor** der Prüfung gezählt — sonst könnten parallele
   * Anfragen den Zähler umgehen. `updateMany` mit der Bedingung
   * `attempts < maxAttempts` trifft nur, solange noch ein Versuch frei ist.
   */
  const gezaehlt = await prisma.signatureOtpChallenge.updateMany({
    where: { id: challenge.id, attempts: { lt: challenge.maxAttempts }, usedAt: null, invalidatedAt: null },
    data: { attempts: { increment: 1 } },
  });
  if (gezaehlt.count === 0) return fehlschlag('versuche_erschoepft');

  const richtig = await verifyOtpCode(challenge.codeHash, challenge.id, code);
  if (!richtig) return fehlschlag('falscher_code');

  // Einmal: Nur wer die noch unbenutzte Zeile trifft, gewinnt.
  const verbraucht = await prisma.signatureOtpChallenge.updateMany({
    where: { id: challenge.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (verbraucht.count === 0) return fehlschlag('bereits_verwendet');

  await prisma.$transaction(async (tx) => {
    await tx.signatureParticipant.updateMany({
      where: { id: participant.id, verifiedAt: null },
      data: { verifiedAt: new Date(), status: 'VERIFIED' },
    });
    await appendSignatureEvent(tx, {
      requestId: request.id,
      participantId: participant.id,
      type: 'OTP_VERIFIED',
      ctx,
      sessionJti: claims!.jti,
      details: { channel: challenge.channel },
    });
  });
}

// ---------------------------------------------------------------------------
//  Öffentlich: unterzeichnen, ablehnen
// ---------------------------------------------------------------------------

/**
 * Der Abschluss für eine Person.
 *
 * Reihenfolge wie im Entwurf: Sitzung und Zustand, Code falls verlangt,
 * Zustimmung, **Hash A aus den Bytes**, Nutzlast, Bild ablegen, dann in
 * einer Transaktion der atomare Übergang des Teilnehmers. Ist damit die
 * letzte Unterschrift da, folgt die Finalisierung des Vorgangs — einmal,
 * für alle Unterschriften zusammen.
 */
export async function completeSignature(
  claims: SignatureSessionClaims | null,
  publicId: string,
  input: SignatureCompleteInput,
  ctx: AnfrageKontext,
): Promise<{ participantStatus: string; requestStatus: string }> {
  const { request, participant } = await sitzungPruefen(claims, publicId, 'sign', { offenNoetig: true });

  if (request.assuranceLevel !== 'LINK_ONLY' && !participant.verifiedAt) {
    throw new BusinessRuleError('Bitte bestätigen Sie zuerst den Code.');
  }

  // Hash A — erneut, aus den gespeicherten Bytes. Nicht aus FileAsset.checksum.
  const originalBytes = await artefaktBytes(request.originalArtifact);
  if (!originalBytes) throw new BusinessRuleError('Das Originaldokument ist nicht auffindbar.');
  const hashJetzt = sha256Hex(originalBytes);
  if (hashJetzt !== request.originalDocumentHash) {
    await appendSignatureEvent(prisma, {
      requestId: request.id,
      participantId: participant.id,
      type: 'INTEGRITY_FAILED',
      ctx,
      sessionJti: claims!.jti,
      details: { expected: request.originalDocumentHash, actual: hashJetzt, stage: 'complete' },
    });
    throw new BusinessRuleError(
      'Das Originaldokument stimmt nicht mehr mit dem Stand überein, der zur Unterzeichnung vorgelegt wurde. Der Vorgang wurde nicht abgeschlossen.',
    );
  }

  // Zustimmung: Server bestimmt Text, Fassung, Sprache.
  const version = isConsentVersion(request.consentVersion) ? request.consentVersion : CURRENT_CONSENT_VERSION;
  const locale = isConsentLocale(request.consentLocale) ? request.consentLocale : DEFAULT_CONSENT_LOCALE;
  const text = consentText(version, locale);
  const textHash = consentHash(text);

  // Bild bei DRAWN: Bytes prüfen, privat ablegen, hashen.
  let bild: { assetId: string; checksum: string } | null = null;
  if (input.method === 'DRAWN') {
    const png = Buffer.from(input.imageDataUrl!.slice('data:image/png;base64,'.length), 'base64');
    if (png.byteLength > 512 * 1024) throw new ValidationError('Die Unterschrift ist zu gross.');
    inspectSignaturePng(png);
    bild = await artefaktAblegen({
      organizationId: request.organizationId,
      requestId: request.id,
      art: 'signature',
      suffix: participant.id,
      bytes: png,
      contentType: 'image/png',
      filename: `unterschrift-${participant.order}.png`,
    });
  }

  const now = new Date();
  const ergebnis = await prisma.$transaction(async (tx) => {
    /**
     * Der eine atomare Übergang. Zwei gleichzeitige Abschlüsse derselben
     * Person: einer trifft die Zeile, der andere nicht — PostgreSQL
     * entscheidet, nicht ein vorher gelesener Zustand.
     */
    const uebergang = await tx.signatureParticipant.updateMany({
      where: { id: participant.id, status: { in: [...PARTICIPANT_OPEN] }, signedAt: null },
      data: {
        status: 'SIGNED',
        signedAt: now,
        authenticationMethod: request.assuranceLevel,
        signatureMethod: input.method as SignatureMethod,
        signedName: input.name,
        signatureArtifactId: bild?.assetId ?? null,
        signatureArtifactHash: bild?.checksum ?? null,
        consentTextSnapshot: text,
        consentTextHash: textHash,
        consentVersion: version,
        consentLocale: locale,
        consentAcceptedAt: now,
        ipAddress: ctx.ip,
        ipSource: ctx.ipSource,
        clientReportedUserAgent: ctx.userAgent,
      },
    });
    if (uebergang.count === 0) throw new BusinessRuleError('Diese Unterzeichnung wurde bereits abgeschlossen.');

    await appendSignatureEvent(tx, { requestId: request.id, participantId: participant.id, type: 'CONSENT_ACCEPTED', ctx, sessionJti: claims!.jti, details: { version, locale, textHash } });
    await appendSignatureEvent(tx, { requestId: request.id, participantId: participant.id, type: 'SIGNATURE_SUBMITTED', ctx, sessionJti: claims!.jti, details: { method: input.method, imageHash: bild?.checksum ?? null, originalHash: hashJetzt } });
    await appendSignatureEvent(tx, { requestId: request.id, participantId: participant.id, type: 'SIGNED', ctx, sessionJti: claims!.jti });

    const offen = await tx.signatureParticipant.count({
      where: { requestId: request.id, role: 'SIGNER', status: { not: 'SIGNED' } },
    });
    return { alleUnterzeichnet: offen === 0 };
  });

  let requestStatus: string = request.status;
  if (ergebnis.alleUnterzeichnet) {
    requestStatus = await finalizeSignatureRequest(request.id, ctx);
  }

  return { participantStatus: 'SIGNED', requestStatus };
}

export async function declineSignature(
  claims: SignatureSessionClaims | null,
  publicId: string,
  reason: string | undefined,
  ctx: AnfrageKontext,
): Promise<void> {
  const { request, participant } = await sitzungPruefen(claims, publicId, 'sign', { offenNoetig: true });

  await prisma.$transaction(async (tx) => {
    const uebergang = await tx.signatureParticipant.updateMany({
      where: { id: participant.id, status: { in: [...PARTICIPANT_OPEN] } },
      data: { status: 'DECLINED', declinedAt: new Date(), declineReason: reason ?? null },
    });
    if (uebergang.count === 0) throw new BusinessRuleError('Für diese Person ist der Vorgang bereits beendet.');
    await tx.signatureRequest.updateMany({
      where: { id: request.id, status: 'PENDING' },
      data: { status: 'DECLINED', declinedAt: new Date() },
    });
    await appendSignatureEvent(tx, { requestId: request.id, participantId: participant.id, type: 'DECLINED', ctx, sessionJti: claims!.jti, details: { reason: reason ?? null } });
    // Der Token der Person ist damit verbraucht.
    await revokeTokensFor({ tx, purpose: 'SIGNATURE_ACCESS', resourceId: participant.id });
  });

  await notifyStaff({
    organizationId: request.organizationId,
    title: 'Unterzeichnung abgelehnt',
    body: `${participant.nameSnapshot} · ${request.title}`,
    link: `/admin/fuehrung/dokumente`,
    permission: 'signature:read',
    emailContent: signatureDeclinedInternalEmail({
      title: request.title,
      participantName: participant.nameSnapshot,
      reason,
      adminUrl: absoluteUrl('/admin/fuehrung/dokumente'),
    }),
  });
}

// ---------------------------------------------------------------------------
//  Finalisierung — die Zustandsmaschine
// ---------------------------------------------------------------------------

/**
 * `PENDING → FINALIZING → COMPLETED`, wiederholbar.
 *
 * Ablage und Datenbank haben keine gemeinsame Transaktion. Deshalb:
 *
 *  1. Nur wer den Übergang nach FINALIZING gewinnt (oder einen hängen
 *     gebliebenen übernimmt), arbeitet weiter. Alle anderen kehren zurück.
 *  2. Jedes Artefakt wird nur erzeugt, wenn es fehlt; sein Pfad ist
 *     deterministisch, sein Eintrag wird per bedingtem `updateMany` gesetzt.
 *  3. Schlägt etwas fehl, bleibt FINALIZING mit `finalizingSince` stehen —
 *     kein falsches COMPLETED. Der Nachtlauf oder der nächste Aufruf
 *     wiederholt; vorhandene Artefakte werden wiederverwendet.
 *  4. Erst wenn alles da ist, COMPLETED. Nie zwei signierte Artefakte, nie
 *     zwei Protokolle: `signedArtifactId`/`evidenceArtifactId` sind eindeutig.
 */
export async function finalizeSignatureRequest(requestId: string, ctx?: AnfrageKontext): Promise<string> {
  const now = new Date();

  let gewonnen = await prisma.signatureRequest.updateMany({
    where: { id: requestId, status: 'PENDING' },
    data: { status: 'FINALIZING', finalizingSince: now },
  });
  if (gewonnen.count === 0) {
    gewonnen = await prisma.signatureRequest.updateMany({
      where: { id: requestId, status: 'FINALIZING', finalizingSince: { lt: new Date(now.getTime() - FINALIZING_STALE_MS) } },
      data: { finalizingSince: now },
    });
    if (gewonnen.count === 0) {
      const aktuell = await prisma.signatureRequest.findUnique({ where: { id: requestId }, select: { status: true } });
      return aktuell?.status ?? 'UNBEKANNT';
    }
  }

  await appendSignatureEvent(prisma, { requestId, type: 'FINALIZATION_STARTED', ctx });

  try {
    const request = await prisma.signatureRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: {
        participants: { orderBy: { order: 'asc' }, include: { signatureArtifact: { include: { storedFile: true } }, otpChallenges: { orderBy: { createdAt: 'asc' } } } },
        originalArtifact: { include: { storedFile: true } },
        documentVersion: { select: { version: true, document: { select: { title: true } } } },
        events: { orderBy: { at: 'asc' } },
      },
    });

    const signer = request.participants.filter((p) => p.role === 'SIGNER');
    if (signer.some((p) => p.status !== 'SIGNED')) {
      // Nicht alle da — zurück auf PENDING; das war ein verfrühter Aufruf.
      await prisma.signatureRequest.update({ where: { id: requestId }, data: { status: 'PENDING', finalizingSince: null } });
      return 'PENDING';
    }

    const originalBytes = await artefaktBytes(request.originalArtifact);
    if (!originalBytes) throw new Error('Originalbytes nicht auffindbar');
    const hashJetzt = sha256Hex(originalBytes);
    if (hashJetzt !== request.originalDocumentHash) {
      await appendSignatureEvent(prisma, { requestId, type: 'INTEGRITY_FAILED', ctx, details: { expected: request.originalDocumentHash, actual: hashJetzt, stage: 'finalize' } });
      // Bleibt FINALIZING — ein Mensch muss hinsehen. Kein COMPLETED.
      return 'FINALIZING';
    }

    // Signiertes Artefakt — nur bei EMBEDDED_VISUAL, nur wenn es fehlt.
    let signedHash = request.signedArtifactHash;
    if (request.artifactMode === 'EMBEDDED_VISUAL' && !request.signedArtifactId) {
      const placement: Placement | null = request.placementPage
        ? {
            page: request.placementPage,
            x: Number(request.placementX),
            y: Number(request.placementY),
            width: Number(request.placementWidth),
            height: Number(request.placementHeight),
          }
        : null;
      if (placement) validatePlacement(placement, await inspectPdf(originalBytes));

      const signers = [];
      for (const p of signer) {
        signers.push({
          name: p.signedName ?? p.nameSnapshot,
          method: (p.signatureMethod ?? 'TYPED') as 'DRAWN' | 'TYPED',
          signedAt: p.signedAt ?? now,
          imagePng: p.signatureArtifact ? await artefaktBytes(p.signatureArtifact) : null,
          placement: p.order === 1 ? placement : null,
        });
      }
      const signedBytes = await buildEmbeddedVisual({
        originalBytes,
        requestId: request.id,
        publicId: request.publicId,
        title: request.title,
        originalHash: request.originalDocumentHash,
        signers,
      });
      const abgelegt = await artefaktAblegen({
        organizationId: request.organizationId,
        requestId: request.id,
        art: 'signed',
        bytes: signedBytes,
        contentType: 'application/pdf',
        filename: `${request.title.replace(/[^\w.-]+/g, '-')}-unterzeichnet.pdf`,
      });
      if (abgelegt.checksum === request.originalDocumentHash) throw new Error('Signiertes Artefakt identisch mit Original');

      const gesetzt = await prisma.signatureRequest.updateMany({
        where: { id: requestId, signedArtifactId: null },
        data: { signedArtifactId: abgelegt.assetId, signedArtifactHash: abgelegt.checksum },
      });
      if (gesetzt.count === 1) {
        signedHash = abgelegt.checksum;
        await appendSignatureEvent(prisma, { requestId, type: 'ARTIFACT_CREATED', ctx, details: { kind: 'signed', assetId: abgelegt.assetId, hash: abgelegt.checksum } });
      } else {
        signedHash = (await prisma.signatureRequest.findUniqueOrThrow({ where: { id: requestId }, select: { signedArtifactHash: true } })).signedArtifactHash;
      }
    }

    // Protokoll — nur wenn es fehlt; enthält A und B, nie C.
    if (!request.evidenceArtifactId) {
      const frisch = await prisma.signatureRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: { signedArtifactId: true, signedArtifactHash: true, events: { orderBy: { at: 'asc' }, include: { participant: { select: { nameSnapshot: true } } } } },
      });
      const evidenceBytes = await renderEvidencePdf(request.organizationId, {
        requestId: request.id,
        publicId: request.publicId,
        title: request.title,
        sourceType: request.documentVersion ? 'Dokumentfassung' : request.quoteId ? 'Offerte' : 'Einsatz',
        sourceReference: request.documentVersion
          ? `${request.documentVersion.document.title} · Fassung ${request.documentVersion.version}`
          : (request.quoteId ?? request.jobId ?? ''),
        artifactMode: request.artifactMode,
        assuranceLevel: request.assuranceLevel,
        originalArtifactId: request.originalArtifactId,
        originalHash: request.originalDocumentHash,
        signedArtifactId: frisch.signedArtifactId,
        signedHash: frisch.signedArtifactHash,
        createdAt: request.createdAt,
        completedAt: null,
        participants: signer.map((p) => ({
          name: p.nameSnapshot,
          email: p.emailSnapshot,
          method: p.signatureMethod,
          signedName: p.signedName,
          signedAt: p.signedAt,
          authenticationMethod: p.authenticationMethod,
          consentText: p.consentTextSnapshot,
          consentHash: p.consentTextHash,
          consentVersion: p.consentVersion,
          consentLocale: p.consentLocale,
          consentAcceptedAt: p.consentAcceptedAt,
          signatureArtifactHash: p.signatureArtifactHash,
          ipAddress: p.ipAddress,
          ipSource: p.ipSource,
          userAgent: p.clientReportedUserAgent,
          otp: p.otpChallenges
            .filter((c) => c.usedAt)
            .map((c) => ({ channel: c.channel, sentTo: c.channel === 'SMS' ? `…${c.sentTo.slice(-3)}` : verschleiert(c.sentTo), requestedAt: c.createdAt, verifiedAt: c.usedAt })),
        })),
        events: frisch.events.map((e) => ({ at: e.at, type: e.type, participant: e.participant?.nameSnapshot ?? null })),
        generatedAt: new Date(),
      });
      const abgelegt = await artefaktAblegen({
        organizationId: request.organizationId,
        requestId: request.id,
        art: 'evidence',
        bytes: evidenceBytes,
        contentType: 'application/pdf',
        filename: `Signaturprotokoll-${request.publicId}.pdf`,
      });
      if (abgelegt.checksum === request.originalDocumentHash || (signedHash && abgelegt.checksum === signedHash)) {
        throw new Error('Protokoll identisch mit einem anderen Artefakt');
      }
      const gesetzt = await prisma.signatureRequest.updateMany({
        where: { id: requestId, evidenceArtifactId: null },
        data: { evidenceArtifactId: abgelegt.assetId, evidenceArtifactHash: abgelegt.checksum },
      });
      if (gesetzt.count === 1) {
        await appendSignatureEvent(prisma, { requestId, type: 'ARTIFACT_CREATED', ctx, details: { kind: 'evidence', assetId: abgelegt.assetId, hash: abgelegt.checksum } });
      }
    }

    const fertig = await prisma.signatureRequest.updateMany({
      where: { id: requestId, status: 'FINALIZING', evidenceArtifactId: { not: null } },
      data: { status: 'COMPLETED', completedAt: now, finalizingSince: null },
    });
    if (fertig.count === 1) {
      await appendSignatureEvent(prisma, { requestId, type: 'REQUEST_COMPLETED', ctx });
      await ergebnisLinksVersenden(requestId, ctx);
      return 'COMPLETED';
    }
    return (await prisma.signatureRequest.findUniqueOrThrow({ where: { id: requestId }, select: { status: true } })).status;
  } catch (error) {
    // Bleibt FINALIZING mit Zeitstempel: sichtbar, wiederholbar, nie COMPLETED.
    log.error('Finalisierung fehlgeschlagen', { requestId, error: error instanceof Error ? error.message : String(error) });
    return 'FINALIZING';
  }
}

/** Nach Abschluss: je Unterzeichnender ein befristeter Ergebnislink, kein Anhang. */
async function ergebnisLinksVersenden(requestId: string, ctx?: AnfrageKontext): Promise<void> {
  const request = await prisma.signatureRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { participants: { where: { role: 'SIGNER', status: 'SIGNED' } } },
  });
  const expiresAt = new Date(Date.now() + RESULT_LINK_TTL_MS);
  for (const p of request.participants) {
    const link = await issuePublicToken({ organizationId: request.organizationId, purpose: 'SIGNATURE_RESULT_VIEW', resourceId: p.id, expiresAt });
    const resultUrl = `${absoluteUrl('/signieren/ergebnis')}#t=${link.raw}`;
    await sendEmail({
      to: p.emailSnapshot,
      ...signatureCompletedEmail({ name: p.nameSnapshot, title: request.title, resultUrl, resultExpiresAt: expiresAt }),
      templateKey: 'signature_completed',
      entity: 'SignatureRequest',
      entityId: request.id,
    });
    await appendSignatureEvent(prisma, { requestId, participantId: p.id, type: 'RESULT_LINK_ISSUED', ctx, details: { tokenId: link.record.id, expiresAt: expiresAt.toISOString() } });
  }
}

// ---------------------------------------------------------------------------
//  Öffentlich: Ergebnis
// ---------------------------------------------------------------------------

export async function getSignatureResult(claims: SignatureSessionClaims | null, publicId: string) {
  const { request, participant } = await sitzungPruefen(claims, publicId, 'result');
  return {
    title: request.title,
    status: request.status,
    artifactMode: request.artifactMode,
    completedAt: request.completedAt,
    participant: { name: participant.nameSnapshot, signedAt: participant.signedAt },
    hashes: { original: request.originalDocumentHash, signed: request.signedArtifactHash, evidence: request.evidenceArtifactHash },
    available: {
      original: true,
      signed: request.signedArtifactId !== null,
      evidence: request.evidenceArtifactId !== null,
    },
  };
}

export async function getResultArtifact(
  claims: SignatureSessionClaims | null,
  publicId: string,
  which: 'original' | 'signed' | 'evidence',
): Promise<{ bytes: Buffer; filename: string }> {
  const { request } = await sitzungPruefen(claims, publicId, 'result');
  const asset = which === 'original' ? request.originalArtifact : which === 'signed' ? request.signedArtifact : request.evidenceArtifact;
  if (!asset) throw new NotFoundError('Datei');
  const bytes = await artefaktBytes(asset);
  if (!bytes) throw new NotFoundError('Datei');
  return { bytes, filename: asset.filename };
}

// ---------------------------------------------------------------------------
//  Nachtlauf
// ---------------------------------------------------------------------------

export async function runSignatureNightly(organizationId: string): Promise<{ expired: number; retried: number; otpPurged: number }> {
  const now = new Date();

  const faellig = await prisma.signatureRequest.findMany({
    where: { organizationId, status: 'PENDING', expiresAt: { lt: now } },
    select: { id: true, participants: { select: { id: true } } },
  });
  let expired = 0;
  for (const r of faellig) {
    const u = await prisma.signatureRequest.updateMany({ where: { id: r.id, status: 'PENDING' }, data: { status: 'EXPIRED', expiredAt: now } });
    if (u.count === 1) {
      expired += 1;
      await appendSignatureEvent(prisma, { requestId: r.id, type: 'EXPIRED' });
      for (const p of r.participants) await revokeTokensFor({ purpose: 'SIGNATURE_ACCESS', resourceId: p.id });
    }
  }

  // Hängengebliebene Abschlüsse und fehlende Protokolle nachholen.
  const offen = await prisma.signatureRequest.findMany({
    where: {
      organizationId,
      OR: [
        { status: 'FINALIZING', finalizingSince: { lt: new Date(now.getTime() - FINALIZING_STALE_MS) } },
        { status: 'COMPLETED', evidenceArtifactId: null },
      ],
    },
    select: { id: true, status: true },
  });
  let retried = 0;
  for (const r of offen) {
    if (r.status === 'COMPLETED') {
      // Ein COMPLETED ohne Protokoll darf es nach dieser Fassung nicht mehr
      // geben; ältere Zeilen werden über FINALIZING nachgeholt.
      await prisma.signatureRequest.updateMany({ where: { id: r.id, status: 'COMPLETED', evidenceArtifactId: null }, data: { status: 'FINALIZING', finalizingSince: new Date(0) } });
    }
    await finalizeSignatureRequest(r.id);
    retried += 1;
  }

  // Verbrauchte oder abgelaufene Codes sind kein Beweis — weg nach 24 h.
  const otp = await prisma.signatureOtpChallenge.deleteMany({
    where: {
      participant: { request: { organizationId } },
      OR: [{ usedAt: { lt: new Date(now.getTime() - 86_400_000) } }, { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } }],
    },
  });

  return { expired, retried, otpPurged: otp.count };
}
