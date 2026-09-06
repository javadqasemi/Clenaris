import { defineRoute } from '@/lib/api/handler';
import { exportCustomersXlsx } from '@/server/services/export.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/exports/kunden
 *
 * Vollständige Kundenliste als Excel-Datei. Der Export enthält
 * personenbezogene Daten und wird deshalb im Audit-Log festgehalten — bei
 * einem Datenabfluss ist so nachvollziehbar, wer wann exportiert hat.
 */
export const GET = defineRoute({
  permissions: ['report:export', 'customer:read'],
  rateLimit: 'apiRead',
  handler: async ({ session }) => {
    const organizationId = await getOrganizationId();

    const { buffer, filename } = await exportCustomersXlsx({
      organizationId,
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
