import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { artefaktManifestSchema, auslieferbarNach, type ArtefaktManifest } from '../../src/lib/release/manifest';

/**
 * Umschalten mit Identitätsprüfung — der gemeinsame Kern von Aktivierung
 * (`deploy/v2/release-aktivieren.sh` über `scripts/release-umschalten.ts`) und
 * Rücksprung (`scripts/release-ruecksprung.ts`), 2026-09-30.
 *
 * ---------------------------------------------------------------------------
 *  Warum das nicht mehr in Bash steht
 * ---------------------------------------------------------------------------
 *
 * Bis hierher schaltete `release-aktivieren.sh` selbst um: Verweis setzen,
 * `pm2 startOrReload`, dreissigmal `curl` auf `/api/health`, bei Misserfolg
 * Verweis zurück — und dann **nichts mehr**. Ob die alte Fassung nach dem
 * Zurückschalten wieder lief, prüfte niemand; das Skript meldete
 * „Aktivierung fehlgeschlagen", und ein Server ohne laufende Anwendung sah im
 * Protokoll genauso aus wie ein sauberer Rücksprung. Dazu kam die Prüfung
 * selbst: gesucht wurde die Zeichenkette `"version":"<commit>"` im Rumpf, und
 * `version` kam aus `APP_VERSION`, das dieselbe Zeile unmittelbar davor an
 * pm2 übergab. Die Prüfung bestätigte also, was sie selbst gesetzt hatte — ein
 * Artefakt A, das mit `APP_VERSION=B` startete, war für sie B.
 *
 * Dieses Modul ersetzt beides: Die Identität kommt aus den Dateien des
 * laufenden Release (`RELEASE.json` und `.next/BUILD_ID`, gelesen von der
 * Instanz selbst, Vertrag C2), verglichen wird Commit **und** Build-ID **und**
 * der Zustand `belegt`; und nach dem Zurückschalten wird die vorherige Fassung
 * genauso geprüft wie die neue. Drei Ausgänge, und jeder sagt, was tatsächlich
 * läuft: 0 die neue Fassung, 20 nachweislich wieder die alte, 30 unklar.
 *
 * **Warum TypeScript mit eingespritzten Befehlen statt Bash:** Die Regeln
 * dieses Wegs sind genau die, die im Ernstfall zählen, und in Bash sind sie
 * auf dem Entwicklungsrechner (Windows) gar nicht prüfbar. Hier stehen sie
 * rein, und `tests/api/release-ruecksprung.test.ts` fährt sie mit
 * Attrappen für Verweis, pm2 und Gesundheit durch — ohne Server, ohne pm2,
 * ohne Bash. Die echten Befehle stehen dünn in `scripts/release-umschalten.ts`.
 */

// ---------------------------------------------------------------------------
//  Identität
// ---------------------------------------------------------------------------

/** Was eine Instanz eindeutig bestimmt: Quellstand und der Bau daraus. */
export interface Identitaet {
  commit: string;
  buildId: string;
}

/**
 * Was `/api/health` über die laufende Instanz sagt (Vertrag C2). `null` je
 * Feld, wenn die Antwort es nicht enthält — nie ein Ersatzwert, sonst stimmte
 * ein fehlendes Feld zufällig mit einem erwarteten leeren Wert überein.
 */
export interface Gesundheit {
  version: string | null;
  buildId: string | null;
  identitaet: string | null;
}

export type ReleaseLesung =
  | { ok: true; identitaet: Identitaet; manifest: ArtefaktManifest }
  | { ok: false; grund: string };

/**
 * Nur schlichte Verzeichnisnamen: `distDir` stammt aus einer Datei im Archiv,
 * und ein `../..` darin liesse diese Prüfung eine `BUILD_ID` ausserhalb des
 * Release lesen — also eine, die mit dem Archiv nichts zu tun hat.
 */
const VERZEICHNISNAME = /^\.?[A-Za-z0-9_-]{1,60}$/;

