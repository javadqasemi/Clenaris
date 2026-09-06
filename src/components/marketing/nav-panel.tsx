'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { DropdownMenuItem } from '@/components/ui/overlays';

/**
 * Bausteine der Navigationspanels in der Kopfzeile.
 *
 * Gestaltungsentscheide:
 *
 *  • **Ein Raster statt einer Liste.** Sechs Einträge untereinander ergeben
 *    eine schmale, hohe Spalte, die man von oben nach unten abarbeiten muss.
 *    Zwei Spalten halbieren die Höhe und lassen sich in einem Blick erfassen.
 *
 *  • **Jeder Eintrag trägt sein Symbol** in einer getönten Kachel. Bei einem
 *    Reinigungsbetrieb sind die Leistungen visuell unterscheidbar (Wohnung,
 *    Umzug, Büro, Fenster, Bau) — das nutzt man besser, als sechs Mal
 *    dieselbe Textzeile zu setzen.
 *
 *  • **Die Beschreibung ist auf zwei Zeilen begrenzt.** Ein Katalogtext, der
 *    unerwartet lang wird, darf das Raster nicht sprengen.
 *
 *  • **Der Fussstreifen liegt bündig am Rand**, auf eigenem Grund. Er trennt
 *    „wohin kann ich gehen" von „was kann ich als Nächstes tun" — ohne eine
 *    weitere Überschrift dafür zu brauchen.
 */

export function NavPanel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('p-2', className)}>{children}</div>;
}

export function NavPanelHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2.5 pb-1.5 pt-1 text-xs font-medium text-muted-foreground">{children}</p>
  );
}

export function NavPanelGrid({
  columns = 2,
  children,
}: {
  columns?: 1 | 2;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('grid gap-0.5', columns === 2 && 'sm:grid-cols-2')}>{children}</div>
  );
}

/** Ein Eintrag: Symbolkachel, Bezeichnung, kurze Erklärung. */
export function NavPanelItem({
  href,
  label,
  description,
  icon,
}: {
  href: string;
  label: string;
  description: string;
  icon: React.ReactNode;
}) {
  return (
    <DropdownMenuItem asChild className="p-0 focus:bg-transparent">
      <Link
        href={href}
        className={cn(
          'group flex items-start gap-3 rounded-xl p-2.5 transition-colors',
          'hover:bg-muted focus-visible:bg-muted focus-visible:outline-none',
        )}
      >
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary',
            'transition-colors group-hover:bg-primary/14 [&_svg]:size-[1.125rem] [&_svg]:text-primary',
          )}
          aria-hidden
        >
          {icon}
        </span>
        <span className="min-w-0 space-y-0.5">
          <span className="block text-sm font-medium leading-snug text-foreground">{label}</span>
          <span className="line-clamp-2 block text-xs leading-relaxed text-muted-foreground">
            {description}
          </span>
        </span>
      </Link>
    </DropdownMenuItem>
  );
}

/** Fussstreifen mit ein bis zwei weiterführenden Handlungen. */
export function NavPanelFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 flex flex-col gap-0.5 border-t border-border bg-surface p-2 sm:flex-row">
      {children}
    </div>
  );
}

export function NavPanelAction({
  href,
  children,
  emphasis,
}: {
  href: string;
  children: React.ReactNode;
  /** Hebt die Handlung hervor, die am häufigsten gebraucht wird. */
  emphasis?: boolean;
}) {
  return (
    <DropdownMenuItem asChild className="flex-1 p-0 focus:bg-transparent">
      <Link
        href={href}
        className={cn(
          'group flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors',
          'focus-visible:outline-none',
          emphasis
            ? 'font-medium text-primary hover:bg-primary/8 focus-visible:bg-primary/8'
            : 'text-foreground hover:bg-muted focus-visible:bg-muted',
        )}
      >
        {children}
        <ArrowRight
          className={cn(
            'size-4 shrink-0 transition-transform duration-200 ease-spring group-hover:translate-x-0.5',
            emphasis ? 'text-primary' : 'text-muted-foreground',
          )}
          aria-hidden
        />
      </Link>
    </DropdownMenuItem>
  );
}
