import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { payrollIdParam, payrollRateUpdateSchema } from '@/lib/validation/payroll';
import { getOrganizationId } from '@/server/services/organization.service';
import { updatePayrollRate } from '@/server/services/payroll-rates.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/payroll/rates/:id — eine noch nicht benutzte Version ändern.
 *
 * Setzt den Prüfstand zurück: Bestätigt wurde der alte Wert. Ist die Version
 * schon in eine veröffentlichte Abrechnung eingeflossen, lehnt der Dienst ab
 * (422) — und die Datenbank ebenfalls (Trigger `payroll_rates_unveraenderlich`).
 */
export const PATCH = defineRoute({
  permissions: ['payslip:publish'],
  params: payrollIdParam,
  body: payrollRateUpdateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await updatePayrollRate({
        organizationId: await getOrganizationId(),
        id: params.id,
        actorId: session.id,
        ip,
        input: body,
      }),
    ),
});
