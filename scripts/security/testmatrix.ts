import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, relative, sep } from 'node:path';

/**
 * Belegprüfung der beiden Abdeckungsmatrizen unter `security/` (2026-09-30).
 *
 * ---------------------------------------------------------------------------
 *  Wogegen das gebaut ist
 * ---------------------------------------------------------------------------
 *
 * `security/testmatrix.json` und `security/sicherheitsmatrix.json` behaupten
 * je Funktion bzw. Sicherheitsklasse: „Das prüft der Test X in Datei Y.“ Zwei
 * Dinge liessen solche Aussagen bis hierher unbemerkt veralten:
 *
 *  1. **Die Prüfung lief in keinem Tor.** `scripts/testmatrix-pruefen.ts`
 *     gab es seit 2026-09-27, aber weder `verify.ts` noch CI riefen es. Der
 *     Fall „fünfzig gleichzeitige Erneuerungen: genau eine gelingt, die
 *     Familie bleibt heil“ wurde am 2026-09-28 umbenannt („… genau eine
 *     rotiert …“, a9810a6), und beide Matrizen zeigten weiter auf den alten
 *     Titel — niemand sah es. Seit 2026-09-30 ist die Prüfung ein Schritt
 *     von `verify:static` („Testmatrix belegt“).
 *  2. **Ein Beleg galt als gefunden, sobald sein Text irgendwo in der Datei
 *     stand** (`inhalt.includes(titel)`). Ein alter Titel, der nach einer
 *     Umbenennung in einem Kommentar weiterlebt („früher hiess der Fall …“),
 *     hätte damit weiter „abgedeckt“ belegt — ebenso ein Satz aus einer
 *     Fehlermeldung oder ein Bruchstück eines längeren Titels.
 *
 * Eine Abdeckungsaussage, deren Beleg nur noch als Erwähnung existiert, ist
 * schlimmer als eine ehrliche Lücke: Die Lücke wird geschlossen, die falsche
 * Aussage nicht.
 *
 * Jetzt zählt nur noch, was ein Testlauf tatsächlich als Titel ausführt: das
 * erste Argument eines Aufrufs von `it`, `test`, `describe`, `suite`,
 * `test.describe` (auch `.serial`/`.parallel`) oder `test.step`, sofern es
 * ein Zeichenkettenliteral ist. Der Matrixbeleg muss einem solchen Titel
 * **gleich** sein, nicht in ihm enthalten — sonst belegte ein Bruchstück wie
 * „gelingt“ jeden Fall, der das Wort trägt.
 *
 * ---------------------------------------------------------------------------
 *  Warum ein eigener kleiner Leser statt eines regulären Ausdrucks
 * ---------------------------------------------------------------------------
 *
 * Ein Muster wie `/\bit\(\s*'([^']*)'/` findet den Aufruf auch im Kommentar —
 * also genau den Fall, um den es geht. Und es scheitert an Titeln mit dem
 * jeweils anderen Anführungszeichen, an Vorlagen mit `${…}` und an Zeichen-
 * ketten, die zufällig „it(“ enthalten. Der Leser unten kennt die vier
 * Dinge, die in TypeScript Text verbergen können — Zeilen- und
 * Blockkommentare, Zeichenketten in drei Formen, reguläre Ausdrücke — und
 * überspringt sie, bevor er nach Aufrufen sucht. Einen vollständigen
 * TypeScript-Parser (`typescript`, `@babel/parser`) braucht es dafür nicht;
 * er wäre für diese eine Frage eine schwere Abhängigkeit in einem Skript,
 * das auch ohne Build laufen soll.
 *
 * Titel werden **roh** geliefert, so wie sie im Quelltext stehen: Ein Titel
 * aus einer Vorlage (`${rolle}: …`) wird mit seinem Platzhalter zitiert, und
 * eine Maskierung (`\'`) bleibt stehen. Die Matrix verweist auf den Aufruf,
 * nicht auf seine Laufzeitausprägung — dieselbe Regel wie vorher, nur jetzt
 * streng.
 *
 * Ohne Abhängigkeiten und ohne Pfad-Aliasse, damit `tests/api/testmatrix.test.ts`
 * das Modul direkt laden kann.
 */

// ---------------------------------------------------------------------------
//  Titel aus dem Quelltext
// ---------------------------------------------------------------------------

