'use client';

import * as React from 'react';
import Link from 'next/link';
import { LogIn, UserRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/overlays';

/**
 * Konto- bzw. Anmeldeschaltfläche der öffentlichen Kopfzeile.
 *
 * Architekturentscheid: Diese eine Stelle fragt die Sitzung ab — nicht das
 * Layout. Läse das Layout den Cookie, wäre jede Marketingseite dynamisch und
 * jeder Besuch eine Datenbankabfrage; so bleibt die Website statisch
 * vorgerendert und nur dieser Knopf holt seinen Zustand nach.
 *
 * Bis die Antwort da ist, steht „Anmelden" — der Zustand für die grosse
 * Mehrheit der Besuchenden. Ein Platzhalterskelett wäre auffälliger als der
 * seltene Wechsel zu „Mein Konto".
 */
interface SessionState {
  authenticated: boolean;
  firstName?: string;
  accountHref?: string;
}

/** Auch vom mobilen Menü der Kopfzeile verwendet — eine Liste, ein Wortlaut. */
export const LOGIN_LINKS = [
  {
    href: '/auth/anmelden?ziel=konto',
    label: 'Kundenkonto',
    description: 'Termine, Rechnungen, Offerten',
  },
  {
    href: '/auth/anmelden?ziel=portal',
    label: 'Mitarbeitendenportal',
    description: 'Einsatzplan und Zeiterfassung',
  },
  {
    href: '/auth/anmelden?ziel=admin',
    label: 'Administration',
    description: 'Disposition und Auswertungen',
  },
];

export function AccountButton({ className }: { className?: string }) {
  const [state, setState] = React.useState<SessionState | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    fetch('/api/auth/session', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!cancelled) setState(payload?.data ?? { authenticated: false });
      })
      // Fällt die Abfrage aus, bleibt es beim Anmeldeknopf — er funktioniert
      // in beiden Fällen.
      .catch(() => {
        if (!cancelled) setState({ authenticated: false });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (state?.authenticated) {
    return (
      <Button asChild variant="outline" size="sm" className={className}>
        <Link href={state.accountHref ?? '/konto'}>
          <UserRound aria-hidden />
          {state.firstName ? `Konto · ${state.firstName}` : 'Mein Konto'}
        </Link>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={className}>
          <LogIn aria-hidden />
          Anmelden
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Wo möchten Sie sich anmelden?</DropdownMenuLabel>
        {LOGIN_LINKS.map((link) => (
          <DropdownMenuItem key={link.href} asChild>
            <Link href={link.href} className="flex-col items-start gap-0.5 py-2.5">
              <span className="font-medium text-foreground">{link.label}</span>
              <span className="text-xs text-muted-foreground">{link.description}</span>
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/auth/registrieren">Neues Kundenkonto erstellen</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
