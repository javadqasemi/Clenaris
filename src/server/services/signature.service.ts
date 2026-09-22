import 'server-only';

import type { SignatureMethod, SignatureOtpChannel } from '@prisma/client';

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
import { prisma } from '@/lib/db';
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
import { actorSourceText } from '@/lib/pdf/documents';
import { renderEvidencePdf } from '@/lib/pdf/render';
import {
  CONTRACT_CONSENT_VERSION,
  CURRENT_CONSENT_VERSION,
  DEFAULT_CONSENT_LOCALE,
  QUOTE_CONSENT_VERSION,
  RAPPORT_CONSENT_VERSION,
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
import {
  VERTRAGSANNAHME_AKTIV,
  acceptContractVersionInTx,
  afterContractVersionAccepted,
} from './contract-acceptance.service';
import { acceptJobInTx, afterJobAccepted } from './job-acceptance.service';
import { ACCEPTANCE_ACTIVE, acceptQuoteInTx, afterQuoteAccepted } from './quote-acceptance.service';
import { appendSignatureEvent, type ActorSource, type AnfrageKontext } from './signature-events';

export { appendSignatureEvent, type AnfrageKontext } from './signature-events';

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

const REQUEST_ACTIVE = ['PENDING', 'FINALIZING'] as const;
const PARTICIPANT_OPEN = ['PENDING', 'VIEWED', 'VERIFIED'] as const;
/** Nach dieser Zeit gilt ein FINALIZING als hängengeblieben und darf übernommen werden. */
const FINALIZING_STALE_MS = 10 * 60 * 1000;
/** Ergebnislink: 30 Tage — nicht 90; verlängern kann die Verwaltung. */
const RESULT_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
  /** Ordner unter `signatures/` — die Vorgangskennung, oder bei Snapshots vor dem Anlegen die `publicId`. */
  requestId: string;
  art: 'original' | 'signed' | 'evidence' | 'signature';
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
      /**
       * Signaturartefakte entstehen in diesem Prozess: Schnappschuss A aus
       * unserem eigenen Renderer, das signierte Artefakt B und das
       * Beweisprotokoll C aus A plus unseren eigenen Daten. Fremder Inhalt
       * kommt auf diesem Weg nicht herein.
       *
       * Die Einstufung steht deshalb hier und nicht als Annahme über den
       * Dateityp. „PDF sind sauber" wäre eine Regel, die auch für jede
       * hochgeladene PDF gälte.
       *
       * `scanStatus` bleibt `PENDING` und heisst hier „war nie im Prüfablauf",
       * nicht „wartet auf Prüfung" — `darfAusgeliefertWerden` entscheidet
       * über die Herkunft. Das Sicherheitscockpit blendet Herkunft
       * `SYSTEM_GENERATED` aus der Liste offener Fälle aus.
       */
      provenance: 'SYSTEM_GENERATED',
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
//  Offertannahme (Gate 4C): anlegen, Zugang ausstellen, nachschlagen
// ---------------------------------------------------------------------------

/**
 * Den Annahmevorgang einer Offerte anlegen — mit dem Snapshot als Original.
 *
 * Der Snapshot wird **hier**, beim Start, abgelegt und gehasht (Hash A);
 * ab dann ist er das, was unterzeichnet wird. Was die Offerte in der
 * Datenbank später zeigt, ändert daran nichts mehr (§ 8, § 13).
 *
 * Genau ein offener Vorgang je Offerte: Der Teilindex
 * `signature_requests_offene_annahme_je_offerte` erzwingt es. Verliert
 * dieser Aufruf das Rennen gegen einen gleichzeitigen, gibt er `null`
 * zurück, und der Aufrufer verwendet den Vorgang des Gewinners. Der bereits
 * abgelegte Snapshot des Verlierers bleibt eine verwaiste Datei ohne
 * Vorgang — harmlos, und seltener als jede Aufräumlogik wert wäre.
 *
 * `createdById` ist ein Pflichtfeld mit Fremdschlüssel: Beim Start über den
 * Link gibt es keine angemeldete Person, der Vorgang wird der Person
 * zugeschrieben, die die Offerte erstellt hat (ersatzweise der
 * Systemverantwortung). Wer tatsächlich gehandelt hat, steht in den
 * Ereignissen (`actorSource`).
 */
export async function createQuoteAcceptanceRequest(params: {
  quote: { id: string; organizationId: string; number: string; title: string; validUntil: Date; createdById: string | null };
  participant: { name: string; email: string; customerId: string | null };
  snapshot: { bytes: Buffer; filename: string };
  expiresAt: Date;
  actorSource: ActorSource;
  actorUserId?: string | null;
  ctx: AnfrageKontext;
}): Promise<{ id: string; publicId: string; participantId: string } | null> {
  const befund = await inspectPdf(params.snapshot.bytes);
  if (befund.pageCount < 1) throw new BusinessRuleError('Die Offerte liess sich nicht als Dokument erzeugen.');

  const publicId = randomToken(16);
  const original = await artefaktAblegen({
    organizationId: params.quote.organizationId,
    requestId: publicId,
    art: 'original',
    bytes: params.snapshot.bytes,
    contentType: 'application/pdf',
    filename: params.snapshot.filename,
  });

  const createdById =
    params.actorUserId ??
    params.quote.createdById ??
    (await prisma.user.findFirst({ where: { organizationId: params.quote.organizationId, role: 'SUPER_ADMIN' }, select: { id: true } }))?.id ??
    null;
  if (!createdById) throw new BusinessRuleError('Für diesen Vorgang lässt sich keine verantwortliche Person ermitteln.');

  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.signatureRequest.create({
        data: {
          organizationId: params.quote.organizationId,
          publicId,
          status: 'PENDING',
          sentAt: new Date(),
          providerType: 'INTERNAL_EVIDENCE',
          artifactMode: 'EMBEDDED_VISUAL',
          assuranceLevel: 'LINK_ONLY',
          title: `Offerte ${params.quote.number} — ${params.quote.title}`,
          quoteId: params.quote.id,
          originalArtifactId: original.assetId,
          originalDocumentHash: original.checksum,
          consentVersion: QUOTE_CONSENT_VERSION,
          consentLocale: DEFAULT_CONSENT_LOCALE,
          createdById,
          expiresAt: params.expiresAt,
          participants: {
            create: {
              order: 1,
              role: 'SIGNER',
              nameSnapshot: params.participant.name,
              emailSnapshot: params.participant.email.toLowerCase(),
              customerId: params.participant.customerId,
            },
          },
        },
        select: { id: true, publicId: true, participants: { select: { id: true } } },
      });
      await appendSignatureEvent(tx, {
        requestId: created.id,
        type: 'REQUEST_CREATED',
        ctx: params.ctx,
        details: {
          source: 'Quote',
          quoteId: params.quote.id,
          quoteNumber: params.quote.number,
          artifactMode: 'EMBEDDED_VISUAL',
          assuranceLevel: 'LINK_ONLY',
          originalHash: original.checksum,
          actorSource: params.actorSource,
          signatureCheck: {
            acroFormSignatureFields: befund.hasSignatureFields,
            signatureStructures: befund.hasSignatureStructures,
            note: 'Clenaris-eigener Snapshot; Suche nach Signaturstrukturen als Vorsichtsmassnahme, keine kryptografische Prüfung.',
          },
        },
      });
      return { id: created.id, publicId: created.publicId, participantId: created.participants[0]!.id };
    });
  } catch (error) {
    // Der Teilindex hat entschieden: Jemand war schneller.
    if ((error as { code?: string }).code === 'P2002') return null;
    throw error;
  }
}

