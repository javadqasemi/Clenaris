import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { assignableRoles } from '@/lib/auth/rbac';
import { ForbiddenError } from '@/lib/errors';
import { createEmployeeSchema } from '@/lib/validation/operations';
import { employeeListQuery } from '@/lib/validation/queries';
import { createEmployee, listEmployees } from '@/server/services/employee.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/employees
 *
 * Ohne Blätterung: ein Reinigungsbetrieb dieser Grösse hat Dutzende, nicht
 * Tausende Mitarbeitende, und Disposition und Zuweisung brauchen die
 * vollständige Liste in einem Zug.
 */
export const GET = defineRoute({
  permissions: ['employee:read'],
  query: employeeListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const organizationId = await getOrganizationId();

    const employees = await listEmployees({
      organizationId,
      q: query.q,
      includeInactive: query.includeInactive,
    });

    return ok(employees);
  },
});

/**
 * POST /api/employees — Mitarbeitende/n anlegen.
 *
 * Legt zugleich das Benutzerkonto an und versendet die Einladung. Ein
 * Personaldatensatz ohne Login wäre nutzlos: ohne Portal keine Zeiterfassung,
 * ohne Zeiterfassung keine Lohnbasis.
 *
 * Bewusst nur für die Administration und die Systemverantwortung: mit dem
 * Datensatz entstehen Lohnfelder, AHV-Nummer und IBAN. (Die Systemverantwortung
 * fehlte in der Liste — sie konnte kein Personal anlegen, obwohl sie alles
 * andere darf.)
 *
 * Die Rolle des neuen Kontos ist eine Rollenvergabe und unterliegt derselben
 * Regel wie `/api/users`: Mitarbeitende darf jede zugelassene Person anlegen,
 * alles darüber nur, wer `role:assign` hat. Sonst wäre die Personalmaske ein
 * Umweg, über den sich die Administration eine zweite Administration erzeugt.
 */
export const POST = defineRoute({
  roles: ['ADMIN', 'SUPER_ADMIN'],
  body: createEmployeeSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();

    if (body.role !== 'EMPLOYEE' && !assignableRoles(session.role).includes(body.role)) {
      throw new ForbiddenError(
        'Für diese Rolle fehlt Ihnen die Berechtigung. Rollen vergibt die Systemverantwortung.',
      );
    }

    const employee = await createEmployee({
      organizationId,
      input: body,
      actorId: session.id,
    });

    return created({ id: employee.id, employeeNumber: employee.employeeNumber });
  },
});
