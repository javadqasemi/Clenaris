'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * Fehlergrenze eines Applikationsbereichs.
 *
 * Architekturentscheid: Ohne `error.tsx` neben dem Layout reisst ein Fehler in
 * einer einzelnen Seite die *gesamte* Oberfläche mit — Navigation,
 * Benachrichtigungen, Kontomenü verschwinden, und die Person steht vor einer
 * leeren Seite. Liegt die Grenze unterhalb des Layouts, bleibt der Rahmen
 * stehen und nur der Inhaltsbereich zeigt den Fehler. Man kann weiterarbeiten.
 *
 * Die technische Meldung erscheint bewusst nicht: sie hilft niemandem und kann
 * interne Details preisgeben. Die `digest`-Kennung erscheint hingegen — damit
 * findet der Support den Vorfall im Serverprotokoll wieder.
 */
export function AreaError({
  error,
  reset,
  /** Wohin führt „Zurück zur Übersicht"? */
  homeHref,
  homeLabel,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  homeHref: string;
  homeLabel: string;
}) {
  React.useEffect(() => {
    // Der Server protokolliert bereits; hier geht es um den Browserverlauf,
    // wenn jemand mit offener Entwicklerkonsole meldet, was passiert ist.
    console.error('[clenaris] Fehler im Bereich:', error);
  }, [error]);

  return (
    <div
      role="alert"
      className="flex min-h-[24rem] flex-col items-center justify-center gap-6 rounded-2xl border border-dashed border-border bg-card/50 px-6 py-16 text-center"
    >
      <span className="flex size-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
        <AlertTriangle className="size-6" aria-hidden />
      </span>

      <div className="max-w-md space-y-2">
        <h2 className="font-display text-lg font-semibold tracking-tight">
          Dieser Bereich lässt sich gerade nicht laden
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Der Fehler liegt bei uns. Ein erneuter Versuch hilft meistens — Ihre übrigen Daten sind
          davon nicht betroffen.
        </p>
      </div>

      <div className="flex flex-wrap justify-center gap-3">
        <Button onClick={reset}>
          <RotateCcw aria-hidden />
          Erneut versuchen
        </Button>
        <Button asChild variant="outline">
          <Link href={homeHref}>{homeLabel}</Link>
        </Button>
      </div>

      {error.digest ? (
        <p className="text-xs text-muted-foreground">
          Kennung für den Support:{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{error.digest}</code>
        </p>
      ) : null}
    </div>
  );
}
