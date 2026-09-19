import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { toNumber } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { requirePermission } from '@/lib/auth/session';
import { getQuoteForCustomer } from '@/server/services/quote.service';
import { getOrganizationId } from '@/server/services/organization.service';
import { QuoteView } from '@/features/shared/quote-view';
import { QuoteResponse } from '@/features/public/quote-response';

export const metadata: Metadata = {
  title: 'Offerte',
};

export const dynamic = 'force-dynamic';

/**
 * Offerte im angemeldeten Kundenbereich.
 *
 * **Warum es diese Seite gibt.** Der Kundenbereich verlinkte bisher auf
 * `/offerte/{quote.publicToken}` — eine angemeldete Person wurde also auf
 * den Weg für Aussenstehende geschickt, und die Berechtigung dafür war eine
 * cuid. Wer eine Sitzung hat und die Offerte besitzt, braucht keine
 * Capability: Das wäre ein Geheimnis, das ohne Not entsteht und irgendwo
 * hinterlassen wird.
 *
 * Die Prüfkette ist `Sitzung → Kundendatensatz → Eigentümerschaft →
 * Offerte`, und sie steht vollständig in der `where`-Klausel von
 * `getQuoteForCustomer`: Eine fremde Offerte wird nicht gefunden, statt
 * gefunden und verweigert zu werden. Das deckt auch die Organisation ab.
 *
 * Darstellung und Antwortmaske teilt sie sich mit der öffentlichen Seite;
 * die Antwort geht aber an die angemeldete Route, und die Geschäftsoperation
 * dahinter ist dieselbe atomare Transition (`respondToQuoteCore`).
 */
export default async function KontoOffertePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requirePermission('quote:read_own');

  /**
   * Ohne verknüpften Kundendatensatz gibt es keine eigene Offerte. Das
   * betrifft Personal, das versehentlich hier landet — 404 statt einer
   * Fehlermeldung, die verrät, dass die Kennung existiert.
   */
  if (!session.profileId) notFound();

  const quote = await getQuoteForCustomer({
    quoteId: id,
    organizationId: await getOrganizationId(),
    customerId: session.profileId,
  }).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  const expired = quote.validUntil < new Date();
  const answered = ['ACCEPTED', 'REJECTED', 'CONVERTED'].includes(quote.status);
  const canRespond = !answered && !expired;

  return (
    <QuoteView
      quote={quote}
      pdfUrl={`/api/quotes/${quote.id}/pdf`}
      responsePanel={
        canRespond ? (
          <QuoteResponse
            grossTotal={toNumber(quote.grossTotal)}
            endpoint={`/api/quotes/${quote.id}/respond`}
            pdfUrl={`/api/quotes/${quote.id}/pdf`}
          />
        ) : undefined
      }
    />
  );
}
