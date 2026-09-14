import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { purgeSchema } from '@/lib/validation/system';
import { previewPurge, runPurge } from '@/server/services/purge.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/system/purge — Vorschau der Datenbereinigung.
 *
 * Je Bereich die Zahl der Hauptdatensätze, die ein Lauf löschen würde. Nur
 * `data:purge` — und das hat allein die Systemverantwortung.
 */
export const GET = defineRoute({
  permissions: ['data:purge'],
  rateLimit: 'apiRead',
  handler: async ({ session }) => {
    const organizationId = await getOrganizationId();
    return ok(await previewPurge({ organizationId, actorId: session.id }));
  },
});

/**
 * POST /api/system/purge — Bereiche endgültig löschen.
 *
 * Unumkehrbar. Verlangt den Bestätigungssatz im Körper (nicht nur ein
 * Häkchen), läuft in einer Transaktion und schreibt je Bereich einen
 * Eintrag ins Prüfprotokoll — im selben Commit, damit es kein Löschen ohne
 * Protokoll gibt. Wer, wann, von welcher Adresse: alles steht dort.
 */
export const POST = defineRoute({
  permissions: ['data:purge'],
  body: purgeSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip, request }) => {
    const organizationId = await getOrganizationId();

    const result = await runPurge({
      organizationId,
      actorId: session.id,
      areas: body.bereiche,
      resetSequences: body.nummernkreiseZuruecksetzen,
      ip,
      userAgent: request.headers.get('user-agent'),
    });

    return ok(result);
  },
});
