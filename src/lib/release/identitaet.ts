import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import paket from '../../../package.json';

import { artefaktManifestSchema, MANIFEST_FORMAT, type ArtefaktManifest } from './manifest';

/**
 * Die Identität einer laufenden Instanz (2026-09-30, Production-V2-Härtung).
 *
 * ---------------------------------------------------------------------------
 *  Was vorher galt, und warum es nicht reichte
 * ---------------------------------------------------------------------------
 *
 * Bis hierher nannte `/api/health` als „Version" den Wert von `APP_VERSION`,
 * den pm2 beim Umschalten setzte, und das Update Center nahm die Versions-
 * nummer aus `package.json` oder — für Prüfumgebungen — aus
 * `CLENARIS_VERSION`. Beides sind Behauptungen der Umgebung, nicht des
 * Artefakts: Wer das Verzeichnis eines Release A mit `APP_VERSION=<B>`
 * startete, bekam eine Instanz, die sich als B ausgab, und der Ausführer
 * meldete daraufhin „B erfolgreich installiert". Eine Rücksprungprüfung, die
 * auf diese Antwort baut, prüft nur, ob die Variable richtig gesetzt wurde.
 *
 * ---------------------------------------------------------------------------
 *  Was jetzt gilt
 * ---------------------------------------------------------------------------
 *
 * Die Instanz belegt ihren Stand aus **zwei Dateien, die mit dem Artefakt
 * reisen** und die keine Umgebungsvariable ersetzen kann:
 *
 *  - `RELEASE.json` (Format 2, `manifest.ts`) nennt Commit, Version und die
 *    `BUILD_ID` des Baus, aus dem das Artefakt gepackt wurde;
 *  - `<distDir>/BUILD_ID` ist die Kennung, die Next beim Bau zufällig
 *    vergibt und mit der die laufende Instanz ihre Seiten ausliefert.
 *
 * Belegt ist der Stand nur, wenn beide Dateien da sind, das Manifest den
 * Vertrag erfüllt, beide dieselbe Build-ID nennen, das Manifest dasselbe
 * Bauverzeichnis beschreibt, das die Instanz liest, und seine Version die
 * ist, die in den Code eingebaut wurde (`package.json` wird beim Bau in das
 * Bündel übernommen). Ein Manifest, das neben einen fremden Bau gelegt
 * wurde, scheitert an der Build-ID; eines, das von Hand umgeschrieben wurde,
 * an der Version oder am Vertrag.
 *
 * Vier Zustände, damit Vorprüfung, Gesundheitsprüfung und Release Center
 * dieselbe Sprache sprechen:
 *
 *  | Zustand            | Bedeutung                                                    |
 *  |--------------------|--------------------------------------------------------------|
 *  | `belegt`           | Manifest und Bau passen zusammen — Commit und Version gelten |
 *  | `ohne-manifest`    | kein `RELEASE.json`: Entwicklung, Prüfbau ohne Manifest, Altstand |
 *  | `widerspruechlich` | gültiges Manifest, aber nicht für diesen Bau                 |
 *  | `ungueltig`        | Manifest unlesbar, Format 1 oder fremd                       |
 *
 * Ohne Beleg ist die Version die in den Code eingebaute (`package.json`) —
 * sie beschreibt, was der Code von sich sagt, und bleibt für die Anzeige
 * brauchbar —, der Commit aber `null`: Einen Commit, den nichts belegt, gibt
 * diese Datei nicht heraus.
 *
 * **Kein `server-only`.** Die Produktionsvorprüfung und der Release-Ausführer
 * sind Skripte ausserhalb von Next und lesen mit derselben Funktion; zwei
 * Umsetzungen derselben Regel liefen beim ersten Unterschied auseinander.
 * Die Datei liest nur Dateien und gibt nichts aus der Umgebung preis.
 */

export type IdentitaetsZustand = 'belegt' | 'ohne-manifest' | 'widerspruechlich' | 'ungueltig';

export const IDENTITAETS_ZUSTAENDE: readonly IdentitaetsZustand[] = ['belegt', 'ohne-manifest', 'widerspruechlich', 'ungueltig'];

/** Zustände in Worten — für die Sicherheitszentrale und die Vorprüfung. */
export const IDENTITAETS_NAMEN: Record<IdentitaetsZustand, string> = {
  belegt: 'belegt',
  'ohne-manifest': 'ohne RELEASE.json',
  widerspruechlich: 'widersprüchlich',
  ungueltig: 'Manifest ungültig',
};

