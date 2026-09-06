import { definePublicRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { contactFormSchema } from '@/lib/validation/crm';
import { createLeadFromContactForm } from '@/server/services/crm.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/public/contact
 *
 * Erzeugt einen Lead, sendet die Eingangsbestätigung an die anfragende Person
 * und benachrichtigt das Büro. Die KI-Bewertung läuft danach im Hintergrund
 * und darf fehlschlagen, ohne die Anfrage zu verlieren.
 */
export const POST = definePublicRoute({
  body: contactFormSchema,
  rateLimit: 'contactForm',
  handler: async ({ body, ip }) => {
    const organizationId = await getOrganizationId();

    const lead = await createLeadFromContactForm({ organizationId, input: body, ip });

    return created({ number: lead.number, status: 'received' });
  },
});
