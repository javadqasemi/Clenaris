'use client';

import { useQuery } from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';

import { api } from '@/lib/api/client';
import { angabenVollstaendig, leistungenPayload } from './payload';
import { useBookingStore } from './store';
import type { PriceBreakdownDto } from './types';

/**
 * Laufende Preisberechnung.
 *
 * Der Preis kommt bei jeder relevanten Änderung frisch vom Server. React Query
 * hält das letzte Ergebnis während des Nachladens sichtbar
 * (`placeholderData: keepPreviousData`), damit die Zahl nicht flackert.
 *
 * Seit 2026-09-26 mit allen gewählten Leistungen (`leistungen`); der Server
 * rechnet Anfahrt, Gutschein und Mindestauftragswert einmal je Buchung, nicht
 * je Leistung.
 */
export function useLivePrice() {
  const state = useBookingStore(
    useShallow((s) => ({
      auswahl: s.auswahl,
      extras: s.extras,
      squareMeters: s.squareMeters,
      rooms: s.rooms,
      bathrooms: s.bathrooms,
      windows: s.windows,
      propertyKind: s.propertyKind,
      frequency: s.frequency,
      scheduledStart: s.scheduledStart,
      postalCode: s.postalCode,
      hasPets: s.hasPets,
      couponCode: s.couponCode,
      urgent: s.urgent,
    })),
  );

  const payload = {
    leistungen: leistungenPayload(state),
    propertyKind: state.propertyKind,
    frequency: state.frequency,
    scheduledStart: state.scheduledStart,
    postalCode: /^[1-9]\d{3}$/.test(state.postalCode) ? state.postalCode : undefined,
    hasPets: state.hasPets,
    couponCode: state.couponCode.trim() || undefined,
    urgent: state.urgent,
  };

  return useQuery<PriceBreakdownDto>({
    queryKey: ['booking-price', payload],
    queryFn: () => api.post<PriceBreakdownDto>('/api/public/pricing/estimate', payload),
    enabled: angabenVollstaendig(state),
    placeholderData: (previous) => previous,
    staleTime: 30_000,
    retry: false,
  });
}
