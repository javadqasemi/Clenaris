import { definePublicRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { newsletterSchema } from '@/lib/validation/crm';
import { newsletterAnmelden } from '@/server/services/newsletter.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/public/newsletter
 *
 * Double-Opt-in-Anmeldung. Die Antwort ist immer identisch — auch bei einer
 * bereits eingetragenen Adresse. So lässt sich über das Formular nicht
 * herausfinden, wer Kunde ist. Regeln und Protokoll in
 * `newsletter.service.ts`.
 */
export const POST = definePublicRoute({
  body: newsletterSchema,
  rateLimit: 'newsletter',
  handler: async ({ body, ip }) => {
    await newsletterAnmelden({ organizationId: await getOrganizationId(), input: body, ip });
    return created({ status: 'pending' });
  },
});
