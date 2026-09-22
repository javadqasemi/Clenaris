import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { contractActivateSchema } from '@/lib/validation/contracts';
import { idParam } from '@/lib/validation/queries';
import { activateContract } from '@/server/services/contract.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/contracts/{id}/activate — den Vertrag in Kraft setzen.
 *
 * Drei Dinge entstehen hier in **einer** Transaktion: die Vertragsnummer aus
 * dem Nummernkreis, die geltende Version und der Zustand. Sie auseinander zu
 * ziehen hiesse, einen Moment zuzulassen, in dem ein Vertrag aktiv ist und
 * keine Version hat — und in dem eine Abrechnung mit null rechnet.
 *
 * Die Nummer entsteht erst hier und nicht beim Anlegen: Ein verworfener
 * Entwurf soll keine Lücke hinterlassen. Scheitert die Aktivierung, rollt die
 * Nummer mit zurück.
 *
 * Abgewiesen wird (422): ein Vertrag ohne Leistungen — er erzeugte weder
 * Einsätze noch Abrechnung; und jeder Übergang, den der Zustandsautomat nicht
 * kennt.
 *
 * **Eigene Berechtigung.** `contract:activate` hat die Betriebsleitung
 * ausdrücklich nicht: Ein Vertrag bindet den Betrieb über Monate, und das ist
 * eine Zusage nach aussen.
 */
export const POST = defineRoute({
  permissions: ['contract:activate'],
  params: idParam,
  body: contractActivateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await activateContract({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        actorId: session.id,
        ip,
        effectiveFrom: body.effectiveFrom,
        note: body.note,
      }),
    ),
});
