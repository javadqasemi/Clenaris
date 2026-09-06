import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { softDelete } from '@/server/services/trash.service';
import { updateJobSchema } from '@/lib/validation/operations';
import { getJobDetail, updateJob } from '@/server/services/job.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/jobs/:id — Einsatzdetails.
 * Mitarbeitende erhalten den Einsatz nur, wenn sie ihm zugeteilt sind; die
 * Prüfung passiert im Service über den `employeeId`-Filter.
 */
export const GET = defineRoute({
  permissions: ['job:read', 'job:read_assigned'],
  anyPermission: true,
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session }) => {
    const organizationId = await getOrganizationId();

    const job = await getJobDetail({
      organizationId,
      jobId: params.id,
      employeeId: session.role === 'EMPLOYEE' ? (session.profileId ?? undefined) : undefined,
    });

    return ok(job);
  },
});

/** PATCH /api/jobs/:id — Status, Termin, Notizen ändern. */
export const PATCH = defineRoute({
  permissions: ['job:update'],
  params: idParam,
  body: updateJobSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();

    const job = await updateJob({
      organizationId,
      jobId: params.id,
      input: body,
      actorId: session.id,
    });

    return ok({ id: job.id, status: job.status });
  },
});

/**
 * DELETE /api/jobs/:id — in den Papierkorb legen.
 *
 * Abgeschlossene Einsätze und solche mit gestempelter Zeit bleiben erhalten.
 *
 * Weich gelöscht: der Datensatz verschwindet aus allen Listen (jede Abfrage
 * filtert `deletedAt: null`), bleibt aber wiederherstellbar. Verknüpfte
 * Datensätze werden **nicht** mitgelöscht — ein Kaskadenlöschen wäre nicht
 * umkehrbar und widerspräche dem Zweck eines Papierkorbs.
 */
export const DELETE = defineRoute({
  permissions: ['job:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await softDelete(
      'job',
      { organizationId: await getOrganizationId(), actorId: session.id, ip },
      params.id,
    );
    return noContent();
  },
});
