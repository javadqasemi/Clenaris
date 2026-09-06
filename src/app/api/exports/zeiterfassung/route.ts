import { defineRoute } from '@/lib/api/handler';
import { exportRangeQuery } from '@/lib/validation/queries';
import { exportTimesheetsXlsx } from '@/server/services/export.service';
import { getOrganizationId } from '@/server/services/organization.service';

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

    const now = new Date();
    const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);

    const { buffer, filename } = await exportTimesheetsXlsx({
      organizationId,
      from: query.from ?? defaultFrom,
      to: query.to ?? now,
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
