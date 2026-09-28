import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { toNumber } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { getQuoteAcceptanceState, getQuoteByToken } from '@/server/services/quote.service';
import { QuoteView } from '@/features/shared/quote-view';
import { QuoteResponse } from '@/features/public/quote-response';
import { PdfViewer } from '@/components/app/pdf-viewer';

export const metadata: Metadata = {
  title: 'Ihre Offerte',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Öffentliche Offertansicht — der Weg ohne Anmeldung.
 *
 * Die Berechtigung ist die Capability aus der E-Mail; `getQuoteByToken` löst
 * sie über `access-token.service.ts` auf und verlangt mindestens
 * `QUOTE_VIEW`. Die Darstellung teilt sich diese Seite mit der angemeldeten
 * Ansicht im Kundenbereich (`QuoteView`) — die *Berechtigung* teilt sie
 * ausdrücklich nicht, das sind zwei getrennte Eingänge.
 */
export default async function PublicQuotePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const quote = await getQuoteByToken(token).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  const expired = quote.validUntil < new Date();
  const answered = ['ACCEPTED', 'REJECTED', 'CONVERTED'].includes(quote.status);
  const canRespond = !answered && !expired;

  /**
   * Läuft schon eine Unterzeichnung? Dann heisst die Schaltfläche
   * „fortsetzen" statt „annehmen" (§ 46). Gelesen wird nur der Zustand —
   * die Kennung des Vorgangs ist nicht geheim, ein Zugang entsteht hier
   * nicht; den stellt erst die Antwortroute nach ihrer Prüfung aus.
   */
  const annahme = canRespond ? await getQuoteAcceptanceState(quote) : null;

  return (
    <QuoteView
      quote={quote}
      pdfUrl={`/api/public/quotes/${token}/pdf`}
      /**
       * Der Viewer holt das PDF über dieselbe Adresse, die auch der
       * Download nutzt — mit dem Token im Pfad. Damit ist auch dieser
       * zweite Abruf autorisiert; eine Ablageadresse, die allein an einer
       * Kennung hängt, gibt es hier nicht.
       */
      preview={
        <PdfViewer
          source={`/api/public/quotes/${token}/pdf`}
          fileName={`Offerte-${quote.number}.pdf`}
        />
      }
      responsePanel={
        canRespond ? (
          <QuoteResponse
            grossTotal={toNumber(quote.grossTotal)}
            endpoint={`/api/public/quotes/${token}/respond`}
            pdfUrl={`/api/public/quotes/${token}/pdf`}
            laufendeUnterzeichnung={Boolean(annahme?.active)}
          />
        ) : undefined
      }
    />
  );
}
