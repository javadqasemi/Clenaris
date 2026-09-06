import { defineRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { createActivitySchema } from '@/lib/validation/crm';

export const runtime = 'nodejs';

/**
 * POST /api/activities — Verlaufseintrag zu Kunde, Lead oder Einsatz.
 *
 * Die Verknüpfungen sind bewusst mehrfach möglich: ein Telefonat kann
 * gleichzeitig zu einem Kunden *und* zu einem konkreten Einsatz gehören. Beim
 * Kunden erscheint es dann in der Gesamthistorie, beim Einsatz im Kontext.
 */
export const POST = defineRoute({
  permissions: ['activity:create'],
  body: createActivitySchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const activity = await prisma.activity.create({
      data: {
        type: body.type,
        subject: body.subject,
        body: body.body ?? null,
        durationMinutes: body.durationMinutes ?? null,
        occurredAt: body.occurredAt ?? new Date(),
        authorId: session.id,
        customerId: body.customerId ?? null,
        leadId: body.leadId ?? null,
        jobId: body.jobId ?? null,
        bookingId: body.bookingId ?? null,
        quoteId: body.quoteId ?? null,
        invoiceId: body.invoiceId ?? null,
      },
    });

    return created({ id: activity.id, occurredAt: activity.occurredAt });
  },
});
