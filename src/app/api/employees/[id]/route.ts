import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { can } from '@/lib/auth/rbac';
import { updateEmployeeSchema } from '@/lib/validation/operations';
import { getEmployeeDetail, updateEmployee } from '@/server/services/employee.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/employees/:id — Personalakte.
 *
 * Lohn, AHV-Nummer und Bankverbindung liefert der Dienst nur mit
 * `includeSensitive`. Die Schwelle dafür ist bewusst **nicht** das Lesen der
 * Akte, sondern `payslip:create` — wer Lohnabrechnungen erstellt, braucht die
 * Zahlen; die Betriebsleitung, die Einsätze plant und Ferien bewilligt,
 * braucht sie nicht. Das ist der Unterschied zwischen „darf die Akte sehen"
 * und „darf den Lohn sehen", und er ist nach DSG bedeutsam: es sind besonders
 * schützenswerte Personendaten.
 */
export const GET = defineRoute({
  permissions: ['employee:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session }) =>
    ok(
      await getEmployeeDetail({
        organizationId: await getOrganizationId(),
        employeeId: params.id,
        includeSensitive: can(session.role, 'payslip:create'),
      }),
    ),
});

/**
 * PATCH /api/employees/:id
 *
 * Lohn- und AHV-Angaben stecken im selben Schema. Sie sind besonders
 * schützenswerte Personendaten nach DSG; das Prüfprotokoll redigiert sie
 * bereits beim Schreiben.
 */
export const PATCH = defineRoute({
  permissions: ['employee:update'],
  params: idParam,
  body: updateEmployeeSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const employee = await updateEmployee({
      organizationId: await getOrganizationId(),
      employeeId: params.id,
      input: body,
      actorId: session.id,
    });
    return ok({ id: employee.id });
  },
});
