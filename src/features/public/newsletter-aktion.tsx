'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';

/**
 * Die eine Schaltfläche auf den Newsletter-Seiten (2026-09-27).
 *
 * Bestätigen und Abmelden geschehen erst mit diesem Klick, nicht beim Laden
 * der Seite: Mailfilter rufen Links in E-Mails vorab auf, und ein Schreiben
 * beim Aufruf hätte Anmeldungen ohne die Person bestätigt und Abonnenten
 * ohne ihr Zutun ausgetragen. Nach dem Klick lädt die Seite neu und zeigt
 * den Stand, den der Server festgehalten hat.
 */
export function NewsletterAktion({
  art,
  token,
  beschriftung,
}: {
  art: 'bestaetigen' | 'abmelden';
  token: string;
  beschriftung: string;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [fehler, setFehler] = React.useState<string | null>(null);

  async function ausfuehren() {
    setPending(true);
    setFehler(null);
    try {
      await api.post(`/api/public/newsletter/${art}`, { token });
      router.refresh();
    } catch (error) {
      setFehler(error instanceof ApiError ? error.message : 'Das hat nicht geklappt. Bitte versuchen Sie es erneut.');
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <Button size="lg" onClick={() => void ausfuehren()} disabled={pending}>
        {pending ? 'Einen Moment …' : beschriftung}
      </Button>
      {fehler ? <Alert variant="destructive">{fehler}</Alert> : null}
    </div>
  );
}
