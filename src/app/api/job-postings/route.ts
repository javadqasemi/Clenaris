import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createJobPostingSchema } from '@/lib/validation/website';
import { createJobPosting, listJobPostings } from '@/server/services/website.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/job-postings — Stellenangebote auflisten.
 *
 * Mit der Zahl der eingegangenen Bewerbungen je Angebot.
 */
export const GET = defineRoute({
  permissions: ['jobPosting:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await listJobPostings(await getOrganizationId())),
});

/**
 * POST /api/job-postings — Stellenangebot anlegen.
 *
 * Das Veröffentlichungsdatum entsteht beim Veröffentlichen, nicht beim Anlegen — ein Entwurf hat keines.
 */
export const POST = defineRoute({
  permissions: ['jobPosting:create'],
  body: createJobPostingSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const row = await createJobPosting({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return created({ id: row.id });
  },
});
