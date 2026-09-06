import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent } from '@/lib/api/response';
import { softDelete } from '@/server/services/trash.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * DELETE /api/invoices/:id — in den Papierkorb legen.
 *
 * Nur Entwürfe. Ausgestellte Rechnungen bleiben unantastbar: nach Art. 957a OR muss die Nummerierung lückenlos sein — korrigiert wird über eine Gutschrift.
 *
 * Weich gelöscht: der Datensatz verschwindet aus allen Listen (jede Abfrage
 * filtert `deletedAt: null`), bleibt aber wiederherstellbar. Verknüpfte
 * Datensätze werden **nicht** mitgelöscht — ein Kaskadenlöschen wäre nicht
 * umkehrbar und widerspräche dem Zweck eines Papierkorbs.
 */
export const DELETE = defineRoute({
  permissions: ['invoice:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await softDelete(
      'invoice',
      { organizationId: await getOrganizationId(), actorId: session.id, ip },
      params.id,
    );
    return noContent();
  },
});
