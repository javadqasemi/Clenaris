'use client';

import * as React from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { api, ApiError } from '@/lib/api/client';

/**
 * Tausch des Zugangstokens gegen eine Sitzung — im Browser, in dieser
 * Reihenfolge, und die Reihenfolge ist der Punkt:
 *
 *  1. Token aus `location.hash` lesen. Das Fragment hat der Browser nie an
 *     den Server geschickt; es steht in keinem Zugriffsprotokoll.
 *  2. **Sofort** `history.replaceState` auf die nackte Adresse. Ab hier
 *     steht der Token in keinem Verlauf, keinem Bildschirmfoto der
 *     Adresszeile, keinem Referrer.
 *  3. Token per `POST` im Körper an die Tausch-API — der einzige Aufruf,
 *     der ihn je trägt.
 *  4. Der Server prüft und setzt das Sitzungs-Cookie (HttpOnly, nur für die
 *     Signatur-API).
 *  5. `location.replace` auf die Adresse ohne Geheimnis. `replace`, nicht
 *     `assign`: Die Tauschseite soll nicht im Verlauf bleiben.
 *
 * Kein `useSearchParams`, kein Querystring: Ein `?t=` stünde im Protokoll.
 */
export function SignatureExchange({ mode }: { mode: 'sign' | 'result' }) {
  const [zustand, setZustand] = React.useState<'laden' | 'kein-token' | 'ungueltig' | 'fehler'>('laden');
  const [meldung, setMeldung] = React.useState<string | null>(null);

  React.useEffect(() => {
    let aktiv = true;
    (async () => {
      const hash = window.location.hash;
      const treffer = /(?:^#|[#&])t=([0-9a-f]{64})(?:&|$)/.exec(hash);

      // Schritt 2 — vor allem anderen, auch wenn kein Token drin ist.
      if (hash) window.history.replaceState(null, '', window.location.pathname);

      if (!treffer) {
        if (aktiv) setZustand('kein-token');
        return;
      }

      try {
        const ergebnis = await api.post<{ publicId: string; scope: 'sign' | 'result' }>(
          '/api/public/signatures/exchange',
          { token: treffer[1] },
        );
        if (!aktiv) return;
        const ziel = ergebnis.scope === 'result' ? `/signieren/ergebnis/${ergebnis.publicId}` : `/signieren/s/${ergebnis.publicId}`;
        window.location.replace(ziel);
      } catch (error) {
        if (!aktiv) return;
        if (error instanceof ApiError && (error.status === 404 || error.status === 422)) {
          setZustand('ungueltig');
          setMeldung(error.message);
        } else {
          setZustand('fehler');
        }
      }
    })();
    return () => {
      aktiv = false;
    };
  }, [mode]);

  return (
    <div className="container flex min-h-[60vh] max-w-lg items-center py-16">
      <div className="w-full space-y-4 text-center" role="status" aria-live="polite">
        {zustand === 'laden' ? (
          <>
            <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">Der Link wird geprüft…</p>
          </>
        ) : null}
        {zustand === 'kein-token' ? (
          <>
            <AlertTriangle className="mx-auto size-8 text-warning" aria-hidden />
            <h1 className="font-display text-lg font-semibold">Kein gültiger Link</h1>
            <p className="text-sm text-muted-foreground">
              Bitte öffnen Sie die Unterzeichnung über den Link aus Ihrer E-Mail. Der Link ist nur für Sie bestimmt.
            </p>
          </>
        ) : null}
        {zustand === 'ungueltig' ? (
          <>
            <AlertTriangle className="mx-auto size-8 text-warning" aria-hidden />
            <h1 className="font-display text-lg font-semibold">Dieser Link ist nicht mehr gültig</h1>
            <p className="text-sm text-muted-foreground">
              {meldung ?? 'Der Link ist abgelaufen, wurde zurückgezogen oder der Vorgang ist bereits beendet.'} Falls Sie
              das Dokument noch unterzeichnen sollen, bitten Sie um einen neuen Link.
            </p>
          </>
        ) : null}
        {zustand === 'fehler' ? (
          <>
            <AlertTriangle className="mx-auto size-8 text-warning" aria-hidden />
            <h1 className="font-display text-lg font-semibold">Verbindung unterbrochen</h1>
            <p className="text-sm text-muted-foreground">Bitte öffnen Sie den Link aus der E-Mail erneut.</p>
          </>
        ) : null}
      </div>
    </div>
  );
}
