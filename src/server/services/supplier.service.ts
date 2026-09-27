import 'server-only';

import { prisma } from '@/lib/db';
import { audit, diff } from '@/lib/audit';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import type { CreateSupplierInput } from '@/lib/validation/finance';

/**
 * Lieferanten — Stammdaten der Kreditorenseite.
 *
 * Vorher im Endpunkt geschrieben (`/api/suppliers`, bis 2026-09-27). Die
 * Regel „Geschäftslogik lebt in `src/server/services`" ist hier keine
 * Stilfrage: Die Löschsperre für Lieferanten mit Belegen ist eine
 * Buchhaltungsregel, und sie gehört dorthin, wo der nächste Aufrufer — ein
 * Import, ein Skript, der Nachtlauf — sie findet, statt sie ein zweites Mal
 * zu erfinden oder zu übersehen. Der Endpunkt übersetzt nur noch HTTP in
 * diese Aufrufe; Berechtigung, Validierung und Ratenbegrenzung bleiben in
 * seiner `defineRoute`-Erklärung.
 *
 * Die Organisation reicht der Aufrufer herein und sie steht in jeder
 * `where`-Klausel: ein fremder Lieferant wird schlicht nicht gefunden.
 */

interface Actor {
  organizationId: string;
  actorId: string;
  ip?: string | null;
}

/**
 * Leere Formularfelder werden zu `null`, nicht zu `''` — dieselbe Umwandlung
 * für Anlegen und Ändern, damit ein Feld nicht je nach Weg einmal leer und
 * einmal `null` gespeichert wird. Vorher stand sie in beiden Endpunkten
 * doppelt.
 */
const empty = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : null);

/** Lieferanten mit der Zahl ihrer Belege. */
export async function listSuppliers(
  organizationId: string,
  query: { q?: string; includeInactive?: boolean },
) {
  return prisma.supplier.findMany({
    where: {
      organizationId,
      ...(query.includeInactive ? {} : { active: true }),
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
    },
    orderBy: { name: 'asc' },
    include: { _count: { select: { expenses: true } } },
  });
}

/** Lieferant erfassen. */
export async function createSupplier({ organizationId, actorId, ip, input }: Actor & { input: CreateSupplierInput }) {
  const supplier = await prisma.supplier.create({
    data: {
      organizationId,
      name: input.name,
      contactName: empty(input.contactName),
      email: empty(input.email),
      phone: empty(input.phone),
      street: empty(input.street),
      postalCode: empty(input.postalCode),
      city: empty(input.city),
      country: input.country,
      vatNumber: empty(input.vatNumber),
      iban: empty(input.iban),
      paymentTermDays: input.paymentTermDays,
      notes: empty(input.notes),
    },
  });

  await audit.created({
    organizationId,
    userId: actorId,
    entity: 'Supplier',
    entityId: supplier.id,
    summary: `Lieferant „${supplier.name}" erfasst`,
    ip,
  });

  return supplier;
}

/** Lieferant ändern — auch der Weg, ihn stillzulegen (`active: false`). */
export async function updateSupplier({
  organizationId,
  actorId,
  ip,
  supplierId,
  input,
}: Actor & { supplierId: string; input: Partial<CreateSupplierInput> & { active?: boolean } }) {
  const before = await prisma.supplier.findFirst({
    where: { id: supplierId, organizationId },
  });
  if (!before) throw new NotFoundError('Lieferant');

  const supplier = await prisma.supplier.update({
    where: { id: supplierId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.contactName !== undefined ? { contactName: empty(input.contactName) } : {}),
      ...(input.email !== undefined ? { email: empty(input.email) } : {}),
      ...(input.phone !== undefined ? { phone: empty(input.phone) } : {}),
      ...(input.street !== undefined ? { street: empty(input.street) } : {}),
      ...(input.postalCode !== undefined ? { postalCode: empty(input.postalCode) } : {}),
      ...(input.city !== undefined ? { city: empty(input.city) } : {}),
      ...(input.country !== undefined ? { country: input.country } : {}),
      ...(input.vatNumber !== undefined ? { vatNumber: empty(input.vatNumber) } : {}),
      ...(input.iban !== undefined ? { iban: empty(input.iban) } : {}),
      ...(input.paymentTermDays !== undefined ? { paymentTermDays: input.paymentTermDays } : {}),
      ...(input.notes !== undefined ? { notes: empty(input.notes) } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'Supplier',
    entityId: supplierId,
    summary: `Lieferant „${supplier.name}" geändert`,
    changes: diff(before as Record<string, unknown>, supplier as Record<string, unknown>),
    ip,
  });

  return supplier;
}

/**
 * Lieferant löschen — nur ohne Belege.
 *
 * Eine Ausgabe verweist auf ihren Lieferanten; verschwände er, liesse sich die
 * Ausgabe in der Buchhaltung nicht mehr zuordnen. Ein Lieferant, mit dem man
 * nicht mehr arbeitet, wird auf inaktiv gesetzt — er verschwindet dann aus
 * den Auswahllisten, bleibt aber in alten Belegen lesbar.
 */
export async function deleteSupplier({ organizationId, actorId, ip, supplierId }: Actor & { supplierId: string }) {
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, organizationId },
    include: { _count: { select: { expenses: true } } },
  });
  if (!supplier) throw new NotFoundError('Lieferant');

  if (supplier._count.expenses > 0) {
    throw new BusinessRuleError(
      `Auf „${supplier.name}" sind ${supplier._count.expenses} Ausgaben gebucht. Setzen Sie den Lieferanten stattdessen ` +
        'auf inaktiv — er verschwindet dann aus den Auswahllisten, bleibt in den Belegen aber lesbar.',
    );
  }

  await prisma.supplier.delete({ where: { id: supplierId } });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'Supplier',
    entityId: supplierId,
    summary: `Lieferant „${supplier.name}" gelöscht`,
    ip,
  });
}
