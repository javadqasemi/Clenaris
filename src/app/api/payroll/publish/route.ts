import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { payrollPublishSchema } from '@/lib/validation/payroll';
import { getOrganizationId } from '@/server/services/organization.service';
import { publishPayslips } from '@/server/services/payroll.service';

export const runtime = 'nodejs';
// Je Abrechnung ein PDF — ein ganzer Monat braucht mehr als die üblichen Sekunden.
export const maxDuration = 120;

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
 *
 * Seit dem Ausbau vom 2026-09-23: Beim Veröffentlichen entsteht das PDF
 * (einmal, gespeichert, mit Prüfsumme). Abrechnungen mit offener Prüfung
 * werden übersprungen und mit Grund gemeldet. Mit ungeprüften
 * Beitragssätzen wird nur veröffentlicht, wenn `trotzUngepruefterSaetze`
 * ausdrücklich gesetzt ist — sonst 422.
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
        trotzUngepruefterSaetze: body.trotzUngepruefterSaetze,
        actorId: session.id,
        ip,
      }),
    ),
});
