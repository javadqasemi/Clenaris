import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createCouponSchema } from '@/lib/validation/catalog';
import { createCoupon, listCoupons } from '@/server/services/catalog.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/coupons — Gutscheincodes samt Einlösestand. */
export const GET = defineRoute({
  permissions: ['coupon:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await listCoupons(await getOrganizationId())),
});

/** POST /api/coupons — neuen Gutscheincode ausgeben. */
export const POST = defineRoute({
  permissions: ['coupon:create'],
  body: createCouponSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const coupon = await createCoupon({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return created({ id: coupon.id, code: coupon.code });
  },
});