/** Der offene Annahmevorgang einer Offerte — oder `null`. */
export async function findActiveQuoteAcceptance(quoteId: string) {
  return prisma.signatureRequest.findFirst({
    where: { quoteId, status: { in: [...ACCEPTANCE_ACTIVE] } },
    include: { participants: { orderBy: { order: 'asc' } } },
  });
}

/** Der abgeschlossene Annahmevorgang einer Offerte — mit Artefakten, oder `null`. */
export async function findCompletedQuoteAcceptance(quoteId: string) {
  return prisma.signatureRequest.findFirst({
    where: { quoteId, status: 'COMPLETED' },
    orderBy: { completedAt: 'desc' },
    include: {
      participants: { orderBy: { order: 'asc' } },
      signedArtifact: { include: { storedFile: true } },
      evidenceArtifact: { include: { storedFile: true } },
    },
  });
}

/**
 * Zugang zum Vorgang für den Browser ausstellen — der Rohwert geht als
 * Fragment (`/signieren#t=…`) zurück und wird nie gespeichert.
 *
 * Anders als beim Versand per E-Mail werden ältere Zugänge **nicht**
 * widerrufen: Zwei offene Browserfenster derselben Person sollen beide zum
 * selben Vorgang führen; die Einmaligkeit hängt am Abschluss, nicht am
 * Link. Widerrufen wird bei Abbruch, Ablehnung und Ablauf.
 *
 * Der Zugang hängt am **Teilnehmer**, nicht am Geschäftsobjekt — er ist
 * quellenunabhängig. Bis Wave 10 hiess die Funktion
 * `issueQuoteAcceptanceAccess` und klang, als gäbe es je Quelle einen eigenen
 * Tokentyp. Den gibt es nicht, und zwei Tokentypen für denselben Zweck wären
 * zwei Widerrufswege — von denen man einen vergisst.
 */
