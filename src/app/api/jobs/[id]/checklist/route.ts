import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { jobChecklistSchema, jobChecklistTemplateSchema } from '@/lib/validation/operations';
import { applyChecklistTemplate, replaceChecklist } from '@/server/services/job.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PUT /api/jobs/:id/checklist — Checkliste vollständig setzen.
 *
 * `PUT`, nicht `PATCH`: Der Aufruf ersetzt die Liste als Ganzes. Das ist kein
 * Zufall der Benennung, sondern die Bedingung dafür, dass zwei gleichzeitige
 * Bearbeitungen nicht ineinander laufen — die letzte gewinnt vollständig,
 * statt eine halb alte, halb neue Liste zu hinterlassen.
 *
 * Abhaken ist bewusst *nicht* hier: Das macht das Team auf der Baustelle über
 * `/api/jobs/checklist/:id` und braucht nur `job:complete_assigned`.
 */
export const PUT = defineRoute({
  permissions: ['job:update'],
  params: idParam,
  body: jobChecklistSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    await replaceChecklist({
      organizationId: await getOrganizationId(),
      jobId: params.id,
      input: body,
      actorId: session.id,
    });

    return ok({ id: params.id, count: body.items.length });
  },
});

/** POST /api/jobs/:id/checklist — eine Standardcheckliste übernehmen. */
export const POST = defineRoute({
  permissions: ['job:update'],
  params: idParam,
  body: jobChecklistTemplateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const count = await applyChecklistTemplate({
      organizationId: await getOrganizationId(),
      jobId: params.id,
      input: body,
      actorId: session.id,
    });

    return ok({ id: params.id, count });
  },
});
