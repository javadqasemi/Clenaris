import 'server-only';

import type { Release, ReleaseRequest, ReleaseRequestStatus } from '@prisma/client';

import { recordAuditInTx } from '@/lib/audit';
import { prisma, type Tx } from '@/lib/db';
import { BusinessRuleError, ConfigurationError, ConflictError, NotFoundError } from '@/lib/errors';
import { IDENTITAETS_NAMEN, identitaetsAngaben, laufendeIdentitaet, type Identitaet } from '@/lib/release/identitaet';
import { COMMIT_MUSTER } from '@/lib/release/manifest';
import { vergleicheVersionen } from '@/lib/version';
import type { ReleaseErgebnis, ReleaseUebernahme } from '@/lib/validation/system';

/**
 * Die Seite der Anwendung zum Release-Ausführer (2026-09-27, gehärtet
 * 2026-09-30).
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
 * Werkzeug ausserhalb — dem Workflow mit `scripts/release-ausfuehrer.ts` —,
 * das die fälligen Aufträge **abholt**. Die Richtung ist Absicht: Die
 * Anwendung ruft niemanden an und hält keinen Schlüssel, mit dem sie etwas
 * auf dem Server auslösen könnte. Ein übernommenes Konto der
 * Systemverantwortung kann einen Termin setzen, den der Ausführer dann
 * prüft — aber keinen Befehl absetzen.
 *
 * Was die Anwendung prüft, bevor sie einen Auftrag hergibt:
 *
 *  | Bedingung                      | warum |
 *  |--------------------------------|-------|
 *  | Signatur und Zeitfenster       | in der Route (`ausfuehrer-signatur.ts`) — ohne Schlüssel keine Übernahme |
 *  | Umgebung = `CLENARIS_UMGEBUNG` | der Ausführer der Vorschau übernimmt keinen Auftrag der Produktion |
 *  | Auftrag SCHEDULED und fällig   | nur, was jemand freigegeben **und** terminiert hat |
 *  | Identität der Instanz belegt   | ohne belegten Ausgangsstand gibt es keinen Rücksprung, der „zurück" hiesse |
 *  | Version neuer als die belegte  | keine Rückstufung über diesen Weg |
 *  | CI bestanden, Commit vollständig | ungeprüftes geht nicht hinaus; ein Kürzel liesse sich nie bestätigen |
 *  | Prüfsumme, Commit, Version gemessen = Release | das Artefakt ist das, was geprüft wurde, und der Ausführer hat es als diese Fassung gelesen |
 *  | keine andere Ausführung in der Umgebung | zwei Umschaltungen gleichzeitig hätten keinen definierten Rücksprung |
 *
 * ---------------------------------------------------------------------------
 *  Das Ergebnis belegt die Instanz, nicht der Ausführer (2026-09-30)
 * ---------------------------------------------------------------------------
 *
 * Bis zur Härtung meldete der Ausführer „erfolgreich" samt der Version, die
 * er gelesen haben wollte, und die Anwendung verglich zwei Zeichenketten aus
 * derselben Quelle. Jetzt entscheidet die **Identität der antwortenden
 * Instanz** (`release/identitaet.ts`): Die Meldung kommt nach dem Umschalten
 * bei der neuen Fassung an, und diese belegt ihren Stand aus `RELEASE.json`
 * und `BUILD_ID` ihres eigenen Verzeichnisses.
 *
 *  - SUCCEEDED nur, wenn die Instanz belegt **Commit und Version des Release** nennt.
 *  - ROLLED_BACK nur, wenn sie belegt die **Ausgangsversion** und einen
 *    anderen Commit nennt — ein Rücksprung, nach dem das Ziel weiterläuft,
 *    ist keiner.
 *  - FAILED wird immer angenommen: Ein Ausführer, der Scheitern meldet, soll
 *    nie an einer Prüfung hängenbleiben und einen Auftrag offen lassen.
 *
 * Ins Prüfprotokoll kommt, was der **Server** beobachtet hat (Commit,
 * Build-ID, Version, Zustand der Identität), neben dem, was der Ausführer
 * über die Aktivierung berichtet.
 *
 * Idempotent über den Ausführungsschlüssel: Wer mit demselben Schlüssel
 * wiederkommt (Netzabbruch, Wiederholung des Laufs), bekommt denselben
 * Auftrag zurück und meldet dasselbe Ergebnis folgenlos erneut. Ein anderer
 * Schlüssel bekommt 409. Ein Auftrag, zu dem nie eine Rückmeldung kommt,
 * wird vom stündlichen Lauf abgeschlossen (`verwaisteAusfuehrungenAbschliessen`).
 * Jeder Übergang steht im Prüfprotokoll, im selben Commit.
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
function hindernis(release: Release, identitaet: Identitaet): string | null {
  // Zuerst die Identität: Ohne belegten Ausgangsstand ist schon der
  // Versionsvergleich darunter nur eine Behauptung, und ein Rücksprung auf
  // „die vorherige Fassung" hätte kein belegtes Ziel.
  if (!identitaet.belegt) {
    return `Die laufende Instanz kann ihren Stand nicht belegen (${IDENTITAETS_NAMEN[identitaet.zustand]}) — ohne belegten Ausgangsstand wird nichts ausgerollt.`;
  }
  if (vergleicheVersionen(release.version, identitaet.version) <= 0) {
    return `Version ${release.version} ist nicht neuer als die laufende ${identitaet.version}.`;
  }
  if (release.ciStatus !== 'PASSED') return `Die Prüfstufe für ${release.version} ist nicht bestanden (${release.ciStatus}).`;
  if (!release.commit || !COMMIT_MUSTER.test(release.commit)) {
    return `Für ${release.version} ist kein vollständiger Commit (40 Hexadezimalzeichen) eingetragen.`;
  }
  if (!release.artifactSha256) return `Für ${release.version} ist keine Artefakt-Prüfsumme eingetragen.`;
  return null;
}

/**
 * Belegt die Instanz das Ziel des Auftrags? `null` heisst ja, sonst der Grund.
 * Dieselbe Regel für die Meldung „erfolgreich" und für den stündlichen
 * Abschluss verwaister Aufträge — zwei Fassungen liefen auseinander.
 */