type Zeichen =
  | { art: 'name'; wert: string }
  | { art: 'zeichen'; wert: string }
  | { art: 'text'; roh: string }
  /** Zahl oder regulärer Ausdruck — gebraucht nur, um `/` als Division zu erkennen. */
  | { art: 'wert' };

/**
 * Aufrufe, deren erstes Argument ein ausgeführter Titel ist.
 *
 * Bewusst **nicht** dabei: `test.skip`, `test.fixme`, `test.fail`, `it.todo`,
 * `*.only`. Ein übersprungener oder als offen markierter Fall belegt nichts —
 * der Prüfweg wertet ihn ohnehin als Fehlschlag (`testbilanz.ts`) —, und ein
 * `only` darf gar nicht erst eingecheckt sein (`forbidOnly`). Ebenso wenig
 * Haken wie `test.beforeAll('…')`: Deren Titel beschreibt Vorbereitung, keine
 * Zusicherung.
 */
const TITELAUFRUFE = new Set(['it', 'test', 'describe', 'suite', 'test.describe', 'test.describe.serial', 'test.describe.parallel', 'test.step']);
const AUFRUFBASEN = new Set(['it', 'test', 'describe', 'suite']);

/**
 * Schlüsselwörter, nach denen ein `/` einen regulären Ausdruck beginnt und
 * keine Division ist (`return /x/.test(a)`). Nach jedem anderen Namen ist es
 * eine Division (`anzahl / 2`).
 */
const VOR_AUSDRUCK = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

const NAME_ANFANG = /[\p{L}_$]/u;
const NAME_TEIL = /[\p{L}\p{N}_$‌‍]/u;
const LEERRAUM = /\s/u;

/**
 * Den Quelltext in die wenigen Zeichen zerlegen, die für die Titelsuche
 * zählen. Kommentare verschwinden, Zeichenketten und Vorlagen werden je zu
 * einem Zeichen mit ihrem rohen Inhalt.
 */
function zerlegen(q: string): Zeichen[] {
  let i = 0;

  function zeichenkette(anfuehrung: string): string {
    const anfang = i + 1;
    let j = anfang;
    while (j < q.length) {
      const c = q[j]!;
      if (c === '\\') j += 2;
      else if (c === anfuehrung || c === '\n') break;
      else j += 1;
    }
    const roh = q.slice(anfang, Math.min(j, q.length));
    // Eine nicht geschlossene Zeichenkette endet an der Zeile — so tut es
    // auch der TypeScript-Leser, und der Rest der Datei bleibt lesbar.
    i = j < q.length && q[j] === anfuehrung ? j + 1 : j;
    return roh;
  }

  function vorlage(): string {
    const anfang = i + 1;
    i = anfang;
    while (i < q.length) {
      const c = q[i]!;
      if (c === '\\') {
        i += 2;
      } else if (c === '`') {
        const roh = q.slice(anfang, i);
        i += 1;
        return roh;
      } else if (c === '$' && q[i + 1] === '{') {
        // Der Ausdruck in `${…}` ist Code mit eigenen Zeichenketten,
        // Vorlagen und Klammern. Seine Zeichen landen in einer eigenen,
        // verworfenen Liste: In der äusseren Liste stünden sie **vor** dem
        // Vorlagenzeichen und trennten `it(` von seinem Titel.
        i += 2;
        code([], true);
      } else {
        i += 1;
      }
    }
    return q.slice(anfang);
  }

  function regulaererAusdruck(): void {
    let j = i + 1;
    let inKlasse = false;
    while (j < q.length) {
      const c = q[j]!;
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '\n') break;
      if (inKlasse) {
        if (c === ']') inKlasse = false;
      } else if (c === '[') {
        inKlasse = true;
      } else if (c === '/') {
        j += 1;
        break;
      }
      j += 1;
    }
    while (j < q.length && /[a-z]/i.test(q[j]!)) j += 1;
    i = j;
  }

  function code(liste: Zeichen[], bisKlammer: boolean): void {
    let tiefe = 0;
    const davorIstWert = (): boolean => {
      const t = liste[liste.length - 1];
      if (!t) return false;
      if (t.art === 'text' || t.art === 'wert') return true;
      if (t.art === 'name') return !VOR_AUSDRUCK.has(t.wert);
      return t.wert === ')' || t.wert === ']' || t.wert === '}';
    };

    while (i < q.length) {
      const c = q[i]!;
      const d = q[i + 1];
      if (LEERRAUM.test(c) || c === '﻿') {
        i += 1;
      } else if (c === '/' && d === '/') {
        const ende = q.indexOf('\n', i);
        i = ende < 0 ? q.length : ende;
      } else if (c === '/' && d === '*') {
        const ende = q.indexOf('*/', i + 2);
        i = ende < 0 ? q.length : ende + 2;
      } else if (c === "'" || c === '"') {
        liste.push({ art: 'text', roh: zeichenkette(c) });
      } else if (c === '`') {
        liste.push({ art: 'text', roh: vorlage() });
      } else if (c === '/') {
        if (davorIstWert()) {
          liste.push({ art: 'zeichen', wert: '/' });
          i += 1;
        } else {
          regulaererAusdruck();
          liste.push({ art: 'wert' });
        }
      } else if (NAME_ANFANG.test(c)) {
        let j = i + 1;
        while (j < q.length && NAME_TEIL.test(q[j]!)) j += 1;
        liste.push({ art: 'name', wert: q.slice(i, j) });
        i = j;
      } else if (/[0-9]/.test(c)) {
        let j = i + 1;
        while (j < q.length && /[0-9a-z_.]/i.test(q[j]!)) j += 1;
        liste.push({ art: 'wert' });
        i = j;
      } else if (c === '?' && d === '.') {
        liste.push({ art: 'zeichen', wert: '?.' });
        i += 2;
      } else {
        if (bisKlammer && c === '{') tiefe += 1;
        if (bisKlammer && c === '}') {
          if (tiefe === 0) {
            i += 1;
            return;
          }
          tiefe -= 1;
        }
        liste.push({ art: 'zeichen', wert: c });
        i += 1;
      }
    }
  }

  const alle: Zeichen[] = [];
  code(alle, false);
  return alle;
}

