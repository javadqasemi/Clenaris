import { NextResponse } from 'next/server';

import { defineRoute, idParam } from '@/lib/api/handler';
import { sanitizeFilename } from '@/lib/storage';
import { documentDownloadQuery } from '@/lib/validation/bi-knowledge';
import { resolveDocumentDownload } from '@/server/services/document.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/bi/documents/:id/download — protokollierter Download.
 *
 * Die Sichtbarkeit wird über das Dokument geprüft, nie über die Datei-ID.
 *
 * **Zwei Auslieferungsarten, eine Berechtigung.** Mit eingerichtetem
 * Objektspeicher antwortet die Route mit einer Weiterleitung auf einen
 * befristeten Verweis; die Datei läuft dann nicht durch die Anwendung. Ohne
 * ihn gibt es keinen solchen Verweis, und die Bytes kommen von hier — aus
 * demselben Dienst, der die Sichtbarkeit bereits in seiner `where`-Klausel
 * geprüft hat. Auf `/api/files/blob/…` weiterzuleiten wäre der kürzere Weg
 * und der falsche: Jene Route kennt `document:read`, aber nicht
 * `EMPLOYEE_PRIVATE` und die betroffene Person.
 *
 * Bis Gate 4D.1 leitete die Route in **beiden** Fällen weiter — ohne
 * Objektspeicher auf den blossen Ablagepfad, also ins Leere. Der Fehler
 * überlebte, weil die HTTP-Prüfung den 302 als Erfolg nahm und ihm nie
 * folgte.
 */
export const GET = defineRoute({
  permissions: ['document:read', 'document:read_own'],
  anyPermission: true,
  params: idParam,
  query: documentDownloadQuery,
  rateLimit: 'apiRead',
  handler: async ({ params, query, session, ip, request }) => {
    const ziel = await resolveDocumentDownload(session, await getOrganizationId(), params.id, query.version, ip);

    if (ziel.art === 'weiterleitung') {
      return NextResponse.redirect(new URL(ziel.url, request.nextUrl.origin), 302);
    }

    // Ein Download ist ein Download: immer `attachment`, auch bei PDF. Wer
    // ansehen will, nimmt `/content` — dort steht der Viewer dahinter.
    return new Response(new Uint8Array(ziel.bytes), {
      status: 200,
      headers: {
        'Content-Type': ziel.mimeType,
        'Content-Length': String(ziel.bytes.byteLength),
        'Content-Disposition': `attachment; filename="${sanitizeFilename(ziel.filename)}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      },
    });
  },
});
