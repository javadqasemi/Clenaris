import { binaerAntwort } from '@/lib/api/binary-response';
import { defineRoute, idParam } from '@/lib/api/handler';
import { can } from '@/lib/auth/rbac';
import { ForbiddenError } from '@/lib/errors';
import { getOrganizationId } from '@/server/services/organization.service';
import { getPayslipPdf } from '@/server/services/payroll.service';

export const runtime = 'nodejs';

/**
 * GET /api/payroll/payslips/:id/pdf — das beim Veröffentlichen erzeugte PDF.
 *
 * **Nichts wird neu gerechnet oder gerendert.** Ausgeliefert werden die
 * gespeicherten Bytes, nach Prüfsummenvergleich. Eine unveröffentlichte
 * Abrechnung hat kein PDF und existiert für diesen Endpunkt nicht (404).
 *
 * Wer nur `payslip:read_own` hält, bekommt ausschliesslich die eigene
 * Abrechnung — die Bedingung steht in der Abfrage, nicht in einer Prüfung
 * danach.
 */
export const GET = defineRoute({
  permissions: ['payslip:read_own', 'payslip:read_all'],
  anyPermission: true,
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session, ip, request }) => {
    const alle = can(session.role, 'payslip:read_all');
    if (!alle && !session.profileId) {
      throw new ForbiddenError('Für Ihr Konto ist kein Mitarbeitendenprofil hinterlegt.');
    }
    const { bytes, filename } = await getPayslipPdf({
      organizationId: await getOrganizationId(),
      payslipId: params.id,
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
