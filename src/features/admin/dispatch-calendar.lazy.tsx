'use client';

import dynamic from 'next/dynamic';

import { Skeleton } from '@/components/ui/primitives';

/**
 * Dispositionskalender, nachgeladen.
 *
 * FullCalendar bringt mit Tages-, Wochen-, Monats- und Listenansicht sowie
 * Drag & Drop rund 150 kB mit. Die Seite soll trotzdem sofort stehen — der
 * Platzhalter hält die Höhe, damit die Kopfzeile beim Nachladen nicht
 * springt.
 */
export const DispatchCalendar = dynamic(
  () => import('./dispatch-calendar').then((m) => m.DispatchCalendar),
  {
    ssr: false,
    loading: () => (
      <Skeleton className="h-[42rem] w-full rounded-2xl" aria-label="Kalender wird geladen" />
    ),
  },
);