export interface Identitaet {
  /** Nur `true`, wenn Manifest und Bau zusammenpassen — die einzige Grundlage für „läuft Commit X". */
  belegt: boolean;
  zustand: IdentitaetsZustand;
  /** Semantische Version: aus dem Manifest, wenn belegt; sonst die in den Code eingebaute. */
  version: string;
  /** Nur wenn belegt. Ein unbelegter Commit wäre eine Behauptung. */
  commit: string | null;
  /**
   * Die `BUILD_ID` im Bauverzeichnis der Instanz — in jedem Zustand, sofern
   * lesbar. Sie ist eine Tatsache über den Bau, keine Behauptung des
   * Manifests, und hilft gerade im Zustand `widerspruechlich` beim Suchen.
   */
  buildId: string | null;
  /**
   * Warum der Stand nicht belegt ist, in deutschen Worten — `null`, wenn er
   * es ist. Nennt Dateinamen und Build-IDs, nie Pfade oder Werte aus der
   * Umgebung; `/api/health` gibt ihn trotzdem nicht heraus (unangemeldet).
   */
  grund: string | null;
  /**
   * Das Manifest, wenn es den Vertrag erfüllt — auch wenn es nicht zum Bau
   * passt. Die Vorprüfung braucht daraus `auslieferbar`; nach aussen geht es
   * nie als Ganzes.
   */
  manifest: ArtefaktManifest | null;
}

export interface IdentitaetsQuelle {
  /** Verzeichnis der Instanz — dort liegen `RELEASE.json` und das Bauverzeichnis. */
  verzeichnis: string;
  /** Bauverzeichnis relativ zu `verzeichnis`; Vorgabe wie `next.config.ts` (`NEXT_DIST_DIR`, sonst `.next`). */
  distDir?: string;
  /** Umgebung für Bauverzeichnis und Prüfschalter; Vorgabe `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * Was eine Build-ID von Next enthalten kann. Alles andere gilt als „nicht
 * lesbar" — die Kennung geht über den unangemeldeten Gesundheitsendpunkt
 * hinaus, und eine Datei mit beliebigem Inhalt soll dort nicht erscheinen.
 */
const BUILD_ID_MUSTER = /^[A-Za-z0-9._-]{1,200}$/;

function buildIdLesen(pfad: string): string | null {
  try {
    if (!existsSync(pfad)) return null;
    const wert = readFileSync(pfad, 'utf8').trim();
    return BUILD_ID_MUSTER.test(wert) ? wert : null;
  } catch {
    return null;
  }
}

/**
 * Warum ein Manifest den Vertrag nicht erfüllt — die häufigen Fälle beim
 * Namen, damit die Vorprüfung „Format 1" sagt statt „format: Invalid literal".
 */
function vertragsgrund(roh: unknown, name: string, erstesProblem: string): string {
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) return `${name} ist kein Objekt.`;
  const r = roh as { format?: unknown; anwendung?: unknown };
  if (r.format !== MANIFEST_FORMAT) {
    return `${name} hat Format ${typeof r.format === 'number' ? r.format : 'ohne Angabe'} — verlangt ist Format ${MANIFEST_FORMAT}.`;
  }
  if (r.anwendung !== 'clenaris') return `${name} beschreibt keine Clenaris-Fassung.`;
  return `${name} erfüllt den Vertrag nicht (${erstesProblem}).`;
}

/**
 * Die Identität aus einem Verzeichnis lesen — rein bis auf das Lesen der
 * zwei Dateien, ohne Zwischenspeicher. Prüfungen und Skripte rufen sie mit
 * ausdrücklichen Verzeichnissen auf; die laufende Instanz über
 * `laufendeIdentitaet()`.
 *
 * **Prüfschalter.** `CLENARIS_PRUEF_RELEASE_MANIFEST` (Pfad zu einem Manifest)
 * ersetzt `RELEASE.json` **nur**, wenn `CLENARIS_UMGEBUNG` genau `test` ist:
 * Der Prüfserver hat kein gepacktes Artefakt, soll aber den Release-Vertrag
 * prüfbar machen (`scripts/test-server.ts`). In jeder anderen Umgebung wird
 * die Variable nicht beachtet — sonst könnte eine gesetzte Variable der
 * Instanz eine Identität geben, die ihr Artefakt nicht trägt, genau die
 * Lücke, die hier geschlossen wird. Die Produktionsvorprüfung weist sie
 * zusätzlich als Fehler aus. Auch das Prüfmanifest muss zum Bau passen: Die
 * Build-ID ist die echte, nur Commit und Herkunft sind festgelegt.
 */
