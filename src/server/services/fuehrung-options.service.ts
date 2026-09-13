import 'server-only';

import { prisma } from '@/lib/db';

/**
 * Auswahllisten für die Masken der Unternehmensführung.
 *
 * Kleine, gezielte Abfragen mit `select` — sie stehen auf fast jeder Seite
 * des Bereichs, und eine Personenliste mit Lohnfeldern hätte in einem
 * Auswahlfeld nichts verloren.
 */

export async function listStaffOptions(organizationId: string) {
  const users = await prisma.user.findMany({
    where: { organizationId, deletedAt: null, status: 'ACTIVE', role: { in: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EMPLOYEE'] } },
    select: { id: true, firstName: true, lastName: true, role: true },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });
  return users.map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`, role: u.role }));
}

export async function listEmployeeOptions(organizationId: string) {
  const employees = await prisma.employee.findMany({
    where: { organizationId, active: true },
    select: { id: true, user: { select: { firstName: true, lastName: true } } },
    orderBy: { user: { lastName: 'asc' } },
  });
  return employees.map((e) => ({ id: e.id, name: `${e.user.firstName} ${e.user.lastName}` }));
}

export async function listSupplierOptions(organizationId: string) {
  return prisma.supplier.findMany({ where: { organizationId, active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
}

export async function listKpiOptions(organizationId: string) {
  return prisma.kpiDefinition.findMany({ where: { organizationId, active: true }, select: { id: true, label: true, unit: true, key: true }, orderBy: [{ group: 'asc' }, { label: 'asc' }] });
}

export async function listObjectiveOptions(organizationId: string) {
  return prisma.objective.findMany({
    where: { organizationId, deletedAt: null, status: { in: ['DRAFT', 'ACTIVE', 'AT_RISK'] } },
    select: { id: true, title: true, horizon: true },
    orderBy: [{ horizon: 'asc' }, { title: 'asc' }],
  });
}

export async function listBudgetOptions(organizationId: string) {
  return prisma.budgetPeriod.findMany({ where: { organizationId }, select: { id: true, name: true, fiscalYear: true }, orderBy: [{ fiscalYear: 'desc' }, { name: 'asc' }] });
}
