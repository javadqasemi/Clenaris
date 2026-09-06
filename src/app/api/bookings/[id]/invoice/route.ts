import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { createInvoiceFromJobs } from '@/server/services/invoice.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/bookings/:id/invoice
 *
 * Erstellt aus den abgeschlossenen Einsätzen einer Buchung einen
 * Rechnungsentwurf. Bewusst ein Entwurf: vor dem Ausstellen prüft jemand die
 * Positionen — danach ist die Rechnung unveränderlich.
 */
export const POST = defineRoute({
  permissions: ['invoice:create'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session }) => {
    const organizationId = await getOrganizationId();

    const booking = await prisma.booking.findFirst({
      where: { id: params.id, organizationId, deletedAt: null },
      include: { jobs: { where: { status: { in: ['COMPLETED', 'VERIFIED'] } } } },
    });
    if (!booking) throw new NotFoundError('Buchung');

    if (booking.jobs.length === 0) {
      throw new BusinessRuleError(
        'Zu dieser Buchung ist noch kein Einsatz abgeschlossen. Eine Rechnung ist erst danach möglich.',
      );
    }

    const invoice = await createInvoiceFromJobs({
      organizationId,
      customerId: booking.customerId,
      jobIds: booking.jobs.map((job) => job.id),
      issueImmediately: false,
      actorId: session.id,
    });

    return created({ id: invoice.id, number: invoice.number, status: invoice.status });
  },
});