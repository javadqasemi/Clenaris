import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { payrollPublishSchema } from '@/lib/validation/payroll';
import { getOrganizationId } from '@/server/services/organization.service';
import { publishPayslips } from '@/server/services/payroll.service';

export const runtime = 'nodejs';

/**
 * POST /api/payroll/publish — Abrechnungen veröffentlichen.
 *
 * Damit werden sie unter `/portal/lohn` sichtbar und **unveränderlich**.
 * Dieselbe Schwelle wie beim Ausstellen einer Rechnung, und aus demselben
 * Grund: Ab hier ist die Zahl bei jemandem angekommen.
 *
 * **Es gibt kein Zurücknehmen.** Eine Abrechnung, die wieder verschwindet, ist
 * schlimmer als eine falsche, die korrigiert wird — die betroffene Person hat
 * sie gesehen, vielleicht ausgedruckt, vielleicht danach geplant. Korrekturen
 * laufen über die Abrechnung des Folgemonats.
 *
 * Eigene Berechtigung (`payslip:publish`), nicht `payslip:create`: Erstellen
 * ist ein Rechenlauf, den man wiederholen kann. Veröffentlichen ist
 * endgültig.
 */
export const POST = defineRoute({
  permissions: ['payslip:publish'],
  body: payrollPublishSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) =>
    ok(
      await publishPayslips({
        organizationId: await getOrganizationId(),
        payslipIds: body.payslipIds,
        actorId: session.id,
        ip,
      }),
    ),
});
