import { definePublicRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { publicApplicationSchema } from '@/lib/validation/content';
import { getOrganizationId } from '@/server/services/organization.service';
import { submitApplication } from '@/server/services/website.service';

export const runtime = 'nodejs';

/**
 * POST /api/public/applications
 *
 * Bewerbung auf eine ausgeschriebene Stelle. Bewerbungsunterlagen sind
 * besonders schützenswerte Personendaten: sie landen nur in der Datenbank und
 * im internen Bereich, nie in einer E-Mail an eine Sammeladresse. Prüfung des
 * Inserats, Anhängen des Lebenslaufs und die Benachrichtigungen stehen in
 * `submitApplication` (`website.service.ts`).
 */
export const POST = definePublicRoute({
  body: publicApplicationSchema,
  rateLimit: 'contactForm',
  handler: async ({ body, ip }) => {
    const organizationId = await getOrganizationId();
    const application = await submitApplication({ organizationId, input: body, ip });
    return created({ id: application.id, status: 'received' });
  },
});
