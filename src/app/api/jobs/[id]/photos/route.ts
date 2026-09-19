import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '@/lib/errors';
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

    /**
     * Nur eine abgeschlossene, noch nicht zugeordnete Datei dieser
     * Organisation wird zum Einsatzfoto. `checksum: { not: null }` ist die
     * Prüfung: Ohne sie hat niemand die Bytes gesehen.
     */
    const datei = await prisma.fileAsset.findFirst({
      where: {
        id: body.fileId,
        organizationId,
        scope: 'JOB',
        checksum: { not: null },
        jobId: null,
      },
      select: { id: true, url: true },
    });
    if (!datei) {
      throw new BusinessRuleError('Diese Datei steht nicht zur Verfügung. Bitte erneut hochladen.');
    }

    await prisma.fileAsset.update({ where: { id: datei.id }, data: { jobId: job.id } });

    const photo = await prisma.jobPhoto.create({
      data: {
        jobId: job.id,
        type: body.type,
        url: datei.url,
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
