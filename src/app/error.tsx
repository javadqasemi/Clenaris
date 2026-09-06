'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, Phone, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Logo } from '@/components/marketing/logo';

/**
 * Fehlerseite.
 *
 * Zeigt nie die technische Meldung — sie hilft der Kundschaft nicht und kann
 * interne Details preisgeben. Die `digest`-Kennung erscheint hingegen, damit
 * der Support einen Vorfall im Log wiederfindet.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error('[app] Unbehandelter Fehler:', error);
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="container flex h-20 items-center">
        <Logo />
      </header>

      <main id="inhalt" className="container flex flex-1 items-center py-20">
        <div className="mx-auto max-w-xl space-y-8">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-destructive/12 text-destructive">
            <AlertTriangle className="size-7" aria-hidden />
          </span>

          <div className="space-y-3">
            <h1 className="text-headline font-bold text-balance">Da ist etwas schiefgelaufen</h1>
            <p className="text-lg leading-relaxed text-muted-foreground">
              Der Fehler liegt bei uns, nicht bei Ihnen. Versuchen Sie es noch einmal — bleibt es
              dabei, rufen Sie uns an. Wir erledigen Ihr Anliegen dann direkt.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Button size="lg" onClick={reset}>
              <RotateCcw aria-hidden />
              Erneut versuchen
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/">Zur Startseite</Link>
            </Button>
            <Button asChild size="lg" variant="ghost">
              <a href="tel:+41315112233">
                <Phone aria-hidden />
                031 511 22 33
              </a>
            </Button>
          </div>

          {error.digest ? (
            <p className="border-t border-border pt-6 text-sm text-muted-foreground">
              Fehlerkennung für unseren Support:{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {error.digest}
              </code>
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}