function zielNichtBelegt(auftrag: ReleaseRequest, release: Release, identitaet: Identitaet): string | null {
  if (!identitaet.belegt) {
    return `Die antwortende Instanz kann ihren Stand nicht belegen (${IDENTITAETS_NAMEN[identitaet.zustand]}).`;
  }
  if (identitaet.commit !== release.commit) {
    return `Die antwortende Instanz belegt Commit ${identitaet.commit?.slice(0, 12)}, das Release ${auftrag.toVersion} ist ${release.commit?.slice(0, 12) ?? '—'}.`;
  }
  if (identitaet.version !== release.version) {
    return `Die antwortende Instanz belegt Version ${identitaet.version}, nicht ${release.version}.`;
  }
  return null;
}

/** Belegt die Instanz den Ausgangsstand des Auftrags (Rücksprung)? `null` heisst ja. */
function ausgangNichtBelegt(auftrag: ReleaseRequest, release: Release, identitaet: Identitaet): string | null {
  if (!identitaet.belegt) {
    return `Die antwortende Instanz kann ihren Stand nicht belegen (${IDENTITAETS_NAMEN[identitaet.zustand]}).`;
  }
  if (identitaet.commit === release.commit) {
    return `Die antwortende Instanz läuft noch mit dem Ziel ${auftrag.toVersion} (${release.commit?.slice(0, 12)}) — das ist kein Rücksprung.`;
  }
  if (identitaet.version !== auftrag.fromVersion) {
    return `Die antwortende Instanz belegt Version ${identitaet.version}, nicht die Ausgangsversion ${auftrag.fromVersion}.`;
  }
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
function auftragFuerAusfuehrer(auftrag: ReleaseRequest, release: Release, identitaet: Identitaet) {
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
    hindernis: auftrag.status === 'SCHEDULED' ? hindernis(release, identitaet) : null,
  };
}

/**
 * Fällige, terminierte Aufträge dieser Umgebung — nur lesen.
 *
 * Seit 2026-09-30 mit drei Zusätzen, die der Ausführer für seinen Plan braucht:
 *
 *  - `laufend`: die belegte Identität der Instanz (Version, Commit, Build-ID,
 *    belegt) statt einer blossen Versionsnummer. Der Ausführer liest sie vor
 *    und nach der Aktivierung, und `/api/health` nennt dieselben Werte.
 *  - `inAusfuehrung`: die Aufträge dieser Umgebung, die gerade DEPLOYING
 *    sind, mit Ausführer, Schlüssel und Beginn. Ein Lauf, der nach einem
 *    Abbruch mit **seinem** Schlüssel wiederkommt, findet seinen Auftrag hier
 *    und setzt ihn fort, statt ihn als „nicht fällig" zu übersehen; ein Lauf
 *    mit anderem Schlüssel sieht, dass die Umgebung belegt ist, und fängt
 *    nichts Zweites an.
 *  - `hindernis` jedes fälligen Auftrags prüft die Identität mit.
 *
 * Der Ausführungsschlüssel ist kein Geheimnis (die Kennung eines CI-Laufs);
 * die Antwort geht nur an den signierten Ausführer.
 */
