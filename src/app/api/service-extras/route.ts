import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createExtraSchema } from '@/lib/validation/catalog';
import { createExtra, listExtras } from '@/server/services/catalog.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/service-extras — buchbare Zusatzleistungen mit ihrer Zuordnung. */
export const GET = defineRoute({
  permissions: ['service:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await listExtras(await getOrganizationId())),
});

/** POST /api/service-extras — neue Zusatzleistung anlegen. */
export const POST = defineRoute({
  permissions: ['service:create'],
  body: createExtraSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const extra = await createExtra({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return created({ id: extra.id, slug: extra.slug });
  },
});
