import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { toNumber } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { getQuoteByToken } from '@/server/services/quote.service';
import { QuoteView } from '@/features/shared/quote-view';
import { QuoteResponse } from '@/features/public/quote-response';

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

  return (
    <QuoteView
      quote={quote}
      pdfUrl={`/api/public/quotes/${token}/pdf`}
      responsePanel={
        canRespond ? (
          <QuoteResponse
            grossTotal={toNumber(quote.grossTotal)}
            endpoint={`/api/public/quotes/${token}/respond`}
            pdfUrl={`/api/public/quotes/${token}/pdf`}
          />
        ) : undefined
      }
    />
  );
}
