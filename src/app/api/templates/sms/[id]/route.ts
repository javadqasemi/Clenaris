import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { updateSmsTemplateSchema } from '@/lib/validation/operations-admin';
import { updateSmsTemplate } from '@/server/services/operations-admin.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/templates/sms/:id
 *
 * Höchstens 480 Zeichen — das sind drei SMS-Segmente. Darüber wird der Versand
 * teurer, ohne dass es jemand bemerkt.
 */
export const PATCH = defineRoute({
  permissions: ['template:update'],
  params: idParam,
  body: updateSmsTemplateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const template = await updateSmsTemplate({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      templateId: params.id,
      input: body,
    });
    return ok({ id: template.id, key: template.key });
  },
});
