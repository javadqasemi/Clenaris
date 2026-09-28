import 'server-only';

import { prisma, toNumber } from '@/lib/db';
import { round2 } from '@/lib/utils';
import { audit, diff } from '@/lib/audit';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import type { CreateExpenseInput, UpdateExpenseInput } from '@/lib/validation/finance';
import { dateienBinden } from '@/server/services/file.service';

/**
 * Ausgaben (Kreditorenbelege).
 *
 * Vorher im Endpunkt geschrieben (`/api/expenses`, bis 2026-09-27). Die
 * Regeln, die hier hängen, sind Buchhaltungsregeln und keine HTTP-Details:
 * MWST und Brutto entstehen serverseitig aus dem Netto, Belege binden nur
 * eigene Uploads mit dem passenden Profil, und eine Ausgabe in einem bereits
 * exportierten Zeitraum lässt sich nicht mehr löschen. Standen sie im
 * Endpunkt, fand sie der nächste Aufrufer — ein Import, ein Skript — nicht
 * und hätte sie nachbauen oder übergehen müssen. Der Endpunkt übersetzt nur
 * noch HTTP in diese Aufrufe; Berechtigung, Validierung und
 * Ratenbegrenzung bleiben in seiner `defineRoute`-Erklärung.
 */

interface Actor {
  organizationId: string;
  actorId: string;
  ip?: string | null;
}

/** Ausgabenliste, neueste zuerst, mit Lieferantenname. */
export async function listExpenses(
  organizationId: string,
  query: { q?: string; page: number; pageSize: number },
) {
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

  return { items, total };
}

/**
 * Ausgabe erfassen.
 *
 * MWST und Bruttobetrag werden serverseitig aus dem Nettobetrag berechnet —
 * so kann eine fehlerhafte Client-Rechnung die Buchhaltung nicht verfälschen.
 */
export async function createExpense({ organizationId, actorId, input }: Omit<Actor, 'ip'> & { input: CreateExpenseInput }) {
  const vatAmount = round2(input.netAmount * (input.vatRate / 100));
  const grossAmount = round2(input.netAmount + vatAmount);

  const expense = await prisma.$transaction(async (tx) => {
    const angelegt = await tx.expense.create({
      data: {
        organizationId,
        supplierId: input.supplierId ?? null,
        category: input.category,
        description: input.description,
        reference: input.reference ?? null,
        expenseDate: input.expenseDate,
        netAmount: input.netAmount,
        vatRate: input.vatRate,
        vatAmount,
        grossAmount,
        paid: input.paid,
        paidAt: input.paid ? (input.paidAt ?? new Date()) : null,
        vatDeductible: input.vatDeductible,
        notes: input.notes ?? null,
        createdById: actorId,
      },
    });

    // Belege nur aus den eigenen Uploads mit dem Beleg-Profil, ungebunden,
    // ohne den Zweck umzuschreiben (`dateienBinden`, 2026-09-27). Vorher
    // wurde jede Datei der Organisation zum Beleg — auch eine
    // Lohnabrechnung, die damit für jede Rolle mit `expense:read` lesbar
    // wurde. In derselben Transaktion: Passt ein Anhang nicht, entsteht
    // auch die Ausgabe nicht.
    await dateienBinden(tx, { organizationId, fileIds: input.fileIds, uploadedById: actorId, scope: 'EXPENSE', ziel: 'expenseId', zielId: angelegt.id });
    return angelegt;
  });

  await audit.created({
    organizationId,
    userId: actorId,
    entity: 'Expense',
    entityId: expense.id,
    summary: `Ausgabe ${expense.description} über CHF ${toNumber(expense.grossAmount).toFixed(2)}`,
  });

  return expense;
}

/** Ausgabe korrigieren. */
export async function updateExpense({
  organizationId,
  actorId,
  ip,
  expenseId,
  input,
}: Actor & { expenseId: string; input: UpdateExpenseInput }) {
  const before = await prisma.expense.findFirst({ where: { id: expenseId, organizationId } });
  if (!before) throw new NotFoundError('Ausgabe');

  const netAmount = input.netAmount ?? Number(before.netAmount);
  const vatRate = input.vatRate ?? Number(before.vatRate);
  const vatAmount = Math.round(netAmount * (vatRate / 100) * 100) / 100;

  const expense = await prisma.expense.update({
    where: { id: expenseId },
    data: {
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.reference !== undefined ? { reference: input.reference || null } : {}),
      ...(input.supplierId !== undefined ? { supplierId: input.supplierId || null } : {}),
      ...(input.expenseDate !== undefined ? { expenseDate: input.expenseDate } : {}),
      ...(input.paid !== undefined ? { paid: input.paid } : {}),
      ...(input.vatDeductible !== undefined ? { vatDeductible: input.vatDeductible } : {}),
      ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
      // Betrag, Satz und Summe hängen zusammen — sie werden immer gemeinsam
      // neu gerechnet, damit keine Ausgabe mit unstimmiger MWST entsteht.
      ...(input.netAmount !== undefined || input.vatRate !== undefined
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
    userId: actorId,
    entity: 'Expense',
    entityId: expenseId,
    summary: `Ausgabe „${expense.description}" geändert`,
    changes: diff(before as Record<string, unknown>, expense as Record<string, unknown>),
    ip,
  });

  return expense;
}

/**
 * Ausgabe löschen.
 *
 * Nicht möglich, sobald die Ausgabe in einem Buchhaltungsexport enthalten war:
 * die Treuhandstelle hat den Beleg dann bereits verbucht, und ein Loch in der
 * exportierten Reihe fällt erst beim Abschluss auf.
 */
export async function deleteExpense({ organizationId, actorId, ip, expenseId }: Actor & { expenseId: string }) {
  const expense = await prisma.expense.findFirst({ where: { id: expenseId, organizationId } });
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

  await prisma.expense.delete({ where: { id: expenseId } });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'Expense',
    entityId: expenseId,
    summary: `Ausgabe „${expense.description}" gelöscht`,
    ip,
  });
}
