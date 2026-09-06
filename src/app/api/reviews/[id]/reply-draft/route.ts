import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { writeEmail } from '@/lib/ai/features';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/reviews/:id/reply-draft
 *
 * Entwirft eine öffentliche Antwort auf eine Bewertung.
 *
 * Gerade bei Kritik ist der erste Impuls oft eine Rechtfertigung. Der Entwurf
 * folgt bewusst dem umgekehrten Muster: danken, Verantwortung übernehmen,
 * konkrete Verbesserung nennen, Gespräch anbieten.
 */
export const POST = defineRoute({
  permissions: ['ai:use', 'review:moderate'],
  params: idParam,
  rateLimit: 'aiGenerate',
  handler: async ({ params, session }) => {
    const organizationId = await getOrganizationId();

    const review = await prisma.review.findFirst({
      where: { id: params.id, organizationId },
      select: { authorName: true, rating: true, title: true, body: true },
    });
    if (!review) throw new NotFoundError('Bewertung');

    const result = await writeEmail({
      purpose:
        review.rating >= 4
          ? 'Öffentliche Antwort auf eine positive Bewertung — kurz danken, ohne Werbefloskeln.'
          : 'Öffentliche Antwort auf eine kritische Bewertung: danken, Verantwortung übernehmen, konkrete Verbesserung nennen, persönliches Gespräch anbieten. Nicht rechtfertigen, nicht relativieren.',
      recipientName: review.authorName,
      tone: review.rating >= 4 ? 'freundlich' : 'entschuldigend',
      context: `Bewertung mit ${review.rating} von 5 Sternen.\nTitel: ${review.title ?? '—'}\nText: ${review.body}`,
      senderName: session.name,
    });

    // Nur der Fliesstext — eine öffentliche Antwort hat keinen Betreff.
    return ok({ text: result.body });
  },
});
