import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { payrollRunSchema } from '@/lib/validation/payroll';
import { getOrganizationId } from '@/server/services/organization.service';
import { generatePayslips } from '@/server/services/payroll.service';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * POST /api/payroll/run — den Lohnlauf eines Monats starten.
 *
 * ---------------------------------------------------------------------------
 *  Was dieser Endpunkt voraussetzt
 * ---------------------------------------------------------------------------
 *
 * **Freigegebene Zeiten.** Nur sie fliessen in den Bruttolohn. Offene
 * Erfassungen werden gezählt und in der Antwort gemeldet, aber nicht bezahlt.
 * Die Reihenfolge — erst freigeben, dann abrechnen — ist keine Bequemlichkeit,
 * sondern die Kontrolle: Eine Abrechnung, die ungeprüfte Stunden mitnimmt,
 * zahlt Stunden aus, die niemand angesehen hat.
 *
 * **Einen abgeschlossenen Monat.** Ein laufender Monat wird abgewiesen (422).
 * Der Fall dahinter: Am 12. einen Lauf starten, weil man „schon mal schauen"
 * will — das Ergebnis sähe aus wie eine Abrechnung und wäre um zwei Drittel zu
 * tief. Wer die Zwischenzahl braucht, nimmt die Zeiterfassung.
 *
 * ---------------------------------------------------------------------------
 *  Idempotenz
 * ---------------------------------------------------------------------------
 *
 * Ein zweiter Lauf über denselben Monat ist unbedenklich: Noch nicht
 * veröffentlichte Abrechnungen werden mit dem aktuellen Stand überschrieben,
 * veröffentlichte bleiben unberührt und werden als übersprungen gemeldet.
 * Genau das ist der Nachlauf, wenn eine vergessene Zeit nachträglich
 * freigegeben wurde.
 *
 * Die Antwort meldet ausserdem, ob die Beitragssätze des Jahres schon einmal
 * bestätigt wurden (`saetzeGeprueft`). Solange nicht, sind UVG-Satz und
 * BVG-Plan Vorbelegungen — und die stehen im Versicherungsvertrag, nicht im
 * Gesetz.
 */
export const POST = defineRoute({
  permissions: ['payslip:create'],
  body: payrollRunSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) =>
    ok(
      await generatePayslips({
        organizationId: await getOrganizationId(),
        year: body.year,
        month: body.month,
        employeeIds: body.employeeIds,
        actorId: session.id,
        ip,
      }),
    ),
});