/**
 * Die Identität eines entpackten Release aus seinen eigenen Dateien lesen.
 *
 * Streng gegen das Schema aus `src/lib/release/manifest.ts` — dieselbe Form,
 * die die Instanz beim Start liest. Eine eigene, nachsichtigere Lesart hier
 * hiesse: Die Umschaltung erwartet eine Identität, die die Instanz danach gar
 * nicht als `belegt` meldet, und jede Aktivierung liefe in den Rücksprung.
 *
 * `BUILD_ID` muss zur Build-ID im Manifest passen. Das Manifest wird beim
 * Packen aus genau dieser Datei geschrieben; weichen beide ab, ist entweder
 * das Archiv nicht das gepackte oder der Baum danach verändert worden.
 */
export function releaseIdentitaetLesen(verzeichnis: string): ReleaseLesung {
  const manifestDatei = join(verzeichnis, 'RELEASE.json');
  if (!existsSync(manifestDatei)) return { ok: false, grund: `RELEASE.json fehlt in ${verzeichnis}.` };
  let roh: unknown;
  try {
    roh = JSON.parse(readFileSync(manifestDatei, 'utf8'));
  } catch {
    return { ok: false, grund: `RELEASE.json in ${verzeichnis} ist kein gültiges JSON.` };
  }
  const geprueft = artefaktManifestSchema.safeParse(roh);
  if (!geprueft.success) {
    const felder = geprueft.error.issues.map((i) => i.path.join('.') || '(Wurzel)').join(', ');
    return { ok: false, grund: `RELEASE.json in ${verzeichnis} entspricht nicht Format 2 (Felder: ${felder}).` };
  }
  const manifest = geprueft.data;
  if (!VERZEICHNISNAME.test(manifest.distDir)) {
    return { ok: false, grund: `distDir „${manifest.distDir}" ist kein schlichter Verzeichnisname.` };
  }
  const buildIdDatei = join(verzeichnis, manifest.distDir, 'BUILD_ID');
  if (!existsSync(buildIdDatei)) return { ok: false, grund: `${manifest.distDir}/BUILD_ID fehlt in ${verzeichnis}.` };
  const buildId = readFileSync(buildIdDatei, 'utf8').trim();
  if (buildId !== manifest.buildId) {
    return { ok: false, grund: `${manifest.distDir}/BUILD_ID (${buildId}) ist nicht die Build-ID im Manifest (${manifest.buildId}).` };
  }
  return { ok: true, identitaet: { commit: manifest.commit, buildId }, manifest };
}

/**
 * Darf dieses Manifest laufen? `auslieferbar` allein genügt nicht: Das Feld
 * steht in einer Datei, und die Regel dahinter (`auslieferbarNach`) muss es
 * bestätigen. Ein Manifest, das `true` sagt, obwohl es aus einem
 * Pull-Request-Lauf stammt, ist in sich widersprüchlich — und wird hier wie
 * eine Probe behandelt.
 */
export function auslieferbarBelegt(manifest: ArtefaktManifest): boolean {
  return manifest.auslieferbar === true && auslieferbarNach(manifest);
}

/**
 * Die Antwort von `/api/health` lesen. Nur ein 200 zählt: 503 heisst
 * „Datenbank nicht erreichbar", und eine Instanz ohne Datenbank ist nicht
 * gesund, auch wenn sie den richtigen Commit nennt.
 */
export function gesundheitAuswerten(status: number, text: string): Gesundheit | null {
  if (status !== 200) return null;
  let rumpf: unknown;
  try {
    rumpf = JSON.parse(text);
  } catch {
    return null;
  }
  const daten = (rumpf as { data?: unknown } | null)?.data;
  if (!daten || typeof daten !== 'object') return null;
  const feld = (name: string) => {
    const wert = (daten as Record<string, unknown>)[name];
    return typeof wert === 'string' ? wert : null;
  };
  return { version: feld('version'), buildId: feld('buildId'), identitaet: feld('identitaet') };
}

/**
 * Die eine Regel, an der Aktivierung, Rücksprung und beide Workflows ihren
 * Erfolg messen: Commit, Build-ID und `belegt`. Der Commit allein genügt
 * nicht — zwei Bauten desselben Commits (etwa ein örtlicher und der aus der
 * CI) haben verschiedene Build-IDs, und nur einer davon ist geprüft worden.
 */
export function identitaetStimmt(g: Gesundheit | null, erwartet: Identitaet): boolean {
  return g !== null && g.identitaet === 'belegt' && g.version === erwartet.commit && g.buildId === erwartet.buildId;
}

