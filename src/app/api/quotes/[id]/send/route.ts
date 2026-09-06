import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { sendQuoteSchema } from '@/lib/validation/operations';
import { sendQuote } from '@/server/services/quote.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** POST /api/quotes/:id/send — Offerte als PDF versenden. */
export const POST = defineRoute({
  permissions: ['quote:send'],
  params: idParam,
  body: sendQuoteSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();

    const quote = await sendQuote({
      organizationId,
      quoteId: params.id,
      email: body.email,
      message: body.message,
      attachPdf: body.attachPdf,
      actorId: session.id,
    });

    return ok({ id: quote.id, status: quote.status, sentAt: quote.sentAt });
  },
});
