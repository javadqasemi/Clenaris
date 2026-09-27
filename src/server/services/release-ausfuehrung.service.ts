import 'server-only';

import type { Release, ReleaseRequest } from '@prisma/client';

import { recordAuditInTx } from '@/lib/audit';
import { prisma, type Tx } from '@/lib/db';
import { BusinessRuleError, ConfigurationError, ConflictError, NotFoundError } from '@/lib/errors';
import { aktuelleVersion, vergleicheVersionen } from '@/lib/version';
import type { ReleaseErgebnis, ReleaseUebernahme } from '@/lib/validation/system';

/**
 * Die Seite der Anwendung zum Release-Ausführer (2026-09-27).
 *
 * ---------------------------------------------------------------------------
 *  Was vorher fehlte
 * ---------------------------------------------------------------------------
 *
 * Das Update Center hielt Entscheidungen fest — freigegeben, terminiert —,
 * und dann geschah nichts. Der Dateikopf von `release.service.ts` sagte das
 * offen: Der Ausführer sei „heute nicht gebaut". Ein terminierter Auftrag war
 * eine Notiz, die niemand las; die Oberfläche zeigte einen Termin, an dem
 * sich nichts ändern würde.
 *
 * ---------------------------------------------------------------------------
 *  Wie die Trennung bleibt
 * ---------------------------------------------------------------------------
 *
 * Die Anwendung führt weiterhin **nichts** aus (Begründung in
 * `release.service.ts`). Ausgeführt wird von einem vertrauenswürdigen
 * Werkzeug ausserhalb — der Vorlage `deploy/v2/release-ausfuehrer.yml` mit
 * `scripts/release-ausfuehrer.ts` —, das die fälligen Aufträge **abholt**.
 * Die Richtung ist Absicht: Die Anwendung ruft niemanden an und hält keinen
 * Schlüssel, mit dem sie etwas auf dem Server auslösen könnte. Ein
 * übernommenes Konto der Systemverantwortung kann einen Termin setzen, den
 * der Ausführer dann prüft — aber keinen Befehl absetzen.
 *
 * Was die Anwendung hier prüft, bevor sie einen Auftrag hergibt:
 *
 *  | Bedingung                  | warum |
 *  |----------------------------|-------|
 *  | Signatur und Zeitfenster   | in der Route (`ausfuehrer-signatur.ts`) — ohne Schlüssel keine Übernahme |
 *  | Umgebung = `CLENARIS_UMGEBUNG` | der Ausführer der Vorschau übernimmt keinen Auftrag der Produktion |
 *  | Auftrag SCHEDULED und fällig | nur, was jemand freigegeben **und** terminiert hat |
 *  | Version neuer als die laufende | keine Rückstufung über diesen Weg |
 *  | CI bestanden, Commit bekannt | ungeprüftes geht nicht hinaus |
 *  | Prüfsumme gemessen = Release | das Artefakt ist das, was geprüft wurde |
 *
 * Idempotent über den Ausführungsschlüssel: Wer mit demselben Schlüssel
 * wiederkommt (Netzabbruch, Wiederholung des Laufs), bekommt denselben
 * Auftrag zurück und meldet dasselbe Ergebnis folgenlos erneut. Ein anderer
 * Schlüssel bekommt 409. Jeder Übergang steht im Prüfprotokoll, im selben
 * Commit.
 */

/** Die Umgebung dieser Instanz — ohne sie nimmt die Schnittstelle nichts an. */
export function instanzUmgebung(): string {
  const umgebung = process.env.CLENARIS_UMGEBUNG?.trim();
  if (!umgebung || !process.env.RELEASE_EXECUTOR_SIGNING_KEY?.trim()) {
    throw new ConfigurationError(
      'release-ausfuehrer',
      'Die Schnittstelle des Release-Ausführers ist nicht eingerichtet (CLENARIS_UMGEBUNG, RELEASE_EXECUTOR_SIGNING_KEY).',
    );
  }
  return umgebung;
}

function umgebungPruefen(verlangt: string) {
  const eigene = instanzUmgebung();
  if (verlangt !== eigene) {
    throw new BusinessRuleError(`Diese Instanz ist „${eigene}", nicht „${verlangt}". Ein Ausführer übernimmt nur Aufträge seiner eigenen Umgebung.`);
  }
}

/** Warum ein fälliger Auftrag (noch) nicht ausführbar ist — oder `null`. */
function hindernis(release: Release, laufend: string): string | null {
  if (vergleicheVersionen(release.version, laufend) <= 0) return `Version ${release.version} ist nicht neuer als die laufende ${laufend}.`;
  if (release.ciStatus !== 'PASSED') return `Die Prüfstufe für ${release.version} ist nicht bestanden (${release.ciStatus}).`;
  if (!release.commit) return `Für ${release.version} ist kein Commit eingetragen.`;
  if (!release.artifactSha256) return `Für ${release.version} ist keine Artefakt-Prüfsumme eingetragen.`;
  return null;
}