/**
 * Die Titel aller Test- und Gruppenaufrufe eines Quelltexts, in der
 * Reihenfolge ihres Auftretens.
 *
 * Gezählt wird ein Aufruf nur, wenn er nicht Glied einer fremden Kette ist
 * (`muster.test(…)`, `regex.test(…)`) und sein erstes Argument ein
 * Zeichenkettenliteral ist. Ein Titel aus einer Variablen (`it(fall.titel)`)
 * lässt sich aus dem Quelltext nicht belegen; die Matrix zitiert dann den
 * umgebenden `describe`.
 */
export function titelAusQuelltext(text: string): string[] {
  const zeichen = zerlegen(text);
  const titel: string[] = [];
  for (let k = 0; k < zeichen.length; k++) {
    const z = zeichen[k]!;
    if (z.art !== 'name' || !AUFRUFBASEN.has(z.wert)) continue;
    const davor = zeichen[k - 1];
    if (davor?.art === 'zeichen' && (davor.wert === '.' || davor.wert === '?.')) continue;
    let kette = z.wert;
    let m = k + 1;
    for (;;) {
      const punkt = zeichen[m];
      const glied = zeichen[m + 1];
      if (punkt?.art !== 'zeichen' || punkt.wert !== '.' || glied?.art !== 'name') break;
      kette += `.${glied.wert}`;
      m += 2;
    }
    if (!TITELAUFRUFE.has(kette)) continue;
    const klammer = zeichen[m];
    const argument = zeichen[m + 1];
    if (klammer?.art === 'zeichen' && klammer.wert === '(' && argument?.art === 'text') titel.push(argument.roh);
  }
  return titel;
}

// ---------------------------------------------------------------------------
//  Die Matrizen
// ---------------------------------------------------------------------------

export const MATRIZEN = [
  { datei: join('security', 'testmatrix.json'), liste: 'funktionen' },
  { datei: join('security', 'sicherheitsmatrix.json'), liste: 'klassen' },
] as const;

/**
 * Die neun Dimensionen der Funktionsmatrix. Fehlt eine, ist das ein
 * Formfehler: Eine nicht erwähnte Dimension liest sich wie „nicht
 * betrachtet“, und genau das soll die Matrix ausschliessen.
 */