export async function issueSignatureAccess(params: {
  organizationId: string;
  requestId: string;
  participantId: string;
  expiresAt: Date;
  actorSource: ActorSource;
  ctx: AnfrageKontext;
}): Promise<{ raw: string; expiresAt: Date }> {
  const link = await issuePublicToken({
    organizationId: params.organizationId,
    purpose: 'SIGNATURE_ACCESS',
    resourceId: params.participantId,
    expiresAt: params.expiresAt,
  });
  await appendSignatureEvent(prisma, {
    requestId: params.requestId,
    participantId: params.participantId,
    type: 'LINK_ISSUED',
    ctx: params.ctx,
    details: { tokenId: link.record.id, channel: 'browser', actorSource: params.actorSource, expiresAt: params.expiresAt.toISOString() },
  });
  return { raw: link.raw, expiresAt: params.expiresAt };
}

/**
 * Eine Unterzeichnungssitzung für die **angemeldete** Kundschaft — ohne Link
 * per E-Mail an sich selbst.
 *
 * Die Sitzung braucht einen Token als Anker (`tok`), damit Abbruch und
 * Widerruf sie sofort entwerten. Er wird ausgestellt, sein Rohwert aber
 * nirgends verwendet — die Person hat ihre Berechtigung bereits über
 * Sitzung und Eigentümerschaft nachgewiesen. Das Protokoll hält
 * `AUTHENTICATED_CUSTOMER` fest; es behauptet damit keine höhere
 * Identitätssicherheit, nur einen anderen Zugangsweg.
 */
export async function issueQuoteAcceptanceSession(params: {
  organizationId: string;
  requestId: string;
  participantId: string;
  expiresAt: Date;
  userId: string;
  ctx: AnfrageKontext;
}): Promise<{ sessionToken: string; expiresAt: Date }> {
  const anker = await issuePublicToken({
    organizationId: params.organizationId,
    purpose: 'SIGNATURE_ACCESS',
    resourceId: params.participantId,
    createdById: params.userId,
    expiresAt: params.expiresAt,
  });
  const sitzung = await issueSignatureSession({
    scope: 'sign',
    requestId: params.requestId,
    participantId: params.participantId,
    tokenId: anker.record.id,
  });
  await appendSignatureEvent(prisma, {
    requestId: params.requestId,
    participantId: params.participantId,
    type: 'LINK_EXCHANGED',
    ctx: params.ctx,
    sessionJti: sitzung.jti,
    details: { tokenId: anker.record.id, actorSource: 'AUTHENTICATED_CUSTOMER', userId: params.userId },
  });
  return { sessionToken: sitzung.token, expiresAt: sitzung.expiresAt };
}

// ---------------------------------------------------------------------------
//  Vor-Ort-Abnahme (Gate 4D): Vorgang anlegen, Sitzung für das Gerät
// ---------------------------------------------------------------------------

/**
 * Den Abnahmevorgang eines Einsatzes anlegen — mit dem Rapport als Original.
 *
 * Wie bei der Offerte entsteht der Snapshot **beim Start** und wird gehasht
 * (Hash A); ab dann ist er das, was unterzeichnet wird. Zwei Dinge sind hier
 * anders als beim Link-Ablauf:
 *
 *  • `ceremonyMode = IN_PERSON_HANDOFF` und die `presentedBy…`-Felder halten
 *    fest, **wer das Gerät bereitgestellt hat**. Das ist keine
 *    Identitätsbestätigung und darf nirgends als solche erscheinen — die
 *    Person aus dem Betrieb reicht ein Telefon weiter, mehr behauptet der
 *    Beweis nicht.
 *  • Der Teilnehmer ist die Kundschaft des Einsatzes, nicht die angemeldete
 *    Person. `createdById` trägt zwar das Personalkonto (Pflichtfeld mit
 *    Fremdschlüssel), aber wer **unterschrieben** hat, steht ausschliesslich
 *    am Teilnehmer.
 *
 * Genau ein offener Vorgang je Einsatz: Der Teilindex
 * `signature_requests_offene_abnahme_je_einsatz` erzwingt es. Verliert dieser
 * Aufruf das Rennen, gibt er `null` zurück.
 */
