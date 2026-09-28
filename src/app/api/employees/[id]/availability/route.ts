import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { employeeAvailabilitySchema } from '@/lib/validation/operations';
import { replaceEmployeeAvailability } from '@/server/services/employee.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PUT /api/employees/:id/availability — die Arbeitszeiten setzen.
 *
 * Bis Wave 7 gab es dafür keinen Weg: `createEmployee` legte Montag bis
 * Freitag 07:00–17:00 an, und dabei blieb es für immer. Für einen Betrieb mit
 * Teilzeit, Schichten und Samstagsdiensten ist das keine Vorgabe, sondern eine
 * Behauptung — und die Eignungsprüfung beim Zuteilen warnte entsprechend
 * falsch.
 *
 * **Die Arbeitszeit bleibt eine Planungshilfe, keine Zusage.** Die
 * Eignungsprüfung *warnt* bei einem Einsatz ausserhalb und blockiert ihn
 * nicht; die Begründung steht in `assignment.service.ts`. Diese Route ändert
 * daran nichts — sie macht nur die Angabe pflegbar, auf der die Warnung
 * beruht.
 *
 * Bereits geplante Einsätze werden **nicht** angefasst. Wer die Zeiten
 * einschränkt, wirft damit keine Disposition um.
 */
export const PUT = defineRoute({
  permissions: ['employee:update'],
  params: idParam,
  body: employeeAvailabilitySchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await replaceEmployeeAvailability({
        organizationId: await getOrganizationId(),
        employeeId: params.id,
        actorId: session.id,
        ip,
        availability: body.availability,
      }),
    ),
});
