import { defineRoute } from '@/lib/api/handler';
import { exportRangeQuery } from '@/lib/validation/queries';
import { exportInvoicesXlsx } from '@/server/services/export.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/exports/rechnungen?from=…&to=…
 *
 * Rechnungsliste als Excel-Datei mit Summenzeile. Ohne Zeitraum wird das
 * laufende Kalenderjahr exportiert.
 */
export const GET = defineRoute({
  permissions: ['report:export'],
  query: exportRangeQuery,
  rateLimit: 'apiRead',
  handler: async ({ query, session }) => {
    const organizationId = await getOrganizationId();
    const year = new Date().getFullYear();

    const { buffer, filename } = await exportInvoicesXlsx({
      organizationId,
      from: query.from ?? new Date(year, 0, 1),
      to: query.to ?? new Date(year, 11, 31),
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
