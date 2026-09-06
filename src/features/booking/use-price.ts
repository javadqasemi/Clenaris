'use client';

import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api/client';
import { useBookingStore } from './store';
import type { PriceBreakdownDto } from './types';

/**
 * Laufende Preisberechnung.
 *
 * Der Preis kommt bei jeder relevanten Änderung frisch vom Server. React Query
 * hält das letzte Ergebnis während des Nachladens sichtbar
 * (`placeholderData: keepPreviousData`), damit die Zahl nicht flackert.
 */
export function useLivePrice() {
  const serviceId = useBookingStore((s) => s.serviceId);
  const squareMeters = useBookingStore((s) => s.squareMeters);
  const rooms = useBookingStore((s) => s.rooms);
  const bathrooms = useBookingStore((s) => s.bathrooms);
  const windows = useBookingStore((s) => s.windows);
  const propertyKind = useBookingStore((s) => s.propertyKind);
  const frequency = useBookingStore((s) => s.frequency);
  const extras = useBookingStore((s) => s.extras);
  const scheduledStart = useBookingStore((s) => s.scheduledStart);
  const postalCode = useBookingStore((s) => s.postalCode);
  const hasPets = useBookingStore((s) => s.hasPets);
  const couponCode = useBookingStore((s) => s.couponCode);
  const urgent = useBookingStore((s) => s.urgent);

  const payload = {
    serviceId,
    squareMeters,
    rooms,
    bathrooms,
    windows,
    propertyKind,
    frequency,
    extras: Object.entries(extras).map(([extraId, quantity]) => ({ extraId, quantity })),
    scheduledStart,
    postalCode: /^[1-9]\d{3}$/.test(postalCode) ? postalCode : undefined,
    hasPets,
    couponCode: couponCode.trim() || undefined,
    urgent,
  };

  return useQuery<PriceBreakdownDto>({
    queryKey: ['booking-price', payload],
    queryFn: () => api.post<PriceBreakdownDto>('/api/public/pricing/estimate', payload),
    enabled: Boolean(serviceId) && Boolean(squareMeters ?? windows ?? rooms),
    placeholderData: (previous) => previous,
    staleTime: 30_000,
    retry: false,
  });
}
