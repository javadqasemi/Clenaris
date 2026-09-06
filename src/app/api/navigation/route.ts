import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createNavItemSchema } from '@/lib/validation/navigation';
import { createNavItem, listNavItems } from '@/server/services/navigation.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/navigation — alle Menüpunkte, auch abgeschaltete. */
export const GET = defineRoute({
  permissions: ['navigation:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await listNavItems(await getOrganizationId())),
});

/**
 * POST /api/navigation — Menüpunkt anlegen.
 *
 * Das Ziel wird gegen dieselbe Positivliste geprüft wie bei einem
 * Handlungsaufruf — interner Pfad, https, tel oder mailto. Ein Menüpunkt mit
 * javascript:-Ziel stünde auf jeder Seite der Website, nicht nur auf einer.
 */
export const POST = defineRoute({
  permissions: ['navigation:update'],
  body: createNavItemSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const item = await createNavItem({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return created({ id: item.id, label: item.label });
  },
});
