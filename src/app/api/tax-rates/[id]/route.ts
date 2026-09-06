import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateTaxRateSchema } from '@/lib/validation/catalog';
import { deleteTaxRate, updateTaxRate } from '@/server/services/catalog.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/tax-rates/:id */
export const PATCH = defineRoute({
  permissions: ['pricing:update'],
  params: idParam,
  body: updateTaxRateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const rate = await updateTaxRate({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      taxRateId: params.id,
      input: body,
    });
    return ok({ id: rate.id, isDefault: rate.isDefault });
  },
});

/** DELETE /api/tax-rates/:id — der Standardsatz ist geschützt. */
export const DELETE = defineRoute({
  permissions: ['pricing:update'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await deleteTaxRate({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      taxRateId: params.id,
    });
    return noContent();
  },
});