export async function createJobAcceptanceRequest(params: {
  job: { id: string; organizationId: string; number: string; title: string };
  participant: { name: string; email: string; customerId: string | null };
  snapshot: { bytes: Buffer; filename: string };
  expiresAt: Date;
  presenter: { userId: string; name: string; employeeId: string | null };
  ctx: AnfrageKontext;
}): Promise<{ id: string; publicId: string; participantId: string } | null> {
  const befund = await inspectPdf(params.snapshot.bytes);
  if (befund.pageCount < 1) throw new BusinessRuleError('Der Rapport liess sich nicht als Dokument erzeugen.');

  const publicId = randomToken(16);
  const original = await artefaktAblegen({
    organizationId: params.job.organizationId,
    requestId: publicId,
    art: 'original',
    bytes: params.snapshot.bytes,
    contentType: 'application/pdf',
    filename: params.snapshot.filename,
  });

  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.signatureRequest.create({
        data: {
          organizationId: params.job.organizationId,
          publicId,
          status: 'PENDING',
          sentAt: new Date(),
          providerType: 'INTERNAL_EVIDENCE',
          artifactMode: 'EMBEDDED_VISUAL',
          assuranceLevel: 'LINK_ONLY',
          ceremonyMode: 'IN_PERSON_HANDOFF',
          title: `Rapport ${params.job.number} — ${params.job.title}`,
          jobId: params.job.id,
          originalArtifactId: original.assetId,
          originalDocumentHash: original.checksum,
          consentVersion: RAPPORT_CONSENT_VERSION,
          consentLocale: DEFAULT_CONSENT_LOCALE,
          createdById: params.presenter.userId,
          presentedById: params.presenter.userId,
          presentedByName: params.presenter.name,
          presentedByEmployeeId: params.presenter.employeeId,
          expiresAt: params.expiresAt,
          participants: {
            create: {
              order: 1,
              role: 'SIGNER',
              nameSnapshot: params.participant.name,
              emailSnapshot: params.participant.email.toLowerCase(),
              customerId: params.participant.customerId,
            },
          },
        },
        select: { id: true, publicId: true, participants: { select: { id: true } } },
      });
      await appendSignatureEvent(tx, {
        requestId: created.id,
        type: 'REQUEST_CREATED',
        ctx: params.ctx,
        details: {
          source: 'Job',
          jobId: params.job.id,
          jobNumber: params.job.number,
          artifactMode: 'EMBEDDED_VISUAL',
          assuranceLevel: 'LINK_ONLY',
          ceremonyMode: 'IN_PERSON_HANDOFF',
          originalHash: original.checksum,
          actorSource: 'IN_PERSON_HANDOFF',
          presentedBy: params.presenter.name,
          note: 'Geraet fuer die Kundenabnahme bereitgestellt — keine Identitaetspruefung.',
          signatureCheck: {
            acroFormSignatureFields: befund.hasSignatureFields,
            signatureStructures: befund.hasSignatureStructures,
            note: 'Clenaris-eigener Snapshot; Suche nach Signaturstrukturen als Vorsichtsmassnahme, keine kryptografische Pruefung.',
          },
        },
      });
      return { id: created.id, publicId: created.publicId, participantId: created.participants[0]!.id };
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
//  Vertragsannahme (Wave 10): die vierte Quelle
// ---------------------------------------------------------------------------

/**
 * Den Annahmevorgang einer **Vertragsfassung** anlegen — mit dem Snapshot als
 * Original.
 *
 * Dieselbe Bauart wie bei der Offerte: Der Snapshot entsteht **hier**, beim
 * Start, und sein SHA-256 wird als Hash A eingefroren. Was die Datenbank
 * später zeigt, ändert daran nichts mehr.
 *
 * Genau ein offener Vorgang je Fassung — der Teilindex
 * `signature_requests_offene_annahme_je_vertragsfassung` erzwingt es. Verliert
 * dieser Aufruf das Rennen, gibt er `null` zurück, und der Aufrufer verwendet
 * den Vorgang des Gewinners.
 *
 * `assuranceLevel` bleibt `LINK_ONLY`: Wer den Link öffnet, hat einen Link —
 * mehr wird nicht behauptet.
 */
export async function createContractAcceptanceRequest(params: {
  version: { id: string; versionNumber: number; organizationId: string; contractId: string };
  contract: { number: string | null; title: string; createdById: string | null };
  participant: { name: string; email: string; customerId: string | null };
  snapshot: { bytes: Buffer; filename: string };
  expiresAt: Date;
  actorUserId?: string | null;
  ctx: AnfrageKontext;
}): Promise<{ id: string; publicId: string; participantId: string } | null> {
  const befund = await inspectPdf(params.snapshot.bytes);
  if (befund.pageCount < 1) throw new BusinessRuleError('Der Vertrag liess sich nicht als Dokument erzeugen.');

  const publicId = randomToken(16);
  const original = await artefaktAblegen({
    organizationId: params.version.organizationId,
    requestId: publicId,
    art: 'original',
    bytes: params.snapshot.bytes,
    contentType: 'application/pdf',
    filename: params.snapshot.filename,
  });

  const createdById =
    params.actorUserId ??
    params.contract.createdById ??
    (
      await prisma.user.findFirst({
        where: { organizationId: params.version.organizationId, role: 'SUPER_ADMIN' },
        select: { id: true },
      })
    )?.id ??
    null;
  if (!createdById) {
    throw new BusinessRuleError('Für diesen Vorgang lässt sich keine verantwortliche Person ermitteln.');
  }

  const bezeichnung = params.contract.number ? `Vertrag ${params.contract.number}` : params.contract.title;

  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.signatureRequest.create({
        data: {
          organizationId: params.version.organizationId,
          publicId,
          status: 'PENDING',
          sentAt: new Date(),
          providerType: 'INTERNAL_EVIDENCE',
          artifactMode: 'EMBEDDED_VISUAL',
          assuranceLevel: 'LINK_ONLY',
          ceremonyMode: 'REMOTE_LINK',
          title: `${bezeichnung} — Fassung ${params.version.versionNumber}`,
          contractVersionId: params.version.id,
          originalArtifactId: original.assetId,
          originalDocumentHash: original.checksum,
          consentVersion: CONTRACT_CONSENT_VERSION,
          consentLocale: DEFAULT_CONSENT_LOCALE,
          createdById,
          expiresAt: params.expiresAt,
          participants: {
            create: {
              order: 1,
              role: 'SIGNER',
              nameSnapshot: params.participant.name,
              emailSnapshot: params.participant.email.toLowerCase(),
              customerId: params.participant.customerId,
            },
          },
        },
        select: { id: true, publicId: true, participants: { select: { id: true } } },
      });

      await appendSignatureEvent(tx, {
        requestId: created.id,
        type: 'REQUEST_CREATED',
        ctx: params.ctx,
        details: {
          source: 'ContractVersion',
          contractId: params.version.contractId,
          contractNumber: params.contract.number,
          contractVersionId: params.version.id,
          /**
           * Die Versionsnummer steht als eigene Angabe im Protokoll, nicht nur
           * in der Kennung. Ein Beweis, in dem man erst eine cuid nachschlagen
           * muss, um zu wissen, welche Fassung angenommen wurde, beantwortet
           * die Frage nicht, für die er da ist.
           */
          versionNumber: params.version.versionNumber,
          artifactMode: 'EMBEDDED_VISUAL',
          assuranceLevel: 'LINK_ONLY',
          ceremonyMode: 'REMOTE_LINK',
          originalHash: original.checksum,
          actorSource: 'PUBLIC_LINK',
          signatureCheck: {
            acroFormSignatureFields: befund.hasSignatureFields,
            signatureStructures: befund.hasSignatureStructures,
            note: 'Clenaris-eigener Snapshot; Suche nach Signaturstrukturen als Vorsichtsmassnahme, keine kryptografische Prüfung.',
          },
        },
      });

      return { id: created.id, publicId: created.publicId, participantId: created.participants[0]!.id };
    });
  } catch (error) {
    // Der Teilindex hat entschieden: Jemand war schneller.
    if ((error as { code?: string }).code === 'P2002') return null;
    throw error;
  }
}

