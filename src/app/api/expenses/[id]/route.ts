import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { audit, diff } from '@/lib/audit';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { updateExpenseSchema } from '@/lib/validation/finance';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/expenses/:id — Ausgabe korrigieren. */
export const PATCH = defineRoute({
  permissions: ['expense:update'],
  params: idParam,
  body: updateExpenseSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const organizationId = await getOrganizationId();
    const before = await prisma.expense.findFirst({ where: { id: params.id, organizationId } });
    if (!before) throw new NotFoundError('Ausgabe');

    const netAmount = body.netAmount ?? Number(before.netAmount);
    const vatRate = body.vatRate ?? Number(before.vatRate);
    const vatAmount = Math.round(netAmount * (vatRate / 100) * 100) / 100;

    const expense = await prisma.expense.update({
      where: { id: params.id },
      data: {
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.reference !== undefined ? { reference: body.reference || null } : {}),
        ...(body.supplierId !== undefined ? { supplierId: body.supplierId || null } : {}),
        ...(body.expenseDate !== undefined ? { expenseDate: body.expenseDate } : {}),
        ...(body.paid !== undefined ? { paid: body.paid } : {}),
        ...(body.vatDeductible !== undefined ? { vatDeductible: body.vatDeductible } : {}),
        ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
        // Betrag, Satz und Summe hängen zusammen — sie werden immer gemeinsam
        // neu gerechnet, damit keine Ausgabe mit unstimmiger MWST entsteht.
        ...(body.netAmount !== undefined || body.vatRate !== undefined
          ? {
              netAmount,
              vatRate,
              vatAmount,
              grossAmount: Math.round((netAmount + vatAmount) * 100) / 100,
            }
          : {}),
      },
    });

    await audit.updated({
      organizationId,
      userId: session.id,
      entity: 'Expense',
      entityId: params.id,
      summary: `Ausgabe „${expense.description}" geändert`,
      changes: diff(before as Record<string, unknown>, expense as Record<string, unknown>),
      ip,
    });

    return ok({ id: expense.id });
  },
});

/**
 * DELETE /api/expenses/:id
 *
 * Nicht möglich, sobald die Ausgabe in einem Buchhaltungsexport enthalten war:
 * die Treuhandstelle hat den Beleg dann bereits verbucht, und ein Loch in der
 * exportierten Reihe fällt erst beim Abschluss auf.
 */
export const DELETE = defineRoute({
  permissions: ['expense:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    const organizationId = await getOrganizationId();
    const expense = await prisma.expense.findFirst({ where: { id: params.id, organizationId } });
    if (!expense) throw new NotFoundError('Ausgabe');

    const exported = await prisma.accountingExport.count({
      where: {
        organizationId,
        periodFrom: { lte: expense.expenseDate },
        periodTo: { gte: expense.expenseDate },
      },
    });
    if (exported > 0) {
      throw new BusinessRuleError(
        'Diese Ausgabe liegt in einem Zeitraum, der bereits an die Buchhaltung exportiert wurde. ' +
          'Ein nachträgliches Löschen risse ein Loch in die exportierte Reihe — korrigieren Sie mit einer Gegenbuchung.',
      );
    }

    await prisma.expense.delete({ where: { id: params.id } });

    await audit.deleted({
      organizationId,
      userId: session.id,
      entity: 'Expense',
      entityId: params.id,
      summary: `Ausgabe „${expense.description}" gelöscht`,
      ip,
    });

    return noContent();
  },
});
