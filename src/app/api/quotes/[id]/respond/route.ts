import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { ForbiddenError } from '@/lib/errors';
import { respondQuoteSchema } from '@/lib/validation/operations';
import { getOrganizationId } from '@/server/services/organization.service';
import { respondToQuoteAsCustomer } from '@/server/services/quote.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/quotes/:id/respond
 *
 * Annahme oder Ablehnung aus dem angemeldeten Kundenbereich.
 *
 * **Warum es diese Route neben der öffentlichen gibt.** Wer angemeldet ist
 * und die Offerte besitzt, braucht keinen Capability-Link. Ihn dafür
 * auszustellen hiesse, ein Geheimnis zu erzeugen, das niemand braucht, und
 * es durch eine Adresszeile zu schicken.
 *
 * **Was sie sich mit der öffentlichen Route teilt.** Die Geschäftsoperation.
 * Beide rufen `respondToQuoteCore` und damit denselben atomaren
 * Statusübergang. Eine zweite Umsetzung hätte den Rennzustand, den Gate 1
 * behoben hat, an dieser Stelle neu eingebaut — und zwar unbemerkt, weil die
 * erste weiterhin richtig gewesen wäre. Eine Annahme über den Link und eine
 * Ablehnung hier, gleichzeitig abgeschickt, ergeben genau einen Übergang.
 */
export const POST = defineRoute({
  permissions: ['quote:respond_own'],
  params: idParam,
  body: respondQuoteSchema,
  // Wie beim öffentlichen Weg: eine Offerte beantwortet man einmal. Hier
  // zählt die Sitzung, also genügt das übliche Schreiblimit.
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    /**
     * Ohne verknüpften Kundendatensatz gibt es keine eigene Offerte. Der
     * Fall tritt bei Personal auf, das die Berechtigung über eine andere
     * Rolle mitbringt.
     */
    if (!session.profileId) {
      throw new ForbiddenError('Dieses Konto ist keiner Kundschaft zugeordnet.');
    }

    const quote = await respondToQuoteAsCustomer({
      quoteId: params.id,
      organizationId: await getOrganizationId(),
      customerId: session.profileId,
      userId: session.id,
      input: body,
      ip,
    });

    return ok({
      status: quote.status,
      acceptedAt: quote.acceptedAt,
      rejectedAt: quote.rejectedAt,
    });
  },
});
