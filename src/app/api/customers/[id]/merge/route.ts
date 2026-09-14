import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { mergeCustomerSchema } from '@/lib/validation/crm';
import { findDuplicateCustomers, mergeCustomers } from '@/server/services/crm.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/customers/:id/merge — Vorschläge für Doppelerfassungen.
 *
 * Getrennt vom Zusammenführen selbst, damit die Oberfläche die Vorschläge
 * zeigen kann, bevor irgendetwas passiert. Zusammenführen ist nicht umkehrbar;
 * ein Ablauf, der Vorschlag und Ausführung in einem Aufruf verbindet, lädt zum
 * Fehlklick ein.
 */
export const GET = defineRoute({
  permissions: ['customer:update'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) => {
    const duplicates = await findDuplicateCustomers({
      organizationId: await getOrganizationId(),
      customerId: params.id,
    });

    return ok(
      duplicates.map((customer) => ({
        id: customer.id,
        number: customer.number,
        name: customer.companyName ?? `${customer.firstName} ${customer.lastName}`,
        email: customer.email,
        phone: customer.phone,
        createdAt: customer.createdAt,
      })),
    );
  },
});

/**
 * POST /api/customers/:id/merge — einen zweiten Datensatz eingliedern.
 *
 * `:id` ist das **Ziel** — der Datensatz, der bestehen bleibt. Der im Körper
 * genannte `sourceId` wird geleert und weich gelöscht. Diese Richtung ist
 * bewusst so herum: Der Aufruf steht auf der Seite des Datensatzes, den man
 * gerade offen hat, und das ist der, den man behalten will.
 *
 * `customer:delete` zusätzlich zu `customer:update`, weil am Ende ein
 * Datensatz verschwindet — und weil der Vorgang nicht rückgängig zu machen
 * ist.
 */
export const POST = defineRoute({
  permissions: ['customer:update', 'customer:delete'],
  params: idParam,
  body: mergeCustomerSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const customer = await mergeCustomers({
      organizationId: await getOrganizationId(),
      targetId: params.id,
      sourceId: body.sourceId,
      actorId: session.id,
    });

    return ok({ id: customer.id, number: customer.number });
  },
});