export async function faelligeAuftraege(organizationId: string, umgebung: string) {
  umgebungPruefen(umgebung);
  const identitaet = laufendeIdentitaet();
  const [auftraege, laufende] = await Promise.all([
    prisma.releaseRequest.findMany({
      where: { organizationId, status: 'SCHEDULED', scheduledFor: { lte: new Date() } },
      include: { release: true },
      orderBy: { scheduledFor: 'asc' },
    }),
    prisma.releaseRequest.findMany({
      where: { organizationId, status: 'DEPLOYING', environment: umgebung },
      include: { release: true },
      orderBy: { claimedAt: 'asc' },
    }),
  ]);
  const { belegt, version, commit, buildId } = identitaetsAngaben(identitaet);
  return {
    umgebung,
    laufend: { version, commit, buildId, belegt },
    auftraege: auftraege.map((a) => auftragFuerAusfuehrer(a, a.release, identitaet)),
    inAusfuehrung: laufende.map((a) => ({
      ...auftragFuerAusfuehrer(a, a.release, identitaet),
      ausfuehrer: a.executorId,
      seit: a.claimedAt?.toISOString() ?? null,
    })),
  };
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
    // Kein Benutzer: Der Ausführer ist eine Maschine, der stündliche Lauf
    // auch. Wer es war, steht in `changes.ausfuehrer` beziehungsweise
    // `changes.abgeschlossenDurch`.
    userId: null,
    action: 'UPDATE',
    entity: 'ReleaseRequest',
    entityId: auftrag.id,
    summary,
    changes: { vonVersion: auftrag.fromVersion, zielVersion: auftrag.toVersion, ...changes },
  });
}

/** Was der Server über sich selbst beobachtet — für das Prüfprotokoll. */
function beobachtet(identitaet: Identitaet) {
  return { commit: identitaet.commit, buildId: identitaet.buildId, version: identitaet.version, identitaet: identitaet.zustand };
}

/**
 * Eine Ausführung je Umgebung. Die Sperre gilt für die Dauer der
 * Transaktion und reiht zwei gleichzeitige Übernahmen **verschiedener**
 * Aufträge hintereinander — die Zeilensperre darunter schützt nur denselben
 * Auftrag, und der Teilindex `release_requests_offen_einmal` nur dieselbe
 * Version.
 */
