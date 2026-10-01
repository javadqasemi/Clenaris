import { klartext, kuerzen } from './metadaten';

/**
 * Alternativtext der Vorher-/Nachher-Bilder (2026-09-30).
 *
 * ---------------------------------------------------------------------------
 *  Das Problem
 * ---------------------------------------------------------------------------
 *
 * Jedes Vergleichsbild der Website — Startseite, Galerie, Leistungsseiten —
 * hiess im `alt` nur „Vorher" bzw. „Nachher". Wer die Seite nicht sieht,
 * erfuhr nicht, *was* vorher und nachher zu sehen ist; die Bildersuche bekam
 * acht gleichlautende Bilder ohne jeden Bezug zum Einsatz. Dabei steht alles
 * Nötige im Datensatz: der Titel des Galerieeintrags, die Leistung, der Ort.
 *
 * ---------------------------------------------------------------------------
 *  Die Regeln
 * ---------------------------------------------------------------------------
 *
 *  • **Nur vorhandene Angaben, nichts erfunden.** Titel, Leistung, Ort —
 *    genau so, wie die Redaktion sie gepflegt hat. Kein „professionelle
 *    Reinigung in Bern und Umgebung" als Füllstoff: Ein Alternativtext
 *    beschreibt ein Bild, er ist kein Platz für Suchbegriffe, und Google
 *    wertet angehäufte Begriffe im `alt` als Spam.
 *  • **Nichts doppelt.** Steht die Leistung schon im Titel
 *    („Umzugsreinigung Länggasse" + „Umzugsreinigung"), fällt sie weg.
 *    Verglichen wird wortweise, nicht als Teilzeichenkette — sonst
 *    verschwände der Ort „Bern" hinter einem Titel „Treppenhaus Bernstrasse".
 *  • **Kurz.** Höchstens 120 Zeichen; Bildschirmleser lesen einen
 *    Alternativtext in einem Zug, und lange Texte werden zur Zumutung. Der
 *    Titel kommt immer (notfalls an einer Wortgrenze gekürzt, dann allein),
 *    Leistung und Ort nur, wenn sie ganz passen — ein halber Ort wäre
 *    falsch, nicht kurz.
 *  • **Klartext.** Tags und Steuerzeichen aus einem Datensatz gehören nicht
 *    in ein Attribut (`klartext` aus `metadaten.ts`, dieselbe Regel wie für
 *    Meta-Beschreibungen). Das Escaping des Attributs besorgt React.
 *
 * Ohne Titel, Leistung und Ort gibt es keine Beschreibung (`undefined`), und
 * die Bilder behalten ihren bisherigen Alternativtext „Vorher"/„Nachher".
 */

/** Höchstlänge der Beschreibung, ohne das vorangestellte „Vorher: ". */
export const VERGLEICHSBILD_MAX_ZEICHEN = 120;

export interface VergleichsbildAngaben {
  /** Titel des Galerieeintrags — was gereinigt wurde. */
  titel?: string | null;
  /** Bezeichnung der Leistung, z. B. „Umzugsreinigung". */
  leistung?: string | null;
  /** Ort, wie er im Galerieeintrag gepflegt ist. */
  ort?: string | null;
}

/** Wörter eines Teils, klein und mit Leerzeichen an beiden Enden — für den Vergleich „steht schon da". */
function woerter(text: string): string {
  return ` ${text.toLocaleLowerCase('de-CH').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
}

/**
 * Die Beschreibung eines Vergleichsbilds aus Titel, Leistung und Ort — oder
 * `undefined`, wenn keine Angabe vorhanden ist.
 */
export function vergleichsbildBeschreibung({ titel, leistung, ort }: VergleichsbildAngaben): string | undefined {
  const teile: string[] = [];
  for (const roh of [titel, leistung, ort]) {
    const teil = klartext(roh);
    if (!teil || woerter(teil).trim() === '') continue;
    if (teile.some((vorhanden) => woerter(vorhanden).includes(woerter(teil)))) continue;
    teile.push(teil);
  }
  const [erster, ...weitere] = teile;
  if (!erster) return undefined;

  let text = kuerzen(erster, VERGLEICHSBILD_MAX_ZEICHEN);
  // Musste schon der erste Teil gekürzt werden, bleibt es bei ihm: Ein Ort
  // hinter einer Auslassung („… Treppenhaus…, Bern") läse sich, als gehöre er
  // zum abgeschnittenen Rest.
  if (text !== erster) return text;
  for (const teil of weitere) {
    const laenger = `${text}, ${teil}`;
    if (laenger.length <= VERGLEICHSBILD_MAX_ZEICHEN) text = laenger;
  }
  return text;
}

/**
 * Der Alternativtext eines der beiden Bilder: „Vorher: <Beschreibung>" bzw.
 * „Nachher: <Beschreibung>". Ohne Beschreibung bleibt es bei der
 * Beschriftung allein — das war der Alternativtext vor 2026-09-30, und ein
 * leerer Zusatz („Vorher: ") wäre schlechter als keiner.
 */
export function vergleichsbildAlt(beschriftung: string, beschreibung?: string | null): string {
  const zusatz = beschreibung?.trim();
  return zusatz ? `${beschriftung}: ${zusatz}` : beschriftung;
}
