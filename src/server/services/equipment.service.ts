import 'server-only';

import type { EquipmentStatus, Prisma } from '@prisma/client';

import { audit } from '@/lib/audit';
import { toDateOnly } from '@/lib/bi/periods';
import { prisma } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import type { EquipmentCreateInput, EquipmentMaintenanceInput, EquipmentUpdateInput } from '@/lib/validation/betrieb';

import { nextNumber } from './numbering.service';

/**
 * Geräte (Wave 11, 2026-09-23): Inventarnummer, Zuteilung an eine Person,
 * Wartungsintervall und -belege, Ausmusterung.
 *
 *  • **Zuteilung ist ein Zustand, kein Freitext.** Ein zugeteiltes Gerät ist
 *    `IN_USE`; zurückgegeben wird es `AVAILABLE`. Ein ausgemustertes Gerät
 *    lässt sich nicht zuteilen.
 *  • **Die nächste Wartung rechnet sich aus der letzten.** Eine erfasste
 *    Wartung setzt `nextMaintenanceOn = Wartungstag + Intervall`, sofern ein
 *    Intervall vereinbart ist. Der Wartungsbeleg ist unveränderlich (Trigger).
 *  • **Ausmustern mit Grund**, endgültig: Der Datensatz bleibt als Beleg für
 *    Anschaffung und Wartung.
 */

const plusTage = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const tag = (text: string) => new Date(`${text}T00:00:00Z`);

export async function listEquipment(params: { organizationId: string; status?: EquipmentStatus; wartungFaellig?: boolean }) {
  const heute = toDateOnly(new Date());
  const where: Prisma.EquipmentWhereInput = {
    organizationId: params.organizationId,
    ...(params.status ? { status: params.status } : { status: { not: 'RETIRED' } }),
    ...(params.wartungFaellig ? { nextMaintenanceOn: { lte: plusTage(heute, 14) }, status: { not: 'RETIRED' } } : {}),
  };
  const geraete = await prisma.equipment.findMany({
    where,
    orderBy: [{ nextMaintenanceOn: { sort: 'asc', nulls: 'last' } }, { inventoryNumber: 'asc' }],
    take: 1000,
    include: { assignedEmployee: { select: { id: true, employeeNumber: true, user: { select: { firstName: true, lastName: true } } } } },
  });
  return geraete.map((g) => ({
    ...g,
    wartungUeberfaellig: g.nextMaintenanceOn !== null && g.nextMaintenanceOn.getTime() < heute.getTime(),
  }));
}

export async function getEquipment(organizationId: string, id: string) {
  const g = await prisma.equipment.findFirst({
    where: { id, organizationId },
    include: {
      assignedEmployee: { select: { id: true, employeeNumber: true, user: { select: { firstName: true, lastName: true } } } },
      maintenances: { orderBy: { performedOn: 'desc' }, take: 100 },
    },
  });
  if (!g) throw new NotFoundError('Gerät');
  return g;
}

export async function createEquipment(params: { organizationId: string; actorId: string; ip?: string | null; input: EquipmentCreateInput }) {
  const { input } = params;
  const neu = await prisma.$transaction(async (tx) => {
    const { number } = await nextNumber(tx, params.organizationId, 'equipment');
    return tx.equipment.create({
      data: {
        organizationId: params.organizationId,
        inventoryNumber: number,
        name: input.name,
        category: input.category ?? null,
        serialNumber: input.serialNumber ?? null,
        purchasedOn: input.purchasedOn ? tag(input.purchasedOn) : null,
        purchaseCost: input.purchaseCost ?? null,
        maintenanceIntervalDays: input.maintenanceIntervalDays ?? null,
        nextMaintenanceOn: input.nextMaintenanceOn
          ? tag(input.nextMaintenanceOn)
          : input.maintenanceIntervalDays && input.purchasedOn
            ? plusTage(tag(input.purchasedOn), input.maintenanceIntervalDays)
            : null,
        note: input.note ?? null,
      },
    });
  });
  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Equipment',
    entityId: neu.id,
    summary: `Gerät ${neu.inventoryNumber} „${neu.name}" erfasst`,
    ip: params.ip,
  });
  return neu;
}

async function laden(organizationId: string, id: string) {
  const g = await prisma.equipment.findFirst({ where: { id, organizationId } });
  if (!g) throw new NotFoundError('Gerät');
  return g;
}

export async function updateEquipment(params: { organizationId: string; id: string; actorId: string; ip?: string | null; input: EquipmentUpdateInput }) {
  const vorher = await laden(params.organizationId, params.id);
  if (vorher.status === 'RETIRED') throw new BusinessRuleError('Ein ausgemustertes Gerät wird nicht mehr geändert.');
  const { input } = params;
  const nachher = await prisma.equipment.update({
    where: { id: vorher.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.serialNumber !== undefined ? { serialNumber: input.serialNumber } : {}),
      ...(input.maintenanceIntervalDays !== undefined ? { maintenanceIntervalDays: input.maintenanceIntervalDays } : {}),
      ...(input.nextMaintenanceOn !== undefined ? { nextMaintenanceOn: input.nextMaintenanceOn ? tag(input.nextMaintenanceOn) : null } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    },
  });
  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Equipment',
    entityId: vorher.id,
    summary: `Gerät ${vorher.inventoryNumber} geändert`,
    ip: params.ip,
  });
  return nachher;
}

