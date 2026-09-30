import type { NextRequest } from 'next/server';

import { defineCronRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { ausfuehrerAnfrage } from '@/lib/release/ausfuehrer-anfrage';
import { releaseAuftraegeQuery } from '@/lib/validation/system';
import { getOrganizationId } from '@/server/services/organization.service';
import { faelligeAuftraege } from '@/server/services/release-ausfuehrung.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/release-auftraege?umgebung=production — fällige Aufträge.
 *
 * Nur für den Release-Ausführer: Bearer `RELEASE_EXECUTOR_TOKEN` **und**
 * Signatur (`x-clenaris-zeit`, `x-clenaris-signatur`). Liest nur; übernommen
 * wird über `…/uebernehmen`. Jeder Auftrag nennt sein `hindernis`, wenn er
 * fällig, aber nicht ausführbar ist (Stand der Instanz nicht belegt, CI nicht
 * bestanden, keine Prüfsumme) — der Ausführer protokolliert es, statt still
 * zu überspringen. Seit 2026-09-30 dazu `laufend` (belegte Identität der
 * Instanz) und `inAusfuehrung` (Aufträge dieser Umgebung in DEPLOYING, mit
 * Schlüssel) — damit ein abgebrochener Lauf seinen Auftrag fortsetzen kann.
 */
export const GET = defineCronRoute({
  secretEnv: 'RELEASE_EXECUTOR_TOKEN',
  handler: async (request: NextRequest) => {
    const { umgebung } = await ausfuehrerAnfrage(request, releaseAuftraegeQuery, 'abfrage');
    return ok(await faelligeAuftraege(await getOrganizationId(), umgebung), { headers: { 'Cache-Control': 'no-store' } });
  },
});
