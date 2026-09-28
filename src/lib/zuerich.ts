/**
 * Kalendertage in Zürich — die allgemeine Stelle (2026-09-27).
 *
 * ---------------------------------------------------------------------------
 *  Warum es das braucht
 * ---------------------------------------------------------------------------
 *
 * Ein Geschäftstag endet für die Firma um Mitternacht in Bern. Der Server
 * läuft aber in UTC (und im Test auf einem Rechner in irgendeiner Zone), und
 * `new Date().getFullYear()`, `toISOString().slice(0, 10)` oder
 * `setHours(0, 0, 0, 0)` rechnen in *seiner* Zone. Zwischen 00:00 und
 * 01:00 (Winter) bzw. 02:00 (Sommer) Zürcher Zeit liegt der UTC-Tag noch auf
 * gestern — eine Rechnung vom 1. Januar um 00:30 bekam die Nummer des alten
 * Jahres, eine Fälligkeit „heute" galt als gestern.
 *
 * Diese Datei ist der eine Ort für die allgemeinen Fälle. Zwei Kopien der
 * Grundrechnung bleiben bewusst, wo sie sind: `lib/bi/periods.ts` (Perioden
 * der Kennzahlen) und `lib/contracts/serie.ts` (Vertragskern) — ihre Köpfe
 * erklären, warum sie nicht voneinander abhängen sollen. Für alles andere
 * gilt diese Datei.
 *
 * Ohne `server-only` und ohne Pfad-Aliasse: Die Prüfreihe importiert sie
 * direkt, und Formulare im Browser dürfen sie ebenfalls benutzen — der
 * Browser der Nutzerin steht vielleicht nicht in Zürich.
 *
 * **Die zwei Formen eines Tages.** Ein Kalendertag ist hier entweder ein
 * String `JJJJ-MM-TT` (für Formulare und Anzeigen) oder ein `Date` auf
 * UTC-Mitternacht (die Form, die `@db.Date` speichert). Ein *Zeitpunkt*
 * (`timestamptz`) ist etwas anderes; der Übergang zwischen beiden läuft nur
 * über die Funktionen hier.
 */

const ZONE = 'Europe/Zurich';

const teile = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Zürcher Kalender- und Uhrzeitfelder eines Zeitpunkts. */
export function zuercherFelder(zeitpunkt: Date): { jahr: number; monat: number; tag: number; stunde: number; minute: number; sekunde: number } {
  const f: Record<string, number> = {};
  for (const t of teile.formatToParts(zeitpunkt)) if (t.type !== 'literal') f[t.type] = Number(t.value);
  return { jahr: f.year!, monat: f.month!, tag: f.day!, stunde: f.hour === 24 ? 0 : f.hour!, minute: f.minute!, sekunde: f.second! };
}

/** Das Zürcher Kalenderjahr eines Zeitpunkts — für Nummernkreise und Jahresgrenzen. */
export function zuercherJahr(zeitpunkt: Date = new Date()): number {
  return zuercherFelder(zeitpunkt).jahr;
}

/** Der Zürcher Kalendertag eines Zeitpunkts als UTC-Mitternacht (Form von `@db.Date`). */
export function zuercherTag(zeitpunkt: Date = new Date()): Date {
  const f = zuercherFelder(zeitpunkt);
  return new Date(Date.UTC(f.jahr, f.monat - 1, f.tag));
}

/** Der Zürcher Kalendertag eines Zeitpunkts als `JJJJ-MM-TT` — für Formulare und Schlüssel. */
export function zuercherTagText(zeitpunkt: Date = new Date()): string {
  return zuercherTag(zeitpunkt).toISOString().slice(0, 10);
}

/** Einen Kalendertag (UTC-Mitternacht) um `tage` verschieben — reine Kalenderrechnung. */
export function tagPlus(tag: Date, tage: number): Date {
  return new Date(Date.UTC(tag.getUTCFullYear(), tag.getUTCMonth(), tag.getUTCDate() + tage));
}

/**
 * Der Zeitpunkt, an dem der Kalendertag in Zürich um 00:00 beginnt.
 *
 * Erster Wurf UTC-Mitternacht, dann der Versatz, den Zürich zu diesem
 * Zeitpunkt hat. Mitternacht liegt nie in der Lücke einer Umstellung, deshalb
 * genügt eine Iteration.
 */
export function zuercherTagesbeginn(tag: Date): Date {
  const versuch = Date.UTC(tag.getUTCFullYear(), tag.getUTCMonth(), tag.getUTCDate());
  const f = zuercherFelder(new Date(versuch));
  const gesehen = Date.UTC(f.jahr, f.monat - 1, f.tag, f.stunde, f.minute, f.sekunde);
  return new Date(versuch - (gesehen - versuch));
}

/** Beginn und ausschliessendes Ende des Zürcher Tages, in dem `zeitpunkt` liegt — für `timestamptz`-Abfragen. */
export function zuercherTagesgrenzen(zeitpunkt: Date = new Date()): { von: Date; bis: Date } {
  const tag = zuercherTag(zeitpunkt);
  return { von: zuercherTagesbeginn(tag), bis: zuercherTagesbeginn(tagPlus(tag, 1)) };
}
