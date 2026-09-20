import { binaerAntwort } from '@/lib/api/binary-response';
import { definePublicRoute } from '@/lib/api/handler';
import { readSignatureSession } from '@/lib/auth/signature-session';
import { sanitizeFilename } from '@/lib/storage';
import { signatureResultArtifactParams } from '@/lib/validation/signatures';
import { getResultArtifact } from '@/server/services/signature.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/public/signatures/:publicId/result/:artifact — Original,
 * signiertes Dokument oder Signaturprotokoll, mit Ergebnis-Sitzung.
 */
export const GET = definePublicRoute({
  params: signatureResultArtifactParams,
  rateLimit: 'publicTokenRead',
  handler: async ({ params: p, request }) => {
    const { bytes, filename } = await getResultArtifact(await readSignatureSession(), p.publicId, p.artifact);
    return binaerAntwort({
      bytes,
      mimeType: 'application/pdf',
      filename: sanitizeFilename(filename),
      // Das Protokoll ist ein Beleg zum Ablegen, das Dokument eines zum Ansehen.
      disposition: p.artifact === 'evidence' ? 'attachment' : 'inline',
      request,
      cacheControl: 'no-store',
      headers: { 'Referrer-Policy': 'no-referrer' },
    });
  },
});
