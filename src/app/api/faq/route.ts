import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createFaqSchema } from '@/lib/validation/website';
import { createFaq, listFaqs } from '@/server/services/website.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/faq — Häufige Fragen auflisten.
 *
 * Ohne Blätterung: eine FAQ-Liste mit über hundert Einträgen liest ohnehin niemand, und die Verwaltung sortiert sie um.
 */
export const GET = defineRoute({
  permissions: ['faq:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await listFaqs(await getOrganizationId())),
});

/**
 * POST /api/faq — Frage anlegen.
 *
 * Die Antwort erscheint nach dem Speichern auf `/faq` und auf der Startseite.
 */
export const POST = defineRoute({
  permissions: ['faq:create'],
  body: createFaqSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const row = await createFaq({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return created({ id: row.id });
  },
});
