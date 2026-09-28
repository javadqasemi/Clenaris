import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { idParam } from '@/lib/validation/queries';
import { getOrganizationId } from '@/server/services/organization.service';
import { inspectionDue } from '@/server/services/quality.service';

export const runtime = 'nodejs';

/**
 * GET /api/contracts/{id}/quality — die Qualitätszusage und ihr Stand.
 *
 * Der Endpunkt, der die drei SLA-Felder der Vertragsfassung endlich
 * **misst**, statt sie nur zu speichern: zugesagter Zielwert, vereinbartes
 * Kontrollintervall, die letzte abgeschlossene Begehung und wann die nächste
 * ansteht.
 *
 * Gerechnet ab der **letzten durchgeführten** Kontrolle, nicht ab dem
 * Vertragsbeginn: Wer früher kontrolliert als vereinbart, verschiebt die
 * nächste Frist nach hinten — sonst häuften sich Termine an, die niemand
 * gewollt hat. Gab es noch keine, zählt der Vertragsbeginn.
 *
 * Ein **Entwurf zählt nicht** als Kontrolle. Er sagt, dass jemand begonnen
 * hat, nicht dass kontrolliert wurde.
 *
 * Ohne vereinbartes Intervall gibt es keine Fälligkeit, und ohne zugesagten
 * Zielwert kein Urteil. Das Produkt erfindet keinen Massstab, auf den sich
 * niemand geeinigt hat.
 */
export const GET = defineRoute({
  permissions: ['quality:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) =>
    ok(
      await inspectionDue({
        organizationId: await getOrganizationId(),
        contractId: params.id,
      }),
    ),
});
