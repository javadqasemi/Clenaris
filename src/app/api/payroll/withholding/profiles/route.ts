import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { withholdingProfileCreateSchema, withholdingProfileQuerySchema } from '@/lib/validation/payroll';
import { getOrganizationId } from '@/server/services/organization.service';
import { createWithholdingProfile, listWithholdingProfiles } from '@/server/services/payroll-stamm.service';

export const runtime = 'nodejs';

/**
 * GET /api/payroll/withholding/profiles — Quellensteuerprofile.
 *
 * Konfession (Kirchensteuer) und Kinderzahl sind besonders schützenswerte
 * bzw. persönliche Daten; sie stehen nur hier und sind im Prüfprotokoll
 * geschwärzt.
 */
export const GET = defineRoute({
  permissions: ['payslip:create'],
  query: withholdingProfileQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ query }) =>
    ok(await listWithholdingProfiles({ organizationId: await getOrganizationId(), employeeId: query.employeeId })),
});

/**
 * POST /api/payroll/withholding/profiles — ein Profil ab einem Datum erfassen.
 * Überschneidungen je Person verweigert die Datenbank (Ausschlussbedingung).
 */
export const POST = defineRoute({
  permissions: ['payslip:create'],
  body: withholdingProfileCreateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) =>
    created(await createWithholdingProfile({ organizationId: await getOrganizationId(), actorId: session.id, ip, input: body })),
});
