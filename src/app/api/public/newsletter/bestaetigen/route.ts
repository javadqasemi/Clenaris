import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { newsletterTokenSchema } from '@/lib/validation/crm';
import { newsletterBestaetigen } from '@/server/services/newsletter.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/public/newsletter/bestaetigen — Double-Opt-in bestätigen.
 *
 * Ein POST und kein Seitenaufruf (2026-09-27): Die Seite `/newsletter/
 * bestaetigen` bestätigte früher schon beim Laden, und die Vorabprüfung
 * eines Mailfilters genügte dafür. Jetzt bestätigt erst der Klick. Der Token
 * steht im Körper, nicht im Pfad. Unbekannt oder schon verwendet: 404.
 */
export const POST = definePublicRoute({
  body: newsletterTokenSchema,
  rateLimit: 'publicTokenAction',
  handler: async ({ body, ip }) => {
    await newsletterBestaetigen({ organizationId: await getOrganizationId(), token: body.token, ip });
    return ok({ status: 'bestaetigt' });
  },
});
