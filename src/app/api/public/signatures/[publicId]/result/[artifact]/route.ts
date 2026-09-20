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
  handler: async ({ params: p }) => {
    const { bytes, filename } = await getResultArtifact(await readSignatureSession(), p.publicId, p.artifact);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': `${p.artifact === 'evidence' ? 'attachment' : 'inline'}; filename="${sanitizeFilename(filename)}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  },
});
