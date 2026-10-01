import type { Release, ReleaseRequest } from '@prisma/client';

import { vergleicheVersionen } from '../version';

import { IDENTITAETS_NAMEN, type Identitaet } from './identitaet';
import { COMMIT_MUSTER } from './manifest';

/**
 * Die Regeln des Release-Ausführers gegen die Identität der Instanz — rein,
 * ohne Datenbank und ohne Prozesszustand (2026-10-01, aus
 * `release-ausfuehrung.service.ts` herausgelöst).
 *
 * ---------------------------------------------------------------------------
 *  Warum eine eigene Datei
 * ---------------------------------------------------------------------------
 *
 * Die zentrale Sicherheitsregel dieses Wegs lautet: **Solange die Instanz
 * ihren Stand nicht belegt, wird nichts ausgerollt, und weder „erfolgreich"
 * noch „zurückgesetzt" wird angenommen.** Bis hierher standen die drei
 * Prüfungen als private Funktionen im Dienst, und geprüft wurden sie nur über
 * HTTP — gegen den Prüfserver, der seinen Stand über das Prüfmanifest immer
 * belegt (`scripts/test-server.ts`). Der Zweig „nicht belegt" lief damit in
 * keiner einzigen Prüfung: Eine Änderung, die die Abfrage `!identitaet.belegt`
 * strich, wäre grün geblieben. Die Gegenprüfung vom 2026-09-30 hat genau das
 * festgehalten.
 *
 * Verworfen wurde eine zweite Instanz ohne Prüfmanifest nur für diese Fälle:
 * Sie kostet einen weiteren Serverstart in jeder Prüfreihe, hängt am
 * Startgerüst eines anderen Stroms (`laufzeit-konfiguration.test.ts`) und
 * deckte trotzdem nur einen der drei unbelegten Zustände ab. Als reine
 * Funktionen lassen sich alle vier Zustände direkt durchgehen
 * (`tests/api/release-identitaet.test.ts`), so wie `lib/bi/math.ts` die
 * Rechenkerne der Unternehmensführung ohne Server prüfbar macht.
 *
 * Die Funktionen nehmen nur die Felder, die sie lesen (`Pick<…>`): Eine
 * Prüfung muss keinen vollständigen Prisma-Datensatz erfinden, und eine neue
 * Spalte ändert hier nichts. Der Dienst gibt seine Datensätze unverändert
 * herein.
 *
 * **Die Abfrage `belegt` steht in jeder Regel zuerst und verlässt sich nicht
 * auf `commit === null`.** `identitaetLesen` gibt heute ohne Beleg keinen
 * Commit heraus — aber eine Regel, die nur deshalb ablehnt, weil `null` nicht
 * gleich dem Ziel ist, hinge an einem Nebeneffekt einer anderen Datei. Die
 * Prüfungen geben deshalb absichtlich unbelegte Identitäten herein, deren
 * Commit und Version **passen würden**: Nur die Abfrage `belegt` kann sie
 * dann noch abweisen.
 */

/** Was die Regeln vom Release lesen. */
export type ReleaseFuerRegeln = Pick<Release, 'version' | 'ciStatus' | 'commit' | 'artifactSha256'>;
/** Was die Regeln vom Auftrag lesen. */
export type AuftragFuerRegeln = Pick<ReleaseRequest, 'fromVersion' | 'toVersion'>;

/**
 * Warum ein fälliger Auftrag (noch) nicht ausgerollt werden darf — oder
 * `null`. Gilt für die Liste des Ausführers und für die Übernahme.
 */
export function hindernis(release: ReleaseFuerRegeln, identitaet: Identitaet): string | null {
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
export function zielNichtBelegt(auftrag: AuftragFuerRegeln, release: ReleaseFuerRegeln, identitaet: Identitaet): string | null {
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

/**
 * Belegt die Instanz den Ausgangsstand des Auftrags (Rücksprung)? `null`
 * heisst ja. Ein Rücksprung, nach dem das Ziel weiterläuft, ist keiner —
 * deshalb zuerst der Commit, dann die Version.
 */
export function ausgangNichtBelegt(auftrag: AuftragFuerRegeln, release: ReleaseFuerRegeln, identitaet: Identitaet): string | null {
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