/** Zuteilen (Person) oder zurücknehmen (`null`). */
export async function assignEquipment(params: { organizationId: string; id: string; employeeId: string | null; actorId: string; ip?: string | null }) {
  const vorher = await laden(params.organizationId, params.id);
  if (vorher.status === 'RETIRED') throw new BusinessRuleError('Ein ausgemustertes Gerät wird nicht zugeteilt.');
  if (params.employeeId) {
    if (vorher.status === 'MAINTENANCE') throw new BusinessRuleError('Das Gerät ist in Wartung.');
    const person = await prisma.employee.findFirst({
      where: { id: params.employeeId, organizationId: params.organizationId, active: true },
      select: { id: true },
    });
    if (!person) throw new NotFoundError('Personalakte');
  }
  const treffer = await prisma.equipment.updateMany({
    where: { id: vorher.id, status: vorher.status, assignedEmployeeId: vorher.assignedEmployeeId },
    data: params.employeeId
      ? { assignedEmployeeId: params.employeeId, status: 'IN_USE' }
      : { assignedEmployeeId: null, status: vorher.status === 'IN_USE' ? 'AVAILABLE' : vorher.status },
  });
  if (treffer.count === 0) throw new BusinessRuleError('Das Gerät wurde eben anders zugeteilt — bitte neu laden.');
  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Equipment',
    entityId: vorher.id,
    summary: params.employeeId ? `Gerät ${vorher.inventoryNumber} zugeteilt` : `Gerät ${vorher.inventoryNumber} zurückgenommen`,
    changes: { assignedEmployeeId: { from: vorher.assignedEmployeeId, to: params.employeeId } },
    ip: params.ip,
  });
  return prisma.equipment.findUniqueOrThrow({ where: { id: vorher.id } });
}

/** Eine durchgeführte Wartung festhalten — Beleg plus nächste Fälligkeit. */
export async function recordMaintenance(params: {
  organizationId: string;
  id: string;
  actorId: string;
  ip?: string | null;
  input: EquipmentMaintenanceInput;
}) {
  const g = await laden(params.organizationId, params.id);
  if (g.status === 'RETIRED') throw new BusinessRuleError('Ein ausgemustertes Gerät wird nicht mehr gewartet.');
  const am = tag(params.input.performedOn);
  if (am.getTime() > toDateOnly(new Date()).getTime()) throw new BusinessRuleError('Eine Wartung in der Zukunft ist eine Planung, kein Beleg.');
  const beleg = await prisma.$transaction(async (tx) => {
    const neu = await tx.equipmentMaintenance.create({
      data: {
        equipmentId: g.id,
        performedOn: am,
        kind: params.input.kind,
        note: params.input.note ?? null,
        cost: params.input.cost ?? null,
        createdById: params.actorId,
      },
    });
    await tx.equipment.update({
      where: { id: g.id },
      data: {
        ...(g.maintenanceIntervalDays ? { nextMaintenanceOn: plusTage(am, g.maintenanceIntervalDays) } : {}),
        ...(params.input.wiederVerfuegbar && g.status === 'MAINTENANCE'
          ? { status: g.assignedEmployeeId ? 'IN_USE' : 'AVAILABLE' }
          : {}),
      },
    });
    return neu;
  });
  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'EquipmentMaintenance',
    entityId: beleg.id,
    summary: `Wartung von Gerät ${g.inventoryNumber} am ${params.input.performedOn} festgehalten`,
    ip: params.ip,
  });
  return beleg;
}

/** In Wartung geben, zurück in Betrieb, ausmustern. */
export async function setEquipmentStatus(params: {
  organizationId: string;
  id: string;
  status: 'AVAILABLE' | 'MAINTENANCE' | 'RETIRED';
  reason?: string;
  actorId: string;
  ip?: string | null;
}) {
  const vorher = await laden(params.organizationId, params.id);
  if (vorher.status === 'RETIRED') throw new BusinessRuleError('Ausgemustert ist endgültig.');
  const data: Prisma.EquipmentUncheckedUpdateManyInput =
    params.status === 'RETIRED'
      ? { status: 'RETIRED', retiredAt: new Date(), retiredReason: params.reason ?? null, assignedEmployeeId: null }
      : params.status === 'AVAILABLE'
        ? { status: vorher.assignedEmployeeId ? 'IN_USE' : 'AVAILABLE' }
        : { status: 'MAINTENANCE' };
  const treffer = await prisma.equipment.updateMany({ where: { id: vorher.id, status: vorher.status }, data });
  if (treffer.count === 0) throw new BusinessRuleError('Das Gerät hat sich eben geändert — bitte neu laden.');
  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Equipment',
    entityId: vorher.id,
    summary: `Gerät ${vorher.inventoryNumber}: ${vorher.status} → ${params.status}${params.reason ? ` (${params.reason})` : ''}`,
    ip: params.ip,
  });
  return prisma.equipment.findUniqueOrThrow({ where: { id: vorher.id } });
}
