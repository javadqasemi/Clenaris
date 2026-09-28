import { binaerAntwort } from '@/lib/api/binary-response';
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
  handler: async ({ params, query, session, ip, request }) => {
    const inhalt = await resolveDocumentContent(
      session,
      await getOrganizationId(),
      params.id,
      query.version,
      ip,
    );

    return binaerAntwort({
      bytes: inhalt.bytes,
      mimeType: inhalt.mimeType,
      filename: sanitizeFilename(inhalt.filename),
      // PDF darf im Fenster angezeigt werden; alles andere wird zum
      // Herunterladen angeboten — ein Office-Dokument hat im Browser nichts
      // zu rendern. Ob die Kopfzeile überhaupt mitgeht, entscheidet die Art
      // der Anfrage (siehe `binary-response.ts`).
      disposition: inhalt.mimeType === 'application/pdf' ? 'inline' : 'attachment',
      request,
      // Personal- und Vertragsdokumente: kein Zwischenspeicher, nirgends.
      headers: { 'X-Document-Version': String(inhalt.version) },
    });
  },
});
