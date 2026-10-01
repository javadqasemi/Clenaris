/**
 * Release-Ausführer — die Gegenseite von `/api/cron/release-auftraege`
 * (2026-09-27, neu geschnitten 2026-09-30 nach Vertrag C4).
 *
 *   npx tsx scripts/release-ausfuehrer.ts plan
 *   npx tsx scripts/release-ausfuehrer.ts ci-lauf    --datei laeufe.json --commit <sha40>
 *   npx tsx scripts/release-ausfuehrer.ts abholen    --verzeichnis release --auftrag <id> --ci-lauf <id> --ci-url <url>
 *   npx tsx scripts/release-ausfuehrer.ts melden     --auftrag <id> --aktivierung <ausgangscode oder leer> [--meldung <text>]
 *   npx tsx scripts/release-ausfuehrer.ts identitaet
 *
 * Umgebung: `CLENARIS_URL` (Herkunft der Instanz), `RELEASE_EXECUTOR_TOKEN`,
 * `RELEASE_EXECUTOR_SIGNING_KEY`, `UMGEBUNG` (production, staging, preview,
 * test), `AUSFUEHRER` (Kennung, etwa `github-actions/production`),
 * `SCHLUESSEL` (Ausführungsschlüssel, `github-actions-lauf-<run_id>`),
 * `GITHUB_OUTPUT`. Die Zugangsdaten gehören in die Geheimnisse der
 * GitHub-Umgebung, nie in die Anwendung einer anderen Umgebung.
 * `AUSFUEHRER_WIEDERHOLUNGEN` (Vorgabe 6) bestimmt, wie oft `melden` ein
 * abgewiesenes „erfolgreich" nach je 10 Sekunden erneut versucht.
 *
 * ---------------------------------------------------------------------------
 *  Was dieses Werkzeug tut, und was nicht
 * ---------------------------------------------------------------------------
 *
 * Es plant, misst, übernimmt und meldet — ausführen tut es nichts. Die
 * Aktivierung (`deploy/v2/release-aktivieren.sh`) steht als eigener Schritt
 * im Workflow; dieses Skript läuft ohne Serverzugang und lässt sich deshalb
 * vollständig gegen den Testserver prüfen (`tests/api/release-center.test.ts`).
 *
 * **Warum fünf Befehle statt eines.** Bis 2026-09-30 holte `abholen` den
 * Auftrag, suchte das Artefakt und übernahm in einem Zug, und der Workflow
 * setzte „erfolgreich" oder „zurückgesetzt" aus Shell-Vergleichen zusammen.
 * Drei Lücken folgten daraus: Ein abgebrochener Lauf fand seinen eigenen
 * Auftrag nicht wieder (er war nicht mehr „fällig", sondern DEPLOYING); der
 * CI-Lauf wurde mit `gh run list --status success` gewählt, ohne Zweig und
 * Ereignis zu prüfen — ein grüner Pull-Request-Lauf desselben Commits galt
 * als Nachweis; und die Version für „erfolgreich" las der Ausführer selbst,
 * statt sie die Instanz belegen zu lassen. Jetzt:
 *
 *  - `plan` entscheidet **neu**, **fortsetzen** (derselbe Schlüssel hat den
 *    Auftrag schon übernommen) oder **nichts** (nichts fällig, oder eine
 *    andere Ausführung belegt die Umgebung).
 *  - `ci-lauf` wählt aus der Ausgabe von `gh run list` nur einen
 *    abgeschlossenen, grünen **Push-Lauf auf `main` für genau diesen Commit**.
 *  - `abholen` misst Archiv, `.sha256` und Beilage (Format 2) gegen den
 *    Auftrag und den CI-Lauf und übernimmt erst danach — mit Commit und
 *    Zielversion aus der Beilage, die die Anwendung ihrerseits vergleicht.
 *  - `melden` übersetzt den Ausgangscode der Aktivierung und lässt die
 *    Anwendung das Ergebnis an der Identität der Instanz prüfen.
 *  - `identitaet` zeigt, welchen Stand die Instanz belegt (Diagnose).
 *
 * **`GITHUB_OUTPUT` ist eine Eingabe des nächsten Schritts.** Jeder Wert wird
 * je Schlüssel gegen seine Form geprüft, Zeilenumbrüche werden abgewiesen.
 * Ein Zeilenumbruch in einem Wert (etwa aus einer Fehlermeldung des Servers
 * oder einem präparierten Dateinamen) schriebe sonst eine zweite Ausgabe
 * `archiv=…` in die Datei, und der Aktivierungsschritt holte ein anderes
 * Archiv; ein Anführungszeichen oder `$` in einem Pfad würde im Workflow, der
 * `${{ … }}` wörtlich in die Shell einsetzt, zu Code. Geschrieben wird ganz
 * oder gar nicht (`ausgeben`), und `abholen` prüft seine Zeilen schon vor der
 * Übernahme (`artefaktMessen`) — ein Wert, der nicht weitergegeben werden
 * darf, soll keinen Auftrag in DEPLOYING zurücklassen.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { SIGNATUR_KOPF, ZEIT_KOPF, signieren } from '../src/lib/release/ausfuehrer-signatur';
import {
  artefaktBeilageSchema,
  auslieferbarNach,
  COMMIT_MUSTER,
  SEMVER_MUSTER,
  SHA256_MUSTER,
  type ArtefaktBeilage,
} from '../src/lib/release/manifest';
import type { Aktivierung, ReleaseErgebnis } from '../src/lib/validation/system';

/** Ein Fehler, den das Werkzeug erklärt — ohne Stapelspur, mit Ausgangscode 1. */
export class AusfuehrerFehler extends Error {}

