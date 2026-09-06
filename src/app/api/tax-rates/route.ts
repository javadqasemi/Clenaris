import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createTaxRateSchema } from '@/lib/validation/catalog';
import { createTaxRate, listTaxRates } from '@/server/services/catalog.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/tax-rates — hinterlegte Mehrwertsteuersätze. */
export const GET = defineRoute({
  permissions: ['pricing:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await listTaxRates(await getOrganizationId())),
});

/**
 * POST /api/tax-rates
 *
 * Wird der neue Satz als Standard markiert, verliert der bisherige diese
 * Markierung in derselben Transaktion — zwei Standardsätze wären ein Zustand,
 * in dem die Sortierung entscheidet, welcher gilt.
 */
export const POST = defineRoute({
  permissions: ['pricing:update'],
  body: createTaxRateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const rate = await createTaxRate({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return created({ id: rate.id, name: rate.name });
  },
});