/** Der offene Annahmevorgang einer Vertragsfassung — oder `null`. */
export async function findActiveContractAcceptance(contractVersionId: string) {
  return prisma.signatureRequest.findFirst({
    where: { contractVersionId, status: { in: [...VERTRAGSANNAHME_AKTIV] } },
    include: { participants: { orderBy: { order: 'asc' } } },
  });
}

/** Der abgeschlossene Annahmevorgang einer Vertragsfassung — mit Artefakten, oder `null`. */
export async function findCompletedContractAcceptance(contractVersionId: string) {
  return prisma.signatureRequest.findFirst({
    where: { contractVersionId, status: 'COMPLETED' },
    orderBy: { completedAt: 'desc' },
    include: {
      participants: { orderBy: { order: 'asc' } },
      signedArtifact: { include: { storedFile: true } },
      evidenceArtifact: { include: { storedFile: true } },
    },
  });
}

/** Der offene Abnahmevorgang eines Einsatzes — oder `null`. */
export async function findActiveJobAcceptance(jobId: string) {
  return prisma.signatureRequest.findFirst({
    where: {
      jobId,
      ceremonyMode: 'IN_PERSON_HANDOFF',
      status: { in: ['DRAFT', 'PENDING', 'FINALIZING'] },
    },
    include: { participants: { orderBy: { order: 'asc' } } },
  });
}

/**
 * Die Signatursitzung für das übergebene Gerät.
 *
 * **Kein Link, kein roher Token, keine E-Mail.** Die Kundschaft sitzt bereits
 * am Gerät; ein zugestellter Zugang wäre ein Geheimnis, das ohne Not
 * entsteht und irgendwo liegen bleibt. Der `SIGNATURE_ACCESS`-Token wird
 * trotzdem angelegt — der Kern verankert jede Sitzung an einem widerrufbaren
 * Objekt, und darauf zu verzichten hiesse, eine zweite Sitzungsarchitektur
 * neben die bestehende zu stellen. Sein Rohwert wird hier schlicht
 * weggeworfen: Was niemand erfährt, kann niemand weitergeben.
 */
