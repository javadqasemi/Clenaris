import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { ForbiddenError, NotFoundError } from '@/lib/errors';
import { jobPhotoSchema } from '@/lib/validation/operations';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/jobs/:id/photos
 *
 * Registriert ein bereits hochgeladenes Foto am Einsatz. Die Datei liegt zu
 * diesem Zeitpunkt schon in Supabase Storage — dieser Endpunkt verknüpft sie
 * nur, weshalb er sehr schnell ist.
 */
export const POST = defineRoute({
  permissions: ['job:complete_assigned', 'job:update'],
  anyPermission: true,
  params: idParam,
  body: jobPhotoSchema,
  rateLimit: 'fileUpload',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();

    const job = await prisma.job.findFirst({
      where: { id: params.id, organizationId, deletedAt: null },
      include: { assignments: { select: { employeeId: true } } },
    });
    if (!job) throw new NotFoundError('Einsatz');

    if (
      session.role === 'EMPLOYEE' &&
      !job.assignments.some((assignment) => assignment.employeeId === session.profileId)
    ) {
      throw new ForbiddenError('Sie sind diesem Einsatz nicht zugeteilt.');
    }

    const photo = await prisma.jobPhoto.create({
      data: {
        jobId: job.id,
        type: body.type,
        url: body.url,
        thumbnailUrl: body.thumbnailUrl ?? null,
        caption: body.caption ?? null,
        room: body.room ?? null,
        lat: body.lat ?? null,
        lng: body.lng ?? null,
        uploadedById: session.profileId,
      },
    });

    return created(photo);
  },
});
