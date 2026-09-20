import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { readSignatureSession } from '@/lib/auth/signature-session';
import { signaturePublicIdParams } from '@/lib/validation/signatures';
import { loadSigningContext } from '@/server/services/signature.service';

export const runtime = 'nodejs';

/**
 * GET /api/public/signatures/:publicId — der Zustand für die Unterzeichnungsseite.
 *
 * Ohne gültige Sitzung: 404, dieselbe Antwort wie für eine erfundene
 * Kennung. Die Adresse ist nicht geheim; sie öffnet nichts.
 */
export const GET = definePublicRoute({
  params: signaturePublicIdParams,
  rateLimit: 'publicTokenRead',
  handler: async ({ params }) => {
    const zustand = await loadSigningContext(await readSignatureSession(), params.publicId);
    return ok(zustand, { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  },
});
