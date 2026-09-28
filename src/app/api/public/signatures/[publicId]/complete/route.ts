import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { readSignatureSession } from '@/lib/auth/signature-session';
import { sha256Hex } from '@/lib/crypto';
import { requestContext } from '@/lib/http/request-context';
import { signatureCompleteSchema, signaturePublicIdParams } from '@/lib/validation/signatures';
import { completeSignature } from '@/server/services/signature.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/public/signatures/:publicId/complete — verbindlich unterzeichnen.
 *
 * Die eine schreibende Handlung der unterzeichnenden Person. Beim Zeichnen
 * wird nichts gespeichert; erst hier prüft der Server Sitzung, Code,
 * Zustimmung, die Prüfsumme des Originals aus den Bytes und die Unterschrift
 * — und macht dann den atomaren Übergang. Zwei gleichzeitige Aufrufe ergeben
 * einen Abschluss und eine Ablehnung „bereits abgeschlossen".
 */
export const POST = definePublicRoute({
  params: signaturePublicIdParams,
  body: signatureCompleteSchema,
  rateLimit: 'signatureFinalize',
  rateLimitKey: ({ request }) => sha256Hex(request.nextUrl.pathname.split('/').at(-2) ?? 'unbekannt'),
  handler: async ({ params, body, request }) => {
    const ergebnis = await completeSignature(await readSignatureSession(), params.publicId, body, requestContext(request));
    return ok(ergebnis, { headers: { 'Cache-Control': 'no-store' } });
  },
});
