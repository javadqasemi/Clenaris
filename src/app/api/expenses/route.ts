import { defineRoute, searchQuery } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { prisma, toNumber } from '@/lib/db';
import { round2 } from '@/lib/utils';
import { audit } from '@/lib/audit';
import { createExpenseSchema } from '@/lib/validation/finance';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/expenses — Ausgabenliste. */
export const GET = defineRoute({
  permissions: ['expense:read'],
  query: searchQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const organizationId = await getOrganizationId();

    const where = {
      organizationId,
      ...(query.q ? { description: { contains: query.q, mode: 'insensitive' as const } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.expense.findMany({
        where,
        orderBy: { expenseDate: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { supplier: { select: { name: true } } },
      }),
      prisma.expense.count({ where }),
    ]);

    return paginated(items, buildPagination(query.page, query.pageSize, total));
  },
});

/**
 * POST /api/expenses
 *
 * MWST und Bruttobetrag werden serverseitig aus dem Nettobetrag berechnet —
 * so kann eine fehlerhafte Client-Rechnung die Buchhaltung nicht verfälschen.
 */
export const POST = defineRoute({
  permissions: ['expense:create'],
  body: createExpenseSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();

    const vatAmount = round2(body.netAmount * (body.vatRate / 100));
    const grossAmount = round2(body.netAmount + vatAmount);

    const expense = await prisma.expense.create({
      data: {
        organizationId,
        supplierId: body.supplierId ?? null,
        category: body.category,
        description: body.description,
        reference: body.reference ?? null,
        expenseDate: body.expenseDate,
        netAmount: body.netAmount,
        vatRate: body.vatRate,
        vatAmount,
        grossAmount,
        paid: body.paid,
        paidAt: body.paid ? (body.paidAt ?? new Date()) : null,
        vatDeductible: body.vatDeductible,
        notes: body.notes ?? null,
        createdById: session.id,
      },
    });

    if (body.fileIds.length > 0) {
      await prisma.fileAsset.updateMany({
        where: { id: { in: body.fileIds }, organizationId },
        data: { expenseId: expense.id, scope: 'EXPENSE' },
      });
    }

    await audit.created({
      organizationId,
      userId: session.id,
      entity: 'Expense',
      entityId: expense.id,
      summary: `Ausgabe ${expense.description} über CHF ${toNumber(expense.grossAmount).toFixed(2)}`,
    });

    return created({ id: expense.id, grossAmount: expense.grossAmount });
  },
});
