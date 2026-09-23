import { binaerAntwort } from '@/lib/api/binary-response';
import { defineRoute } from '@/lib/api/handler';
import { can } from '@/lib/auth/rbac';
import { ForbiddenError } from '@/lib/errors';
import { payrollIdParam } from '@/lib/validation/payroll';
import { getOrganizationId } from '@/server/services/organization.service';
import { getSalaryCertificatePdf } from '@/server/services/salary-certificate.service';

export const runtime = 'nodejs';

/**
 * GET /api/payroll/certificates/:id/pdf — das beim Abschliessen erzeugte PDF,
 * gespeicherte Bytes mit Prüfsummenvergleich. Für die eigene Person nur der
 * eigene, abgeschlossene Ausweis (Bedingung in der Abfrage).
 */
export const GET = defineRoute({
  permissions: ['payslip:read_own', 'payslip:read_all'],
  anyPermission: true,
  params: payrollIdParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session, ip, request }) => {
    const alle = can(session.role, 'payslip:read_all');
    if (!alle && !session.profileId) {
      throw new ForbiddenError('Für Ihr Konto ist kein Mitarbeitendenprofil hinterlegt.');
    }
    const { bytes, filename } = await getSalaryCertificatePdf({
      organizationId: await getOrganizationId(),
      id: params.id,
      ...(alle ? {} : { employeeId: session.profileId! }),
      actorId: session.id,
      ip,
    });
    return binaerAntwort({
      bytes,
      mimeType: 'application/pdf',
      filename,
      disposition: 'attachment',
      request,
      cacheControl: 'private, no-store',
    });
  },
});