export const DIMENSIONEN = [
  'happyPath',
  'validierung',
  'unangemeldet',
  'unberechtigt',
  'fremderMandant',
  'falscherBezug',
  'nebenlaeufigkeit',
  'idempotenz',
  'audit',
] as const;

const STATUS = ['abgedeckt', 'luecke', 'nicht_zutreffend'] as const;
type Status = (typeof STATUS)[number];

interface Beleg {
  datei: string;
  test: string;
}

interface Bewertung {
  status: Status;
  belege?: Beleg[];
  grund?: string;
  hinweis?: string;
}

export interface Zaehler {
  abgedeckt: number;
  luecke: number;
  nicht_zutreffend: number;
}

export interface MatrixBericht {
  /** Anzeigepfad mit `/`, unabhängig vom Betriebssystem. */
  datei: string;
  zaehler: Zaehler;
  luecken: string[];
  fehler: string[];
}

export interface Belegpruefung {
  matrizen: MatrixBericht[];
  /** Alle Fehler beider Matrizen; leer heisst: jeder Beleg ist ein echter Titel. */
  fehler: string[];
  /** Zahl der gelesenen Testdateien. */
  gelesen: number;
}

function istBeleg(wert: unknown): wert is Beleg {
  return (
    typeof wert === 'object' &&
    wert !== null &&
    typeof (wert as Beleg).datei === 'string' &&
    typeof (wert as Beleg).test === 'string' &&
    (wert as Beleg).test.trim().length > 0
  );
}

const woerter = (text: string) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));

/**
 * Der ähnlichste vorhandene Titel — als Hinweis in der Fehlermeldung, damit
 * wer die Matrix nachführt, nicht die ganze Datei lesen muss. Nur ein
 * Vorschlag: Ob der Fall dieselbe Eigenschaft zusichert, bleibt eine
 * Leseaufgabe.
 */
function aehnlichsterTitel(gesucht: string, titel: Iterable<string>): string | null {
  const a = woerter(gesucht);
  if (a.size === 0) return null;
  let bester: { titel: string; mass: number } | null = null;
  for (const t of titel) {
    const b = woerter(t);
    const gemeinsam = [...a].filter((w) => b.has(w)).length;
    const mass = gemeinsam / (a.size + b.size - gemeinsam);
    if (mass >= 0.5 && (!bester || mass > bester.mass)) bester = { titel: t, mass };
  }
  return bester?.titel ?? null;
}

/**
 * Beide Matrizen unter `wurzel` prüfen: Form, Status, Gründe und — für jede
 * abgedeckte Stelle — dass jeder Beleg ein ausgeführter Testtitel seiner
 * Datei ist.
 *
 * **Lücken scheitern nicht.** Sie sind der Zweck der Dateien: Eine Matrix,
 * die bei jeder Lücke rot wird, wird innerhalb einer Woche mit
 * „nicht_zutreffend“ zugekleistert — dann hat man die Prüfung und die
 * Wahrheit verloren. Sie werden vollständig gemeldet, damit sie gesehen
 * werden.
 *
 * Die Prüfung sagt ausdrücklich **nicht**, dass der zitierte Test die
 * behauptete Eigenschaft wirklich zusichert. Das bleibt eine Leseaufgabe;
 * hier wird nur verhindert, dass die Belegkette unbemerkt reisst.
 */
