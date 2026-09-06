import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createAutomationSchema } from '@/lib/validation/operations-admin';
import { createAutomation, listAutomations } from '@/server/services/operations-admin.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/automations — Regeln samt Aktionen und Laufzahl. */
export const GET = defineRoute({
  permissions: ['automation:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await listAutomations(await getOrganizationId())),
});

/**
 * POST /api/automations — Regel anlegen.
 *
 * Mindestens eine Aktion ist Pflicht: eine Regel ohne Aktion löst aus und tut
 * nichts — sie stünde in der Liste und wäre nicht als wirkungslos erkennbar.
 */
export const POST = defineRoute({
  permissions: ['automation:update'],
  body: createAutomationSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const automation = await createAutomation({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return created({ id: automation.id, name: automation.name });
  },
});
