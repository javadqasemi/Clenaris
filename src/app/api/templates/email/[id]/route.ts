import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { updateEmailTemplateSchema } from '@/lib/validation/operations-admin';
import { updateEmailTemplate } from '@/server/services/operations-admin.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/templates/email/:id
 *
 * Platzhalter dürfen wegfallen, aber keine neuen dazukommen: ein Platzhalter,
 * den der Versand nicht füllt, erscheint wörtlich in der E-Mail an die
 * Kundschaft. Die Fehlermeldung nennt die verfügbaren.
 */
export const PATCH = defineRoute({
  permissions: ['template:update'],
  params: idParam,
  body: updateEmailTemplateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const template = await updateEmailTemplate({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      templateId: params.id,
      input: body,
    });
    return ok({ id: template.id, key: template.key });
  },
});
