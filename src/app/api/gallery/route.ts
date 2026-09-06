import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createGalleryItemSchema } from '@/lib/validation/website';
import { createGalleryItem, listGalleryItems } from '@/server/services/website.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/gallery — Galerie auflisten.
 *
 * Alle Einträge, auch unveröffentlichte.
 */
export const GET = defineRoute({
  permissions: ['gallery:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await listGalleryItems(await getOrganizationId())),
});

/**
 * POST /api/gallery — Galerieeintrag anlegen.
 *
 * Vorher und Nachher müssen verschiedene Bilder sein — sonst zeigt der Schieberegler auf der Startseite nichts.
 */
export const POST = defineRoute({
  permissions: ['gallery:create'],
  body: createGalleryItemSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const row = await createGalleryItem({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return created({ id: row.id });
  },
});
