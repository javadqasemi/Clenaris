import { definePublicRoute } from '@/lib/api/handler';
import { noContent } from '@/lib/api/response';
import { readSignatureSession } from '@/lib/auth/signature-session';
import { sha256Hex } from '@/lib/crypto';
import { requestContext } from '@/lib/http/request-context';
import { signatureDeclineSchema, signaturePublicIdParams } from '@/lib/validation/signatures';
import { declineSignature } from '@/server/services/signature.service';

export const runtime = 'nodejs';

/** POST /api/public/signatures/:publicId/decline — ablehnen, endgültig, kein Bild. */
export const POST = definePublicRoute({
  params: signaturePublicIdParams,
  body: signatureDeclineSchema,
  rateLimit: 'signatureFinalize',
  rateLimitKey: ({ request }) => sha256Hex(request.nextUrl.pathname.split('/').at(-2) ?? 'unbekannt'),
  handler: async ({ params, body, request }) => {
    await declineSignature(await readSignatureSession(), params.publicId, body.reason, requestContext(request));
    return noContent({ 'Cache-Control': 'no-store' });
  },
});
