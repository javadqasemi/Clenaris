import { z } from 'zod';

import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { contractDeadlines } from '@/server/services/contract-schedule.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/contracts/deadlines — Fristen, die auf jemanden warten.
 *
 * Drei Listen: nahende Kündigungsfristen, auslaufende Verträge und fällige
 * Preisüberprüfungen.
 *
 * **Der Lauf erinnert, er handelt nicht.** Verlängern, kündigen und Preise
 * anpassen sind Verpflichtungen über Monate; die trifft ein Mensch. Was diese
 * Auskunft leistet, ist, dass niemand eine Frist verpasst, weil sie in keiner
 * Liste stand — der teuerste Fehler dieses Moduls, weil er sich erst
 * bemerkbar macht, wenn er nicht mehr zu beheben ist.
 *
 * Der statische Pfad steht vor `/{id}`; Next entscheidet das zugunsten des
 * statischen Segments. Eine Abfrage `?deadlines=1` an der Liste hätte dieselbe
 * Antwort in einem Endpunkt versteckt, der etwas anderes tut.
 */
export const GET = defineRoute({
  permissions: ['contract:read'],
  query: z.object({ tage: z.coerce.number().int().min(1).max(365).default(45) }),
  rateLimit: 'apiRead',
  handler: async ({ query }) => ok(await contractDeadlines(await getOrganizationId(), query.tage)),
});
