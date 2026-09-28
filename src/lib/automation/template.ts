import { wertAn, type Nutzlast } from './conditions';

/**
 * Platzhalter in Vorlagen füllen: `{{kunde.vorname}}`.
 *
 * ---------------------------------------------------------------------------
 *  Warum kein Handlebars
 * ---------------------------------------------------------------------------
 *
 * Das Schema nennt die Syntax „handlebars-artig", und die Versuchung ist,
 * einfach Handlebars zu nehmen. Das brächte Schleifen, Bedingungen,
 * Teilvorlagen und Helfer — eine kleine Programmiersprache, die jemand mit
 * `template:update` in eine E-Mail schreiben kann, die an echte Kundschaft
 * geht.
 *
 * Gebraucht wird davon nichts. Eine Terminbestätigung braucht einen Namen,
 * ein Datum und einen Betrag. Deshalb: Ersetzung, keine Auswertung. Es gibt
 * keinen Ausdruck, der ausgeführt wird, also auch keinen, der ausbrechen kann.
 *
 * ---------------------------------------------------------------------------
 *  Unbekannte Platzhalter
 * ---------------------------------------------------------------------------
 *
 * Ein `{{kunde.vorname}}`, zu dem es keinen Wert gibt, wird zu einer **leeren
 * Zeichenkette** — nicht zum Platzhalter selbst und nicht zu „undefined".
 *
 * Die Alternativen sind beide schlechter: Bleibt der Platzhalter stehen, geht
 * `Guten Tag {{kunde.vorname}}` an die Kundschaft und sieht nach einem defekten
 * System aus. Steht dort „undefined", ebenso, nur unverständlicher. Leer ist
 * still falsch, aber nicht peinlich — und `fehlendePlatzhalter` gibt zurück,
 * welche gefehlt haben, damit die Vorlagenpflege es sieht, bevor jemand
 * anders es tut.
 */

const PLATZHALTER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function alsText(wert: unknown): string {
  if (wert === null || wert === undefined) return '';
  if (wert instanceof Date) return wert.toISOString();
  if (typeof wert === 'object') return '';
  return String(wert);
}

/**
 * HTML-Sonderzeichen ersetzen.
 *
 * **Auch bei Werten aus der eigenen Datenbank.** Der Einwand „das sind doch
 * unsere Daten" trifft nicht: Ein Kundenname kommt aus einem öffentlichen
 * Buchungsformular. Wer dort `<img src=x onerror=…>` einträgt, schriebe das
 * sonst in jede E-Mail, die seinen Namen nennt — und in die Kopie, die im
 * Büro gelesen wird.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface FuellErgebnis {
  text: string;
  /** Platzhalter ohne Wert — für die Vorlagenpflege, nicht für die Ausgabe. */
  fehlendePlatzhalter: string[];
}

export function fuelleVorlage(
  vorlage: string,
  nutzlast: Nutzlast,
  optionen: { html?: boolean } = {},
): FuellErgebnis {
  const fehlend: string[] = [];

  const text = vorlage.replace(PLATZHALTER, (_treffer, pfad: string) => {
    const wert = wertAn(nutzlast, pfad);
    if (wert === undefined || wert === null || wert === '') {
      fehlend.push(pfad);
      return '';
    }
    const roh = alsText(wert);
    return optionen.html ? escapeHtml(roh) : roh;
  });

  return { text, fehlendePlatzhalter: [...new Set(fehlend)] };
}

/**
 * Welche Platzhalter eine Vorlage überhaupt verwendet.
 *
 * Für die Vorlagenpflege: Wer eine Vorlage schreibt, will wissen, welche
 * Felder sie verlangt — bevor sie zum ersten Mal an echte Kundschaft geht.
 */
export function platzhalterIn(vorlage: string): string[] {
  const gefunden = new Set<string>();
  for (const treffer of vorlage.matchAll(PLATZHALTER)) {
    gefunden.add(treffer[1]);
  }
  return [...gefunden];
}
