import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { readSignatureSession } from '@/lib/auth/signature-session';
import { sha256Hex } from '@/lib/crypto';
import { requestContext } from '@/lib/http/request-context';
import { signaturePublicIdParams } from '@/lib/validation/signatures';
import { requestSignatureOtp } from '@/server/services/signature.service';

export const runtime = 'nodejs';

/**
 * POST /api/public/signatures/:publicId/otp/request — Bestätigungscode anfordern.
 *
 * Kontingent je Vorgang (Hash der Adresse, kein Geheimnis) — jede
 * Anforderung kostet eine E-Mail oder eine SMS. Dazu die Wiederholsperre
 * von 60 Sekunden im Dienst.
 */
export const POST = definePublicRoute({
  params: signaturePublicIdParams,
  rateLimit: 'otpRequest',
  rateLimitKey: ({ request }) => sha256Hex(request.nextUrl.pathname.split('/').at(-3) ?? 'unbekannt'),
  handler: async ({ params, request }) => {
    const ergebnis = await requestSignatureOtp(await readSignatureSession(), params.publicId, requestContext(request));
    return ok(ergebnis, { headers: { 'Cache-Control': 'no-store' } });
  },
});