export function matrizenPruefen(wurzel: string): Belegpruefung {
  const quelltexte = new Map<string, { inhalt: string; titel: Set<string> } | null>();
  const alleFehler: string[] = [];

  /**
   * Eine Testdatei höchstens einmal lesen und zerlegen. Der Pfad muss
   * unterhalb des Projekts bleiben — ein `../` in der Matrix wäre kein Beleg,
   * sondern ein Verweis ins Ungewisse.
   */
  function quelle(datei: string): { inhalt: string; titel: Set<string> } | null {
    const pfad = normalize(join(wurzel, datei));
    if (relative(wurzel, pfad).startsWith('..')) return null;
    if (!quelltexte.has(pfad)) {
      const inhalt = existsSync(pfad) ? readFileSync(pfad, 'utf8') : null;
      quelltexte.set(pfad, inhalt === null ? null : { inhalt, titel: new Set(titelAusQuelltext(inhalt)) });
    }
    return quelltexte.get(pfad) ?? null;
  }

  function pruefeBewertung(ort: string, wert: unknown, bericht: MatrixBericht): void {
    if (typeof wert !== 'object' || wert === null) {
      bericht.fehler.push(`${ort}: keine Bewertung`);
      return;
    }
    const b = wert as Bewertung;
    if (!STATUS.includes(b.status)) {
      bericht.fehler.push(`${ort}: unbekannter Status „${String(b.status)}“`);
      return;
    }
    bericht.zaehler[b.status] += 1;

    if (b.status === 'abgedeckt') {
      if (!Array.isArray(b.belege) || b.belege.length === 0) {
        bericht.fehler.push(`${ort}: „abgedeckt“ ohne Beleg`);
        return;
      }
      for (const beleg of b.belege) {
        if (!istBeleg(beleg)) {
          bericht.fehler.push(`${ort}: Beleg ohne „datei“ oder „test“`);
          continue;
        }
        const q = quelle(beleg.datei);
        if (q === null) {
          bericht.fehler.push(`${ort}: Datei fehlt — ${beleg.datei}`);
        } else if (!q.titel.has(beleg.test)) {
          const nurErwaehnt = q.inhalt.includes(beleg.test)
            ? ' (steht in der Datei, aber nicht als Titel eines it/test/describe-Aufrufs — etwa in einem Kommentar)'
            : '';
          const vorschlag = aehnlichsterTitel(beleg.test, q.titel);
          bericht.fehler.push(
            `${ort}: Titel nicht gefunden in ${beleg.datei} — „${beleg.test}“${nurErwaehnt}${vorschlag ? `; ähnlichster Titel: „${vorschlag}“` : ''}`,
          );
        }
      }
      return;
    }

    if (typeof b.grund !== 'string' || b.grund.trim().length === 0) {
      bericht.fehler.push(`${ort}: „${b.status}“ ohne Grund`);
      return;
    }
    if (b.status === 'luecke') bericht.luecken.push(`${ort}: ${b.grund}`);
  }

  const matrizen: MatrixBericht[] = [];
  for (const { datei, liste } of MATRIZEN) {
    const anzeige = datei.split(sep).join('/');
    const bericht: MatrixBericht = { datei: anzeige, zaehler: { abgedeckt: 0, luecke: 0, nicht_zutreffend: 0 }, luecken: [], fehler: [] };
    matrizen.push(bericht);

    const pfad = join(wurzel, datei);
    let matrix: Record<string, unknown> | null = null;
    if (!existsSync(pfad)) {
      bericht.fehler.push(`${anzeige}: Datei fehlt`);
    } else {
      try {
        matrix = JSON.parse(readFileSync(pfad, 'utf8')) as Record<string, unknown>;
      } catch (e) {
        bericht.fehler.push(`${anzeige}: kein gültiges JSON — ${(e as Error).message}`);
      }
    }

    const eintraege = matrix?.[liste];
    if (matrix && !Array.isArray(eintraege)) {
      bericht.fehler.push(`${anzeige}: „${liste}“ fehlt oder ist keine Liste`);
    } else if (Array.isArray(eintraege)) {
      for (const eintrag of eintraege as Record<string, unknown>[]) {
        const name = typeof eintrag.name === 'string' ? eintrag.name : String(eintrag.id ?? '?');
        if (liste === 'funktionen') {
          const dims = eintrag.dimensionen as Record<string, unknown> | undefined;
          for (const dim of DIMENSIONEN) {
            if (!dims || !(dim in dims)) {
              bericht.fehler.push(`${name}: Dimension „${dim}“ fehlt`);
              continue;
            }
            pruefeBewertung(`${name} / ${dim}`, dims[dim], bericht);
          }
          for (const unbekannt of Object.keys(dims ?? {}).filter((d) => !(DIMENSIONEN as readonly string[]).includes(d))) {
            bericht.fehler.push(`${name}: unbekannte Dimension „${unbekannt}“`);
          }
        } else {
          pruefeBewertung(name, eintrag, bericht);
        }
      }
    }
    alleFehler.push(...bericht.fehler);
  }

  return { matrizen, fehler: alleFehler, gelesen: [...quelltexte.values()].filter((v) => v !== null).length };
}
