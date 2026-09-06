import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { twoFactorConfirmSchema } from '@/lib/validation/auth';
import { confirmTwoFactor } from '@/server/services/two-factor.service';

export const runtime = 'nodejs';

/**
 * POST /api/auth/2fa/confirm — Code bestätigen und einschalten.
 *
 * Die Antwort enthält die Wiederherstellungscodes — **einmalig**. Danach
 * existieren sie nur noch als Hash; wer sie nicht notiert, muss den zweiten
 * Faktor von der Systemverantwortung zurücksetzen lassen.
 */
export const POST = defineRoute({
  body: twoFactorConfirmSchema,
  rateLimit: 'login',
  rateLimitKey: ({ session }) => session?.id ?? 'anonym',
  handler: async ({ body, session, ip }) =>
    ok(await confirmTwoFactor({ userId: session.id, token: body.token, ip })),
});
