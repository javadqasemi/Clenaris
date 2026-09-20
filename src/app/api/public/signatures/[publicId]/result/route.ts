import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { readSignatureSession } from '@/lib/auth/signature-session';
import { signaturePublicIdParams } from '@/lib/validation/signatures';
import { getSignatureResult } from '@/server/services/signature.service';

export const runtime = 'nodejs';

/**
 * GET /api/public/signatures/:publicId/result — das Ergebnis nach Abschluss.
 *
 * Braucht eine Ergebnis-Sitzung (`SIGNATURE_RESULT_VIEW`), keine
 * Unterzeichnungs-Sitzung: Wer ansehen darf, darf nicht deshalb auch
 * unterzeichnen — und umgekehrt.
 */
export const GET = definePublicRoute({
  params: signaturePublicIdParams,
  rateLimit: 'publicTokenRead',
  handler: async ({ params }) => {
    const ergebnis = await getSignatureResult(await readSignatureSession(), params.publicId);
    return ok(ergebnis, { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  },
});
