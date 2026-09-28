import paket from '../../package.json';

/**
 * Die laufende Clenaris-Version und der Vergleich zweier Versionen.
 *
 * **Quelle ist `package.json`.** Sie wird beim Bau in das Bündel übernommen,
 * steht also im selben Artefakt wie der Code, dessen Version sie nennt. Eine
 * Umgebungsvariable als einzige Quelle hätte den Nachteil, dass ein
 * vergessener Eintrag nach einem Update weiterhin die alte Version meldet —
 * und das Update Center dann eine längst installierte Version als „verfügbar"
 * anböte. `APP_VERSION` (vom Deployment gesetzt) ist ein Commit-Hash und
 * keine Versionsnummer; sie beantwortet eine andere Frage und bleibt, wo sie
 * ist (`/api/health`).
 *
 * `CLENARIS_VERSION` darf den Wert überschreiben — für eine Prüfumgebung, die
 * „eine ältere Installation" darstellen soll. Nur eine gültige semantische
 * Version wird angenommen; alles andere fällt still auf `package.json` zurück,
 * statt die Anzeige mit einem Tippfehler zu füllen.
 */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

export function aktuelleVersion(): string {
  const ueberschrieben = process.env.CLENARIS_VERSION?.trim().replace(/^v/, '');
  if (ueberschrieben && SEMVER.test(ueberschrieben)) return ueberschrieben;
  return paket.version;
}

export function istGueltigeVersion(version: string): boolean {
  return SEMVER.test(version);
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
  const ta = SEMVER.exec(a);
  const tb = SEMVER.exec(b);
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
