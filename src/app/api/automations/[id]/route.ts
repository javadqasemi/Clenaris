import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateAutomationSchema } from '@/lib/validation/operations-admin';
import { deleteAutomation, updateAutomation } from '@/server/services/operations-admin.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/automations/:id
 *
 * `actions` ist der gewünschte Endzustand, kein Zuwachs. Fehlt das Feld,
 * bleiben die Aktionen unangetastet.
 */
export const PATCH = defineRoute({
  permissions: ['automation:update'],
  params: idParam,
  body: updateAutomationSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const automation = await updateAutomation({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      automationId: params.id,
      input: body,
    });
    return ok({ id: automation.id, active: automation.active });
  },
});

/**
 * DELETE /api/automations/:id
 *
 * Nur ohne Laufhistorie. Die Läufe belegen, warum welche Nachricht verschickt
 * wurde; ohne die zugehörige Regel wären sie nicht mehr lesbar. Schalten Sie
 * die Regel stattdessen ab.
 */
export const DELETE = defineRoute({
  permissions: ['automation:update'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await deleteAutomation({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      automationId: params.id,
    });
    return noContent();
  },
});
