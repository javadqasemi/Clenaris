'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';

import { api } from '@/lib/api/client';
import { toDateKey } from '@/lib/utils';
import { angabenVollstaendig, leistungenPayload } from './payload';
import { useBookingStore } from './store';
import type { VerfuegbarkeitDto } from './types';

/** Wie viele Tage der Kalender zeigt. */
export const KALENDER_TAGE = 21;

/**
 * Der Kalender für die ganze Auswahl (Produktsprint 2026-09-26).
 *
 * Fragt `POST /api/public/availability` mit den gewählten Leistungen samt
 * ihren Angaben. Der Abfrageschlüssel *ist* die Auswahl: Kommt eine Leistung
 * dazu, ändert sich die Fläche oder eine Zusatzleistung, entsteht ein neuer
 * Schlüssel und damit eine neue Abfrage — die alten Zeitfenster gelten für
 * die neue Auswahl nicht und werden deshalb auch nicht als Platzhalter
 * weitergezeigt (kein `placeholderData`).
 *
 * Genutzt vom Terminschritt *und* vom Assistenten selbst: Dieser prüft nach
 * jeder Änderung, ob die bereits gewählte Uhrzeit noch buchbar ist.
 */
export function useVerfuegbarkeit(aktiv: boolean) {
  const state = useBookingStore(
    useShallow((s) => ({
      auswahl: s.auswahl,
      extras: s.extras,
      squareMeters: s.squareMeters,
      rooms: s.rooms,
      bathrooms: s.bathrooms,
      windows: s.windows,
      hasPets: s.hasPets,
    })),
  );

  // Ab morgen, als Zürcher Kalendertag. Einmal je Einhängen — ein Kalender,
  // der um Mitternacht unter der Hand einen Tag weiterrückt, verwirrt mehr,
  // als er nützt; der Server prüft den Vorlauf ohnehin selbst.
  const von = React.useMemo(() => toDateKey(new Date(Date.now() + 86_400_000)), []);

  const body = {
    leistungen: leistungenPayload(state),
    hasPets: state.hasPets,
    von,
    tage: KALENDER_TAGE,
  };

  return useQuery<VerfuegbarkeitDto>({
    queryKey: ['verfuegbarkeit', body],
    queryFn: () => api.post<VerfuegbarkeitDto>('/api/public/availability', body),
    enabled: aktiv && angabenVollstaendig(state),
    staleTime: 30_000,
    retry: 1,
  });
}
