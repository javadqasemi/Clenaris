import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { reportListQuery } from '@/lib/validation/bi-reports';
import { listReportRuns } from '@/server/services/bi-report.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/reports — erzeugte Berichte, neueste zuerst. */
export const GET = defineRoute({
  permissions: ['bireport:read'],
  query: reportListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => ok(await listReportRuns(await getOrganizationId(), query)),
});
