import { defineRoute } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { serviceScheduleSchema } from '@/lib/validation/contracts';
import { idParam } from '@/lib/validation/queries';
import { deleteSchedule, updateSchedule } from '@/server/services/contract-schedule.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/contract-schedules/{id} — eine Serie ändern.
 *
 * Bereits erzeugte Einsätze bleiben, wie sie sind. Das ist Absicht: Sie sind
 * disponiert, vielleicht schon angekündigt, vielleicht schon geleistet. Eine
 * Planänderung, die rückwirkend Termine verschöbe, wäre eine, die man dem
 * Team nicht mehr erklären kann.
 *
 * Wirkung hat die Änderung ab dem nächsten Planungslauf — und weil
 * `generatedUntil` stehen bleibt, erst jenseits des bereits geplanten
 * Zeitraums. Wer früher wirken will, verschiebt einzelne Termine über eine
 * Ausnahme.
 */
export const PATCH = defineRoute({
  permissions: ['contract:version'],
  params: idParam,
  body: serviceScheduleSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await updateSchedule({
        organizationId: await getOrganizationId(),
        scheduleId: params.id,
        actorId: session.id,
        ip,
        input: body,
      }),
    ),
});

/**
 * DELETE /api/contract-schedules/{id} — eine Serie entfernen.
 *
 * Hängen bereits Einsätze daran, wird sie **stillgelegt statt gelöscht**, und
 * die Antwort trägt den stillgelegten Plan statt eines 204. Sonst verlören die
 * Einsätze ihre Herkunft, und die Frage „aus welchem Plan kam dieser Termin"
 * wäre für immer unbeantwortbar.
 */
export const DELETE = defineRoute({
  permissions: ['contract:version'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    const ergebnis = await deleteSchedule({
      organizationId: await getOrganizationId(),
      scheduleId: params.id,
      actorId: session.id,
      ip,
    });
    return ergebnis ? ok(ergebnis) : noContent();
  },
});