async function umgebungSperren(tx: Tx, organizationId: string, umgebung: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`release-ausfuehrung:${organizationId}:${umgebung}`}))`;
}

/** SCHEDULED (fällig) → DEPLOYING. Idempotent über den Ausführungsschlüssel. */
export async function auftragUebernehmen(organizationId: string, eingabe: ReleaseUebernahme) {
  umgebungPruefen(eingabe.umgebung);
  const identitaet = laufendeIdentitaet();

  return prisma.$transaction(async (tx) => {
    await umgebungSperren(tx, organizationId, eingabe.umgebung);
    const auftrag = await ladeUnterSperre(tx, organizationId, eingabe.auftragId);

    // Dieselbe Übernahme noch einmal: dieselbe Antwort, keine zweite Wirkung.
    // Das Hindernis wird dabei nicht neu geprüft — nach einer gelungenen
    // Umschaltung läuft das Ziel schon, und „nicht neuer als die laufende"
    // verhinderte genau die Fortsetzung, für die der Schlüssel da ist. Was
    // aber stimmen muss, ist das Artefakt: derselbe Schlüssel mit einem
    // anderen Archiv ist keine Wiederholung, sondern ein zweiter Vorgang.
    if (auftrag.executionKey === eingabe.ausfuehrungsSchluessel) {
      if (auftrag.executorId !== eingabe.ausfuehrer || auftrag.environment !== eingabe.umgebung) {
        throw new ConflictError('Dieser Ausführungsschlüssel gehört zu einem anderen Ausführer oder einer anderen Umgebung.');
      }
      if (
        auftrag.verifiedSha256 !== eingabe.artefaktSha256 ||
        auftrag.release.commit !== eingabe.commit ||
        auftrag.toVersion !== eingabe.zielVersion
      ) {
        throw new ConflictError('Dieser Ausführungsschlüssel hat den Auftrag mit einem anderen Artefakt übernommen.');
      }
      return { wiederholt: true, auftrag: auftragFuerAusfuehrer(auftrag, auftrag.release, identitaet) };
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
    const grund = hindernis(auftrag.release, identitaet);
    if (grund) throw new BusinessRuleError(grund);
    if (eingabe.commit !== auftrag.release.commit) {
      throw new BusinessRuleError(
        `Das gemessene Artefakt trägt Commit ${eingabe.commit.slice(0, 12)}, das Release ${auftrag.toVersion} aber ${auftrag.release.commit?.slice(0, 12) ?? '—'}.`,
      );
    }
    if (eingabe.zielVersion !== auftrag.release.version || eingabe.zielVersion !== auftrag.toVersion) {
      throw new BusinessRuleError(`Das gemessene Artefakt ist Version ${eingabe.zielVersion}, der Auftrag gilt ${auftrag.toVersion}.`);
    }
    if (eingabe.artefaktSha256 !== auftrag.release.artifactSha256) {
      throw new BusinessRuleError(
        'Die gemessene Prüfsumme des Artefakts entspricht nicht der des Release. Ausgerollt wird nur, was geprüft wurde.',
      );
    }
    const andere = await tx.releaseRequest.findFirst({
      where: { organizationId, status: 'DEPLOYING', environment: eingabe.umgebung, NOT: { id: auftrag.id } },
      select: { toVersion: true, executorId: true },
    });
    if (andere) {
      throw new ConflictError(
        `In „${eingabe.umgebung}" wird gerade Version ${andere.toVersion} von „${andere.executorId}" installiert. Erst deren Ergebnis, dann die nächste.`,
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
      beobachtet: beobachtet(identitaet),
    });
    return { wiederholt: false, auftrag: auftragFuerAusfuehrer(uebernommen, auftrag.release, identitaet) };
  });
}

/** DEPLOYING → SUCCEEDED | FAILED | ROLLED_BACK. Idempotent für dieselbe Meldung. */
export async function auftragErgebnis(organizationId: string, eingabe: ReleaseErgebnis) {
  const umgebung = instanzUmgebung();
  const identitaet = laufendeIdentitaet();
  return prisma.$transaction(async (tx) => {
    const auftrag = await ladeUnterSperre(tx, organizationId, eingabe.auftragId);
    if (auftrag.executionKey !== eingabe.ausfuehrungsSchluessel) {
      throw new ConflictError('Dieser Auftrag wurde nicht mit diesem Ausführungsschlüssel übernommen.');
    }
    if (auftrag.status === eingabe.ergebnis) {
      return { wiederholt: true, auftrag: auftragFuerAusfuehrer(auftrag, auftrag.release, identitaet) };
    }
    if (auftrag.status !== 'DEPLOYING') {
      throw new ConflictError(`Für diesen Auftrag wurde bereits ${auftrag.status} gemeldet.`);
    }

    // Erfolg und Rücksprung belegt die antwortende Instanz selbst — und nur
    // eine Instanz der Umgebung, für die der Auftrag übernommen wurde; eine
    // Vorschau, die zufällig denselben Commit trägt, belegt die Produktion nicht.
    if (eingabe.ergebnis !== 'FAILED') {
      if (auftrag.environment !== umgebung) {
        throw new BusinessRuleError(`Der Auftrag gilt „${auftrag.environment ?? '—'}", diese Instanz ist „${umgebung}" — sie kann das Ergebnis nicht belegen.`);
      }
      const grund =
        eingabe.ergebnis === 'SUCCEEDED'
          ? zielNichtBelegt(auftrag, auftrag.release, identitaet)
          : ausgangNichtBelegt(auftrag, auftrag.release, identitaet);
      if (grund) {
        throw new BusinessRuleError(
          `„${ERGEBNISNAMEN[eingabe.ergebnis]}" ist nicht belegt: ${grund} Ein Scheitern (FAILED) wird immer angenommen.`,
        );
      }
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
      aktivierung: eingabe.aktivierung,
      beobachtet: beobachtet(identitaet),
      ruecksprungAuf: eingabe.ergebnis === 'ROLLED_BACK' ? auftrag.fromVersion : null,
      meldung: eingabe.meldung ?? null,
    });
    return { wiederholt: false, auftrag: auftragFuerAusfuehrer(fertig, auftrag.release, identitaet) };
  });
}

const ERGEBNISNAMEN = { SUCCEEDED: 'erfolgreich', FAILED: 'fehlgeschlagen', ROLLED_BACK: 'zurückgesetzt' } as const;

/** Nach dieser Zeit ohne Rückmeldung gilt eine Ausführung als verwaist. */
export const VERWAIST_NACH_MS = 2 * 60 * 60 * 1000;

