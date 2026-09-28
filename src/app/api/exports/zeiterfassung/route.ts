import { defineRoute } from '@/lib/api/handler';
import { exportRangeQuery } from '@/lib/validation/queries';
import { exportTimesheetsXlsx } from '@/server/services/export.service';
import { getOrganizationId } from '@/server/services/organization.service';
import { zuercherTag } from '@/lib/zuerich';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/exports/zeiterfassung?from=…&to=…
 *
 * Zwei Blätter: Einzelbuchungen und Monatssummen pro Person. Das
 * Zusammenzugs-Blatt ist das, was die Lohnbuchhaltung tatsächlich braucht.
 */
export const GET = defineRoute({
  permissions: ['timetracking:read_all'],
  query: exportRangeQuery,
  rateLimit: 'apiRead',
  handler: async ({ query, session }) => {
    const organizationId = await getOrganizationId();

    // Ohne Angabe: der laufende Zürcher Monat bis heute (2026-09-27). Vorher
    // der Monat in der Zone des Servers — am 1. zwischen 00:00 und 02:00 der
    // Vormonat.
    const heute = zuercherTag();
    const monatsbeginn = new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth(), 1));

    const { buffer, filename } = await exportTimesheetsXlsx({
      organizationId,
      from: query.from ?? monatsbeginn,
      to: query.to ?? heute,
      actorId: session.id,
    });

    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  },
});
