import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { payrollEmployeeParam, payrollProfileSchema } from '@/lib/validation/payroll';
import { getOrganizationId } from '@/server/services/organization.service';
import { getPayrollProfile, upsertPayrollProfile } from '@/server/services/payroll-stamm.service';

export const runtime = 'nodejs';

/**
 * GET /api/payroll/profiles/:employeeId — die Lohnvereinbarungen einer Person
 * (13. Monatslohn, Ferien- und Feiertagsentschädigung).
 *
 * Nur mit `payslip:create`, nicht über die Personalakte: Die Akte liest auch
 * die Betriebsleitung, die bewusst keinen Lohneinblick hat.
 */
export const GET = defineRoute({
  permissions: ['payslip:create'],
  params: payrollEmployeeParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => ok(await getPayrollProfile(await getOrganizationId(), params.employeeId)),
});

/**
 * PUT /api/payroll/profiles/:employeeId — die Vereinbarungen setzen.
 *
 * Ganzheitlich (PUT), weil die Felder zusammengehören: Art und
 * Auszahlungsmonat des 13. ergeben nur gemeinsam einen Sinn. Eine berechnete,
 * unveröffentlichte Abrechnung dieser Person wird als veraltet markiert.
 */
export const PUT = defineRoute({
  permissions: ['payslip:create'],
  params: payrollEmployeeParam,
  body: payrollProfileSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await upsertPayrollProfile({
        organizationId: await getOrganizationId(),
        employeeId: params.employeeId,
        actorId: session.id,
        ip,
        input: body,
      }),
    ),
});
