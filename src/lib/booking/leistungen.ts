/**
 * Die Leistungen einer Buchung beim Namen nennen (Produktsprint 2026-09-26).
 *
 * Bis zu diesem Sprint stand an rund einem Dutzend Stellen
 * `booking.items[0]?.name` — in der Buchungsliste, in E-Mails, im Titel des
 * Einsatzes, auf dem PDF. Bei einer Buchung mit Büroreinigung *und*
 * Fensterreinigung hiess das: Die Fensterreinigung verschwand überall ausser
 * in der Detailansicht. Diese Funktion ist die eine Antwort auf „welche
 * Leistungen?".
 *
 * Eine Leistung kann mehrere Positionen haben (Arbeit und Grundpauschale);
 * gezählt wird je `serviceId` einmal, in der Reihenfolge der Positionen. Der
 * Name kommt aus dem Katalog, wenn die Position ihn mitbringt, sonst aus der
 * Positionsbezeichnung bis zum ersten „ · " („Büroreinigung · 3.00 Std." →
 * „Büroreinigung") — das ist das Format, das die Preis-Engine seit jeher
 * schreibt.
 */
export interface PositionMitLeistung {
  serviceId: string | null;
  name: string;
  position?: number;
  service?: { name: string } | null;
}

export function leistungenDerBuchung(items: PositionMitLeistung[]): string[] {
  const sortiert = [...items].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const gesehen = new Set<string>();
  const namen: string[] = [];
  for (const item of sortiert) {
    const schluessel = item.serviceId ?? item.name;
    if (gesehen.has(schluessel)) continue;
    gesehen.add(schluessel);
    namen.push(item.service?.name ?? item.name.split(' · ')[0]!.trim());
  }
  return namen;
}

export function leistungsnamen(items: PositionMitLeistung[], ersatz = 'Reinigung'): string {
  const namen = leistungenDerBuchung(items);
  return namen.length ? namen.join(' + ') : ersatz;
}
