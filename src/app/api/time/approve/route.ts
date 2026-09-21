import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { approveTimeEntriesSchema } from '@/lib/validation/operations';
import { getOrganizationId } from '@/server/services/organization.service';
import { approveTimeEntries } from '@/server/services/timetracking.service';

export const runtime = 'nodejs';

/**
 * POST /api/time/approve — Zeiten freigeben.
 *
 * Mehrere auf einmal, weil das der Arbeitsablauf ist: Am Monatsende geht
 * jemand die Liste durch und gibt frei, was stimmt. Ein Endpunkt je Zeile
 * hiesse dreissig Aufrufe für einen Monat, und dreissig Gelegenheiten, in der
 * Mitte abzubrechen.
 *
 * **Eine laufende Erfassung wird übersprungen, nicht abgewiesen.** Ohne Ende
 * gibt es keine Dauer, und eine Freigabe von null Minuten wäre eine Zusage
 * über etwas, das noch nicht feststeht. Ein Abbruch des ganzen Stapels wäre
 * die andere Möglichkeit und die schlechtere: Wer dreissig Zeilen markiert und
 * eine laufende dabei hat, soll die neunundzwanzig freigeben können.
 *
 * Die Antwort sagt beides — was freigegeben wurde und was nicht.
 */
export const POST = defineRoute({
  permissions: ['timetracking:approve'],
  body: approveTimeEntriesSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) =>
    ok(
      await approveTimeEntries({
        organizationId: await getOrganizationId(),
        entryIds: body.entryIds,
        actorId: session.id,
        ip,
      }),
    ),
});
