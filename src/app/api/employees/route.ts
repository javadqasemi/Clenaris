import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
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
 * Bewusst nur für ADMIN: mit dem Datensatz entstehen Lohnfelder, AHV-Nummer
 * und IBAN.
 */
export const POST = defineRoute({
  roles: ['ADMIN'],
  body: createEmployeeSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();

    const employee = await createEmployee({
      organizationId,
      input: body,
      actorId: session.id,
    });

    return created({ id: employee.id, employeeNumber: employee.employeeNumber });
  },
});
