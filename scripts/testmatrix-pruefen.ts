import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, relative, sep } from 'node:path';

/**
 * Prüfung der beiden Abdeckungsmatrizen unter `security/`.
 *
 * ---------------------------------------------------------------------------
 *  Wogegen das gebaut ist
 * ---------------------------------------------------------------------------
 *
 * `security/testmatrix.json` und `security/sicherheitsmatrix.json` behaupten
 * je Funktion bzw. Sicherheitsklasse: „Das prüft der Test X in Datei Y.“ Eine
 * solche Behauptung veraltet leise. Ein Test wird umbenannt, weil sein Titel
 * nicht mehr stimmt; eine Datei wird aufgeteilt; ein Fall wird gestrichen,
 * weil er doppelt war. Die Matrix sagt danach weiter „abgedeckt“, und niemand
 * merkt es, bis jemand im Ernstfall den Beleg sucht und ihn nicht findet.
 *
 * Eine Abdeckungsaussage ohne auffindbaren Beleg ist schlimmer als eine
 * ehrliche Lücke: Die Lücke wird geschlossen, die falsche Aussage nicht.
 *
 * Deshalb wird hier nicht nachgezählt, sondern **nachgeschlagen**: Für jeden
 * Beleg muss die Datei existieren und der Testtitel wörtlich darin stehen.
 * Wörtlich heisst: Auch ein Titel aus einem Template-Literal (`${role}: …`)
 * wird so zitiert, wie er im Quelltext steht — die Matrix verweist auf den
 * Aufruf, nicht auf seine Laufzeitausprägung.
 *
 * ---------------------------------------------------------------------------
 *  Was scheitert und was nicht
 * ---------------------------------------------------------------------------
 *
 * **Ein kaputter Beleg scheitert (Exit 1)**, ebenso eine Matrix, die ihre
 * eigene Form verletzt (unbekannter Status, „abgedeckt“ ohne Beleg, Lücke ohne
 * Grund). Das sind Fehler der Matrix, und sie sind billig zu beheben.
 *
 * **Lücken scheitern nicht.** Sie sind der Zweck der Datei: Eine Matrix, die
 * bei jeder Lücke rot wird, wird innerhalb einer Woche mit „nicht_zutreffend“
 * zugekleistert — dann hat man die Prüfung und die Wahrheit verloren. Die
 * Lücken werden vollständig ausgegeben, damit sie gesehen werden.
 *
 * Die Prüfung sagt ausdrücklich **nicht**, dass der zitierte Test die
 * behauptete Eigenschaft wirklich zusichert. Das bleibt eine Leseaufgabe;
 * dieses Skript verhindert nur, dass die Belegkette unbemerkt reisst.
 *
 * Aufruf: `npx tsx scripts/testmatrix-pruefen.ts`
 */

const ROOT = process.cwd();

const MATRIZEN = [
  { datei: join('security', 'testmatrix.json'), liste: 'funktionen' },
  { datei: join('security', 'sicherheitsmatrix.json'), liste: 'klassen' },
] as const;

/**
 * Die neun Dimensionen der Funktionsmatrix. Fehlt eine, ist das ein
 * Formfehler: Eine nicht erwähnte Dimension liest sich wie „nicht
 * betrachtet“, und genau das soll die Matrix ausschliessen.
 */
