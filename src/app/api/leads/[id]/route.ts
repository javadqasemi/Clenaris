import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { softDelete } from '@/server/services/trash.service';
import { updateLeadSchema } from '@/lib/validation/crm';
import { updateLead } from '@/server/services/crm.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/leads/:id
 *
 * Wird sowohl vom Kanban (Stufenwechsel) als auch vom Detailformular genutzt.
 * Statuswechsel werden als Aktivität protokolliert, damit die Zeitachse
 * lückenlos bleibt.
 */
export const PATCH = defineRoute({
  permissions: ['lead:update'],
  params: idParam,
  body: updateLeadSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const organizationId = await getOrganizationId();

    const lead = await updateLead({
      organizationId,
      leadId: params.id,
      input: body,
      actorId: session.id,
    });

    return ok({ id: lead.id, status: lead.status, stageId: lead.stageId });
  },
});

/**
 * DELETE /api/leads/:id — in den Papierkorb legen.
 *
 * Eine in eine Kundschaft überführte Anfrage bleibt als Herkunftsnachweis erhalten.
 *
 * Weich gelöscht: der Datensatz verschwindet aus allen Listen (jede Abfrage
 * filtert `deletedAt: null`), bleibt aber wiederherstellbar. Verknüpfte
 * Datensätze werden **nicht** mitgelöscht — ein Kaskadenlöschen wäre nicht
 * umkehrbar und widerspräche dem Zweck eines Papierkorbs.
 */
export const DELETE = defineRoute({
  permissions: ['lead:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await softDelete(
      'lead',
      { organizationId: await getOrganizationId(), actorId: session.id, ip },
      params.id,
    );
    return noContent();
  },
});
