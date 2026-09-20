import { NextResponse } from 'next/server';

import { binaerAntwort } from '@/lib/api/binary-response';
import { defineRoute, idParam } from '@/lib/api/handler';
import { sanitizeFilename } from '@/lib/storage';
import { resolveReportDownload } from '@/server/services/bi-report.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/bi/reports/:id/download — protokollierter Download.
 *
 * Mit eingerichtetem Objektspeicher eine Weiterleitung auf einen befristeten
 * Verweis, sonst die Bytes aus diesem Dienst. Die Herleitung steht bei
 * `Dateiauslieferung` in `src/lib/storage/index.ts`; kurz: Ohne Objektspeicher
 * gibt es keinen Verweis, auf den sich weiterleiten liesse, und die einzige
 * Route, die lokale Bytes ausliefert, prüft gröber als dieser Dienst.
 */
export const GET = defineRoute({
  permissions: ['bireport:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session, ip, request }) => {
    const ziel = await resolveReportDownload(session, await getOrganizationId(), params.id, ip);

    if (ziel.art === 'weiterleitung') {
      return NextResponse.redirect(new URL(ziel.url, request.nextUrl.origin), 302);
    }

    return binaerAntwort({
      bytes: ziel.bytes,
      mimeType: ziel.mimeType,
      filename: sanitizeFilename(ziel.filename),
      disposition: 'attachment',
      request,
    });
  },
});