// ---------------------------------------------------------------------------
//  Befehle — was die Umschaltung auf dem Server tut
// ---------------------------------------------------------------------------

/**
 * Alles, was die Umschaltung an der Welt ändert oder aus ihr liest. Die
 * echten Befehle stehen in `scripts/release-umschalten.ts`; die Prüfreihe
 * spritzt Attrappen ein.
 */
export interface Befehle {
  /** Wohin `<basis>/current` zeigt — absolut; `null`, wenn es keinen Verweis gibt. */
  verweisLesen(basis: string): string | null;
  /**
   * `<basis>/current` auf `ziel` setzen — atomar: neuer Verweis daneben, dann
   * `rename` darüber. Ein `ln -sfn` löscht und legt neu an; dazwischen gibt
   * es für einen Augenblick gar kein `current`, und ein Neustart von pm2 in
   * diesem Augenblick fände nichts.
   */
  verweisSetzen(basis: string, ziel: string): void;
  /** Die Anwendung aus `verzeichnis` (neu) laden. `false`, wenn pm2 scheiterte. */
  pm2Neuladen(verzeichnis: string): Promise<boolean>;
  /** Die laufende Prozessliste für einen Neustart des Servers festhalten (`pm2 save`). */
  pm2Sichern(): Promise<boolean>;
  /** `/api/health` der Instanz auf `port` — `null`, wenn keine brauchbare Antwort kam. */
  gesundheit(port: number): Promise<Gesundheit | null>;
  schlafen(ms: number): Promise<void>;
  protokoll(zeile: string): void;
}

export type Umschaltcode = 0 | 10 | 20 | 30;
export type Umschaltzustand = 'AKTIV' | 'NICHT_UMGESCHALTET' | 'ZURUECK' | 'UNKLAR';

/** Code und Zustand gehören zusammen (Vertrag C3) — eine Tabelle, nicht vier `if`. */
export const ZUSTAND_JE_CODE: Readonly<Record<Umschaltcode, Umschaltzustand>> = {
  0: 'AKTIV',
  10: 'NICHT_UMGESCHALTET',
  20: 'ZURUECK',
  30: 'UNKLAR',
};

export interface Umschaltergebnis {
  code: Umschaltcode;
  zustand: Umschaltzustand;
  /** Worauf `current` vorher zeigte. */
  vorher: string | null;
  /** Worauf `current` danach zeigt, soweit bekannt. */
  jetzt: string | null;
  meldung: string;
}

export interface Umschaltauftrag {
  basis: string;
  ziel: string;
  erwartet: Identitaet;
  port: number;
  /** Wie oft `/api/health` höchstens gefragt wird, je Richtung. */
  versuche: number;
  /** Pause zwischen zwei Fragen. */
  abstandMs?: number;
  /**
   * Wie viele Antworten **in Folge** die Identität bestätigen müssen. Mehr als
   * eine, weil pm2 im Cluster-Modus mehrere Arbeiter betreibt und die
   * Anfragen verteilt: Ist einer davon noch der alte (Neuladen halb
   * gescheitert), träfe eine einzelne Frage mit etwas Glück den neuen.
   */
  treffer?: number;
}

const gleicherPfad = (a: string | null, b: string | null) => a !== null && b !== null && resolve(a) === resolve(b);

function ergebnis(code: Umschaltcode, vorher: string | null, jetzt: string | null, meldung: string): Umschaltergebnis {
  return { code, zustand: ZUSTAND_JE_CODE[code], vorher, jetzt, meldung };
}

/**
 * `/api/health` so lange fragen, bis `treffer` Antworten in Folge die
 * erwartete Identität nennen — oder die Versuche aufgebraucht sind. Die
 * letzte Beobachtung kommt ins Protokoll: „nicht gesund" allein sagt nicht,
 * ob die Instanz schwieg, die alte Fassung meldete oder `widerspruechlich`.
 */
