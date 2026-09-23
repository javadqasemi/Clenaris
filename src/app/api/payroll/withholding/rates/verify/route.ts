import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { withholdingRateVerifySchema } from '@/lib/validation/payroll';
import { getOrganizationId } from '@/server/services/organization.service';
import { verifyWithholdingRates } from '@/server/services/payroll-stamm.service';

export const runtime = 'nodejs';

/**
 * POST /api/payroll/withholding/rates/verify — einen eingelesenen Stapel als
 * geprüft bestätigen (Abgleich mit der Quelle), mit Vermerk.
 */
export const POST = defineRoute({
  permissions: ['payslip:publish'],
  body: withholdingRateVerifySchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) =>
    ok(
      await verifyWithholdingRates({
        organizationId: await getOrganizationId(),
        importBatch: body.importBatch,
        note: body.note,
        actorId: session.id,
        ip,
      }),
    ),
});
