'use client';

import { Cookie } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { revokeConsent } from '@/lib/consent';

/**
 * Einwilligung widerrufen.
 *
 * Nach DSGVO und DSG muss der Widerruf so einfach sein wie die Erteilung.
 * Ein Klick setzt die Entscheidung zurück und lädt die Seite neu, sodass der
 * Hinweis erneut erscheint und die Analyse-Skripte nicht mehr laufen.
 */
export function ConsentSettingsLink() {
  return (
    <div className="not-prose my-6 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
      <Cookie className="size-4 shrink-0 text-primary" aria-hidden />
      <span className="flex-1 text-sm text-muted-foreground">
        Sie möchten Ihre Cookie-Entscheidung ändern?
      </span>
      <Button variant="outline" size="sm" onClick={() => revokeConsent()}>
        Einstellungen zurücksetzen
      </Button>
    </div>
  );
}