export function identitaetLesen(quelle: IdentitaetsQuelle): Identitaet {
  const env = quelle.env ?? process.env;
  const distDir = quelle.distDir ?? (env.NEXT_DIST_DIR?.trim() || '.next');
  const codeVersion = paket.version;
  const buildId = buildIdLesen(join(quelle.verzeichnis, distDir, 'BUILD_ID'));

  const unbelegt = (
    zustand: Exclude<IdentitaetsZustand, 'belegt'>,
    grund: string,
    manifest: ArtefaktManifest | null = null,
  ): Identitaet => ({ belegt: false, zustand, version: codeVersion, commit: null, buildId, grund, manifest });

  const pruefManifest = env.CLENARIS_PRUEF_RELEASE_MANIFEST?.trim();
  const pruefGilt = Boolean(pruefManifest) && env.CLENARIS_UMGEBUNG?.trim() === 'test';
  const pfad = pruefGilt ? resolve(quelle.verzeichnis, pruefManifest!) : join(quelle.verzeichnis, 'RELEASE.json');
  const name = pruefGilt ? 'Das Prüfmanifest' : 'RELEASE.json';

  if (!existsSync(pfad)) {
    // Ein ausdrücklich genanntes Prüfmanifest, das fehlt, ist eine kaputte
    // Prüfumgebung — kein „Stand ohne Artefakt" wie in der Entwicklung.
    return pruefGilt
      ? unbelegt('ungueltig', 'Das Prüfmanifest (CLENARIS_PRUEF_RELEASE_MANIFEST) fehlt.')
      : unbelegt('ohne-manifest', 'Kein RELEASE.json im Verzeichnis der Instanz — der Stand stammt aus keinem geprüften Artefakt.');
  }

  let roh: unknown;
  try {
    roh = JSON.parse(readFileSync(pfad, 'utf8'));
  } catch {
    return unbelegt('ungueltig', `${name} ist nicht lesbar oder kein JSON.`);
  }
  const geprueft = artefaktManifestSchema.safeParse(roh);
  if (!geprueft.success) {
    const problem = geprueft.error.issues[0];
    return unbelegt('ungueltig', vertragsgrund(roh, name, problem ? `${problem.path.join('.') || 'Wurzel'}: ${problem.message}` : 'unbekannt'));
  }
  const manifest = geprueft.data;

  if (manifest.distDir !== distDir) {
    return unbelegt('widerspruechlich', `${name} beschreibt den Bau in ${manifest.distDir}, die Instanz liest ${distDir}.`, manifest);
  }
  if (!buildId) {
    return unbelegt('widerspruechlich', `${name} nennt Build ${manifest.buildId}, aber ${distDir}/BUILD_ID fehlt oder ist nicht lesbar.`, manifest);
  }
  if (manifest.buildId !== buildId) {
    return unbelegt(
      'widerspruechlich',
      `BUILD_ID des Baus (${buildId}) weicht von ${name} (${manifest.buildId}) ab — das Manifest gehört zu einem anderen Bau.`,
      manifest,
    );
  }
  if (manifest.version !== codeVersion) {
    return unbelegt('widerspruechlich', `${name} nennt Version ${manifest.version}, der Code wurde als ${codeVersion} gebaut.`, manifest);
  }

  return { belegt: true, zustand: 'belegt', version: manifest.version, commit: manifest.commit, buildId, grund: null, manifest };
}

let laufende: Identitaet | null = null;

/**
 * Die Identität dieses Prozesses — einmal gelesen, dann gemerkt.
 *
 * Einmal genügt, und es ist richtig so: Ein Release-Verzeichnis ändert sich
 * nach dem Entpacken nicht, und eine neue Fassung läuft in einem neuen
 * Prozess aus einem neuen Verzeichnis (`deploy/v2/release-aktivieren.sh`).
 * Das Arbeitsverzeichnis eines Prozesses bleibt das, in dem er gestartet
 * wurde, auch wenn der Verweis `current` inzwischen auf die nächste Fassung
 * zeigt — die alte Instanz meldet also bis zuletzt ihren eigenen Stand.
 * Ohne Zwischenspeicher läse jeder Aufruf des Gesundheitsendpunkts (die
 * Überwachung fragt minütlich, die Aktivierung sekündlich) zwei Dateien.
 */
export function laufendeIdentitaet(): Identitaet {
  laufende ??= identitaetLesen({ verzeichnis: process.cwd() });
  return laufende;
}

/**
 * Die Angaben, die nach aussen gehen dürfen — ohne Grund und ohne Manifest.
 * Eine Stelle für Gesundheitsendpunkt und Ausführerschnittstelle, damit
 * keine von beiden aus Versehen das ganze Objekt ausgibt.
 */
export function identitaetsAngaben(i: Identitaet) {
  return { belegt: i.belegt, zustand: i.zustand, version: i.version, commit: i.commit, buildId: i.buildId };
}
