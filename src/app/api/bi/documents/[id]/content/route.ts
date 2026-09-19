import { defineRoute, idParam } from '@/lib/api/handler';
import { sanitizeFilename } from '@/lib/storage';
import { documentDownloadQuery } from '@/lib/validation/bi-knowledge';
import { resolveDocumentContent } from '@/server/services/document.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/bi/documents/:id/content — die Bytes einer Fassung, zum Anzeigen.
 *
 * Das Gegenstück zur Download-Route für den Viewer: dieselbe
 * Sichtbarkeitsprüfung über `documentVisibilityWhere`, aber die Datei selbst
 * statt einer Weiterleitung. Der Viewer braucht die Statuscodes — 403, 404
 * und ein unlesbares PDF sind drei verschiedene Meldungen an die Person —,
 * und eine Weiterleitung auf die Speicheradresse nähme sie ihm.
 *
 * `?version=` benennt die Fassung; ohne Angabe gilt die geltende, und der
 * Kopf `X-Document-Version` sagt, welche ausgeliefert wurde.
 */
export const GET = defineRoute({
  permissions: ['document:read', 'document:read_own'],
  anyPermission: true,
  params: idParam,
  query: documentDownloadQuery,
  rateLimit: 'apiRead',
  handler: async ({ params, query, session, ip }) => {
    const inhalt = await resolveDocumentContent(
      session,
      await getOrganizationId(),
      params.id,
      query.version,
      ip,
    );

    const istPdf = inhalt.mimeType === 'application/pdf';
    const name = sanitizeFilename(inhalt.filename);

    return new Response(new Uint8Array(inhalt.bytes), {
      status: 200,
      headers: {
        'Content-Type': inhalt.mimeType,
        'Content-Length': String(inhalt.bytes.byteLength),
        // PDF darf im Fenster angezeigt werden; alles andere wird zum
        // Herunterladen angeboten — ein Office-Dokument hat im Browser
        // nichts zu rendern.
        'Content-Disposition': `${istPdf ? 'inline' : 'attachment'}; filename="${name}"`,
        'X-Content-Type-Options': 'nosniff',
        'X-Document-Version': String(inhalt.version),
        // Personal- und Vertragsdokumente: kein Zwischenspeicher, nirgends.
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      },
    });
  },
});