export async function issueJobAcceptanceSession(params: {
  organizationId: string;
  requestId: string;
  participantId: string;
  expiresAt: Date;
  presenterUserId: string;
  ctx: AnfrageKontext;
}): Promise<{ sessionToken: string; expiresAt: Date }> {
  const anker = await issuePublicToken({
    organizationId: params.organizationId,
    purpose: 'SIGNATURE_ACCESS',
    resourceId: params.participantId,
    createdById: params.presenterUserId,
    expiresAt: params.expiresAt,
  });
  const sitzung = await issueSignatureSession({
    scope: 'sign',
    requestId: params.requestId,
    participantId: params.participantId,
    tokenId: anker.record.id,
  });
  await appendSignatureEvent(prisma, {
    requestId: params.requestId,
    participantId: params.participantId,
    type: 'LINK_EXCHANGED',
    ctx: params.ctx,
    sessionJti: sitzung.jti,
    details: {
      tokenId: anker.record.id,
      actorSource: 'IN_PERSON_HANDOFF',
      channel: 'device_handoff',
      note: 'Sitzung auf dem uebergebenen Geraet ausgestellt; kein Zugang versendet.',
    },
  });
  return { sessionToken: sitzung.token, expiresAt: sitzung.expiresAt };
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
      quote: { select: { id: true, number: true, title: true, status: true } },
      originalArtifact: { select: { id: true, filename: true, checksum: true } },
      signedArtifact: { select: { id: true, filename: true, checksum: true } },
      evidenceArtifact: { select: { id: true, filename: true, checksum: true } },
    },
  });
  if (!request) throw new NotFoundError('Unterzeichnungsvorgang');
  // Das Recht am Vorgang ersetzt nicht das Recht am Ursprung — auch bei Offerten.
  if (request.quoteId && !can(session.role, 'quote:read')) throw new NotFoundError('Unterzeichnungsvorgang');
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

/**
 * Ein Artefakt für die Verwaltung — Original (A), signiert (B) oder
 * Protokoll (C). Dieselbe Berechtigung wie die Ansicht des Vorgangs; der
 * Abruf wird als Ereignis nicht protokolliert (das Signaturprotokoll gehört
 * der Unterzeichnung), wohl aber im allgemeinen Prüfprotokoll des Aufrufers.
 */
export async function getSignatureArtifactAdmin(
  session: SessionUser,
  organizationId: string,
  requestId: string,
  which: 'original' | 'signed' | 'evidence',
): Promise<{ bytes: Buffer; filename: string }> {
  await getSignatureRequestAdmin(session, organizationId, requestId);
  const request = await prisma.signatureRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: {
      originalArtifact: { include: { storedFile: true } },
      signedArtifact: { include: { storedFile: true } },
      evidenceArtifact: { include: { storedFile: true } },
    },
  });
  const asset = which === 'original' ? request.originalArtifact : which === 'signed' ? request.signedArtifact : request.evidenceArtifact;
  if (!asset) throw new NotFoundError('Datei');
  const bytes = await artefaktBytes(asset);
  if (!bytes) throw new NotFoundError('Datei');
  await audit.updated({
    organizationId,
    userId: session.id,
    entity: 'SignatureRequest',
    entityId: requestId,
    summary: `Artefakt „${which}" des Unterzeichnungsvorgangs heruntergeladen`,
  });
  return { bytes, filename: asset.filename };
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
      details: { tokenId: aufgeloest.token.record.id, actorSource: 'PUBLIC_LINK' },
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
      /** Woran hängt der Vorgang — die Maske wählt danach ihre Worte. */
      source: request.quoteId ? ('quote' as const) : request.jobId ? ('job' as const) : ('document' as const),
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
/** Steuert den Rückroll der Abschluss-Transaktion — kein Fehler für den Aufrufer. */
class Kopplungsfehler extends Error {
  constructor(
    readonly grund:
      | 'QUOTE_NOT_ACCEPTABLE'
      | 'JOB_NOT_ACCEPTABLE'
      | 'CONTRACT_VERSION_NOT_ACCEPTABLE'
      | 'REQUEST_NOT_FINALIZING',
  ) {
    super(grund);
  }
}

/**
 * Der Vorgang ist technisch fertig, das Geschäftsobjekt nimmt ihn nicht mehr
 * an — abbrechen, mit Grund.
 *
 * Kein stiller Endzustand „unterschrieben, aber nichts passiert": Die
 * Unterschrift wurde geleistet, sie trifft nur nichts mehr. Snapshot und
 * Protokoll bleiben als Beleg, die Zugänge werden entwertet, und der Zustand
 * hat einen Namen und ein Ereignis. Gemeinsam für Offerte und Einsatz, damit
 * es nicht zwei Auslegungen desselben Bruchs gibt.
 */
