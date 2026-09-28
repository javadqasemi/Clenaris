import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { employeeSkillsSchema } from '@/lib/validation/operations';
import { replaceEmployeeSkills } from '@/server/services/employee.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PUT /api/employees/:id/skills — die Qualifikationen setzen.
 *
 * **`PUT` und nicht `PATCH`**, weil die Liste als Ganzes ersetzt wird. Das ist
 * keine Formsache: `PATCH` verspricht eine Teiländerung, und wer das erwartet,
 * schickt eine Qualifikation und verliert die anderen. Die Bedeutung des
 * Verbs soll zum Verhalten passen.
 *
 * Die Begründung für „ersetzen statt abgleichen" steht im Dienst — kurz:
 * Diese Zeilen haben keinen Bezug nach aussen, ein Abgleich wäre nur eine
 * zweite Stelle, an der etwas falsch sein kann, und Ersetzen ist wettlauffrei.
 *
 * `employee:update`, also dieselbe Schwelle wie für die Personalakte selbst.
 * Eine eigene Berechtigung wäre eine Unterscheidung ohne Unterschied:
 * Qualifikationen bestimmen mit, wer einen Einsatz übernehmen darf — das ist
 * nicht weniger tragend als das Eintrittsdatum.
 */
export const PUT = defineRoute({
  permissions: ['employee:update'],
  params: idParam,
  body: employeeSkillsSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await replaceEmployeeSkills({
        organizationId: await getOrganizationId(),
        employeeId: params.id,
        actorId: session.id,
        ip,
        skills: body.skills,
      }),
    ),
});
