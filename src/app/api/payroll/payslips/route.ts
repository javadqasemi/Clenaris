import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { payslipQuerySchema } from '@/lib/validation/payroll';
import { getOrganizationId } from '@/server/services/organization.service';
import { listPayslips } from '@/server/services/payroll.service';

export const runtime = 'nodejs';

/**
 * GET /api/payroll/payslips — die Abrechnungen.
 *
 * `payslip:read_all`, und die Berechtigung ist neu: Bis Wave 9 gab es
 * `payslip:read_own` (die eigene Abrechnung im Portal) und `payslip:create`
 * (das Lohneinblicksrecht in der Personalakte) — aber keine Möglichkeit, die
 * Abrechnungen eines Monats nebeneinander zu sehen. Ohne diese Ansicht lässt
 * sich ein Lohnlauf nicht prüfen, bevor er veröffentlicht wird.
 *
 * Die Antwort trägt die Summen über **alle** Treffer. Dieselbe Überlegung wie
 * bei der Zeiterfassung: Eine Seitensumme sähe aus wie die Monatssumme und
 * wäre keine.
 */
export const GET = defineRoute({
  permissions: ['payslip:read_all'],
  query: payslipQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ query }) =>
    ok(
      await listPayslips({
        organizationId: await getOrganizationId(),
        year: query.year,
        month: query.month,
        employeeId: query.employeeId,
        published: query.published === undefined ? undefined : query.published === 'true',
      }),
    ),
});
