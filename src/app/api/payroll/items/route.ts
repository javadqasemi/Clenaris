import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { payrollItemCreateSchema, payrollItemQuerySchema } from '@/lib/validation/payroll';
import { getOrganizationId } from '@/server/services/organization.service';
import { createPayrollItem, listPayrollItems } from '@/server/services/payroll-stamm.service';

export const runtime = 'nodejs';

/** GET /api/payroll/items — Lohnpositionen (Überstunden, Zulagen, Spesen, Korrekturen, Abzüge). */
export const GET = defineRoute({
  permissions: ['payslip:create'],
  query: payrollItemQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ query }) =>
    ok(
      await listPayrollItems({
        organizationId: await getOrganizationId(),
        year: query.year,
        month: query.month,
        employeeId: query.employeeId,
      }),
    ),
});

/**
 * POST /api/payroll/items — eine Position erfassen.
 *
 * Bei Überstunden rechnet der Server den Betrag (Stunden × Ansatz × Zuschlag);
 * ein mitgeschickter Betrag wird abgewiesen. In einen veröffentlichten Monat
 * wird nicht erfasst — die Korrektur gehört in einen offenen Monat.
 */
export const POST = defineRoute({
  permissions: ['payslip:create'],
  body: payrollItemCreateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) =>
    created(await createPayrollItem({ organizationId: await getOrganizationId(), actorId: session.id, ip, input: body })),
});