async function vorgangAbbrechenNachBruch(
  requestId: string,
  participants: { id: string }[],
  ctx: AnfrageKontext | undefined,
  details: Record<string, unknown>,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const abgebrochen = await tx.signatureRequest.updateMany({
      where: { id: requestId, status: 'FINALIZING' },
      data: { status: 'CANCELLED', cancelledAt: new Date(), finalizingSince: null },
    });
    if (abgebrochen.count === 0) return;
    for (const p of participants) {
      await revokeTokensFor({ tx, purpose: 'SIGNATURE_ACCESS', resourceId: p.id });
    }
    await appendSignatureEvent(tx, {
      requestId,
      type: 'CANCELLED',
      ctx,
      details: { by: 'system', ...details },
    });
  });
}

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
        quote: { select: { id: true, number: true, title: true } },
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
        sourceType: request.documentVersion ? 'Dokumentfassung' : request.quote ? 'Offerte' : 'Einsatz',
        sourceReference: request.documentVersion
          ? `${request.documentVersion.document.title} · Fassung ${request.documentVersion.version}`
          : request.quote
            ? `Offerte ${request.quote.number} · ${request.quote.title} (${request.quote.id})`
            : (request.jobId ?? ''),
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
        events: frisch.events.map((e) => ({
          at: e.at,
          type: e.type,
          participant: e.participant?.nameSnapshot ?? null,
          note: actorSourceText((e.details as { actorSource?: string } | null)?.actorSource),
        })),
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

    /**
     * Der Abschluss — und bei Offerten die Kopplung an das Geschäftsobjekt.
     *
     * Für einen Vorgang mit `quoteId` geschehen zwei Übergänge in **einer**
     * Transaktion, in der Sperrreihenfolge `Quote → SignatureRequest`:
     * erst die Offerte nach ACCEPTED (nur wenn sie noch annehmbar ist —
     * die Bedingungen stehen in der `where`-Klausel), dann der Vorgang
     * nach COMPLETED. Trifft einer der beiden keine Zeile, rollt alles
     * zurück. Ein COMPLETED ohne ACCEPTED gibt es damit nicht, und ein
     * ACCEPTED ohne COMPLETED auch nicht.
     *
     * Ist die Offerte nicht mehr annehmbar (inzwischen abgelehnt, geändert,
     * abgelaufen), wird der Vorgang aus FINALIZING heraus **abgebrochen**:
     * Die Unterschrift wurde geleistet, aber sie trifft nichts mehr. Der
     * Snapshot und das Protokoll bleiben als Beleg; die Links werden
     * widerrufen. Kein stiller Endzustand „unterschrieben, aber nicht
     * angenommen" — er hat einen Namen und ein Ereignis.
     */
    const quoteId = request.quoteId;
    /**
     * Der Einsatz wird nur gekoppelt, wenn es sich um eine **Vor-Ort-Abnahme**
     * handelt. Ein Vorgang mit `jobId` aus einem anderen Hergang — etwa ein
     * später zugestellter Link — hat andere Regeln und darf hier nicht
     * versehentlich eine Abnahme buchen.
     */
    const jobId = request.ceremonyMode === 'IN_PERSON_HANDOFF' ? request.jobId : null;
    /**
     * Die Vertragsfassung — die vierte Quelle (Wave 10, § 12).
     *
     * Dieselbe Kopplung wie bei der Offerte, in derselben Transaktion:
     * `Fassung angenommen ⇔ Vorgang COMPLETED`. Ist die Fassung inzwischen
     * abgelöst oder der Vertrag annulliert, trifft der Übergang keine Zeile,
     * und der Vorgang endet CANCELLED mit Grund — die Unterschrift wurde
     * geleistet, aber sie trifft nichts mehr.
     */
    const contractVersionId = request.contractVersionId;
    let ergebnis: 'COMPLETED' | 'CANCELLED' | 'OFFEN' = 'OFFEN';
    let grund: string | null = null;
    try {
      await prisma.$transaction(async (tx) => {
        if (quoteId) {
          const angenommen = await acceptQuoteInTx(tx, quoteId, now);
          if (!angenommen) throw new Kopplungsfehler('QUOTE_NOT_ACCEPTABLE');
        }
        if (jobId) {
          const abgenommen = await acceptJobInTx(tx, jobId, now);
          if (!abgenommen) throw new Kopplungsfehler('JOB_NOT_ACCEPTABLE');
        }
        if (contractVersionId) {
          const angenommen = await acceptContractVersionInTx(tx, {
            contractVersionId,
            requestId,
            now,
          });
          if (!angenommen) throw new Kopplungsfehler('CONTRACT_VERSION_NOT_ACCEPTABLE');
        }
        const fertig = await tx.signatureRequest.updateMany({
          where: { id: requestId, status: 'FINALIZING', evidenceArtifactId: { not: null } },
          data: { status: 'COMPLETED', completedAt: now, finalizingSince: null },
        });
        if (fertig.count === 0) throw new Kopplungsfehler('REQUEST_NOT_FINALIZING');
        await appendSignatureEvent(tx, {
          requestId,
          type: 'REQUEST_COMPLETED',
          ctx,
          details: quoteId
            ? { quoteId, quoteStatus: 'ACCEPTED' }
            : jobId
              ? { jobId, jobAccepted: true }
              : contractVersionId
                ? { contractVersionId, contractVersionAccepted: true }
                : undefined,
        });
      });
      ergebnis = 'COMPLETED';
    } catch (error) {
      if (!(error instanceof Kopplungsfehler)) throw error;
      grund = error.grund;
      if (error.grund === 'QUOTE_NOT_ACCEPTABLE' && quoteId) {
        const zustand = await prisma.quote.findUnique({ where: { id: quoteId }, select: { status: true, validUntil: true } });
        await vorgangAbbrechenNachBruch(requestId, request.participants, ctx, {
          reason: 'quote_not_acceptable_at_completion',
          quoteStatus: zustand?.status ?? null,
          quoteValidUntil: zustand?.validUntil?.toISOString() ?? null,
        });
        ergebnis = 'CANCELLED';
      }
      if (error.grund === 'JOB_NOT_ACCEPTABLE' && jobId) {
        const zustand = await prisma.job.findUnique({
          where: { id: jobId },
          select: { status: true, deletedAt: true, customerAcceptedAt: true },
        });
        await vorgangAbbrechenNachBruch(requestId, request.participants, ctx, {
          reason: 'job_not_acceptable_at_completion',
          jobStatus: zustand?.status ?? null,
          jobDeleted: Boolean(zustand?.deletedAt),
          jobAlreadyAccepted: Boolean(zustand?.customerAcceptedAt),
        });
        ergebnis = 'CANCELLED';
      }
      if (error.grund === 'CONTRACT_VERSION_NOT_ACCEPTABLE' && contractVersionId) {
        const zustand = await prisma.contractVersion.findUnique({
          where: { id: contractVersionId },
          select: { status: true, acceptedAt: true, contract: { select: { status: true, deletedAt: true } } },
        });
        await vorgangAbbrechenNachBruch(requestId, request.participants, ctx, {
          reason: 'contract_version_not_acceptable_at_completion',
          versionStatus: zustand?.status ?? null,
          versionAlreadyAccepted: Boolean(zustand?.acceptedAt),
          contractStatus: zustand?.contract.status ?? null,
          contractDeleted: Boolean(zustand?.contract.deletedAt),
        });
        ergebnis = 'CANCELLED';
      }
    }

    if (ergebnis === 'COMPLETED') {
      if (quoteId) {
        const letzterZugang = [...request.events].reverse().find((e) => e.type === 'LINK_EXCHANGED');
        const actorSource = ((letzterZugang?.details as { actorSource?: string } | null)?.actorSource ?? null) as
          | 'PUBLIC_LINK'
          | 'AUTHENTICATED_CUSTOMER'
          | null;
        await afterQuoteAccepted({ quoteId, requestId, actorSource, ctx });
      }
      if (jobId) {
        const signer = request.participants.find((p) => p.role === 'SIGNER');
        await afterJobAccepted({
          jobId,
          requestId,
          signerName: signer?.signedName ?? signer?.nameSnapshot ?? 'unbekannt',
          presentedByName: request.presentedByName,
          ctx,
        });
      }
      if (contractVersionId) {
        const signer = request.participants.find((p) => p.role === 'SIGNER');
        await afterContractVersionAccepted({
          contractVersionId,
          requestId,
          signerName: signer?.signedName ?? signer?.nameSnapshot ?? 'unbekannt',
          ctx,
        });
      }
      /**
       * Ergebnislinks gehen nur nach aussen, wenn der Vorgang auch von
       * aussen kam. Bei der Vor-Ort-Abnahme hält die Kundschaft das Gerät
       * gerade in der Hand und sieht das Ergebnis dort — eine E-Mail mit
       * einem Zugang wäre ein Geheimnis, das ohne Not entsteht.
       */
      if (!jobId) await ergebnisLinksVersenden(requestId, ctx);
      return 'COMPLETED';
    }
    if (ergebnis === 'CANCELLED') {
      log.warn('Unterzeichnung abgeschlossen, Offerte nicht mehr annehmbar — Vorgang abgebrochen', { requestId, grund });
      return 'CANCELLED';
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
