import { defineRoute, idParam } from '@/lib/api/handler';
import { audit } from '@/lib/audit';
import { updateInvoiceSchema } from '@/lib/validation/finance';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { prisma } from '@/lib/db';
import { noContent, ok } from '@/lib/api/response';
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

/**
 * PATCH /api/invoices/:id — Rechnungsentwurf ändern.
 *
 * Nur Entwürfe. Eine ausgestellte Rechnung ist ein Beleg: Betrag, Datum und
 * Nummer sind ab dem Ausstellen unveränderlich, weil die Buchhaltung darauf
 * aufbaut und die Kundschaft sie erhalten hat. Korrigiert wird über eine
 * Gutschrift.
 */
export const PATCH = defineRoute({
  permissions: ['invoice:update'],
  params: idParam,
  body: updateInvoiceSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const organizationId = await getOrganizationId();
    const invoice = await prisma.invoice.findFirst({
      where: { id: params.id, organizationId, deletedAt: null },
    });
    if (!invoice) throw new NotFoundError('Rechnung');

    if (invoice.status !== 'DRAFT') {
      throw new BusinessRuleError(
        `Rechnung ${invoice.number} ist ausgestellt und damit unveränderlich. ` +
          'Korrigieren Sie über eine Gutschrift oder eine Stornierung.',
      );
    }

    const updated = await prisma.invoice.update({
      where: { id: params.id },
      data: {
        ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
        ...(body.notes !== undefined ? { notes: body.notes ?? null } : {}),
        ...(body.introText !== undefined ? { introText: body.introText ?? null } : {}),
        ...(body.outroText !== undefined ? { outroText: body.outroText ?? null } : {}),
      },
    });

    await audit.updated({
      organizationId,
      userId: session.id,
      entity: 'Invoice',
      entityId: params.id,
      summary: `Rechnungsentwurf ${updated.number} geändert`,
      ip,
    });

    return ok({ id: updated.id, number: updated.number, status: updated.status });
  },
});
