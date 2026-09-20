import { defineRoute } from '@/lib/api/handler';
import { sanitizeFilename } from '@/lib/storage';
import { signatureArtifactParams } from '@/lib/validation/signatures';
import { getOrganizationId } from '@/server/services/organization.service';
import { getSignatureArtifactAdmin } from '@/server/services/signature.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/signatures/:id/artifacts/:artifact — Original (A), signiertes
 * Dokument (B) oder Signaturprotokoll (C) für die Verwaltung.
 *
 * Bis Gate 4C gab es diese Dateien nur über den Ergebnislink der
 * unterzeichnenden Person. Die Verwaltung, die eine angenommene Offerte
 * prüft, braucht denselben Zugang — mit ihrer Sitzung und `signature:read`
 * (bei Offerten zusätzlich `quote:read`), protokolliert im Prüfprotokoll.
 */
export const GET = defineRoute({
  permissions: ['signature:read'],
  params: signatureArtifactParams,
  rateLimit: 'fileDownload',
  handler: async ({ params, session }) => {
    const { bytes, filename } = await getSignatureArtifactAdmin(session, await getOrganizationId(), params.id, params.artifact);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': `${params.artifact === 'evidence' ? 'attachment' : 'inline'}; filename="${sanitizeFilename(filename)}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    });
  },
});
