import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateJobPostingSchema } from '@/lib/validation/website';
import { deleteJobPosting, updateJobPosting } from '@/server/services/website.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/job-postings/:id — Teil-Update. */
export const PATCH = defineRoute({
  permissions: ['jobPosting:update'],
  params: idParam,
  body: updateJobPostingSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const row = await updateJobPosting({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      postingId: params.id,
      input: body,
    });
    return ok({ id: row.id });
  },
});

/**
 * DELETE /api/job-postings/:id
 *
 * Nur ohne Bewerbungen. Bewerbungen sind Personendaten mit Auskunftsanspruch; ohne die zugehörige Stelle liessen sie sich nicht mehr erklären. Archivieren Sie stattdessen.
 */
export const DELETE = defineRoute({
  permissions: ['jobPosting:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await deleteJobPosting({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      postingId: params.id,
    });
    return noContent();
  },
});
