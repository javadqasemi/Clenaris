/**
 * „Heute" so, wie die Anwendung es versteht: der **Kalendertag in Zürich**,
 * als UTC-Mitternacht dieses Tages.
 *
 * Die Dienste rechnen mit `zuercherHeute()` (Planer, Pausen, Ausnahmen,
 * Abrechnungsperioden). Die Prüfungen nahmen bis 2026-09-27 den Kalendertag
 * in **UTC** — `new Date()` und dann `getUTCDate()`. Zwischen 00:00 und
 * 01:00/02:00 Zürcher Zeit (je nach Sommerzeit) liegen die beiden einen Tag
 * auseinander: Die Prüfung schickte dann „heute" als gestrigen Tag, der
 * Dienst lehnte eine Pause ab, die in der Vergangenheit begann, und ein
 * pausierter Vertrag plante munter weiter. Gemessen am 2026-09-27 um 00:21
 * Zürcher Zeit — drei Fehlschläge in `vertraege*.test.ts`, die tagsüber nie
 * auftraten und im CI zu jeder Uhrzeit nach Mitternacht Zürich aufgetreten
 * wären.
 *
 * Der Fehler lag in den Prüfungen, nicht im Produkt: Der Tag einer Kundschaft
 * in Bern beginnt um Mitternacht in Bern. Die Hilfsfunktion gibt deshalb
 * denselben Tag zurück wie der Dienst — über `Intl` statt einer festen
 * Verschiebung, damit die Sommerzeit stimmt.
 */
export function zuercherHeute(jetzt: Date = new Date()): Date {
  const [jahr, monat, tag] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(jetzt)
    .split('-')
    .map(Number);
  return new Date(Date.UTC(jahr!, monat! - 1, tag!));
}
