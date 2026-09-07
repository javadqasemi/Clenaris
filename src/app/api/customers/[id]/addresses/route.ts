import { defineRoute, idParam } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createAddressSchema } from '@/lib/validation/crm';
import {
  assertMayReadAddresses,
  assertMayManageAddresses,
  createAddress,
  listAddresses,
} from '@/server/services/address.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * Adressen einer Kundschaft — für das Büro **und** für die Kundschaft selbst.
 *
 * Zwei Zugänge, ein Endpunkt. Die Tür öffnet, wer `customer:update` hat (das
 * Büro) oder `customer:update_own` (die Kundschaft im eigenen Konto). Die
 * engere Regel steht danach im Rumpf: Wer nur das eigene Recht hat, kommt
 * ausschliesslich an die eigene Akte.
 *
 * Zwei getrennte Endpunkte wären die naheliegende Alternative gewesen und
 * hätten dieselbe Fachlogik zweimal geführt — mit der Aussicht, dass eine der
 * beiden Fassungen bei der nächsten Regel vergessen wird.
 */

/** GET /api/customers/:id/addresses */
export const GET = defineRoute({
  permissions: ['customer:read', 'customer:read_own'],
  anyPermission: true,
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session }) => {
    assertMayReadAddresses(session, params.id);
    return ok(await listAddresses(params.id));
  },
});

/**
 * POST /api/customers/:id/addresses — Adresse erfassen.
 *
 * Die erste Adresse einer Kundschaft wird zwangsläufig Standard- und
 * Rechnungsanschrift: Eine Kundschaft mit einer Adresse, die für nichts gilt,
 * könnte keinen Termin buchen.
 */
export const POST = defineRoute({
  permissions: ['customer:update', 'customer:update_own'],
  anyPermission: true,
  params: idParam,
  body: createAddressSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    assertMayManageAddresses(session, params.id);

    return created(
      await createAddress({
        organizationId: await getOrganizationId(),
        customerId: params.id,
        actorId: session.id,
        ip,
        input: body,
      }),
    );
  },
});
