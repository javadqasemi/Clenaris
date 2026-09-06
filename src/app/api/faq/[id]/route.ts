import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateFaqSchema } from '@/lib/validation/website';
import { deleteFaq, updateFaq } from '@/server/services/website.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/faq/:id — Teil-Update. */
export const PATCH = defineRoute({
  permissions: ['faq:update'],
  params: idParam,
  body: updateFaqSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const row = await updateFaq({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      faqId: params.id,
      input: body,
    });
    return ok({ id: row.id });
  },
});

/**
 * DELETE /api/faq/:id
 *
 * Endgültig — eine Frage ist schnell neu erfasst, ein Papierkorb wäre hier mehr Verwaltung als Nutzen.
 */
export const DELETE = defineRoute({
  permissions: ['faq:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await deleteFaq({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      faqId: params.id,
    });
    return noContent();
  },
});