const DIMENSIONEN = [
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

interface Zaehler {
  abgedeckt: number;
  luecke: number;
  nicht_zutreffend: number;
}

const fehler: string[] = [];
const dateiCache = new Map<string, string | null>();

/**
 * Liest eine Testdatei höchstens einmal. Der Pfad muss unterhalb des
 * Projekts bleiben — ein `../` in der Matrix wäre kein Beleg, sondern ein
 * Verweis ins Ungewisse.
 */
function inhaltVon(datei: string): string | null {
  const pfad = normalize(join(ROOT, datei));
  if (relative(ROOT, pfad).startsWith('..')) return null;
  if (!dateiCache.has(pfad)) {
    dateiCache.set(pfad, existsSync(pfad) ? readFileSync(pfad, 'utf8') : null);
  }
  return dateiCache.get(pfad) ?? null;
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

/**
 * Prüft eine einzelne Bewertung (eine Zelle der Funktionsmatrix oder eine
 * Klasse der Sicherheitsmatrix) auf Form und Belege.
 */
function pruefeBewertung(ort: string, wert: unknown, zaehler: Zaehler, luecken: string[]): void {
  if (typeof wert !== 'object' || wert === null) {
    fehler.push(`${ort}: keine Bewertung`);
    return;
  }
  const b = wert as Bewertung;
  if (!STATUS.includes(b.status)) {
    fehler.push(`${ort}: unbekannter Status „${String(b.status)}“`);
    return;
  }
  zaehler[b.status] += 1;

  if (b.status === 'abgedeckt') {
    if (!Array.isArray(b.belege) || b.belege.length === 0) {
      fehler.push(`${ort}: „abgedeckt“ ohne Beleg`);
      return;
    }
    for (const beleg of b.belege) {
      if (!istBeleg(beleg)) {
        fehler.push(`${ort}: Beleg ohne „datei“ oder „test“`);
        continue;
      }
      const inhalt = inhaltVon(beleg.datei);
      if (inhalt === null) {
        fehler.push(`${ort}: Datei fehlt — ${beleg.datei}`);
      } else if (!inhalt.includes(beleg.test)) {
        fehler.push(`${ort}: Titel nicht gefunden in ${beleg.datei} — „${beleg.test}“`);
      }
    }
    return;
  }

  if (typeof b.grund !== 'string' || b.grund.trim().length === 0) {
    fehler.push(`${ort}: „${b.status}“ ohne Grund`);
    return;
  }
  if (b.status === 'luecke') luecken.push(`${ort}: ${b.grund}`);
}

function ladeMatrix(datei: string): Record<string, unknown> | null {
  const pfad = join(ROOT, datei);
  if (!existsSync(pfad)) {
    fehler.push(`${datei}: Datei fehlt`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(pfad, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    fehler.push(`${datei}: kein gültiges JSON — ${(e as Error).message}`);
    return null;
  }
}

const anzeige = (datei: string) => datei.split(sep).join('/');

for (const { datei, liste } of MATRIZEN) {
  const zaehler: Zaehler = { abgedeckt: 0, luecke: 0, nicht_zutreffend: 0 };
  const luecken: string[] = [];
  const fehlerVorher = fehler.length;
  const matrix = ladeMatrix(datei);
  const eintraege = matrix?.[liste];

  if (matrix && !Array.isArray(eintraege)) {
    fehler.push(`${anzeige(datei)}: „${liste}“ fehlt oder ist keine Liste`);
  } else if (Array.isArray(eintraege)) {
    for (const eintrag of eintraege as Record<string, unknown>[]) {
      const name = typeof eintrag.name === 'string' ? eintrag.name : String(eintrag.id ?? '?');
      if (liste === 'funktionen') {
        const dims = eintrag.dimensionen as Record<string, unknown> | undefined;
        for (const dim of DIMENSIONEN) {
          if (!dims || !(dim in dims)) {
            fehler.push(`${name}: Dimension „${dim}“ fehlt`);
            continue;
          }
          pruefeBewertung(`${name} / ${dim}`, dims[dim], zaehler, luecken);
        }
        for (const unbekannt of Object.keys(dims ?? {}).filter((d) => !(DIMENSIONEN as readonly string[]).includes(d))) {
          fehler.push(`${name}: unbekannte Dimension „${unbekannt}“`);
        }
      } else {
        pruefeBewertung(name, eintrag, zaehler, luecken);
      }
    }
  }

  const kaputt = fehler.length - fehlerVorher;
  console.log(`\n${anzeige(datei)}`);
  console.log(
    `  abgedeckt: ${zaehler.abgedeckt} · Lücken: ${zaehler.luecke} · nicht zutreffend: ${zaehler.nicht_zutreffend} · Fehler: ${kaputt}`,
  );
  if (luecken.length > 0) {
    console.log('  Lücken:');
    for (const l of luecken) console.log(`    - ${l}`);
  }
}

console.log(`\nGelesene Testdateien: ${[...dateiCache.values()].filter((v) => v !== null).length}`);

if (fehler.length > 0) {
  console.error(`\n${fehler.length} kaputte Belege oder Formfehler:`);
  for (const f of fehler) console.error(`  ✗ ${f}`);
  process.exit(1);
}

console.log('\nAlle Belege auffindbar. Lücken sind gemeldet, nicht gescheitert.');
