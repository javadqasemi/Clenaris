import type { NextRequest } from 'next/server';

import { defineCronRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { ausfuehrerAnfrage } from '@/lib/release/ausfuehrer-anfrage';
import { releaseErgebnisSchema } from '@/lib/validation/system';
import { getOrganizationId } from '@/server/services/organization.service';
import { auftragErgebnis } from '@/server/services/release-ausfuehrung.service';

export const runtime = 'nodejs';

/**
 * POST /api/cron/release-auftraege/ergebnis — Ergebnis einer Ausführung
 * (DEPLOYING → SUCCEEDED | FAILED | ROLLED_BACK).
 *
 * Nur mit dem Ausführungsschlüssel der Übernahme. SUCCEEDED verlangt, dass
 * die Instanz danach die Zielversion meldet. Dieselbe Meldung erneut → 200
 * mit `wiederholt: true`; eine abweichende nach einer ersten → 409.
 */
export const POST = defineCronRoute({
  secretEnv: 'RELEASE_EXECUTOR_TOKEN',
  handler: async (request: NextRequest) => {
    const eingabe = await ausfuehrerAnfrage(request, releaseErgebnisSchema, 'rumpf');
    return ok(await auftragErgebnis(await getOrganizationId(), eingabe));
  },
});
