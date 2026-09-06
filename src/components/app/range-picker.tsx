'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { cn } from '@/lib/utils';

/**
 * Zeitraumwahl.
 *
 * Der gewählte Zeitraum steht in der URL, nicht im Komponentenzustand: so
 * lässt sich eine Auswertung als Link teilen, und der Zurück-Knopf des
 * Browsers funktioniert wie erwartet.
 */
const RANGES = [
  { value: 'today', label: 'Heute' },
  { value: 'week', label: '7 Tage' },
  { value: 'month', label: 'Monat' },
  { value: 'quarter', label: 'Quartal' },
  { value: 'year', label: 'Jahr' },
] as const;

export function RangePicker({
  current,
  paramName = 'zeitraum',
}: {
  current: string;
  paramName?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const select = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set(paramName, value);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-xl bg-muted p-1"
      role="radiogroup"
      aria-label="Zeitraum"
    >
      {RANGES.map((range) => {
        const active = current === range.value;
        return (
          <button
            key={range.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => select(range.value)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-card text-foreground shadow-soft'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {range.label}
          </button>
        );
      })}
    </div>
  );
}
