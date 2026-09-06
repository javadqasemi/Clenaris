import * as React from 'react';
import Link from 'next/link';
import { Inbox } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * Bausteine der Applikationsseiten.
 *
 * Sie halten Kopfzeile, Leerzustand, Filterleiste und Blätterung in allen
 * Listen identisch. Der Leerzustand ist dabei nie nur „keine Daten": er sagt,
 * was als Nächstes zu tun ist.
 */

export function PageHeader({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('space-y-4', className)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-title font-bold tracking-tight">{title}</h1>
          {description ? (
            <p className="prose-measure text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description: string;
  action?: { href: string; label: string };
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border bg-card/50 px-6 py-16 text-center',
        className,
      )}
    >
      <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground [&_svg]:size-6">
        {icon ?? <Inbox aria-hidden />}
      </span>
      <div className="max-w-sm space-y-1.5">
        <h2 className="font-display text-base font-semibold">{title}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {action ? (
        <Button asChild>
          <Link href={action.href}>{action.label}</Link>
        </Button>
      ) : null}
    </div>
  );
}

/** Karte, die eine Liste oder Tabelle umschliesst. */
export function ListCard({
  title,
  action,
  children,
  className,
  footer,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  footer?: React.ReactNode;
}) {
  return (
    <section className={cn('overflow-hidden rounded-2xl border border-border bg-card shadow-soft', className)}>
      {title || action ? (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5">
          {title ? (
            <h2 className="font-display text-base font-semibold tracking-tight">{title}</h2>
          ) : (
            <span />
          )}
          {action}
        </header>
      ) : null}

      {children}

      {footer ? <div className="border-t border-border p-4">{footer}</div> : null}
    </section>
  );
}

/**
 * Waagrecht scrollbarer Tabellenrahmen.
 *
 * Drei Dinge, die vorher fehlten:
 *
 *  • **Das Polster liegt aussen, nicht innen.** Zuvor sass `px-5` im
 *    scrollenden Element; beim Scrollen wanderte es mit, und die letzte Spalte
 *    klebte am Kartenrand. Jetzt trägt der äussere Rahmen das Polster, der
 *    innere nur die Mindestbreite.
 *
 *  • **Die Mindestbreite ist wählbar.** Pauschal 44 rem zwang schon auf einem
 *    Tablet zum Querscrollen, auch bei vier schmalen Spalten. Der Vorgabewert
 *    ist jetzt niedriger; breite Tabellen fordern mehr ausdrücklich an.
 *
 *  • **Ein Hinweis für Screenreader und Tastatur.** Ein scrollender Bereich
 *    muss fokussierbar sein, sonst lässt er sich ohne Maus nicht bewegen —
 *    `tabIndex={0}` mit Rolle und Beschriftung erledigt das.
 */
export function TableScroll({
  children,
  minWidth = '36rem',
  label = 'Tabelle, waagrecht scrollbar',
}: {
  children: React.ReactNode;
  /** Ab welcher Breite umgebrochen bzw. gescrollt wird. */
  minWidth?: string;
  label?: string;
}) {
  return (
    <div className="px-5 pb-2">
      <div
        className="-mx-1 overflow-x-auto px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        tabIndex={0}
        role="region"
        aria-label={label}
      >
        <div style={{ minWidth }}>{children}</div>
      </div>
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  total,
  baseHref,
  className,
}: {
  page: number;
  totalPages: number;
  total: number;
  /** Basis-URL inkl. bestehender Filter, ohne `seite`-Parameter. */
  baseHref: string;
  className?: string;
}) {
  if (totalPages <= 1) {
    return (
      <p className={cn('text-sm text-muted-foreground', className)}>
        {total} {total === 1 ? 'Eintrag' : 'Einträge'}
      </p>
    );
  }

  const separator = baseHref.includes('?') ? '&' : '?';

  return (
    <nav
      className={cn('flex flex-wrap items-center justify-between gap-3', className)}
      aria-label="Blättern"
    >
      <p className="text-sm text-muted-foreground">
        Seite {page} von {totalPages} · {total} Einträge
      </p>
      <div className="flex items-center gap-2">
        <Button asChild variant="outline" size="sm" disabled={page <= 1}>
          <Link
            href={`${baseHref}${separator}seite=${page - 1}`}
            aria-disabled={page <= 1}
            tabIndex={page <= 1 ? -1 : undefined}
            className={page <= 1 ? 'pointer-events-none opacity-50' : undefined}
          >
            Zurück
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link
            href={`${baseHref}${separator}seite=${page + 1}`}
            aria-disabled={page >= totalPages}
            tabIndex={page >= totalPages ? -1 : undefined}
            className={page >= totalPages ? 'pointer-events-none opacity-50' : undefined}
          >
            Weiter
          </Link>
        </Button>
      </div>
    </nav>
  );
}

/** Detailseiten-Abschnitt mit Protokollzeilen. */
export function DetailSection({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-2xl border border-border bg-card shadow-soft', className)}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <h2 className="font-display text-base font-semibold tracking-tight">{title}</h2>
        {action}
      </header>
      <div className="px-6 py-2">{children}</div>
    </section>
  );
}

export function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="protocol-row">
      <dt className="protocol-label">{label}</dt>
      <dd className="protocol-value">{children}</dd>
    </div>
  );
}
