import { NextResponse } from 'next/server';

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
