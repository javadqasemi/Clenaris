import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { respondQuoteSchema } from '@/lib/validation/operations';
import { publicTokenParams } from '@/lib/validation/queries';
import { respondToQuote } from '@/server/services/quote.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/public/quotes/:token/respond
 *
 * Annahme oder Ablehnung über den öffentlichen Link — ohne Anmeldung.
 *
 * Der Token ist das Berechtigungsmerkmal: er ist unerratbar (cuid), steht nur
 * in der E-Mail an die richtige Adresse und ist an genau eine Offerte
 * gebunden. Bei der Annahme protokolliert der Service zusätzlich die
 * IP-Adresse und den Zeitstempel.
 */
export const POST = definePublicRoute({
  params: publicTokenParams,
  body: respondQuoteSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, ip }) => {
    const quote = await respondToQuote({ token: params.token, input: body, ip });

    return ok({
      status: quote.status,
      acceptedAt: quote.acceptedAt,
      rejectedAt: quote.rejectedAt,
    });
  },
});