async function bestaetigen(
  b: Befehle,
  port: number,
  erwartet: Identitaet,
  versuche: number,
  abstandMs: number,
  treffer: number,
): Promise<boolean> {
  let folge = 0;
  let zuletzt: Gesundheit | null = null;
  for (let versuch = 1; versuch <= versuche; versuch++) {
    zuletzt = await b.gesundheit(port);
    if (identitaetStimmt(zuletzt, erwartet)) {
      folge++;
      if (folge >= treffer) return true;
      continue;
    }
    folge = 0;
    if (versuch < versuche) await b.schlafen(abstandMs);
  }
  b.protokoll(
    zuletzt
      ? `Zuletzt gemeldet: version=${zuletzt.version ?? '–'} buildId=${zuletzt.buildId ?? '–'} identitaet=${zuletzt.identitaet ?? '–'} ` +
          `(erwartet ${erwartet.commit.slice(0, 12)} / ${erwartet.buildId}).`
      : 'Zuletzt: keine brauchbare Antwort von /api/health.',
  );
  return false;
}

/**
 * Umschalten, prüfen, notfalls zurück — und auch das Zurück prüfen.
 *
 *   0   die neue Fassung läuft, Identität bestätigt, pm2-Liste gesichert
 *   10  nicht umgeschaltet: Der Verweis liess sich nicht setzen und zeigt
 *       unverändert auf das Vorherige
 *   20  umgeschaltet, neue Fassung nicht bestätigt, **vorherige nachweislich
 *       wieder aktiv** (Identität bestätigt), pm2-Liste gesichert
 *   30  alles andere: kein vorheriges Release, Zurückschalten gescheitert oder
 *       die vorherige Fassung meldet sich nicht mit ihrer Identität
 *
 * `pm2 save` nur nach einer bestätigten Identität. Die gesicherte Liste ist,
 * was pm2 nach einem Neustart des Servers startet; eine Liste aus einem
 * ungeklärten Zustand zu sichern hiesse, den ungeklärten Zustand über den
 * Neustart hinaus festzuschreiben. Gesichert wird an genau dieser einen
 * Stelle — Aktivierung und Rücksprung laufen beide hier durch, also gilt für
 * beide dieselbe Regel, und kein Aufrufer muss sie wiederholen.
 */
export async function umschaltenMitPruefung(auftrag: Umschaltauftrag, b: Befehle): Promise<Umschaltergebnis> {
  const abstand = auftrag.abstandMs ?? 2000;
  const treffer = Math.max(1, auftrag.treffer ?? 3);
  const vorher = b.verweisLesen(auftrag.basis);

  try {
    b.verweisSetzen(auftrag.basis, auftrag.ziel);
  } catch (fehler) {
    const jetzt = b.verweisLesen(auftrag.basis);
    const grund = fehler instanceof Error ? fehler.message : String(fehler);
    if (gleicherPfad(jetzt, vorher) || (jetzt === null && vorher === null)) {
      b.protokoll(`Verweis nicht gesetzt (${grund}) — current unverändert.`);
      return ergebnis(10, vorher, jetzt, `Verweis nicht gesetzt: ${grund}`);
    }
    // Gescheitert gemeldet, aber doch umgestellt (oder halb): wie ein
    // gescheiterter Start behandeln, also prüfen und notfalls zurück.
    b.protokoll(`Verweis meldete einen Fehler (${grund}), zeigt aber nicht mehr aufs Vorherige — weiter mit Prüfung.`);
  }
  b.protokoll(`Umgeschaltet   : current → ${auftrag.ziel}`);

  const geladen = await b.pm2Neuladen(auftrag.ziel);
  if (!geladen) b.protokoll('pm2 hat die neue Fassung nicht geladen.');
  const neuGesund = geladen && (await bestaetigen(b, auftrag.port, auftrag.erwartet, auftrag.versuche, abstand, treffer));

  if (neuGesund) {
    const gesichert = await b.pm2Sichern();
    if (!gesichert) {
      // Kein Grund, eine bestätigte Umschaltung als gescheitert zu melden —
      // aber ein Grund, es laut zu sagen: Nach einem Neustart des Servers
      // startete pm2 sonst die alte Liste.
      b.protokoll('WARNUNG: pm2 save ist gescheitert — nach einem Neustart des Servers von Hand `pm2 save` nachholen.');
    }
    b.protokoll(`Aktiv          : ${auftrag.erwartet.commit} (Build ${auftrag.erwartet.buildId}), Identität bestätigt.`);
    return ergebnis(0, vorher, auftrag.ziel, 'Neue Fassung aktiv, Identität bestätigt.');
  }

  if (!vorher || gleicherPfad(vorher, auftrag.ziel)) {
    return ergebnis(30, vorher, auftrag.ziel, 'Neue Fassung nicht bestätigt, und es gibt kein vorheriges Release, auf das zurückgeschaltet werden könnte.');
  }

  // --- Zurück ---------------------------------------------------------------
  const alt = releaseIdentitaetLesen(vorher);
  b.protokoll(`Rücksprung     : current → ${vorher}`);
  try {
    b.verweisSetzen(auftrag.basis, vorher);
  } catch (fehler) {
    const grund = fehler instanceof Error ? fehler.message : String(fehler);
    return ergebnis(30, vorher, b.verweisLesen(auftrag.basis), `Zurückschalten gescheitert: ${grund}`);
  }
  const zurueckGeladen = await b.pm2Neuladen(vorher);
  if (!alt.ok) {
    // Die alte Fassung läuft womöglich — belegen lässt es sich nicht. Ein
    // Rücksprung, der nur „vermutlich" gelungen ist, heisst UNKLAR.
    return ergebnis(30, vorher, vorher, `Zurückgeschaltet, aber die vorherige Fassung hat keine belegbare Identität: ${alt.grund}`);
  }
  const altGesund =
    zurueckGeladen && (await bestaetigen(b, auftrag.port, alt.identitaet, auftrag.versuche, abstand, treffer));
  if (!altGesund) {
    return ergebnis(30, vorher, vorher, 'Zurückgeschaltet, aber auch die vorherige Fassung bestätigt ihre Identität nicht.');
  }
  const gesichert = await b.pm2Sichern();
  if (!gesichert) b.protokoll('WARNUNG: pm2 save ist gescheitert — nach einem Neustart des Servers von Hand `pm2 save` nachholen.');
  b.protokoll(`Wieder aktiv   : ${alt.identitaet.commit} (Build ${alt.identitaet.buildId}), Identität bestätigt.`);
  return ergebnis(20, vorher, vorher, 'Neue Fassung nicht bestätigt; die vorherige läuft nachweislich wieder.');
}

