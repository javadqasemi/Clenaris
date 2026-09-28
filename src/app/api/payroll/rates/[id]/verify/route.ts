import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { payrollIdParam, payrollRateVerifySchema } from '@/lib/validation/payroll';
import { getOrganizationId } from '@/server/services/organization.service';
import { verifyPayrollRate } from '@/server/services/payroll-rates.service';

export const runtime = 'nodejs';

/**
 * POST /api/payroll/rates/:id/verify — eine Version als fachlich geprüft
 * bestätigen, mit Vermerk, worauf sich die Bestätigung stützt.
 *
 * Die Bestätigung ist eine Aussage der Person, die sie abgibt — nicht des
 * Systems. Das System prüft keinen Satz gegen eine amtliche Quelle.
 */
export const POST = defineRoute({
  permissions: ['payslip:publish'],
  params: payrollIdParam,
  body: payrollRateVerifySchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await verifyPayrollRate({
        organizationId: await getOrganizationId(),
        id: params.id,
        actorId: session.id,
        ip,
        note: body.note,
      }),
    ),
});
