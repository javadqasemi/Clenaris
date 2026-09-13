import { NextResponse } from 'next/server';

import { defineRoute, idParam } from '@/lib/api/handler';
import { resolveReportDownload } from '@/server/services/bi-report.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/reports/:id/download — protokollierter Download, Weiterleitung auf befristeten Verweis. */
export const GET = defineRoute({
  permissions: ['bireport:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session, ip, request }) => {
    const target = await resolveReportDownload(session, await getOrganizationId(), params.id, ip);
    return NextResponse.redirect(new URL(target.url, request.nextUrl.origin), 302);
  },
});
