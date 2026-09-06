import { defineRoute, idParam } from '@/lib/api/handler';
import { getCustomerDetail, updateCustomer } from '@/server/services/crm.service';
import { updateCustomerSchema } from '@/lib/validation/crm';
import { noContent, ok } from '@/lib/api/response';
import { softDelete } from '@/server/services/trash.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * DELETE /api/customers/:id — in den Papierkorb legen.
 *
 * Offene Rechnungen und geplante Termine verhindern das Löschen — die Antwort nennt die Zahl.
 *
 * Weich gelöscht: der Datensatz verschwindet aus allen Listen (jede Abfrage
 * filtert `deletedAt: null`), bleibt aber wiederherstellbar. Verknüpfte
 * Datensätze werden **nicht** mitgelöscht — ein Kaskadenlöschen wäre nicht
 * umkehrbar und widerspräche dem Zweck eines Papierkorbs.
 */
export const DELETE = defineRoute({
  permissions: ['customer:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await softDelete(
      'customer',
      { organizationId: await getOrganizationId(), actorId: session.id, ip },
      params.id,
    );
    return noContent();
  },
});

/** GET /api/customers/:id — vollständige Kundenakte. */
export const GET = defineRoute({
  permissions: ['customer:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) =>
    ok(
      await getCustomerDetail({
        organizationId: await getOrganizationId(),
        customerId: params.id,
      }),
    ),
});

/** PATCH /api/customers/:id — Stammdaten, Konditionen und Notizen ändern. */
export const PATCH = defineRoute({
  permissions: ['customer:update'],
  params: idParam,
  body: updateCustomerSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const customer = await updateCustomer({
      organizationId: await getOrganizationId(),
      customerId: params.id,
      input: body,
      actorId: session.id,
    });
    return ok({ id: customer.id, number: customer.number });
  },
});
