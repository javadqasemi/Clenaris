import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma, toNumber } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { formatDateLong } from '@/lib/utils';
import { generateJobReport } from '@/lib/ai/features';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/jobs/:id/report/draft
 *
 * Erzeugt einen Berichtsentwurf aus Checkliste, Material und Zeiterfassung.
 * Bewusst ein *Entwurf*: der Text geht an die Kundschaft, also gibt ihn eine
 * Person frei, bevor er gespeichert wird.
 */
export const POST = defineRoute({
  permissions: ['ai:use', 'job:update'],
  params: idParam,
  rateLimit: 'aiGenerate',
  handler: async ({ params }) => {
    const organizationId = await getOrganizationId();

    const job = await prisma.job.findFirst({
      where: { id: params.id, organizationId, deletedAt: null },
      include: {
        customer: { select: { firstName: true, lastName: true, companyName: true } },
        service: { select: { name: true } },
        checklist: { orderBy: { position: 'asc' } },
        materials: true,
        timeEntries: true,
        assignments: {
          include: { employee: { include: { user: { select: { firstName: true, lastName: true } } } } },
        },
      },
    });
    if (!job) throw new NotFoundError('Einsatz');

    const durationMinutes =
      job.timeEntries.reduce((sum, entry) => sum + entry.minutes, 0) || job.estimatedMin;

    const text = await generateJobReport({
      jobNumber: job.number,
      customerName:
        job.customer.companyName ?? `${job.customer.firstName} ${job.customer.lastName}`,
      serviceName: job.service?.name ?? job.title,
      date: formatDateLong(job.actualStart ?? job.scheduledStart),
      durationMinutes,
      crew: job.assignments.map(
        (assignment) => `${assignment.employee.user.firstName} ${assignment.employee.user.lastName}`,
      ),
      checklist: job.checklist.map((item) => ({
        label: item.room ? `${item.room}: ${item.label}` : item.label,
        done: item.done,
        note: item.note,
      })),
      materials: job.materials.map((material) => ({
        name: material.name,
        quantity: toNumber(material.quantity),
        unit: material.unit,
      })),
      notes: job.completionNote,
    });

    return ok({ text });
  },
});
