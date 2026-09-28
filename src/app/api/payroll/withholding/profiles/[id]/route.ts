import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { payrollIdParam, withholdingProfileUpdateSchema } from '@/lib/validation/payroll';
import { getOrganizationId } from '@/server/services/organization.service';
import { deleteWithholdingProfile, updateWithholdingProfile } from '@/server/services/payroll-stamm.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/payroll/withholding/profiles/:id — Liegt eine veröffentlichte
 * Abrechnung im Zeitraum, sind nur Ende und Notiz änderbar; ein Tarifwechsel
 * ist ein neues Profil ab dem Wechseltag.
 */
export const PATCH = defineRoute({
  permissions: ['payslip:create'],
  params: payrollIdParam,
  body: withholdingProfileUpdateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await updateWithholdingProfile({
        organizationId: await getOrganizationId(),
        id: params.id,
        actorId: session.id,
        ip,
        input: body,
      }),
    ),
});

/** DELETE /api/payroll/withholding/profiles/:id — nur ohne veröffentlichte Abrechnung im Zeitraum. */
export const DELETE = defineRoute({
  permissions: ['payslip:create'],
  params: payrollIdParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) =>
    ok(await deleteWithholdingProfile({ organizationId: await getOrganizationId(), id: params.id, actorId: session.id, ip })),
});
