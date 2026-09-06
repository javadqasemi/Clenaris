import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { updateCompanySchema } from '@/lib/validation/cms';
import { getCompany, updateCompany } from '@/server/services/company.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/company — Firmendaten samt Öffnungszeiten. */
export const GET = defineRoute({
  permissions: ['company:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await getCompany(await getOrganizationId())),
});

/**
 * PATCH /api/company — Firmendaten ändern.
 *
 * IBAN und QR-IBAN werden gegen die Prüfziffer nach ISO 13616 geprüft. Eine
 * falsche Nummer fiele sonst erst auf, wenn eine Kundschaft die erste Rechnung
 * nicht bezahlen kann — und stünde dann bereits auf ausgestellten,
 * unveränderlichen Belegen.
 */
export const PATCH = defineRoute({
  permissions: ['company:update'],
  body: updateCompanySchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const org = await updateCompany({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return ok({ id: org.id, name: org.name });
  },
});
