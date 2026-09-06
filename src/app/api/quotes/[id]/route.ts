import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { softDelete } from '@/server/services/trash.service';
import { updateQuoteSchema } from '@/lib/validation/operations';
import { getQuoteDetail, updateQuote } from '@/server/services/quote.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/quotes/:id */
export const GET = defineRoute({
  permissions: ['quote:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => {
    const organizationId = await getOrganizationId();
    return ok(await getQuoteDetail({ organizationId, quoteId: params.id }));
  },
});

/**
 * PATCH /api/quotes/:id
 *
 * Nur bis zur Annahme möglich — danach verweigert der Service die Änderung
 * und verweist auf die Kopie. Eine angenommene Offerte ist eine Zusage.
 */
export const PATCH = defineRoute({
  permissions: ['quote:update'],
  params: idParam,
  body: updateQuoteSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();

    const quote = await updateQuote({
      organizationId,
      quoteId: params.id,
      input: body,
      actorId: session.id,
    });

    return ok({ id: quote.id, number: quote.number, status: quote.status });
  },
});

/**
 * DELETE /api/quotes/:id — in den Papierkorb legen.
 *
 * Eine angenommene Offerte ist eine vertragliche Zusage und bleibt erhalten.
 *
 * Weich gelöscht: der Datensatz verschwindet aus allen Listen (jede Abfrage
 * filtert `deletedAt: null`), bleibt aber wiederherstellbar. Verknüpfte
 * Datensätze werden **nicht** mitgelöscht — ein Kaskadenlöschen wäre nicht
 * umkehrbar und widerspräche dem Zweck eines Papierkorbs.
 */
export const DELETE = defineRoute({
  permissions: ['quote:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await softDelete(
      'quote',
      { organizationId: await getOrganizationId(), actorId: session.id, ip },
      params.id,
    );
    return noContent();
  },
});
