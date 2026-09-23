import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { complaintUpdateSchema } from '@/lib/validation/betrieb';
import { getComplaint, updateComplaint } from '@/server/services/complaint.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/complaints/:id — mit Vertrag, Einsatz, Zuständigkeit, Massnahme und Fristenstand. */
export const GET = defineRoute({
  permissions: ['complaint:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => ok(await getComplaint({ organizationId: await getOrganizationId(), id: params.id })),
});

/**
 * PATCH /api/complaints/:id — Schweregrad, Zuständigkeit, interne Notiz.
 * Frist und Meldezeitpunkt sind nicht änderbar.
 */
export const PATCH = defineRoute({
  permissions: ['complaint:update'],
  params: idParam,
  body: complaintUpdateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(await updateComplaint({ organizationId: await getOrganizationId(), id: params.id, actorId: session.id, ip, input: body })),
});
