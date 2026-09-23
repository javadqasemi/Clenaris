/**
 * Monatsnamen für Lohnseiten und Lohndokumente — an einer Stelle, damit die
 * Seite nicht das PDF-Modul (und mit ihm `@react-pdf/renderer`) laden muss,
 * nur um „März" zu schreiben.
 */
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

export function monatsname(monat: number): string {
  return MONATE[monat - 1] ?? String(monat);
}
