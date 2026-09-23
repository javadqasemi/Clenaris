import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { payslipReviewSchema } from '@/lib/validation/payroll';
import { getOrganizationId } from '@/server/services/organization.service';
import { resolvePayslipReview } from '@/server/services/payroll.service';

export const runtime = 'nodejs';

/**
 * POST /api/payroll/payslips/:id/review — eine zur Prüfung markierte
 * Abrechnung freigeben (etwa: Quellensteuer ohne Tarif, bewusst ausserhalb
 * abgerechnet). Die Notiz ist Pflicht. Eine **veraltete** Abrechnung lässt
 * sich so nicht freigeben — sie wird neu gerechnet.
 */
export const POST = defineRoute({
  permissions: ['payslip:publish'],
  params: idParam,
  body: payslipReviewSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await resolvePayslipReview({
        organizationId: await getOrganizationId(),
        payslipId: params.id,
        actorId: session.id,
        note: body.note,
        ip,
      }),
    ),
});
