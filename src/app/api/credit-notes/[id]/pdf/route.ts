import { binaerAntwort } from '@/lib/api/binary-response';
import { defineRoute, idParam } from '@/lib/api/handler';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { renderCreditNotePdf } from '@/lib/pdf/render';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/credit-notes/:id/pdf — die Gutschrift als PDF. Gerendert aus den
 * unveränderlichen Daten der Gutschrift; die Organisation steht in der
 * Abfrage.
 */
export const GET = defineRoute({
  permissions: ['creditnote:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, request }) => {
    const note = await prisma.creditNote.findFirst({
      where: { id: params.id, organizationId: await getOrganizationId() },
      select: { id: true },
    });
    if (!note) throw new NotFoundError('Gutschrift');
    const { buffer, filename } = await renderCreditNotePdf(note.id);
    return binaerAntwort({ bytes: buffer, mimeType: 'application/pdf', filename, disposition: 'attachment', request, cacheControl: 'private, no-store' });
  },
});