export type Aktivlage = 'aktiv' | 'nicht-aktiv' | 'aktiv-unbestaetigt' | 'anderer-bau';

/**
 * Ist `ziel` schon das laufende Release, und bestätigt die Instanz das?
 *
 * Für die Wiederholung einer Aktivierung (derselbe Lauf noch einmal, etwa
 * nach einem Netzabbruch): Läuft das Release bereits nachweislich, ist die
 * zweite Aktivierung ohne Wirkung und endet mit 0. Läuft es angeblich, meldet
 * sich aber nicht mit seiner Identität, wird **nichts** getan — ein Neustart
 * derselben Fassung verdeckte nur, dass sie krank ist.
 *
 * **Derselbe Commit, ein anderer Bau** (`anderer-bau`) ist ein eigener Fall,
 * und er wird zuerst entschieden. Next vergibt die Build-ID je Bau zufällig;
 * ein von Hand ausgelöster Lauf auf `main` baut also den Commit, der schon
 * läuft, mit einer neuen Build-ID. Bis 2026-10-01 fragte diese Prüfung dann
 * nur die Gesundheit nach der **neuen** Build-ID, bekam die alte, und die
 * Aktivierung meldete „bestätigt seine Identität nicht" — über eine gesunde
 * Instanz. Die Diagnose führte zu `pm2 logs` statt zur Ursache. Gelesen wird
 * deshalb zuerst, was unter `current` liegt: Nennt es denselben Commit mit
 * einer anderen Build-ID, ist die Antwort ohne eine einzige Frage an die
 * Instanz klar — umgeschaltet wird nicht, denn `releases/<commit>` ist das
 * Verzeichnis, aus dem die laufende Instanz liest, und es unter ihr zu
 * ersetzen wäre kein Umschalten, sondern ein Eingriff in den laufenden
 * Betrieb ohne Rückweg. Die Identität der Instanz stammt aus genau diesen
 * Dateien (Vertrag C2); die Dateien zu lesen ist also dieselbe Frage, nur
 * ohne Netz.
 */
