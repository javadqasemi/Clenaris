import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { payrollIdParam } from '@/lib/validation/payroll';
import { getOrganizationId } from '@/server/services/organization.service';
import { finalizeSalaryCertificate } from '@/server/services/salary-certificate.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/payroll/certificates/:id/finalize — den Entwurf abschliessen:
 * PDF erzeugen, ablegen, unveränderlich machen. Eine Korrektur danach ist
 * eine neue Version.
 */
export const POST = defineRoute({
  permissions: ['payslip:publish'],
  params: payrollIdParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) =>
    ok(await finalizeSalaryCertificate({ organizationId: await getOrganizationId(), id: params.id, actorId: session.id, ip })),
});
