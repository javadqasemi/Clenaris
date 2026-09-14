'use client';

import * as React from 'react';
import Link from 'next/link';
import { LogIn, UserRound } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * Konto- bzw. Anmeldeschaltfläche der öffentlichen Kopfzeile.
 *
 * Architekturentscheide:
 *
 *  • **Diese eine Stelle fragt die Sitzung ab — nicht das Layout.** Läse das
 *    Layout den Cookie, wäre jede Marketingseite dynamisch und jeder Besuch
 *    eine Datenbankabfrage; so bleibt die Website statisch vorgerendert und
 *    nur dieser Knopf holt seinen Zustand nach.
 *
 *  • **Ein Anmeldeweg, kein Portal-Menü.** Vorher stand hier die Frage „Wo
 *    möchten Sie sich anmelden?" mit drei Einträgen. Sie war eine Zumutung und
 *    eine Fehlerquelle zugleich: Wer den falschen Eintrag wählte, landete
 *    trotzdem im richtigen Bereich (die Rolle entscheidet, nicht die URL) —
 *    die Frage hatte also nie eine falsche Antwort und damit auch keinen
 *    Zweck. Mitarbeitende, die sowohl Personal- als auch Verwaltungsrechte
 *    haben, mussten raten. Jetzt führt ein Knopf zu einer Anmeldeseite, und
 *    die Weiterleitung ergibt sich aus der Rolle des Kontos.
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
export const ACCOUNT_LINKS = [
  { href: '/auth/anmelden', label: 'Anmelden' },
  { href: '/auth/registrieren', label: 'Neues Kundenkonto' },
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
    <Button asChild variant="ghost" size="sm" className={className}>
      <Link href="/auth/anmelden">
        <LogIn aria-hidden />
        Anmelden
      </Link>
    </Button>
  );
}