// ---------------------------------------------------------------------------
//  Formen
// ---------------------------------------------------------------------------

const UMGEBUNGEN = ['production', 'staging', 'preview', 'test'] as const;
const AUSFUEHRER_MUSTER = /^[a-z0-9][a-z0-9._/-]{2,79}$/;
/** Wie `releaseErgebnisSchema` — 16 bis 120 Zeichen, etwa `github-actions-lauf-<run_id>`. */
export const SCHLUESSEL_MUSTER = /^[A-Za-z0-9._:-]{16,120}$/;
/** Kennung eines Auftrags: eine cuid, wie Prisma sie vergibt. */
const AUFTRAG_MUSTER = /^c[a-z0-9]{8,49}$/;
/** Adresse eines Actions-Laufs, wie `gh run list --json url` sie liefert. */
const CI_URL_MUSTER = /^https:\/\/github\.com\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})\/actions\/runs\/(\d{1,20})$/;
const LAUF_MUSTER = /^\d{1,20}$/;
/**
 * Ein Pfad, der wörtlich in eine Shell-Zeile eingesetzt werden darf: keine
 * Anführungszeichen, kein `$`, kein Backtick, keine Steuer- oder
 * Trennzeichen. Laufwerksbuchstabe und Rückstrich bleiben erlaubt, damit die
 * Prüfreihe unter Windows läuft.
 */
const PFAD_MUSTER = /^[A-Za-z0-9 ._/\\:~+@-]{1,1000}$/;

const leerOder = (pruefen: (v: string) => boolean) => (v: string) => v === '' || pruefen(v);

/**
 * Jede Ausgabe mit ihrer Form. Ein Schlüssel, der hier nicht steht, wird
 * nicht geschrieben — ein Tippfehler im Skript soll auffallen, nicht eine
 * Ausgabe erzeugen, die der Workflow nie liest.
 */
export const AUSGABEN: Record<string, (wert: string) => boolean> = {
  modus: (v) => v === 'neu' || v === 'fortsetzen' || v === 'nichts',
  auftrag: leerOder((v) => AUFTRAG_MUSTER.test(v)),
  commit: leerOder((v) => COMMIT_MUSTER.test(v)),
  zielversion: leerOder((v) => SEMVER_MUSTER.test(v)),
  id: (v) => LAUF_MUSTER.test(v),
  url: (v) => CI_URL_MUSTER.test(v),
  archiv: (v) => PFAD_MUSTER.test(v),
  sha256: (v) => SHA256_MUSTER.test(v),
  buildid: leerOder((v) => /^[A-Za-z0-9._-]{1,200}$/.test(v)),
  ergebnis: (v) => v === 'SUCCEEDED' || v === 'FAILED' || v === 'ROLLED_BACK',
  belegt: (v) => v === 'ja' || v === 'nein',
  version: (v) => SEMVER_MUSTER.test(v),
};

/** Eine Ausgabezeile `name=wert` — geprüft, oder ein Fehler. Rein, für die Prüfreihe exportiert. */
export function ausgabeZeile(name: string, wert: string): string {
  const pruefen = AUSGABEN[name];
  if (!pruefen) throw new AusfuehrerFehler(`Unbekannte Ausgabe „${name}".`);
  if (/[\r\n]/.test(wert)) {
    throw new AusfuehrerFehler(`Ausgabe „${name}" enthält einen Zeilenumbruch — abgewiesen, sie schriebe eine zweite Ausgabe in GITHUB_OUTPUT.`);
  }
  if (!pruefen(wert)) throw new AusfuehrerFehler(`Ausgabe „${name}" hat nicht die erwartete Form — abgewiesen.`);
  return `${name}=${wert}`;
}

/**
 * Schon geprüfte Zeilen ausgeben und an `GITHUB_OUTPUT` anhängen — in einem
 * Schreibvorgang.
 *
 * **Warum erst alle prüfen, dann alle schreiben.** Bis 2026-09-30 schrieb
 * jede Ausgabe für sich: `plan` hatte `modus=neu` und `auftrag=…` schon in
 * der Datei, wenn die dritte Zeile (etwa ein Commit-Kürzel aus einem alten
 * Release) an ihrer Form scheiterte. Der Schritt wurde rot, aber ein
 * Folgeschritt mit `if: always()` oder ein `continue-on-error` hätte eine
 * halbe Ausgabe gelesen — einen Auftrag ohne Commit. Ganz oder gar nicht ist
 * die einzige Form, die ein Folgeschritt nicht missverstehen kann.
 */