/**
 * Was der Ausführer über einen Auftrag wissen muss — und nicht mehr.
 *
 * Kein Ziel (Host, Pfad, Schlüssel): Wohin ausgerollt wird, steht in der
 * Konfiguration des Ausführers, nicht in einem Datensatz, den ein Browser
 * mitgestalten konnte. Die Rücksprungangaben sagen, wohin es zurückgeht und
 * ob das Schema dabei mitkommt (es kommt nie mit — Migrationen laufen nur
 * vorwärts, siehe `deploy/v2/release-aktivieren.sh`).
 */
function auftragFuerAusfuehrer(auftrag: ReleaseRequest, release: Release, laufend: string) {
  return {
    auftragId: auftrag.id,
    status: auftrag.status,
    vonVersion: auftrag.fromVersion,
    zielVersion: auftrag.toVersion,
    faelligAb: auftrag.scheduledFor?.toISOString() ?? null,
    commit: release.commit,
    artefaktSha256: release.artifactSha256,
    artefaktGroesseBytes: release.artifactSizeBytes,
    ciStatus: release.ciStatus,
    migrationen: release.migrations,
    erwarteteAusfallzeitMinuten: release.expectedDowntimeMinutes,
    ausfuehrungsSchluessel: auftrag.executionKey,
    ruecksprung: {
      verfuegbar: release.rollbackAvailable,
      aufVersion: auftrag.fromVersion,
      schemaBleibt: release.migrations.length > 0,
    },
    hindernis: auftrag.status === 'SCHEDULED' ? hindernis(release, laufend) : null,
  };
}

/** Fällige, terminierte Aufträge dieser Umgebung — nur lesen. */
export async function faelligeAuftraege(organizationId: string, umgebung: string) {
  umgebungPruefen(umgebung);
  const laufend = aktuelleVersion();
  const auftraege = await prisma.releaseRequest.findMany({
    where: { organizationId, status: 'SCHEDULED', scheduledFor: { lte: new Date() } },
    include: { release: true },
    orderBy: { scheduledFor: 'asc' },
  });
  return { umgebung, laufend, auftraege: auftraege.map((a) => auftragFuerAusfuehrer(a, a.release, laufend)) };
}

