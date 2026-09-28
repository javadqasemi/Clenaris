/**
 * Lesbare Farbpaare für farbige Flächen mit Schrift (Kalendereinträge).
 *
 * Warum eine Rechnung und keine feste Palette (2026-09-27): Die Fläche eines
 * Einsatzes kommt entweder aus der Statusfarbe oder aus `Job.color` — und
 * die ist ein Datenwert, den die Personalakte aus einer Palette setzt, die
 * sich ändern kann. Die axe-Prüfung fand weisse Schrift auf `#2B8A3E`
 * (4.36 : 1, verlangt 4.5 : 1); die Nachrechnung ergab fünf von neun
 * Statusfarben unter der Schwelle. Eine korrigierte Palette hätte genau
 * diese neun geheilt und die nächste gespeicherte Farbe wieder durchgelassen.
 *
 * Und warum nicht bloss „Schrift hell oder dunkel je nach Fläche": Bei
 * mittelhellen Tönen erreicht *keine* der beiden Schriften 4.5 : 1 — auf
 * `#2B8A3E` kommt Weiss auf 4.37, Dunkel auf rund 4.1. Dort wird die Fläche
 * so weit abgedunkelt, bis weisse Schrift die Schwelle hält. Der Farbton
 * bleibt, nur die Helligkeit weicht; die Zuordnung „grün = erledigt" liest
 * man weiter.
 *
 * Reine Funktion, ohne DOM: Sie läuft im Dienst, der die Kalenderdaten
 * baut, und ist direkt prüfbar (`tests/api/farbkontrast.test.ts`).
 */

/** WCAG 2.1, 1.4.3 — normaler Text. Kalendereinträge sind klein, also nicht „grosser Text". */
export const MIN_KONTRAST = 4.5;

const WEISS = '#FFFFFF';
/** Die dunkle Schrift der Oberfläche (`--foreground` im hellen Schema). */
const DUNKEL = '#0F172A';

function kanaele(hex: string): [number, number, number] | null {
  const treffer = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!treffer) return null;
  const wert = parseInt(treffer[1], 16);
  return [(wert >> 16) & 0xff, (wert >> 8) & 0xff, wert & 0xff];
}

function alsHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((k) => Math.round(k).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** Relative Leuchtdichte nach WCAG 2.1. */
function leuchtdichte([r, g, b]: [number, number, number]): number {
  const lin = (k: number) => {
    const v = k / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Kontrastverhältnis zweier Farben (1 bis 21). Unlesbare Eingaben ergeben 1. */
export function kontrast(a: string, b: string): number {
  const ka = kanaele(a);
  const kb = kanaele(b);
  if (!ka || !kb) return 1;
  const [hell, dunkel] = [leuchtdichte(ka), leuchtdichte(kb)].sort((x, y) => y - x);
  return (hell + 0.05) / (dunkel + 0.05);
}

/**
 * Eine Farbe als **Schrift** auf einer hellen Fläche lesbar machen — für
 * Etiketten, deren Farbe ein Datenwert ist (`Tag.color`).
 *
 * Der Befund (2026-09-27, im sauberen Release-Lauf auf frischer Datenbank):
 * Die Etiketten der Kundenliste setzten ihre Farbe unverändert als Schrift auf
 * Weiss — „Stammkunde" in `#2B8A3E` mit 4.36 : 1, ein orangefarbenes Etikett
 * mit 3.58 : 1. Die Farbe bleibt als Rahmen, wie sie ist; nur die Schrift
 * wird so weit abgedunkelt, bis sie die Schwelle hält. Unlesbare Eingaben
 * ergeben die dunkle Schrift der Oberfläche.
 */
export function lesbareSchrift(farbe: string, flaeche = WEISS): string {
  let kanal = kanaele(farbe);
  if (!kanal) return DUNKEL;
  while (kontrast(alsHex(kanal), flaeche) < MIN_KONTRAST) {
    kanal = [kanal[0] * 0.92, kanal[1] * 0.92, kanal[2] * 0.92];
  }
  return alsHex(kanal);
}

/**
 * Fläche und Schrift, die zusammen mindestens `MIN_KONTRAST` erreichen.
 *
 * Reihenfolge: Hält dunkle Schrift auf der unveränderten Fläche, bleibt die
 * Fläche, wie sie ist (helle Töne wie Bernstein). Sonst weisse Schrift und
 * die Fläche in Schritten von 8 % dunkler, bis es reicht — Schwarz erreicht
 * 21 : 1, die Schleife endet also immer. Eine Eingabe, die kein
 * `#RRGGBB` ist, wird durch `ersatz` ersetzt, statt ungeprüft durchzugehen.
 */
export function lesbareFarben(hintergrund: string, ersatz = '#0B7285'): { hintergrund: string; schrift: string } {
  const basis = kanaele(hintergrund) ?? kanaele(ersatz) ?? [11, 114, 133];
  const hex = alsHex(basis);
  if (kontrast(hex, WEISS) >= MIN_KONTRAST) return { hintergrund: hex, schrift: WEISS };
  if (kontrast(hex, DUNKEL) >= MIN_KONTRAST) return { hintergrund: hex, schrift: DUNKEL };

  let kanal = basis;
  while (kontrast(alsHex(kanal), WEISS) < MIN_KONTRAST) {
    kanal = [kanal[0] * 0.92, kanal[1] * 0.92, kanal[2] * 0.92];
  }
  return { hintergrund: alsHex(kanal), schrift: WEISS };
}
