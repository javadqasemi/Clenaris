import { NextResponse } from 'next/server';

import { defineRoute, idParam } from '@/lib/api/handler';
import { documentDownloadQuery } from '@/lib/validation/bi-knowledge';
import { resolveDocumentDownload } from '@/server/services/document.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/bi/documents/:id/download — protokollierter Download.
 *
 * Antwortet mit einer Weiterleitung auf einen befristeten Verweis. Die Datei
 * selbst läuft nicht durch die Anwendung; die Sichtbarkeit wird über das
 * Dokument geprüft, nie über die Datei-ID.
 */
export const GET = defineRoute({
  permissions: ['document:read', 'document:read_own'],
  anyPermission: true,
  params: idParam,
  query: documentDownloadQuery,
  rateLimit: 'apiRead',
  handler: async ({ params, query, session, ip, request }) => {
    const target = await resolveDocumentDownload(session, await getOrganizationId(), params.id, query.version, ip);
    return NextResponse.redirect(new URL(target.url, request.nextUrl.origin), 302);
  },
});
