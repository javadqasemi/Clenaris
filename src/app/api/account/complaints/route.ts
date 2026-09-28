import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { ForbiddenError } from '@/lib/errors';
import { complaintOwnCreateSchema } from '@/lib/validation/betrieb';
import { createOwnComplaint, listOwnComplaints } from '@/server/services/complaint.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

function kundenakte(profileId: string | null | undefined): string {
  if (!profileId) throw new ForbiddenError('Für Ihr Konto ist keine Kundenakte hinterlegt.');
  return profileId;
}

/**
 * GET /api/account/complaints — die eigenen Reklamationen mit Stand und
 * Reaktionsfrist. Ausgewählt werden nur kundensichtbare Felder; die interne
 * Notiz steht nicht in der Abfrage.
 */
export const GET = defineRoute({
  permissions: ['complaint:read_own'],
  rateLimit: 'apiRead',
  handler: async ({ session }) =>
    ok(await listOwnComplaints({ organizationId: await getOrganizationId(), customerId: kundenakte(session.profileId) })),
});

/**
 * POST /api/account/complaints — eine Reklamation zu einem eigenen Objekt
 * oder Einsatz melden. Fremde Objekte existieren für diesen Weg nicht (404).
 * Kanal ist das Portal; Schweregrad und Zuständigkeit legt der Betrieb fest.
 */
export const POST = defineRoute({
  permissions: ['complaint:create_own'],
  body: complaintOwnCreateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) =>
    created(
      await createOwnComplaint({
        organizationId: await getOrganizationId(),
        customerId: kundenakte(session.profileId),
        userId: session.id,
        ip,
        input: body,
      }),
    ),
});
