'use client';

import dynamic from 'next/dynamic';

import { Skeleton } from '@/components/ui/primitives';

/**
 * Persönlicher Kalender, nachgeladen.
 *
 * Zielgerät ist das Mobiltelefon, oft im Mobilfunknetz auf der Baustelle.
 * Dort zählt jedes eingesparte Kilobyte vor der ersten Darstellung.
 */
export const PersonalCalendar = dynamic(
  () => import('./personal-calendar').then((m) => m.PersonalCalendar),
  {
    ssr: false,
    loading: () => (
      <Skeleton className="h-[32rem] w-full rounded-2xl" aria-label="Kalender wird geladen" />
    ),
  },
);
