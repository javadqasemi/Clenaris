import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { writeReviewReply } from '@/lib/ai/features';
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
      select: {
        authorName: true,
        rating: true,
        title: true,
        body: true,
        customer: { select: { firstName: true, lastName: true, contacts: { select: { firstName: true, lastName: true } } } },
      },
    });
    if (!review) throw new NotFoundError('Bewertung');

    // Die Namen, die im Bewertungstext stehen können und nicht hinausgehören:
    // Mitarbeitende („Frau Keller war super"), die Kundschaft der Bewertung
    // samt Kontakten. Die Konten der Organisation sind eine kleine Menge und
    // werden je Aufruf frisch gelesen — wie im Führungsassistenten (F-15).
    const konten = await prisma.user.findMany({ where: { organizationId }, select: { firstName: true, lastName: true } });
    const bekannteNamen = [
      ...konten.flatMap((k) => [k.firstName, k.lastName]),
      review.customer?.firstName,
      review.customer?.lastName,
      ...(review.customer?.contacts ?? []).flatMap((c) => [c.firstName, c.lastName]),
    ];

    // Eigene Nutzlast statt `writeEmail`: Sterne als Zahl, Zweck aus dem Code,
    // Text geschwärzt ohne Rückweg (`bewertungsantwortNutzlast`).
    // Nur der Fliesstext — eine öffentliche Antwort hat keinen Betreff.
    const text = await writeReviewReply({
      rating: review.rating,
      title: review.title,
      body: review.body,
      authorName: review.authorName,
      senderName: session.name,
      bekannteNamen,
    });

    return ok({ text });
  },
});