/**
 * Verwaiste Ausführungen abschliessen — Teilaufgabe von `/api/cron/hourly`
 * (2026-09-30).
 *
 * **Das Loch, das hier zugeht.** Ein Ausführer, der nach der Übernahme
 * abbricht (Lauf abgebrochen, Runner weg, Meldung im Netz verloren), liess
 * den Auftrag für immer in DEPLOYING stehen. Das Update Center zeigte
 * „Wird installiert" ohne Ende, und weil DEPLOYING als offen zählt
 * (`release_requests_offen_einmal`), liess sich dieselbe Version nie wieder
 * freigeben; jede weitere Übernahme in der Umgebung scheiterte mit 409.
 *
 * **Wie abgeschlossen wird.** Nach zwei Stunden ohne Rückmeldung — weit über
 * der Laufzeit einer Aktivierung (der Workflow bricht nach 45 Minuten ab) —
 * fragt die Instanz ihre eigene Identität, mit derselben Regel wie die
 * Meldung „erfolgreich":
 *
 *  - belegt sie Commit und Version des Ziels, ist die Fassung nachweislich
 *    aktiv: SUCCEEDED, „durch die Identität der Instanz belegt, Rückmeldung
 *    fehlte";
 *  - sonst FAILED, „ohne Rückmeldung abgelaufen". Ein Rücksprung wird hier
 *    nie angenommen — ob die Ausgangsfassung durch einen Rücksprung oder
 *    durch eine nie begonnene Aktivierung läuft, lässt sich nachträglich
 *    nicht unterscheiden, und ROLLED_BACK behauptete Ersteres.
 *
 * Nur Aufträge der eigenen Umgebung (`CLENARIS_UMGEBUNG`): Die Identität
 * dieser Instanz sagt nichts über eine andere. Jeder Abschluss unter
 * Zeilensperre, mit erneuter Prüfung des Zustands — die Rückmeldung des
 * Ausführers kann zwischen Suche und Sperre eingetroffen sein und hat dann
 * Vorrang. Protokolliert ohne Benutzer, mit `abgeschlossenDurch`.
 */
export async function verwaisteAusfuehrungenAbschliessen(organizationId: string, optionen: { aelterAlsMs?: number } = {}) {
  const umgebung = process.env.CLENARIS_UMGEBUNG?.trim();
  if (!umgebung) return { umgebung: null, geprueft: 0, erfolgreich: 0, fehlgeschlagen: 0 };
  const grenze = new Date(Date.now() - (optionen.aelterAlsMs ?? VERWAIST_NACH_MS));
  const kandidaten = await prisma.releaseRequest.findMany({
    where: { organizationId, status: 'DEPLOYING', environment: umgebung, claimedAt: { lt: grenze } },
    select: { id: true },
    orderBy: { claimedAt: 'asc' },
  });
  const identitaet = laufendeIdentitaet();
  let erfolgreich = 0;
  let fehlgeschlagen = 0;

  for (const { id } of kandidaten) {
    const status = await prisma.$transaction(async (tx): Promise<ReleaseRequestStatus | null> => {
      const auftrag = await ladeUnterSperre(tx, organizationId, id);
      if (auftrag.status !== 'DEPLOYING' || !auftrag.claimedAt || auftrag.claimedAt >= grenze) return null;
      const grund = zielNichtBelegt(auftrag, auftrag.release, identitaet);
      const ergebnis: ReleaseRequestStatus = grund ? 'FAILED' : 'SUCCEEDED';
      const meldung = grund
        ? `Ohne Rückmeldung abgelaufen (seit ${auftrag.claimedAt.toISOString()} in Ausführung). ${grund}`
        : 'Durch die Identität der Instanz belegt, Rückmeldung fehlte.';
      const fertig = await tx.releaseRequest.update({
        where: { id: auftrag.id },
        data: { status: ergebnis, finishedAt: new Date(), resultMessage: meldung, rollbackVersion: null },
      });
      await protokolliere(
        tx,
        organizationId,
        fertig,
        `Version ${auftrag.toVersion}: Ausführung ${ERGEBNISNAMEN[ergebnis as 'SUCCEEDED' | 'FAILED']} ohne Rückmeldung (${auftrag.executorId})`,
        {
          status: { from: 'DEPLOYING', to: ergebnis },
          ausfuehrer: auftrag.executorId,
          abgeschlossenDurch: 'stuendlicher-lauf',
          uebernommenAm: auftrag.claimedAt.toISOString(),
          beobachtet: beobachtet(identitaet),
          meldung,
        },
      );
      return ergebnis;
    });
    if (status === 'SUCCEEDED') erfolgreich += 1;
    else if (status === 'FAILED') fehlgeschlagen += 1;
  }
  return { umgebung, geprueft: kandidaten.length, erfolgreich, fehlgeschlagen };
}
