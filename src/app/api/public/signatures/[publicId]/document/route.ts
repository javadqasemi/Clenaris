import { binaerAntwort } from '@/lib/api/binary-response';
import { definePublicRoute } from '@/lib/api/handler';
import { readSignatureSession } from '@/lib/auth/signature-session';
import { requestContext } from '@/lib/http/request-context';
import { sanitizeFilename } from '@/lib/storage';
import { signaturePublicIdParams } from '@/lib/validation/signatures';
import { getSigningDocument } from '@/server/services/signature.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/public/signatures/:publicId/document — exakt das Original.
 *
 * Der Viewer bekommt die Bytes, deren Prüfsumme beim Anlegen eingefroren
 * wurde — nicht eine neu gerenderte Fassung, nicht „die aktuelle". Was hier
 * ausgeliefert wird, ist das, was unterzeichnet wird.
 */
export const GET = definePublicRoute({
  params: signaturePublicIdParams,
  rateLimit: 'publicTokenRead',
  handler: async ({ params, request }) => {
    const { bytes, filename } = await getSigningDocument(await readSignatureSession(), params.publicId, requestContext(request));
    return binaerAntwort({
      bytes,
      mimeType: 'application/pdf',
      filename: sanitizeFilename(filename),
      request,
      cacheControl: 'no-store',
      headers: { 'Referrer-Policy': 'no-referrer' },
    });
  },
});