export async function aktivPruefen(
  auftrag: { basis: string; ziel: string; erwartet: Identitaet; port: number; versuche?: number; abstandMs?: number; treffer?: number },
  b: Befehle,
): Promise<Aktivlage> {
  if (!gleicherPfad(b.verweisLesen(auftrag.basis), auftrag.ziel)) return 'nicht-aktiv';
  const vorhanden = releaseIdentitaetLesen(auftrag.ziel);
  if (vorhanden.ok && vorhanden.identitaet.commit === auftrag.erwartet.commit && vorhanden.identitaet.buildId !== auftrag.erwartet.buildId) {
    b.protokoll(
      `current zeigt bereits auf ${vorhanden.identitaet.commit.slice(0, 12)} als Bau ${vorhanden.identitaet.buildId}; ` +
        `das gelieferte Archiv ist Bau ${auftrag.erwartet.buildId} desselben Commits.`,
    );
    return 'anderer-bau';
  }
  const bestaetigt = await bestaetigen(
    b,
    auftrag.port,
    auftrag.erwartet,
    auftrag.versuche ?? 5,
    auftrag.abstandMs ?? 2000,
    Math.max(1, auftrag.treffer ?? 3),
  );
  return bestaetigt ? 'aktiv' : 'aktiv-unbestaetigt';
}

// ---------------------------------------------------------------------------
//  Protokoll der Umschaltungen
// ---------------------------------------------------------------------------

/**
 * Eine Zeile in `${BASIS}/aktivierungen.jsonl` — dieselben Felder, die
 * `release-aktivieren.sh` schreibt, damit eine Datei beide Wege lückenlos
 * erzählt. Keine Umgebung, keine Geheimnisse, keine Pfade ausserhalb der
 * Basis: nur, wer wann wovon wohin umgeschaltet hat und mit welchem Ausgang.
 */
export interface Aktivierungseintrag {
  zeitUtc: string;
  art: 'aktivierung' | 'ruecksprung';
  /** Commit (Verzeichnisname) des vorher aktiven Release. */
  von: string | null;
  /** Commit des Ziels. */
  nach: string | null;
  code: number;
  zustand: string;
  [weiteres: string]: unknown;
}

/**
 * Anhängen, nie umschreiben. Ein Fehler beim Schreiben ändert den Ausgang der
 * Umschaltung nicht — der ist bereits geschehen —, wird aber gemeldet: Ein
 * stilles Loch im Protokoll wäre genau die Lücke, die es schliessen soll.
 */
export function aktivierungProtokollieren(basis: string, eintrag: Aktivierungseintrag, protokoll: (zeile: string) => void): void {
  try {
    appendFileSync(join(basis, 'aktivierungen.jsonl'), `${JSON.stringify(eintrag)}\n`, { encoding: 'utf8', mode: 0o640 });
  } catch (fehler) {
    protokoll(`WARNUNG: aktivierungen.jsonl nicht geschrieben (${fehler instanceof Error ? fehler.message : String(fehler)}).`);
  }
}

// ---------------------------------------------------------------------------
//  pm2 — reine Teile der echten Befehle
// ---------------------------------------------------------------------------

/**
 * Die Umgebung, mit der pm2 aufgerufen wird.
 *
 * `pm2 … --update-env` übernimmt die Umgebung des **Aufrufers** in die
 * Anwendung, und Umgebungsvariablen gehen in Next der `.env` vor. Aufgerufen
 * wird aus einer SSH-Sitzung, die ein Workflow geöffnet hat — was dort
 * zufällig gesetzt ist, liefe sonst in der Produktion mit. Drei Familien
 * gezielt nie:
 *
 *  • `APP_VERSION` — früher die Versionsangabe der Instanz; heute belegt sie
 *    ihre Identität aus ihren eigenen Dateien. Ein übrig gebliebener Wert
 *    darf nicht wieder eine Behauptung neben den Tatsachen werden.
 *  • `GITHUB_*` — Laufdaten der Pipeline, in der Anwendung bedeutungslos und
 *    teils irreführend (`GITHUB_SHA` eines anderen Laufs).
 *  • `CLENARIS_PRUEF_*` — Schalter der Prüfreihe (etwa das Prüfmanifest der
 *    Identität). Die Anwendung beachtet sie nur mit `CLENARIS_UMGEBUNG=test`;
 *    hier kommen sie gar nicht erst an.
 *
 * Darüber hinaus eine Positivliste statt einer Sperrliste: Was nicht
 * ausdrücklich gebraucht wird (Suchpfad, Heimatverzeichnis für `~/.pm2`,
 * Sprache, Zeitzone, die Stellschrauben aus `ecosystem.config.js`), bleibt
 * draussen. Die Geheimnisse der Anwendung liegen in `shared/.env` und werden
 * von Next aus dem Release-Verzeichnis gelesen — nie aus dieser Umgebung.
 */
