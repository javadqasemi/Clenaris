import { defineRoute, idParam } from '@/lib/api/handler';
import { renderJobReportPdf } from '@/lib/pdf/render';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/jobs/:id/report — Einsatzbericht als PDF.
 *
 * Der Bericht wird bei jedem Abruf neu gerendert. Er ist kein Finanzdokument,
 * sondern eine Momentaufnahme des Einsatzes — eine ältere Fassung wäre
 * irreführend, sobald Fotos oder Checklistenpunkte nachgetragen wurden.
 */
export const GET = defineRoute({
  permissions: ['job:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => {
    const { buffer, filename } = await renderJobReportPdf(params.id);

    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  },
});
