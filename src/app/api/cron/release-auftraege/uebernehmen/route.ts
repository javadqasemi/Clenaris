import type { NextRequest } from 'next/server';

import { defineCronRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { ausfuehrerAnfrage } from '@/lib/release/ausfuehrer-anfrage';
import { releaseUebernahmeSchema } from '@/lib/validation/system';
import { getOrganizationId } from '@/server/services/organization.service';
import { auftragUebernehmen } from '@/server/services/release-ausfuehrung.service';

export const runtime = 'nodejs';

/**
 * POST /api/cron/release-auftraege/uebernehmen — einen fälligen Auftrag
 * übernehmen (SCHEDULED → DEPLOYING).
 *
 * Bearer `RELEASE_EXECUTOR_TOKEN` und Signatur über den Rohrumpf. Die
 * Bedingungen (Umgebung, fällig, CI bestanden, Prüfsumme gleich, Version
 * neuer) stehen in `release-ausfuehrung.service.ts`. Idempotent über
 * `ausfuehrungsSchluessel`: dieselbe Übernahme erneut → 200 mit
 * `wiederholt: true`; ein anderer Schlüssel → 409.
 */
export const POST = defineCronRoute({
  secretEnv: 'RELEASE_EXECUTOR_TOKEN',
  handler: async (request: NextRequest) => {
    const eingabe = await ausfuehrerAnfrage(request, releaseUebernahmeSchema, 'rumpf');
    return ok(await auftragUebernehmen(await getOrganizationId(), eingabe));
  },
});