function zeilenSchreiben(zeilen: readonly string[]): void {
  for (const zeile of zeilen) console.log(zeile);
  const ziel = process.env.GITHUB_OUTPUT?.trim();
  if (ziel && zeilen.length > 0) appendFileSync(ziel, zeilen.map((z) => `${z}\n`).join(''));
}

/** Mehrere Ausgaben: jede gegen ihre Form geprüft, erst dann alle geschrieben. */
function ausgeben(...paare: readonly (readonly [string, string])[]): void {
  zeilenSchreiben(paare.map(([name, wert]) => ausgabeZeile(name, wert)));
}

// ---------------------------------------------------------------------------
//  Aufruf und Umgebung
// ---------------------------------------------------------------------------

function argument(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const wert = process.argv[i + 1];
  return wert === undefined || wert.startsWith('--') ? '' : wert;
}
function pflicht(name: string): string {
  const wert = argument(name);
  if (!wert) throw new AusfuehrerFehler(`--${name} fehlt.`);
  return wert;
}
function umgebungswert(name: string): string {
  const wert = process.env[name]?.trim();
  if (!wert) throw new AusfuehrerFehler(`${name} ist nicht gesetzt.`);
  return wert;
}
function umgebung(): string {
  const wert = umgebungswert('UMGEBUNG');
  if (!(UMGEBUNGEN as readonly string[]).includes(wert)) throw new AusfuehrerFehler(`UMGEBUNG „${wert}" ist keine bekannte Umgebung (${UMGEBUNGEN.join(', ')}).`);
  return wert;
}
function ausfuehrerKennung(): string {
  const wert = umgebungswert('AUSFUEHRER');
  if (!AUSFUEHRER_MUSTER.test(wert)) throw new AusfuehrerFehler('AUSFUEHRER hat nicht die Form einer Ausführerkennung (3–80 Zeichen, klein).');
  return wert;
}
function schluessel(): string {
  const wert = umgebungswert('SCHLUESSEL');
  if (!SCHLUESSEL_MUSTER.test(wert)) throw new AusfuehrerFehler('SCHLUESSEL hat nicht die Form eines Ausführungsschlüssels (16–120 Zeichen aus A–Z, a–z, 0–9, . _ : -).');
  return wert;
}

// ---------------------------------------------------------------------------
//  Schnittstelle
// ---------------------------------------------------------------------------

export interface Auftrag {
  auftragId: string;
  status: string;
  zielVersion: string;
  vonVersion: string;
  commit: string | null;
  artefaktSha256: string | null;
  ausfuehrungsSchluessel: string | null;
  hindernis: string | null;
}
export interface Lage {
  umgebung: string;
  laufend: { version: string; commit: string | null; buildId: string | null; belegt: boolean };
  auftraege: Auftrag[];
  inAusfuehrung: (Auftrag & { ausfuehrer: string | null; seit: string | null })[];
}

