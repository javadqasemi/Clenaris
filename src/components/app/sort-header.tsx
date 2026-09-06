'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { SortOrder } from '@/lib/sort';

/**
 * Sortierbare Tabellenüberschrift.
 *
 * Entscheide:
 *
 *  • **Ein Link, kein Knopf.** Die Sortierung steht in der Adresse; ein Link
 *    ist damit die ehrliche Auszeichnung. Er lässt sich in einem neuen Tab
 *    öffnen, kopieren und vom Zurück-Knopf rückgängig machen — alles, was ein
 *    Knopf mit `router.push` erst nachbauen müsste.
 *
 *  • **Der erste Klick sortiert in die nützliche Richtung.** Bei Datum und
 *    Betrag ist das absteigend (das Neueste, das Grösste zuerst), bei Namen
 *    aufsteigend. Wer beim ersten Klick auf „Betrag" die kleinsten Rechnungen
 *    sehen will, ist die Ausnahme; ein zweiter Klick liefert sie.
 *
 *  • **Auch die untätige Spalte zeigt ihr Symbol.** Ein Pfeil, der erst beim
 *    Überfahren erscheint, ist auf einem Tastbildschirm unsichtbar — dort
 *    gibt es kein Überfahren. Das doppelte Pfeilsymbol sagt „hier lässt sich
 *    sortieren", ohne etwas über den aktuellen Zustand zu behaupten.
 *
 *  • **`aria-sort` steht am `<th>`, nicht am Link.** So liest ein
 *    Screenreader beim Betreten der Spalte, wonach die Tabelle geordnet ist,
 *    statt es nur beim Fokussieren des Links zu erfahren.
 */
export function SortHeader({
  field,
  children,
  defaultOrder = 'asc',
  align = 'left',
  className,
}: {
  /** Feldname, wie ihn die Liste auf dem Server zulässt. */
  field: string;
  children: React.ReactNode;
  defaultOrder?: SortOrder;
  align?: 'left' | 'right';
  className?: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const activeField = searchParams.get('sort');
  const activeOrder = searchParams.get('order') === 'desc' ? 'desc' : 'asc';
  const active = activeField === field;

  // Aktive Spalte: umkehren. Neue Spalte: in ihrer natürlichen Richtung.
  const nextOrder: SortOrder = active ? (activeOrder === 'asc' ? 'desc' : 'asc') : defaultOrder;

  const params = new URLSearchParams(searchParams.toString());
  params.set('sort', field);
  params.set('order', nextOrder);
  // Eine neue Sortierung beginnt wieder auf Seite 1 — sonst landet man
  // mitten in einer Liste, die man noch nie von oben gesehen hat.
  params.delete('seite');

  const Icon = active ? (activeOrder === 'asc' ? ArrowUp : ArrowDown) : ChevronsUpDown;

  return (
    <th
      scope="col"
      aria-sort={active ? (activeOrder === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn(align === 'right' && 'text-right', className)}
    >
      <Link
        href={`${pathname}?${params.toString()}`}
        scroll={false}
        className={cn(
          'group inline-flex items-center gap-1.5 rounded transition-colors hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          align === 'right' && 'flex-row-reverse',
          active && 'text-foreground',
        )}
      >
        {children}
        <Icon
          className={cn(
            'size-3 shrink-0 transition-opacity',
            active ? 'opacity-100' : 'opacity-40 group-hover:opacity-70',
          )}
          aria-hidden
        />
        <span className="sr-only">
          {active
            ? `— aktuell ${activeOrder === 'asc' ? 'aufsteigend' : 'absteigend'} sortiert, klicken für ${nextOrder === 'asc' ? 'aufsteigend' : 'absteigend'}`
            : `— klicken, um ${nextOrder === 'asc' ? 'aufsteigend' : 'absteigend'} zu sortieren`}
        </span>
      </Link>
    </th>
  );
}
