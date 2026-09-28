import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { complaintCreateSchema, complaintQuerySchema } from '@/lib/validation/betrieb';
import { createComplaint, listComplaints } from '@/server/services/complaint.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/complaints — Reklamationen und Vorfälle mit dem Stand ihrer
 * Reaktionsfrist (`frist`: KEINE_ZUSAGE, LAEUFT, EINGEHALTEN, VERPASST).
 * Der Stand wird gerechnet, nie gespeichert.
 */
export const GET = defineRoute({
  permissions: ['complaint:read'],
  query: complaintQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ query }) =>
    ok(
      await listComplaints({
        organizationId: await getOrganizationId(),
        status: query.status,
        customerId: query.customerId,
        offen: query.offen === 'true',
        ueberfaellig: query.ueberfaellig === 'true',
      }),
    ),
});

/**
 * POST /api/complaints — eine Meldung erfassen (Telefon, E-Mail, vor Ort).
 *
 * Die Reaktionsfrist rechnet der Server aus der Vertragsfassung, die am
 * Meldetag galt; es gibt kein Feld, sie zu setzen. Ein Meldezeitpunkt in
 * der Zukunft oder älter als 30 Tage wird abgewiesen (422).
 */
export const POST = defineRoute({
  permissions: ['complaint:create'],
  body: complaintCreateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) =>
    created(await createComplaint({ organizationId: await getOrganizationId(), actorId: session.id, ip, input: body })),
});
