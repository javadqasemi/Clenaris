import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { contractBillingBasisQuerySchema } from '@/lib/validation/contracts';
import { idParam } from '@/lib/validation/queries';
import { contractBillingBasis } from '@/server/services/contract.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/contracts/{id}/billing-basis — was für eine Periode aus diesem
 * Vertrag zu fakturieren ist.
 *
 * **Rechnet, schreibt nichts.** Die Rechnung entsteht über den
 * Rechnungsdienst, damit Nummernkreis, Belegregeln und Append-only an genau
 * einer Stelle bleiben. Hier steht die Herleitung — und zwar mit jeder
 * Zwischengrösse: Preismodell, Zahl der Einsätze, freigegebene Minuten,
 * Menge, Satz. Eine Summe, die sich nicht nachrechnen lässt, erzeugt eine
 * Rückfrage je Monat und je Kundschaft.
 *
 * Jede Position trägt ihre **Vertragsversion**. Bei einem Vertrag, der sich
 * geändert hat, ist eine Rechnungssumme ohne diese Zuordnung nicht mehr
 * prüfbar — und eine spätere Vertragsänderung darf eine ausgestellte Rechnung
 * nicht berühren.
 *
 * Gezählt werden nur **abgeschlossene** und **geprüfte** Einsätze; bei
 * Stundenabrechnung nur **freigegebene** Zeiten. Der Ertrag aus Wave 8: Was
 * niemand geprüft hat, wird nicht verrechnet.
 */
export const GET = defineRoute({
  permissions: ['contract:billing'],
  params: idParam,
  query: contractBillingBasisQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ params, query }) =>
    ok(
      await contractBillingBasis({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        von: query.von,
        bis: query.bis,
      }),
    ),
});
