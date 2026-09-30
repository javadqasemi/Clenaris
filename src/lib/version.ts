import { laufendeIdentitaet } from './release/identitaet';
import { SEMVER_MUSTER } from './release/manifest';

/**
 * Die laufende Clenaris-Version und der Vergleich zweier Versionen.
 *
 * **Quelle ist die Identität der Instanz** (`release/identitaet.ts`, seit
 * 2026-09-30): Ist der Stand durch `RELEASE.json` und `BUILD_ID` belegt, ist
 * es die Version des Artefakts; sonst die beim Bau in das Bündel übernommene
 * aus `package.json`. Beide stehen im selben Artefakt wie der Code, dessen
 * Version sie nennen — eine Umgebungsvariable als Quelle hätte den Nachteil,
 * dass ein vergessener Eintrag nach einem Update weiterhin die alte Version
 * meldet und das Update Center eine längst installierte Version als
 * „verfügbar" anböte.
 *
 * **`CLENARIS_VERSION` gibt es nicht mehr.** Bis 2026-09-30 durfte sie den
 * Wert überschreiben, damit eine Prüfumgebung „eine ältere Installation"
 * darstellen konnte. Damit konnte aber auch jede Instanz eine Version
 * behaupten, die sie nicht ist — und genau auf diese Antwort baut der
 * Release-Ausführer, wenn er „erfolgreich" meldet. Die Prüfreihe stellt
 * ihren Stand seither über ein Prüfmanifest dar, das nur in der Umgebung
 * `test` wirkt und zum echten Bau passen muss (`scripts/test-server.ts`).
 */
export function aktuelleVersion(): string {
  return laufendeIdentitaet().version;
}

export function istGueltigeVersion(version: string): boolean {
  return SEMVER_MUSTER.test(version);
}

/**
 * Vergleich zweier Versionen: negativ, null oder positiv wie bei `sort`.
 *
 * Vorabversionen (`1.2.0-rc.1`) liegen vor der Endfassung derselben Nummer,
 * untereinander wird der Zusatz lexikalisch verglichen — genug für die
 * Frage „ist das neuer als das, was läuft", ohne eine ganze
 * SemVer-Bibliothek für drei Zahlen und einen Zusatz.
 */
export function vergleicheVersionen(a: string, b: string): number {
  const ta = SEMVER_MUSTER.exec(a);
  const tb = SEMVER_MUSTER.exec(b);
  if (!ta || !tb) return a.localeCompare(b);
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(ta[i]) - Number(tb[i]);
    if (d !== 0) return d;
  }
  const za = a.split('-').slice(1).join('-');
  const zb = b.split('-').slice(1).join('-');
  if (za === zb) return 0;
  if (!za) return 1;
  if (!zb) return -1;
  return za.localeCompare(zb);
}
