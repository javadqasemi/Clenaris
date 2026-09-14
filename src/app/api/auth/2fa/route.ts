import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { getTwoFactorStatus } from '@/server/services/two-factor.service';

export const runtime = 'nodejs';

/** GET /api/auth/2fa — Zustand des eigenen zweiten Faktors. */
export const GET = defineRoute({
  rateLimit: 'apiRead',
  handler: async ({ session }) => ok(await getTwoFactorStatus(session.id)),
});
