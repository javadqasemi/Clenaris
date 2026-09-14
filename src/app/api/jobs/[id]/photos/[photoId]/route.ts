import { defineRoute } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { updateJobPhotoSchema } from '@/lib/validation/operations';
import { photoParams } from '@/lib/validation/queries';
import { assertPhotoAccess } from '@/server/services/job.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/jobs/:id/photos/:photoId — Foto einordnen.
 *
 * Fotos entstehen auf der Baustelle mit einer Hand am Telefon; Art und Raum
 * werden dort selten sauber gesetzt. Sie nachträglich einordnen zu können ist
 * der Unterschied zwischen einem Rapport und einem Haufen Bilder.
 *
 * Die Bilddatei selbst wird nie ersetzt: „Ersetzen" heisst hier hochladen und
 * das alte löschen. Ein Bild unter derselben Adresse auszutauschen würde jede
 * bereits verschickte Kopie des Rapports still verändern.
 */
export const PATCH = defineRoute({
  permissions: ['job:complete_assigned', 'job:update'],
  anyPermission: true,
  params: photoParams,
  body: updateJobPhotoSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();

    const photo = await assertPhotoAccess({
      organizationId,
      photoId: params.photoId,
      employeeId: session.role === 'EMPLOYEE' ? (session.profileId ?? undefined) : undefined,
    });

    const updated = await prisma.jobPhoto.update({
      where: { id: photo.id },
      data: {
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.caption !== undefined ? { caption: body.caption || null } : {}),
        ...(body.room !== undefined ? { room: body.room || null } : {}),
      },
    });

    return ok(updated);
  },
});

/**
 * DELETE /api/jobs/:id/photos/:photoId
 *
 * Hart gelöscht, nicht in den Papierkorb: Ein Foto ist häufig genau deshalb zu
 * entfernen, weil es etwas zeigt, das nicht aufbewahrt werden darf — eine
 * Person im Bild, ein offenes Dokument auf dem Schreibtisch. Ein Papierkorb
 * würde diesen Zweck verfehlen. Der Vorgang steht im Prüfprotokoll.
 */
export const DELETE = defineRoute({
  permissions: ['job:complete_assigned', 'job:update'],
  anyPermission: true,
  params: photoParams,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    const organizationId = await getOrganizationId();

    const photo = await assertPhotoAccess({
      organizationId,
      photoId: params.photoId,
      employeeId: session.role === 'EMPLOYEE' ? (session.profileId ?? undefined) : undefined,
    });

    await prisma.jobPhoto.delete({ where: { id: photo.id } });

    await audit.deleted({
      organizationId,
      userId: session.id,
      entity: 'JobPhoto',
      entityId: photo.id,
      summary: `Foto von Einsatz ${photo.job.number} gelöscht`,
      ip,
    });

    return noContent();
  },
});
