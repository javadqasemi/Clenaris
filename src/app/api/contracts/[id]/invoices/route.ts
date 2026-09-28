import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import {
  contractBillingOverviewQuerySchema,
  contractInvoiceSchema,
} from '@/lib/validation/contracts';
import { idParam } from '@/lib/validation/queries';
import {
  contractBillingOverview,
  createContractInvoice,
} from '@/server/services/contract-billing.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/contracts/{id}/invoices — welche Perioden fakturiert sind und
 * welche offen.
 *
 * Die Frage des Monatsabschlusses — „was fehlt noch" — beantwortet, ohne dass
 * jemand die Rechnungsliste nach Verträgen durchsehen muss. Die Perioden
 * entstehen aus dem Zyklus der geltenden Version, nicht aus den vorhandenen
 * Rechnungen; eine vergessene Periode wäre sonst unsichtbar, weil zu ihr eben
 * kein Beleg existiert.
 */
export const GET = defineRoute({
  permissions: ['contract:billing'],
  params: idParam,
  query: contractBillingOverviewQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ params, query }) =>
    ok(
      await contractBillingOverview({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        perioden: query.perioden,
      }),
    ),
});

/**
 * POST /api/contracts/{id}/invoices — die Rechnung einer Vertragsperiode
 * erzeugen.
 *
 * **Idempotent.** Ein zweiter Aufruf für dieselbe Periode legt nichts an,
 * sondern gibt die vorhandene Rechnung mit `neu: false` zurück — und antwortet
 * darum mit 200 statt 201. Das ist die Antwort auf den doppelten Klick, auf
 * den Wiederholungsversuch nach einem Netzabbruch und auf zwei gleichzeitig
 * laufende Monatsabschlüsse. Die Zusicherung steht nicht in diesem Handler,
 * sondern als Teilindex in der Datenbank; eine Prüfung im Code wäre eine Wette
 * auf die Zeit zwischen Lesen und Schreiben.
 *
 * **Zwei Berechtigungen.** Wer aus einem Vertrag abrechnet, erzeugt einen
 * Finanzbeleg — `contract:billing` allein genügt dafür nicht.
 *
 * Abgewiesen wird (422): ein Vertrag ohne geltende Fassung, ein Entwurf oder
 * gekündigter Vertrag, der nie in Kraft war, und eine Periode ohne Betrag —
 * bei Abrechnung nach Einsätzen oder Stunden entsteht die Rechnung erst, wenn
 * es etwas abzurechnen gibt.
 */
export const POST = defineRoute({
  permissions: ['contract:billing', 'invoice:create'],
  params: idParam,
  body: contractInvoiceSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const rechnung = await createContractInvoice({
      organizationId: await getOrganizationId(),
      contractId: params.id,
      actorId: session.id,
      stichtag: body.stichtag,
      sofortAusstellen: body.sofortAusstellen,
    });

    return rechnung.neu ? created(rechnung) : ok(rechnung);
  },
});
