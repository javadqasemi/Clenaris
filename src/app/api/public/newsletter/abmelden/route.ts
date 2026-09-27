import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { newsletterTokenSchema } from '@/lib/validation/crm';
import { newsletterAbmelden } from '@/server/services/newsletter.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/public/newsletter/abmelden — Newsletter abbestellen.
 *
 * Ein Klick, kein Login, keine Rückfrage — der Widerruf muss so einfach sein
 * wie die Anmeldung. Aber ein Klick und nicht schon der Seitenaufruf
 * (2026-09-27): Mailfilter rufen Links vorab auf und trugen so Abonnenten
 * aus, die nie abbestellen wollten. Unbekannter Link: 404.
 */
export const POST = definePublicRoute({
  body: newsletterTokenSchema,
  rateLimit: 'publicTokenAction',
  handler: async ({ body, ip }) => {
    await newsletterAbmelden({ organizationId: await getOrganizationId(), token: body.token, ip });
    return ok({ status: 'abgemeldet' });
  },
});
