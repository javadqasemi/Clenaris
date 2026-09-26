'use client';

import type { BookingState } from './store';

/**
 * Die Auswahl, wie der Server sie liest — für Preis, Verfügbarkeit und
 * Abschluss dieselbe (Produktsprint 2026-09-26).
 *
 * Drei Aufrufe, eine Quelle: Wichen Preis- und Verfügbarkeitsabfrage in den
 * Angaben voneinander ab, rechnete der Kalender mit einer anderen Dauer als
 * die Buchung — genau der Fehler, der dreistündige Einsätze um 20 Uhr
 * anbot. Die Objektangaben (Fläche, Zimmer, Bäder, Fenster) gelten für jede
 * Leistung; die Zusatzleistungen gehören der Leistung, bei der sie gewählt
 * wurden. Dauer und Preis rechnet ausschliesslich der Server.
 */
export function leistungenPayload(
  state: Pick<BookingState, 'auswahl' | 'extras' | 'squareMeters' | 'rooms' | 'bathrooms' | 'windows'>,
) {
  return state.auswahl.map((leistung) => ({
    serviceId: leistung.id,
    squareMeters: state.squareMeters,
    rooms: state.rooms,
    bathrooms: state.bathrooms,
    windows: state.windows,
    extras: Object.entries(state.extras[leistung.id] ?? {}).map(([extraId, quantity]) => ({ extraId, quantity })),
  }));
}

/** Genügen die Angaben, damit der Server eine Dauer rechnen kann? */
export function angabenVollstaendig(
  state: Pick<BookingState, 'auswahl' | 'squareMeters' | 'rooms' | 'windows'>,
): boolean {
  if (state.auswahl.length === 0) return false;
  const fenster = state.auswahl.some((l) => l.kind === 'WINDOW_CLEANING');
  const flaeche = state.auswahl.some((l) => l.kind !== 'WINDOW_CLEANING');
  return (!fenster || Boolean(state.windows)) && (!flaeche || Boolean(state.squareMeters ?? state.rooms));
}
