import { binaerAntwort } from '@/lib/api/binary-response';
import { defineRoute, idParam } from '@/lib/api/handler';
import { renderJobReportPdf } from '@/lib/pdf/render';
import { getOrganizationId } from '@/server/services/organization.service';

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
  handler: async ({ params, request }) => {
    const { buffer, filename } = await renderJobReportPdf(await getOrganizationId(), params.id);

    return binaerAntwort({
      bytes: buffer,
      mimeType: 'application/pdf',
      filename,
      disposition: 'attachment',
      request,
      cacheControl: 'private, no-store',
    });
  },
});
