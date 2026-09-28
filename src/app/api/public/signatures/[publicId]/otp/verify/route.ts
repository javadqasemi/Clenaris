import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { readSignatureSession } from '@/lib/auth/signature-session';
import { sha256Hex } from '@/lib/crypto';
import { requestContext } from '@/lib/http/request-context';
import { signatureOtpVerifySchema, signaturePublicIdParams } from '@/lib/validation/signatures';
import { verifySignatureOtp } from '@/server/services/signature.service';

export const runtime = 'nodejs';

/**
 * POST /api/public/signatures/:publicId/otp/verify — Code prüfen.
 *
 * Sechs Ziffern sind eine Million Möglichkeiten. Zwei Bremsen: das
 * Kontingent hier (je Vorgang) und der Versuchszähler in der Datenbank
 * (fünf je Code, vor der Prüfung erhöht).
 */
export const POST = definePublicRoute({
  params: signaturePublicIdParams,
  body: signatureOtpVerifySchema,
  rateLimit: 'otpVerify',
  rateLimitKey: ({ request }) => sha256Hex(request.nextUrl.pathname.split('/').at(-3) ?? 'unbekannt'),
  handler: async ({ params, body, request }) => {
    await verifySignatureOtp(await readSignatureSession(), params.publicId, body.code, requestContext(request));
    return ok({ verified: true }, { headers: { 'Cache-Control': 'no-store' } });
  },
});
