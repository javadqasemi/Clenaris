import { z } from 'zod';

import { defineRoute } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateAddressSchema } from '@/lib/validation/crm';
import {
  assertMayManageAddresses,
  deleteAddress,
  updateAddress,
} from '@/server/services/address.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

const params = z.object({
  id: z.string().min(1),
  addressId: z.string().min(1),
});

/**
 * PATCH /api/customers/:id/addresses/:addressId — Adresse ändern.
 *
 * Erreichbar für das Büro und für die Kundschaft im eigenen Konto; die engere
 * Regel steht im Dienst. Die Standardmarkierung lässt sich dabei nicht
 * abwählen, nur weitergeben — sonst stünde eine Kundschaft ohne
 * Standardadresse da und käme im Buchungsformular nicht weiter.
 */
export const PATCH = defineRoute({
  permissions: ['customer:update', 'customer:update_own'],
  anyPermission: true,
  params,
  body: updateAddressSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params: route, body, session, ip }) => {
    assertMayManageAddresses(session, route.id);

    return ok(
      await updateAddress({
        organizationId: await getOrganizationId(),
        customerId: route.id,
        addressId: route.addressId,
        actorId: session.id,
        ip,
        input: body,
      }),
    );
  },
});

/**
 * DELETE /api/customers/:id/addresses/:addressId — Adresse entfernen.
 *
 * Endgültig, nicht in den Papierkorb: `Address` trägt kein `deletedAt`.
 * Deshalb bleibt jede Adresse stehen, an der Objekte, Buchungen oder Einsätze
 * hängen — sie belegt, wohin damals gefahren wurde. Und die letzte Adresse
 * bleibt ohnehin, weil ohne sie keine Buchung mehr zustande käme.
 */
export const DELETE = defineRoute({
  permissions: ['customer:update', 'customer:update_own'],
  anyPermission: true,
  params,
  rateLimit: 'apiWrite',
  handler: async ({ params: route, session, ip }) => {
    assertMayManageAddresses(session, route.id);

    await deleteAddress({
      organizationId: await getOrganizationId(),
      customerId: route.id,
      addressId: route.addressId,
      actorId: session.id,
      ip,
    });
    return noContent();
  },
});
