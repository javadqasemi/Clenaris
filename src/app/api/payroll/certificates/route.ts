import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { can } from '@/lib/auth/rbac';
import { ForbiddenError } from '@/lib/errors';
import { salaryCertificateCreateSchema, salaryCertificateQuerySchema } from '@/lib/validation/payroll';
import { getOrganizationId } from '@/server/services/organization.service';
import { createSalaryCertificate, listSalaryCertificates } from '@/server/services/salary-certificate.service';

export const runtime = 'nodejs';

/**
 * GET /api/payroll/certificates — Lohnausweis-Aufstellungen.
 *
 * Wer nur die eigenen Abrechnungen sehen darf, sieht nur die eigenen
 * **abgeschlossenen** Aufstellungen; ein Entwurf ändert sich noch.
 */
export const GET = defineRoute({
  permissions: ['payslip:read_own', 'payslip:read_all'],
  anyPermission: true,
  query: salaryCertificateQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ query, session }) => {
    const alle = can(session.role, 'payslip:read_all');
    if (!alle && !session.profileId) {
      throw new ForbiddenError('Für Ihr Konto ist kein Mitarbeitendenprofil hinterlegt.');
    }
    return ok(
      await listSalaryCertificates({
        organizationId: await getOrganizationId(),
        year: query.year,
        employeeId: alle ? query.employeeId : session.profileId!,
        nurAbgeschlossen: !alle,
      }),
    );
  },
});

/**
 * POST /api/payroll/certificates — die Aufstellung eines Jahres aus den
 * veröffentlichten Abrechnungen verdichten (Entwurf). Kein amtliches
 * Formular 11; die Ziffernzuordnung ist fachlich zu prüfen.
 */
export const POST = defineRoute({
  permissions: ['payslip:create'],
  body: salaryCertificateCreateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) =>
    created(
      await createSalaryCertificate({
        organizationId: await getOrganizationId(),
        employeeId: body.employeeId,
        year: body.year,
        actorId: session.id,
        ip,
      }),
    ),
});