const PM2_UMGEBUNG_ERLAUBT = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'PM2_HOME',
  'PM2_APP_NAME',
  'PM2_INSTANCES',
  'PM2_MAX_MEMORY',
] as const;

const PM2_UMGEBUNG_NIE = /^(APP_VERSION$|GITHUB_|CLENARIS_PRUEF_)/;

export function pm2Umgebung(quelle: Record<string, string | undefined>, port: number): Record<string, string> {
  const umgebung: Record<string, string> = {};
  for (const name of PM2_UMGEBUNG_ERLAUBT) {
    const wert = quelle[name];
    if (wert !== undefined && !PM2_UMGEBUNG_NIE.test(name)) umgebung[name] = wert;
  }
  umgebung.NODE_ENV = 'production';
  umgebung.PORT = String(port);
  return umgebung;
}

export interface Pm2Prozess {
  name: string;
  /** `pm2_env.pm_cwd` — aus welchem Verzeichnis der Arbeiter läuft. */
  verzeichnis: string | null;
  status: string | null;
}

/**
 * `pm2 jlist` lesen. Was sich nicht lesen lässt, ist eine leere Liste, nie
 * ein Fehler: Die Lage „fehlt" führt dann zu `pm2 start`, und ob danach das
 * Richtige läuft, entscheidet ohnehin die Identitätsprüfung.
 */
export function pm2ProzesseLesen(jlist: string): Pm2Prozess[] {
  let liste: unknown;
  try {
    // pm2 schreibt gelegentlich Hinweise vor das JSON; gelesen wird ab der ersten Klammer.
    const anfang = jlist.indexOf('[');
    liste = JSON.parse(anfang >= 0 ? jlist.slice(anfang) : jlist);
  } catch {
    return [];
  }
  if (!Array.isArray(liste)) return [];
  return liste.map((p) => {
    const eintrag = (p ?? {}) as { name?: unknown; pm2_env?: { pm_cwd?: unknown; status?: unknown } };
    return {
      name: typeof eintrag.name === 'string' ? eintrag.name : '',
      verzeichnis: typeof eintrag.pm2_env?.pm_cwd === 'string' ? eintrag.pm2_env.pm_cwd : null,
      status: typeof eintrag.pm2_env?.status === 'string' ? eintrag.pm2_env.status : null,
    };
  });
}

/**
 * Wo die Anwendung `name` gerade läuft — gemessen an `pm_cwd`.
 *
 * Der Grund für diese Frage: `pm2 reload` übernimmt beim Neuladen aus der
 * Konfigurationsdatei die Umgebung, aber je nach pm2-Fassung **nicht** das
 * Arbeitsverzeichnis und den Programmpfad. Ein Neuladen „aus dem neuen
 * Release" startete dann still wieder das alte. Die Identitätsprüfung fände
 * das (falscher Commit), und die Aktivierung spränge zurück — richtig, aber
 * aus dem falschen Grund und bei jeder Aktivierung. Deshalb schaut der echte
 * Befehl nach dem Neuladen nach und startet die Anwendung notfalls neu
 * (`scripts/release-umschalten.ts`).
 */
export function pm2Lage(prozesse: readonly Pm2Prozess[], name: string, verzeichnis: string): 'fehlt' | 'hier' | 'anderswo' {
  const eigene = prozesse.filter((p) => p.name === name);
  if (eigene.length === 0) return 'fehlt';
  return eigene.every((p) => p.verzeichnis !== null && resolve(p.verzeichnis) === resolve(verzeichnis)) ? 'hier' : 'anderswo';
}
