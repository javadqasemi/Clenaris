import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updatePriceRuleSchema } from '@/lib/validation/catalog';
import { deletePriceRule, updatePriceRule } from '@/server/services/catalog.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/price-rules/:id */
export const PATCH = defineRoute({
  permissions: ['pricing:update'],
  params: idParam,
  body: updatePriceRuleSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const rule = await updatePriceRule({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      ruleId: params.id,
      input: body,
    });
    return ok({ id: rule.id, active: rule.active });
  },
});

/**
 * DELETE /api/price-rules/:id
 *
 * Ohne Rückfrage löschbar: eine Preisregel hinterlässt keine Spur in
 * bestehenden Belegen — der Zuschlag steht dort als eigene Position mit
 * eigenem Betrag.
 */
export const DELETE = defineRoute({
  permissions: ['pricing:update'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await deletePriceRule({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      ruleId: params.id,
    });
    return noContent();
  },
});
