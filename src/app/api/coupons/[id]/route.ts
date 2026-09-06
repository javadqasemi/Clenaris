import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateCouponSchema } from '@/lib/validation/catalog';
import { deleteCoupon, updateCoupon } from '@/server/services/catalog.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/coupons/:id
 *
 * Der Einlösezähler lässt sich hier nicht setzen: er hält eine Tatsache fest,
 * keine Absicht. Wäre er beschreibbar, liesse sich jedes Nutzungslimit
 * beliebig oft aufheben.
 */
export const PATCH = defineRoute({
  permissions: ['coupon:update'],
  params: idParam,
  body: updateCouponSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const coupon = await updateCoupon({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      couponId: params.id,
      input: body,
    });
    return ok({ id: coupon.id, code: coupon.code, status: coupon.status });
  },
});

/** DELETE /api/coupons/:id — nur, solange der Code nie eingelöst wurde. */
export const DELETE = defineRoute({
  permissions: ['coupon:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await deleteCoupon({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      couponId: params.id,
    });
    return noContent();
  },
});
