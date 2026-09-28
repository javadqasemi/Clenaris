import 'server-only';

import { audit } from '@/lib/audit';
import { verifyPassword } from '@/lib/auth/password';
import {
  createSession,
  currentSessionFamily,
  type SessionUser,
} from '@/lib/auth/session';
import { prisma, type Tx } from '@/lib/db';
import { BusinessRuleError, ForbiddenError, NotFoundError, UnauthorizedError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { enforceRateLimit } from '@/lib/rate-limit';

const log = logger('geraeteuebergabe');

/**
 * Die Geräteübergabe — das Gerät wechselt die Hand, die Sitzung nicht.
 *
 * **Das Problem.** Bei der Vor-Ort-Abnahme reicht die Reinigungskraft ihr
 * eigenes, angemeldetes Telefon der Kundschaft, damit diese den Rapport
 * liest und unterschreibt. In diesem Moment sitzen zwei verschiedene Personen
 * hintereinander an derselben Sitzung. Eine Maske ohne Navigation genügt
 * dagegen nicht: Zurück-Taste, zweiter Tab, direkt eingetippte Adresse — der
 * Browser trägt die Anmeldecookies weiterhin bei jedem Aufruf mit.
 *
 * **Was hier deshalb nicht passiert: Abmelden.** Naheliegend wäre, die
 * Sitzung zu beenden und danach neu anzumelden. Das kostet vor Ort, auf
 * einem Telefon, mit nassen Händen, zwischen zwei Terminen: E-Mail-Adresse,
 * Passwort, womöglich zweiter Faktor — und zwar nach *jeder* Abnahme. Was in
 * der Praxis daraus wird, ist ein Team, das sich nicht mehr abmeldet.
 *
 * **Was stattdessen passiert.** Die Sitzung bleibt bestehen und wird
 * serverseitig gesperrt. Die Sperre steht als Zeile in
 * `device_handoff_sessions`, gebunden an die Rotationsfamilie *dieses*
 * Browsers, und sie wird bei jedem Ausstellen eines Zugangstokens erneut
 * eingeprägt (`createSession`). Aufgehoben wird sie mit dem Passwort der
 * bereits angemeldeten Person — eine Bestätigung, keine Anmeldung.
 *
 * **Warum an der Familie und nicht am Benutzer.** Dieselbe Person ist häufig
 * auf dem Arbeitstelefon *und* am Bürorechner angemeldet. Eine Sperre je
 * Benutzer würde beim Übergeben des Telefons den Rechner mitsperren — und
 * damit die Disposition, die gerade nichts weitergibt.
 */

/** Wie lange eine Abnahme höchstens offen bleibt, bevor sie abläuft. */
export const HANDOFF_TTL_MS = 30 * 60 * 1000;

/** Was die Entsperrmaske und der Kundenmodus über den Zustand wissen dürfen. */
export interface HandoffZustand {
  id: string;
  jobId: string;
  jobNumber: string;
  signatureRequestId: string;
  signaturePublicId: string;
  /** Der Vorgang selbst — abgeschlossen, abgelehnt, offen, abgelaufen. */
  signatureStatus: string;
  startedAt: Date;
  expiresAt: Date;
  /** Wer das Gerät übergeben hat — für die Rückgabemaske. */
  presentedByName: string | null;
}

/**
 * Die laufende Übergabe dieses Browsers — oder `null`.
 *
 * Gelesen wird über die Familie, nicht über die Kennung im Token: Der
 * Kundenmodus soll den Zustand auch dann noch bestimmen können, wenn das
 * Zugangstoken inzwischen abgelaufen ist.
 */
export async function activeHandoffForCurrentDevice(): Promise<HandoffZustand | null> {
  const family = await currentSessionFamily();
  if (!family) return null;
  return handoffByFamily(family);
}

async function handoffByFamily(family: string): Promise<HandoffZustand | null> {
  const treffer = await prisma.deviceHandoffSession.findFirst({
    where: { sessionFamily: family, status: 'ACTIVE' },
    include: {
      job: { select: { id: true, number: true } },
      signatureRequest: { select: { id: true, publicId: true, status: true, presentedByName: true } },
    },
  });
  if (!treffer) return null;
  return {
    id: treffer.id,
    jobId: treffer.job.id,
    jobNumber: treffer.job.number,
    signatureRequestId: treffer.signatureRequest.id,
    signaturePublicId: treffer.signatureRequest.publicId,
    signatureStatus: treffer.signatureRequest.status,
    startedAt: treffer.startedAt,
    expiresAt: treffer.expiresAt,
    presentedByName: treffer.signatureRequest.presentedByName,
  };
}

/**
 * Läuft für einen Einsatz gerade eine Abnahme? Der Rapport ist dann
 * eingefroren (§ 12/§ 13 des Gate-4D-Auftrags).
 *
 * Die Frage stellt `job.service.ts` vor jeder signaturrelevanten Änderung —
 * **serverseitig**, nicht in der Maske. Eine ausgegraute Schaltfläche ist
 * eine Bitte; diese Prüfung ist die Zusicherung.
 */
export async function jobHatOffeneAbnahme(jobId: string, tx?: Tx): Promise<boolean> {
  const client = tx ?? prisma;
  const offen = await client.signatureRequest.count({
    where: {
      jobId,
      ceremonyMode: 'IN_PERSON_HANDOFF',
      status: { in: ['DRAFT', 'PENDING', 'FINALIZING'] },
    },
  });
  return offen > 0;
}

/**
 * Wirft, wenn der Einsatz gerade zur Abnahme übergeben ist.
 *
 * Bewusst eine Geschäftsregel (422) und keine Berechtigungsfrage: Die Person
 * dürfte den Rapport bearbeiten, nur nicht *jetzt* — der Kunde liest gerade
 * genau diese Fassung.
 */
export async function assertRapportNichtEingefroren(jobId: string, tx?: Tx): Promise<void> {
  if (await jobHatOffeneAbnahme(jobId, tx)) {
    throw new BusinessRuleError(
      'Für diesen Einsatz läuft gerade die Kundenabnahme. Der Rapport ist bis zu deren Abschluss festgehalten.',
    );
  }
}

/**
 * Die Sperre setzen — in der Transaktion des Aufrufers, nach dem Vorgang.
 *
 * Sperrreihenfolge in Gate 4D durchgehend:
 * `Job → SignatureRequest → SignatureParticipant → DeviceHandoffSession`.
 * Der Teilindex `device_handoff_sessions_eine_aktive_je_familie` lässt je
 * Browser nur eine aktive Übergabe zu; verliert dieser Aufruf ein Rennen,
 * wirft Prisma P2002 und der Aufrufer rollt zurück.
 */
export async function createHandoffInTx(
  tx: Tx,
  params: {
    organizationId: string;
    userId: string;
    jobId: string;
    signatureRequestId: string;
    sessionFamily: string;
    expiresAt: Date;
  },
): Promise<string> {
  const angelegt = await tx.deviceHandoffSession.create({
    data: {
      organizationId: params.organizationId,
      userId: params.userId,
      jobId: params.jobId,
      signatureRequestId: params.signatureRequestId,
      sessionFamily: params.sessionFamily,
      status: 'ACTIVE',
      expiresAt: params.expiresAt,
    },
    select: { id: true },
  });
  return angelegt.id;
}

/**
 * Das Zugangstoken dieses Browsers neu ausstellen — mit oder ohne Sperre.
 *
 * `createSession` schlägt die Übergabe selbst nach; hier wird nur die
 * Familie fortgeführt. Dadurch bleibt die Rotationsfamilie über Sperren und
 * Entsperren hinweg **dieselbe** — es gibt kein Abmelden, keine neue
 * Familie, keine zweite Anmeldung.
 */
export async function stempelSitzungNeu(userId: string): Promise<void> {
  const family = await currentSessionFamily();
  if (!family) {
    // Ohne Refresh-Cookie liesse sich die Sitzung nicht fortführen. Dann ist
    // die Sperre zwar in der Datenbank, das Token aber unbelastet — deshalb
    // hier hart abbrechen statt still weiterzumachen.
    throw new BusinessRuleError(
      'Diese Sitzung lässt sich nicht für eine Geräteübergabe verwenden. Bitte neu anmelden.',
    );
  }
  await createSession({ userId, family });
}

/**
 * Entsperren nach der Rückgabe — Bestätigung, keine Anmeldung.
 *
 * **Was hier absichtlich nicht verlangt wird.** Keine E-Mail-Adresse (die
 * Person ist bekannt), kein zweiter Faktor (der soll den *Zugang* zum Konto
 * schützen, und der besteht seit Stunden), kein neuer PIN (ein vierstelliger
 * Zusatzcode wäre ein schwächeres Geheimnis neben einem starken, das es
 * schon gibt). Verlangt wird das Passwort dieses Kontos: der Nachweis, dass
 * wieder die Person am Gerät ist, der es gehört.
 *
 * **Das Kontingent** zählt je Übergabe, nicht je Konto. Ein hartes Limit auf
 * den Benutzer würde die Person auf allen Geräten aussperren — ein
 * Denial-of-Service durch eine Kundin, die dreimal danebentippt.
 */
export async function releaseHandoff(params: {
  session: SessionUser;
  password: string;
  ip: string;
}): Promise<{ jobId: string; jobNumber: string; signatureStatus: string }> {
  const family = await currentSessionFamily();
  if (!family) throw new UnauthorizedError('Die Sitzung ist nicht mehr gültig.');

  const handoff = await prisma.deviceHandoffSession.findFirst({
    where: { sessionFamily: family, status: 'ACTIVE' },
    include: {
      job: { select: { id: true, number: true } },
      signatureRequest: { select: { id: true, status: true } },
    },
  });
  if (!handoff) throw new NotFoundError('Geräteübergabe');

  // Die Sperre gehört zu diesem Browser — und sie gehört zu dieser Person.
  if (handoff.userId !== params.session.id) {
    throw new ForbiddenError('Diese Geräteübergabe gehört zu einem anderen Konto.');
  }

  await enforceRateLimit('handoffUnlock', handoff.id);

  const user = await prisma.user.findFirst({
    where: { id: params.session.id, status: 'ACTIVE', deletedAt: null },
    select: { id: true, passwordHash: true, organizationId: true },
  });
  if (!user?.passwordHash) throw new UnauthorizedError('Die Sitzung ist nicht mehr gültig.');

  if (!(await verifyPassword(user.passwordHash, params.password))) {
    await audit.updated({
      organizationId: user.organizationId,
      userId: user.id,
      entity: 'DeviceHandoffSession',
      entityId: handoff.id,
      summary: `Entsperren des Geräts nach der Abnahme von Einsatz ${handoff.job.number} fehlgeschlagen`,
      ip: params.ip,
    });
    throw new UnauthorizedError('Das Passwort stimmt nicht.');
  }

  /**
   * Freigeben und sofort ein unbelastetes Zugangstoken ausstellen.
   *
   * Reihenfolge ist wesentlich: erst die Zeile auf RELEASED, dann das neue
   * Token. Andersherum schlüge `createSession` die noch aktive Übergabe nach
   * und prägte die Sperre erneut ein — das Entsperren wäre wirkungslos.
   */
  const freigegeben = await prisma.deviceHandoffSession.updateMany({
    where: { id: handoff.id, status: 'ACTIVE' },
    data: { status: 'RELEASED', releasedAt: new Date() },
  });
  if (freigegeben.count === 0) {
    // Jemand war schneller (zweiter Tab). Kein Fehler: Das Ziel ist erreicht.
    log.info('Übergabe war bereits freigegeben', { handoffId: handoff.id });
  }

  await createSession({ userId: user.id, family });

  await audit.updated({
    organizationId: user.organizationId,
    userId: user.id,
    entity: 'DeviceHandoffSession',
    entityId: handoff.id,
    summary: `Gerät nach der Kundenabnahme von Einsatz ${handoff.job.number} wieder übernommen`,
    ip: params.ip,
  });

  return {
    jobId: handoff.job.id,
    jobNumber: handoff.job.number,
    signatureStatus: handoff.signatureRequest.status,
  };
}

/**
 * Die Sperre aufheben, weil der Vorgang selbst endete — **nicht** verwendet.
 *
 * Steht hier als ausdrückliche Notiz zum Entwurf: Weder der erfolgreiche
 * Abschluss der Unterschrift noch das Ablaufen des Vorgangs geben das Gerät
 * frei. Täten sie es, zeigte ein liegengelassenes Telefon nach der
 * Unterschrift — oder nach Fristablauf — wieder den Mitarbeiterbereich, und
 * zwar genau dann, wenn niemand hinsieht. Freigegeben wird ausschliesslich
 * durch `releaseHandoff`, also durch eine Person mit dem Passwort.
 */
export const HANDOFF_ENDET_NICHT_AUTOMATISCH = true;
