import * as React from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Datenliste — tabellarische Zeilen ohne `<table>`.
 *
 * **Warum das hier steht.** Die Listen in Kundenakte, Offerten- und
 * Rechnungsdetail waren als `flex flex-wrap` gebaut. Das sieht auf einem
 * breiten Bildschirm nach einer Tabelle aus, ist aber keine: sobald die Spalte
 * schmaler wird — etwa weil daneben eine 22-rem-Seitenspalte steht —, brechen
 * einzelne Zellen um und landen unter Zellen, mit denen sie nichts zu tun
 * haben. Die Spalten fluchten dann nicht mehr, und Werte stehen scheinbar
 * ausserhalb der Tabelle.
 *
 * **Was stattdessen passiert.** Ab `sm` ein echtes Raster mit ausdrücklich
 * benannten Spaltenbreiten — jede Zeile hat dieselben Spuren, es kann nichts
 * verrutschen. Darunter, wo ein fünfspaltiges Raster ohnehin unlesbar wäre,
 * ein zweizeiliger Aufbau: oben die Kennung mit dem Status, darunter die
 * Merkmale. Das ist die Form, die man auf dem Telefon tatsächlich lesen kann.
 *
 * **Warum kein `<table>`.** Diese Listen sind Navigationsziele — jede Zeile
 * ist ein Link. Ein Anker darf nicht `<tr>` umschliessen, und ein Link je
 * Zelle wäre für die Tastatur eine Zumutung. Für reine Datenansichten ohne
 * Verlinkung bleibt `<table>` mit `.data-table` die richtige Wahl.
 */

export function DataList({
  children,
  className,
  label,
}: {
  children: React.ReactNode;
  className?: string;
  /** Beschriftung der Liste für Screenreader. */
  label?: string;
}) {
  return (
    <ul
      aria-label={label}
      className={cn(
        'divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card',
        className,
      )}
    >
      {children}
    </ul>
  );
}

/** Kopfzeile über der Liste — dieselben Spuren wie die Zeilen darunter. */
export function DataListHeader({
  columns,
  children,
}: {
  columns: string;
  children: React.ReactNode;
}) {
  return (
    <li
      aria-hidden
      className="hidden gap-4 border-b border-border bg-surface px-4 py-2.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground sm:grid"
      style={{ gridTemplateColumns: columns }}
    >
      {children}
    </li>
  );
}

interface DataRowProps {
  /** Rasterspuren ab `sm`, etwa `'6rem minmax(0,1fr) 7rem 6rem auto'`. */
  columns: string;
  children: React.ReactNode;
  /** Macht die ganze Zeile zum Link. */
  href?: string;
  className?: string;
}

export function DataRow({ columns, children, href, className }: DataRowProps) {
  const inner = (
    <>
      {/*
        Unter `sm` fliessen die Zellen zweizeilig, darüber sitzen sie in festen
        Spuren. `items-center` und `min-w-0` verhindern, dass eine hohe Zelle
        die Zeile auseinanderzieht oder eine lange die Spur sprengt.
      */}
      <span
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 sm:grid sm:gap-4"
        style={{ gridTemplateColumns: columns }}
      >
        {children}
      </span>
      {href ? (
        <ChevronRight
          className="hidden size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-spring group-hover:translate-x-0.5 sm:block"
          aria-hidden
        />
      ) : null}
    </>
  );

  const shell = cn(
    'group flex items-center gap-3 px-4 py-3.5',
    href && 'transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none',
    className,
  );

  return (
    <li>
      {href ? (
        <Link href={href} className={shell}>
          {inner}
        </Link>
      ) : (
        <div className={shell}>{inner}</div>
      )}
    </li>
  );
}

/**
 * Eine Zelle.
 *
 * `truncate` ist der Regelfall für Freitext: ein Objektname, den jemand mit
 * achtzig Zeichen erfasst hat, darf die Spur nicht dehnen. Zahlen bekommen
 * Tabellenziffern und werden nie umgebrochen — Beträge müssen untereinander
 * fluchten.
 */
export function DataCell({
  children,
  className,
  /** Rechtsbündig mit Tabellenziffern — für Beträge und Mengen. */
  numeric,
  /** Zurückgenommen: Datum, Herkunft, Nebenangaben. */
  muted,
  /** Hervorgehoben: Belegnummer, Name. */
  strong,
  /** Kürzt mit Auslassungspunkten statt umzubrechen. */
  truncate = false,
  /** Beschriftung, die unter `sm` vor dem Wert steht. */
  label,
}: {
  children: React.ReactNode;
  className?: string;
  numeric?: boolean;
  muted?: boolean;
  strong?: boolean;
  truncate?: boolean;
  label?: string;
}) {
  return (
    <span
      className={cn(
        'min-w-0 text-sm',
        numeric && 'tabular-nums whitespace-nowrap sm:text-right',
        muted && 'text-muted-foreground',
        strong && 'font-medium',
        truncate && 'truncate',
        className,
      )}
    >
      {label ? (
        <span className="mr-1.5 text-2xs uppercase tracking-wide text-muted-foreground sm:hidden">
          {label}
        </span>
      ) : null}
      {children}
    </span>
  );
}
