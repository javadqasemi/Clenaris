import { defineRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { generateReportSchema } from '@/lib/validation/bi-reports';
import { generateReportForUser } from '@/server/services/bi-report.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** POST /api/bi/reports/generate — Bericht ausserplanmässig erzeugen. */
export const POST = defineRoute({
  permissions: ['bireport:manage'],
  body: generateReportSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const run = await generateReportForUser(session, await getOrganizationId(), body);
    return created({ id: run.id, status: run.status, file: run.file });
  },
});
