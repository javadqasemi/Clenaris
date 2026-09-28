import { defineRoute } from '@/lib/api/handler';
import { exportRangeQuery } from '@/lib/validation/queries';
import { exportInvoicesXlsx } from '@/server/services/export.service';
import { getOrganizationId } from '@/server/services/organization.service';
import { zuercherJahr } from '@/lib/zuerich';

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
    // Das Zürcher Jahr als Kalendertage (`@db.Date`), nicht `new Date(y, 0, 1)`
    // in der Zone des Servers (2026-09-27): In Zürich-Zeit wäre das der
    // 31. Dezember 23:00 UTC gewesen, und der Export hätte den Silvester des
    // Vorjahres mitgenommen; am Neujahrsmorgen bis 01:00 galt das alte Jahr.
    const year = zuercherJahr();

    const { buffer, filename } = await exportInvoicesXlsx({
      organizationId,
      from: query.from ?? new Date(Date.UTC(year, 0, 1)),
      to: query.to ?? new Date(Date.UTC(year, 11, 31)),
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
