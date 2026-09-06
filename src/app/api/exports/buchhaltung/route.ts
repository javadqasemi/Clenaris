import { defineRoute } from '@/lib/api/handler';
import { accountingExportSchema } from '@/lib/validation/finance';
import { exportAccounting } from '@/server/services/export.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * POST /api/exports/buchhaltung
 *
 * Erzeugt Buchungssätze im gewünschten Format. Bewusst POST statt GET: die
 * Auswahl der enthaltenen Belegarten ist ein Array, und der Vorgang wird in
 * `accounting_exports` protokolliert — das ist eine Zustandsänderung.
 */
export const POST = defineRoute({
  permissions: ['accounting:export'],
  body: accountingExportSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();

    const { content, filename, rowCount } = await exportAccounting({
      organizationId,
      input: body,
      actorId: session.id,
    });

    return new Response(content, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
        'X-Row-Count': String(rowCount),
      },
    });
  },
});
