import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { payrollSettingsSchema } from '@/lib/validation/payroll';
import { payrollYearQuery } from '@/lib/validation/queries';
import { getOrganizationId } from '@/server/services/organization.service';
import {
  getOrCreatePayrollSettings,
  updatePayrollSettings,
} from '@/server/services/payroll.service';

export const runtime = 'nodejs';

/**
 * GET /api/payroll/settings?year=2026 — die Beitragssätze eines Jahres.
 *
 * Legt sie an, wenn es sie noch nicht gibt — mit den gesetzlichen Vorgaben und,
 * sofern vorhanden, den betriebsabhängigen Sätzen des Vorjahres. Die
 * Alternative wäre, mit „bitte zuerst erfassen" abzuweisen; das klingt
 * gründlicher und verschiebt die Arbeit nur an den ungünstigsten Moment.
 */
export const GET = defineRoute({
  permissions: ['payslip:create'],
  query: payrollYearQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) =>
    ok(await getOrCreatePayrollSettings(await getOrganizationId(), query.year)),
});

/**
 * PATCH /api/payroll/settings?year=2026 — die Sätze pflegen.
 *
 * ---------------------------------------------------------------------------
 *  Warum das eine eigene Berechtigung hat
 * ---------------------------------------------------------------------------
 *
 * Wer hier eine Zahl ändert, ändert den Nettolohn **aller** Mitarbeitenden für
 * ein ganzes Jahr. Das ist die weitreichendste Eingabe des ganzen
 * Personalbereichs und gehört nicht mit dem Erstellen einer Abrechnung
 * zusammengelegt — Erstellen ist ein Rechenlauf, den man wiederholen kann.
 *
 * ---------------------------------------------------------------------------
 *  Eine Grenze, die das Schema zieht
 * ---------------------------------------------------------------------------
 *
 * `bvgAnteilArbeitnehmer` ist auf 50 % gedeckelt: Gesetzlich trägt der Betrieb
 * mindestens die Hälfte der Altersgutschrift (Art. 66 BVG). Ein höherer Wert
 * wäre kein Tippfehler, den man durchlassen sollte — er stünde auf jeder
 * Abrechnung des Jahres.
 *
 * Alte Jahre bleiben unberührt: Eine nachträgliche Korrektur einer Abrechnung
 * von 2025 muss mit den Sätzen von 2025 rechnen.
 */
export const PATCH = defineRoute({
  permissions: ['payslip:publish'],
  query: payrollYearQuery,
  body: payrollSettingsSchema,
  rateLimit: 'apiWrite',
  handler: async ({ query, body, session, ip }) =>
    ok(
      await updatePayrollSettings({
        organizationId: await getOrganizationId(),
        year: query.year,
        actorId: session.id,
        ip,
        input: body,
      }),
    ),
});