async function ladeUnterSperre(tx: Tx, organizationId: string, auftragId: string) {
  const zeile = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM release_requests WHERE id = ${auftragId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  if (!zeile[0]) throw new NotFoundError('Auftrag');
  return tx.releaseRequest.findUniqueOrThrow({ where: { id: auftragId }, include: { release: true } });
}

async function protokolliere(tx: Tx, organizationId: string, auftrag: ReleaseRequest, summary: string, changes: Record<string, unknown>) {
  await recordAuditInTx(tx, {
    organizationId,
    // Kein Benutzer: Der Ausführer ist eine Maschine. Wer er war, steht in
    // `changes.ausfuehrer` — die Kennung aus seiner Konfiguration.
    userId: null,
    action: 'UPDATE',
    entity: 'ReleaseRequest',
    entityId: auftrag.id,
    summary,
    changes: { vonVersion: auftrag.fromVersion, zielVersion: auftrag.toVersion, ...changes },
  });
}

/** SCHEDULED (fällig) → DEPLOYING. Idempotent über den Ausführungsschlüssel. */
export async function auftragUebernehmen(organizationId: string, eingabe: ReleaseUebernahme) {
  umgebungPruefen(eingabe.umgebung);
  const laufend = aktuelleVersion();

  return prisma.$transaction(async (tx) => {
    const auftrag = await ladeUnterSperre(tx, organizationId, eingabe.auftragId);

    // Dieselbe Übernahme noch einmal: dieselbe Antwort, keine zweite Wirkung.
    if (auftrag.executionKey === eingabe.ausfuehrungsSchluessel) {
      if (auftrag.executorId !== eingabe.ausfuehrer || auftrag.environment !== eingabe.umgebung) {
        throw new ConflictError('Dieser Ausführungsschlüssel gehört zu einem anderen Ausführer oder einer anderen Umgebung.');
      }
      return { wiederholt: true, auftrag: auftragFuerAusfuehrer(auftrag, auftrag.release, laufend) };
    }
    if (auftrag.status === 'DEPLOYING') {
      throw new ConflictError(`Der Auftrag wird bereits von „${auftrag.executorId}" ausgeführt.`);
    }
    if (auftrag.status !== 'SCHEDULED') {
      throw new BusinessRuleError(`Der Auftrag ist ${auftrag.status}, nicht terminiert — es gibt nichts zu übernehmen.`);
    }
    if (!auftrag.scheduledFor || auftrag.scheduledFor.getTime() > Date.now()) {
      throw new BusinessRuleError(`Der Auftrag ist erst ab ${auftrag.scheduledFor?.toISOString() ?? '—'} fällig.`);
    }
    const grund = hindernis(auftrag.release, laufend);
    if (grund) throw new BusinessRuleError(grund);
    if (eingabe.artefaktSha256 !== auftrag.release.artifactSha256) {
      throw new BusinessRuleError(
        'Die gemessene Prüfsumme des Artefakts entspricht nicht der des Release. Ausgerollt wird nur, was geprüft wurde.',
      );
    }

    const jetzt = new Date();
    const uebernommen = await tx.releaseRequest.update({
      where: { id: auftrag.id },
      data: {
        status: 'DEPLOYING',
        executorId: eingabe.ausfuehrer,
        executionKey: eingabe.ausfuehrungsSchluessel,
        environment: eingabe.umgebung,
        verifiedSha256: eingabe.artefaktSha256,
        ciEvidence: eingabe.ciNachweis,
        claimedAt: jetzt,
      },
    });
    await protokolliere(tx, organizationId, uebernommen, `Version ${auftrag.toVersion}: Ausführung übernommen von ${eingabe.ausfuehrer} (${eingabe.umgebung})`, {
      status: { from: 'SCHEDULED', to: 'DEPLOYING' },
      ausfuehrer: eingabe.ausfuehrer,
      umgebung: eingabe.umgebung,
      commit: auftrag.release.commit,
      artefaktSha256: eingabe.artefaktSha256,
      ciNachweis: eingabe.ciNachweis,
    });
    return { wiederholt: false, auftrag: auftragFuerAusfuehrer(uebernommen, auftrag.release, laufend) };
  });
}

/** DEPLOYING → SUCCEEDED | FAILED | ROLLED_BACK. Idempotent für dieselbe Meldung. */
export async function auftragErgebnis(organizationId: string, eingabe: ReleaseErgebnis) {
  const laufend = aktuelleVersion();
  return prisma.$transaction(async (tx) => {
    const auftrag = await ladeUnterSperre(tx, organizationId, eingabe.auftragId);
    if (auftrag.executionKey !== eingabe.ausfuehrungsSchluessel) {
      throw new ConflictError('Dieser Auftrag wurde nicht mit diesem Ausführungsschlüssel übernommen.');
    }
    if (auftrag.status === eingabe.ergebnis) {
      return { wiederholt: true, auftrag: auftragFuerAusfuehrer(auftrag, auftrag.release, laufend) };
    }
    if (auftrag.status !== 'DEPLOYING') {
      throw new ConflictError(`Für diesen Auftrag wurde bereits ${auftrag.status} gemeldet.`);
    }
    if (eingabe.ergebnis === 'SUCCEEDED' && eingabe.laufendeVersion !== auftrag.toVersion) {
      throw new BusinessRuleError(
        `„Erfolgreich" verlangt, dass die Instanz danach ${auftrag.toVersion} meldet — gemeldet wurde ${eingabe.laufendeVersion ?? 'nichts'}.`,
      );
    }

    const fertig = await tx.releaseRequest.update({
      where: { id: auftrag.id },
      data: {
        status: eingabe.ergebnis,
        finishedAt: new Date(),
        resultMessage: eingabe.meldung ?? null,
        rollbackVersion: eingabe.ergebnis === 'ROLLED_BACK' ? auftrag.fromVersion : null,
      },
    });
    await protokolliere(tx, organizationId, fertig, `Version ${auftrag.toVersion}: Ausführung ${ERGEBNISNAMEN[eingabe.ergebnis]} (${auftrag.executorId})`, {
      status: { from: 'DEPLOYING', to: eingabe.ergebnis },
      ausfuehrer: auftrag.executorId,
      laufendeVersion: eingabe.laufendeVersion ?? null,
      ruecksprungAuf: eingabe.ergebnis === 'ROLLED_BACK' ? auftrag.fromVersion : null,
      meldung: eingabe.meldung ?? null,
    });
    return { wiederholt: false, auftrag: auftragFuerAusfuehrer(fertig, auftrag.release, laufend) };
  });
}

const ERGEBNISNAMEN = { SUCCEEDED: 'erfolgreich', FAILED: 'fehlgeschlagen', ROLLED_BACK: 'zurückgesetzt' } as const;