async function anfrage<T>(methode: 'GET' | 'POST', pfad: string, rumpf?: unknown): Promise<{ status: number; daten: T | null; text: string }> {
  const basis = umgebungswert('CLENARIS_URL').replace(/\/$/, '');
  const text = rumpf === undefined ? '' : JSON.stringify(rumpf);
  const zeit = Math.floor(Date.now() / 1000);
  const antwort = await fetch(`${basis}${pfad}`, {
    method: methode,
    headers: {
      authorization: `Bearer ${umgebungswert('RELEASE_EXECUTOR_TOKEN')}`,
      [ZEIT_KOPF]: String(zeit),
      [SIGNATUR_KOPF]: signieren(umgebungswert('RELEASE_EXECUTOR_SIGNING_KEY'), { methode, pfad, zeit, rumpf: text }),
      ...(rumpf === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: rumpf === undefined ? undefined : text,
  });
  const inhalt = await antwort.text();
  let daten: T | null = null;
  try {
    daten = (JSON.parse(inhalt) as { data?: T }).data ?? null;
  } catch {
    /* kein JSON — der Text steht in der Fehlermeldung */
  }
  return { status: antwort.status, daten, text: inhalt };
}

/** Die Meldung aus einer Fehlerantwort `{ error: { message } }` — einzeilig, gekürzt. */
function fehlermeldung(text: string): string {
  let meldung = text;
  try {
    const roh = JSON.parse(text) as { error?: { message?: unknown; details?: { message?: unknown }[] } };
    const details = Array.isArray(roh.error?.details) ? roh.error!.details.map((d) => d.message).filter((m) => typeof m === 'string') : [];
    if (typeof roh.error?.message === 'string') meldung = [roh.error.message, ...details].join(' ');
  } catch {
    /* kein JSON */
  }
  return meldung.replace(/\s+/g, ' ').trim().slice(0, 600);
}

async function lageLesen(umg: string): Promise<Lage> {
  const r = await anfrage<Lage>('GET', `/api/cron/release-auftraege?umgebung=${encodeURIComponent(umg)}`);
  if (r.status !== 200 || !r.daten) throw new AusfuehrerFehler(`Aufträge nicht lesbar: HTTP ${r.status} ${fehlermeldung(r.text)}`);
  const l = r.daten;
  if (!Array.isArray(l.auftraege) || !Array.isArray(l.inAusfuehrung) || !l.laufend || typeof l.laufend.belegt !== 'boolean') {
    throw new AusfuehrerFehler('Die Antwort der Instanz hat nicht die erwartete Form (auftraege, inAusfuehrung, laufend) — Anwendung älter als der Ausführer?');
  }
  return l;
}

// ---------------------------------------------------------------------------
//  plan
// ---------------------------------------------------------------------------

/**
 * Was dieser Lauf tun soll — rein, aus der Lage der Instanz und dem eigenen
 * Schlüssel.
 *
 * Reihenfolge mit Absicht: Zuerst der eigene, schon übernommene Auftrag
 * (ein abgebrochener Lauf mit demselben Schlüssel setzt fort — die Anwendung
 * erkennt dieselbe Übernahme am Schlüssel und gibt denselben Auftrag
 * zurück). Dann ein fremder: Solange eine andere Ausführung die Umgebung
 * belegt, fängt dieser Lauf nichts an; die Anwendung wiese ihn ohnehin mit
 * 409 ab, und zwei Umschaltungen gleichzeitig hätten keinen definierten
 * Rücksprung. Erst dann der älteste fällige Auftrag ohne Hindernis — einer je
 * Lauf, denn zwei Versionen in einem Lauf hiessen zwei Umschaltungen ohne
 * Gesundheitsprüfung dazwischen.
 */
export function planen(lage: Lage, eigenerSchluessel: string): { modus: 'neu' | 'fortsetzen' | 'nichts'; auftrag: Auftrag | null; hinweise: string[] } {
  const hinweise: string[] = [];
  const eigener = lage.inAusfuehrung.find((a) => a.ausfuehrungsSchluessel === eigenerSchluessel);
  if (eigener) {
    hinweise.push(`Fortsetzen: ${eigener.zielVersion} (${eigener.auftragId}) wurde von diesem Lauf bereits übernommen.`);
    return { modus: 'fortsetzen', auftrag: eigener, hinweise };
  }
  const fremd = lage.inAusfuehrung[0];
  if (fremd) {
    hinweise.push(`In Ausführung durch „${fremd.ausfuehrer ?? '—'}" seit ${fremd.seit ?? '—'}: ${fremd.zielVersion} (${fremd.auftragId}) — dieser Lauf beginnt nichts.`);
    return { modus: 'nichts', auftrag: null, hinweise };
  }
  for (const a of lage.auftraege) {
    if (a.hindernis) hinweise.push(`Übersprungen ${a.zielVersion} (${a.auftragId}): ${a.hindernis}`);
  }
  const auftrag = lage.auftraege.find((a) => !a.hindernis) ?? null;
  if (!auftrag) {
    hinweise.push('Nichts fällig.');
    return { modus: 'nichts', auftrag: null, hinweise };
  }
  return { modus: 'neu', auftrag, hinweise };
}

// ---------------------------------------------------------------------------
//  ci-lauf
// ---------------------------------------------------------------------------

/**
 * Den CI-Lauf wählen, aus dem das Artefakt stammen darf — rein, aus der
 * JSON-Ausgabe von `gh run list --json databaseId,url,headSha,headBranch,event,status,conclusion`.
 *
 * Nur ein **abgeschlossener, grüner Push-Lauf auf `main` für genau diesen
 * Commit**. Die Vorlage bis 2026-09-30 filterte nur „success" und nahm den
 * ersten Treffer: Ein grüner Lauf eines Pull Requests baut den
 * Zusammenführungs-Commit, der nie auf `main` stand, und ein Lauf auf einem
 * anderen Zweig hat eine andere Umgebung — beide sind kein Nachweis für das,
 * was ausgeliefert werden soll. Die Adresse muss zur Laufnummer passen, weil
 * sie als Nachweis in den Auftrag geht. Bei mehreren Treffern (erneut
 * gestarteter Lauf) gilt der neueste.
 */
export function ciLaufWaehlen(laeufe: unknown, commit: string): { id: string; url: string } {
  if (!COMMIT_MUSTER.test(commit)) throw new AusfuehrerFehler('--commit ist kein vollständiger Commit (40 Hexadezimalzeichen).');
  if (!Array.isArray(laeufe)) throw new AusfuehrerFehler('Die Laufliste ist kein JSON-Array (gh run list --json …).');
  const gruende: string[] = [];
  const passend: { id: string; url: string }[] = [];
  for (const roh of laeufe) {
    const l = (roh ?? {}) as Record<string, unknown>;
    const id = typeof l.databaseId === 'number' || typeof l.databaseId === 'string' ? String(l.databaseId) : '';
    if (l.headSha !== commit) continue;
    const warum: string[] = [];
    if (!LAUF_MUSTER.test(id)) warum.push('keine Laufnummer');
    if (l.headBranch !== 'main') warum.push(`Zweig ${String(l.headBranch)}`);
    if (l.event !== 'push') warum.push(`Ereignis ${String(l.event)}`);
    if (l.status !== 'completed') warum.push(`Status ${String(l.status)}`);
    if (l.conclusion !== 'success') warum.push(`Ergebnis ${String(l.conclusion)}`);
    const url = typeof l.url === 'string' ? l.url : '';
    const u = CI_URL_MUSTER.exec(url);
    if (!u || u[3] !== id) warum.push('Adresse passt nicht zur Laufnummer');
    if (warum.length > 0) gruende.push(`Lauf ${id || '?'}: ${warum.join(', ')}`);
    else passend.push({ id, url });
  }
  if (passend.length === 0) {
    throw new AusfuehrerFehler(
      `Kein abgeschlossener, grüner Push-Lauf auf main für ${commit.slice(0, 12)}${gruende.length ? ` (${gruende.join('; ')})` : ' (kein Lauf für diesen Commit)'} — keine Übernahme.`,
    );
  }
  // Laufnummern sind Ziffernfolgen ohne führende Null: längere ist grösser,
  // gleich lange vergleicht die Zeichenfolge — ohne Umweg über Number, das
  // ab 2^53 ungenau würde.
  passend.sort((a, b) => b.id.length - a.id.length || b.id.localeCompare(a.id));
  return passend[0]!;
}

// ---------------------------------------------------------------------------
//  abholen
// ---------------------------------------------------------------------------

function sha256Datei(pfad: string): Promise<string> {
  return new Promise((ok, fehler) => {
    const h = createHash('sha256');
    createReadStream(pfad)
      .on('data', (d) => h.update(d))
      .on('end', () => ok(h.digest('hex')))
      .on('error', fehler);
  });
}

export interface Erwartung {
  commit: string;
  zielVersion: string;
  artefaktSha256: string;
  ciLauf: string;
  ciUrl: string;
}

/**
 * Das Artefakt eines Auftrags finden und messen — nur Dateien, kein Server.
 *
 * Verlangt werden Archiv, `.sha256` und Beilage (`clenaris-<sha12>.*`, wie
 * `scripts/release-artefakt.ts` sie ablegt). Geprüft wird, dass
 *
 *  - die gemessene Summe der `.sha256`-Datei, der Beilage und dem Release
 *    entspricht und die Grösse der Beilage stimmt;
 *  - die Beilage den Vertrag (Format 2) erfüllt, auslieferbar ist und die
 *    Regel dafür erfüllt;
 *  - Commit und Version der Beilage die des Auftrags sind;
 *  - die Beilage aus **diesem** CI-Lauf stammt (`ci.lauf`), auf `main`, im
 *    Repository der Laufadresse.
 *
 * Stimmt eines nicht, wird nicht übernommen: Der Auftrag bleibt terminiert
 * und sichtbar, statt als „in Ausführung" hängenzubleiben.
 *
 * **Die Ausgaben werden hier schon geprüft, nicht erst nach der Übernahme.**
 * Archivpfad, Prüfsumme und Build-ID gehen über `GITHUB_OUTPUT` in den
 * Aktivierungsschritt. Bis 2026-09-30 prüfte `abholen` sie erst nach dem
 * POST auf `/uebernehmen`: Ein Arbeitsverzeichnis mit einer Klammer oder
 * einem Umlaut im Pfad, oder eine Build-ID mit einem Zeichen, das der
 * Vertrag zulässt, die Ausgabe aber nicht, liess den Auftrag übernommen
 * (DEPLOYING) und das Werkzeug mit Ausgang 1 zurück. Ein neuer Lauf mit
 * demselben Schlüssel scheiterte genauso, und erst der stündliche Lauf
 * schloss den Auftrag nach zwei Stunden als FAILED — für ein Release, an dem
 * nichts falsch war. Jetzt kommen die fertigen Zeilen (`ausgaben`) aus der
 * Messung, und `abholen` schreibt sie erst, wenn die Übernahme gelungen ist.
 */
export async function artefaktMessen(
  verzeichnis: string,
  e: Erwartung,
): Promise<{ archiv: string; summe: string; beilage: ArtefaktBeilage; ausgaben: string[] }> {
  const name = `clenaris-${e.commit.slice(0, 12)}`;
  /** Eine Ausgabe vorab prüfen — mit dem Hinweis, dass deshalb nichts übernommen wird. */
  const vorab = (feld: string, wert: string): string => {
    try {
      return ausgabeZeile(feld, wert);
    } catch (fehler) {
      throw new AusfuehrerFehler(
        `${name}: ${(fehler as Error).message} Nichts übernommen — der Auftrag bleibt terminiert; der Wert muss die Form haben, die der Aktivierungsschritt sicher liest.`,
      );
    }
  };
  const archiv = join(verzeichnis, `${name}.tar.gz`);
  // Vor dem Hashen: Ein Pfad, der nicht weitergegeben werden darf, muss
  // nicht erst hunderte Megabyte lesen lassen, um abgewiesen zu werden.
  const archivZeile = vorab('archiv', archiv);
  const summenDatei = `${archiv}.sha256`;
  const beilagePfad = join(verzeichnis, `${name}.json`);
  for (const datei of [archiv, summenDatei, beilagePfad]) {
    if (!existsSync(datei)) throw new AusfuehrerFehler(`Artefakt unvollständig: ${basename(datei)} fehlt.`);
  }

  const summe = await sha256Datei(archiv);
  if (summe !== e.artefaktSha256) throw new AusfuehrerFehler(`${name}: gemessene Summe ≠ Prüfsumme des Release ${e.zielVersion}.`);
  const [notiert, notierterName] = readFileSync(summenDatei, 'utf8').trim().split(/\s+/);
  if (summe !== notiert) throw new AusfuehrerFehler(`${name}: gemessene Summe ≠ .sha256-Datei.`);
  if (notierterName && basename(notierterName.replace(/^\*/, '')) !== `${name}.tar.gz`) {
    throw new AusfuehrerFehler(`${name}: die .sha256-Datei gilt einer anderen Datei.`);
  }

  let roh: unknown;
  try {
    roh = JSON.parse(readFileSync(beilagePfad, 'utf8'));
  } catch {
    throw new AusfuehrerFehler(`${name}: Beilage ist kein JSON.`);
  }
  const geprueft = artefaktBeilageSchema.safeParse(roh);
  if (!geprueft.success) {
    const p = geprueft.error.issues[0];
    throw new AusfuehrerFehler(`${name}: Beilage erfüllt den Vertrag (Format 2) nicht — ${p ? `${p.path.join('.') || 'Wurzel'}: ${p.message}` : 'unbekannt'}.`);
  }
  const b = geprueft.data;
  if (b.archivSha256 !== summe) throw new AusfuehrerFehler(`${name}: Beilage nennt eine andere Summe.`);
  if (b.archivGroesseBytes !== statSync(archiv).size) throw new AusfuehrerFehler(`${name}: Beilage nennt eine andere Grösse.`);
  if (b.commit !== e.commit) throw new AusfuehrerFehler(`${name}: Beilage nennt Commit ${b.commit.slice(0, 12)}, der Auftrag ${e.commit.slice(0, 12)}.`);
  if (b.version !== e.zielVersion) throw new AusfuehrerFehler(`${name}: Beilage ist Version ${b.version}, der Auftrag gilt ${e.zielVersion}.`);
  if (!b.auslieferbar || !auslieferbarNach(b)) throw new AusfuehrerFehler(`${name}: Beilage beschreibt eine Probe (nicht auslieferbar).`);
  if (!b.ci || b.ci.lauf !== e.ciLauf) throw new AusfuehrerFehler(`${name}: Beilage stammt aus CI-Lauf ${b.ci?.lauf ?? '—'}, nicht aus ${e.ciLauf}.`);
  if (b.ci.ref !== 'refs/heads/main') throw new AusfuehrerFehler(`${name}: Beilage wurde auf ${b.ci.ref} gebaut, nicht auf main.`);
  const u = CI_URL_MUSTER.exec(e.ciUrl);
  if (!u || u[3] !== e.ciLauf) throw new AusfuehrerFehler('--ci-url ist keine Adresse des Laufs --ci-lauf.');
  if (`${u[1]}/${u[2]}`.toLowerCase() !== b.ci.repository.toLowerCase()) {
    throw new AusfuehrerFehler(`${name}: Beilage stammt aus ${b.ci.repository}, der Lauf aus ${u[1]}/${u[2]}.`);
  }
  return { archiv, summe, beilage: b, ausgaben: [archivZeile, vorab('sha256', summe), vorab('buildid', b.buildId)] };
}

// ---------------------------------------------------------------------------
//  melden
// ---------------------------------------------------------------------------

/** Aus dem Schema der Schnittstelle, nicht nachgeschrieben — eine Liste für beide Seiten. */
export type Ergebnis = ReleaseErgebnis['ergebnis'];

/**
 * Ausgangscode der Aktivierung → Aktivierung und gemeldetes Ergebnis
 * (Vertrag C3/C4). Nur 0 ist ein Erfolg und nur 20 ein Rücksprung; beide
 * prüft die Anwendung danach an der Identität der Instanz. Alles andere ist
 * ein Scheitern — auch ein leerer Code (der Schritt lief nicht oder sein
 * Ausgang ist unbekannt): „Unklar" als Erfolg zu melden hiesse raten. 255 ist
 * der Code, mit dem `ssh` selbst scheitert, bevor das Skript lief.
 */
export function aktivierungDeuten(code: string | undefined): { aktivierung: Aktivierung; ergebnis: Ergebnis } {
  switch ((code ?? '').trim()) {
    case '0':
      return { aktivierung: 'AKTIV', ergebnis: 'SUCCEEDED' };
    case '20':
      return { aktivierung: 'ZURUECK', ergebnis: 'ROLLED_BACK' };
    case '10':
      return { aktivierung: 'NICHT_UMGESCHALTET', ergebnis: 'FAILED' };
    case '11':
      return { aktivierung: 'GESPERRT', ergebnis: 'FAILED' };
    case '255':
      return { aktivierung: 'NICHT_VERBUNDEN', ergebnis: 'FAILED' };
    default:
      return { aktivierung: 'UNKLAR', ergebnis: 'FAILED' };
  }
}

function wiederholungen(): number {
  const roh = process.env.AUSFUEHRER_WIEDERHOLUNGEN?.trim();
  if (roh === undefined || roh === '') return 6;
  const n = Number(roh);
  return Number.isInteger(n) && n >= 0 && n <= 60 ? n : 6;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Das Ergebnis melden.
 *
 * Ein „erfolgreich", das die Anwendung mit 422 abweist, heisst: Die
 * antwortende Instanz belegt das Ziel nicht. Unmittelbar nach dem Umschalten
 * kann das eine Frage von Sekunden sein (Neustart, Lastverteiler), also wird
 * es einige Male im Abstand von 10 Sekunden wiederholt. Bleibt es dabei,
 * meldet das Werkzeug FAILED **mit dem Grund des Servers** — ein offener
 * Auftrag, den erst der stündliche Lauf nach zwei Stunden schliesst, hülfe
 * niemandem, und ein Erfolg ohne Beleg wäre gelogen. Ein abgewiesener
 * Rücksprung wird nicht wiederholt: Die Aktivierung hat ihren Rücksprung
 * schon gesund gemeldet, ein Warten ändert daran nichts.
 *
 * Ausgangscode 0 heisst „Meldung angenommen" — unabhängig vom Ergebnis. Ob
 * der Lauf rot wird, entscheidet der Workflow an der Ausgabe `ergebnis`.
 */
async function melden(): Promise<void> {
  const auftragId = pflicht('auftrag');
  if (!AUFTRAG_MUSTER.test(auftragId)) throw new AusfuehrerFehler('--auftrag ist keine Auftragskennung.');
  if (!process.argv.includes('--aktivierung')) throw new AusfuehrerFehler('--aktivierung fehlt (leer ist erlaubt und heisst: Ausgang unbekannt).');
  const code = argument('aktivierung') ?? '';
  const { aktivierung, ergebnis } = aktivierungDeuten(code);
  const eigenerSchluessel = schluessel();
  const zusatz = argument('meldung');
  const grundtext = `Aktivierung ${code.trim() === '' ? 'ohne Ausgangscode' : `Code ${code.trim()}`} (${aktivierung})${zusatz ? `: ${zusatz}` : ''}`;

  const senden = (e: Ergebnis, meldung: string) =>
    anfrage<{ wiederholt: boolean }>('POST', '/api/cron/release-auftraege/ergebnis', {
      auftragId,
      ausfuehrungsSchluessel: eigenerSchluessel,
      ergebnis: e,
      aktivierung,
      meldung: meldung.slice(0, 2000),
    });

  let gemeldet: Ergebnis = ergebnis;
  let r = await senden(ergebnis, grundtext);
  if (ergebnis === 'SUCCEEDED') {
    for (let rest = wiederholungen(); r.status === 422 && rest > 0; rest -= 1) {
      console.log(`„Erfolgreich" noch nicht belegt (${fehlermeldung(r.text)}) — neuer Versuch in 10 s, noch ${rest}.`);
      await pause(10_000);
      r = await senden(ergebnis, grundtext);
    }
  }
  if (r.status === 422 && ergebnis !== 'FAILED') {
    const grund = fehlermeldung(r.text);
    console.log(`„${ergebnis}" abgewiesen: ${grund} — gemeldet wird FAILED.`);
    gemeldet = 'FAILED';
    r = await senden('FAILED', `${ergebnis} abgewiesen: ${grund} | ${grundtext}`);
  }
  if (r.status !== 200) throw new AusfuehrerFehler(`Meldung abgewiesen: HTTP ${r.status} ${fehlermeldung(r.text)}`);
  console.log(`Gemeldet: ${gemeldet}${r.daten?.wiederholt ? ' (war bereits gemeldet)' : ''}`);
  ausgeben(['ergebnis', gemeldet]);
}

// ---------------------------------------------------------------------------
//  Befehle
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const befehl = process.argv[2];

  if (befehl === 'plan') {
    const plan = planen(await lageLesen(umgebung()), schluessel());
    for (const h of plan.hinweise) console.log(h);
    ausgeben(
      ['modus', plan.modus],
      ['auftrag', plan.auftrag?.auftragId ?? ''],
      ['commit', plan.auftrag?.commit ?? ''],
      ['zielversion', plan.auftrag?.zielVersion ?? ''],
    );
    return;
  }

  if (befehl === 'ci-lauf') {
    let laeufe: unknown;
    try {
      laeufe = JSON.parse(readFileSync(pflicht('datei'), 'utf8'));
    } catch (error) {
      if (error instanceof AusfuehrerFehler) throw error;
      throw new AusfuehrerFehler('Die Laufliste ist nicht lesbar oder kein JSON.');
    }
    const lauf = ciLaufWaehlen(laeufe, pflicht('commit'));
    ausgeben(['id', lauf.id], ['url', lauf.url]);
    return;
  }

  if (befehl === 'abholen') {
    const auftragId = pflicht('auftrag');
    const ciLauf = pflicht('ci-lauf');
    const ciUrl = pflicht('ci-url');
    if (!AUFTRAG_MUSTER.test(auftragId)) throw new AusfuehrerFehler('--auftrag ist keine Auftragskennung.');
    if (!LAUF_MUSTER.test(ciLauf)) throw new AusfuehrerFehler('--ci-lauf ist keine Laufnummer.');
    const u = CI_URL_MUSTER.exec(ciUrl);
    if (!u || u[3] !== ciLauf) throw new AusfuehrerFehler('--ci-url ist keine Adresse des Laufs --ci-lauf.');
    const umg = umgebung();
    const eigenerSchluessel = schluessel();
    const kennung = ausfuehrerKennung();

    const lage = await lageLesen(umg);
    const auftrag =
      lage.auftraege.find((a) => a.auftragId === auftragId) ??
      lage.inAusfuehrung.find((a) => a.auftragId === auftragId && a.ausfuehrungsSchluessel === eigenerSchluessel);
    if (!auftrag) throw new AusfuehrerFehler(`Auftrag ${auftragId} ist weder fällig noch von diesem Lauf übernommen.`);
    if (auftrag.hindernis) throw new AusfuehrerFehler(`Auftrag ${auftragId} ist nicht ausführbar: ${auftrag.hindernis}`);
    if (!auftrag.commit || !COMMIT_MUSTER.test(auftrag.commit) || !auftrag.artefaktSha256) {
      throw new AusfuehrerFehler(`Auftrag ${auftragId}: Commit oder Prüfsumme fehlt.`);
    }

    // Die Messung liefert die Ausgabezeilen schon geprüft mit: Was hier
    // scheitert, scheitert vor der Übernahme, und der Auftrag bleibt frei.
    const { summe, beilage, ausgaben } = await artefaktMessen(pflicht('verzeichnis'), {
      commit: auftrag.commit,
      zielVersion: auftrag.zielVersion,
      artefaktSha256: auftrag.artefaktSha256,
      ciLauf,
      ciUrl,
    });
    const r = await anfrage<{ wiederholt: boolean; auftrag: { status: string } }>('POST', '/api/cron/release-auftraege/uebernehmen', {
      auftragId,
      umgebung: umg,
      ausfuehrer: kennung,
      ausfuehrungsSchluessel: eigenerSchluessel,
      artefaktSha256: summe,
      commit: beilage.commit,
      zielVersion: beilage.version,
      ciNachweis: ciUrl,
    });
    if (r.status !== 200) throw new AusfuehrerFehler(`Übernahme abgewiesen: HTTP ${r.status} ${fehlermeldung(r.text)}`);
    // Dieselbe Übernahme eines schon abgeschlossenen Auftrags gibt 200 mit
    // dessen Endzustand — dann gibt es nichts mehr zu aktivieren.
    if (r.daten?.auftrag?.status !== 'DEPLOYING') {
      throw new AusfuehrerFehler(`Auftrag ${auftragId} ist ${r.daten?.auftrag?.status ?? 'unbekannt'} — nichts zu aktivieren.`);
    }
    if (r.daten.wiederholt) console.log(`Übernahme bestätigt (bereits mit diesem Schlüssel übernommen).`);
    zeilenSchreiben(ausgaben);
    return;
  }

  if (befehl === 'melden') {
    await melden();
    return;
  }

  /*
    Welchen Stand die Instanz belegt — über dieselbe signierte Schnittstelle.
    `/api/health` nennt dieselben Werte, ist aber unangemeldet; hier ist
    sicher, dass die Antwort von der Instanz stammt, die auch die Aufträge
    hergibt.
  */
  if (befehl === 'identitaet') {
    const { laufend } = await lageLesen(umgebung());
    console.log(JSON.stringify(laufend, null, 2));
    ausgeben(
      ['belegt', laufend.belegt ? 'ja' : 'nein'],
      ['version', laufend.version],
      ['commit', laufend.commit ?? ''],
      ['buildid', laufend.buildId ?? ''],
    );
    return;
  }

  throw new AusfuehrerFehler('Befehl: plan | ci-lauf | abholen | melden | identitaet');
}

if (process.argv[1] && /release-ausfuehrer\.(ts|js|mjs)$/.test(process.argv[1])) {
  main().catch((fehler) => {
    console.error(`FEHLER: ${fehler instanceof Error ? fehler.message : String(fehler)}`);
    process.exit(1);
  });
}
