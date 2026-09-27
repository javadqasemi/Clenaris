import 'server-only';

import { prisma, type Tx } from '@/lib/db';
import { audit, diff } from '@/lib/audit';
import { can } from '@/lib/auth/rbac';
import type { SessionUser } from '@/lib/auth/session';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '@/lib/errors';
import type { CreateAddressInput, UpdateAddressInput } from '@/lib/validation/crm';

/**
 * Adressen einer Kundschaft.
 *
 * Architekturentscheide:
 *
 *  • **Eine Kundschaft hat mehrere Adressen, nicht eine.** Wohnung und Büro,
 *    Rechnungsanschrift bei der Treuhand, das Ferienhaus. Genau eine ist die
 *    Standardadresse, höchstens eine die Rechnungsanschrift.
 *
 *  • **Die Standardadresse ist eine Eigenschaft der Menge, nicht der Zeile.**
 *    Sie wird deshalb in einer Transaktion umgesetzt: Erst verlieren alle
 *    anderen die Markierung, dann bekommt die neue sie. Zwei Standardadressen
 *    wären kein sichtbarer Fehler — die Buchung nähme einfach irgendeine, und
 *    das Team stünde vor der falschen Tür.
 *
 *  • **Eine Adresse, an der Einsätze hängen, wird nicht gelöscht.** Sie trägt
 *    kein `deletedAt`; ein Löschen wäre endgültig und risse die Adresse aus
 *    abgeschlossenen Einsatzrapporten und Rechnungen. Wer umzieht, legt eine
 *    neue an — die alte bleibt als Beleg stehen, wohin damals gefahren wurde.
 *
 *  • **Die letzte Adresse bleibt.** Ohne sie liesse sich keine Buchung mehr
 *    anlegen, und die Kundschaft stünde vor einem Formular, das nicht
 *    weitergeht.
 */

/**
 * Darf diese Sitzung an diese Kundenakte?
 *
 * Reihenfolge mit Absicht: erst das allgemeine Recht, dann das eigene. Wer
 * beides hat — eine Person mit Kundenkonto *und* Bürorechten — kommt über das
 * allgemeine hinein und wird nicht auf die eigene Akte eingeschränkt.
 *
 * Die Meldung nennt nicht, ob die fremde Akte existiert. Das geht die
 * anfragende Person nichts an, und ein Unterschied zwischen „gibt es nicht"
 * und „dürfen Sie nicht" wäre ein Weg, fremde Kennungen abzuklopfen.
 */
export function assertMayManageAddresses(session: SessionUser, customerId: string): void {
  if (can(session.role, 'customer:update')) return;
  if (session.profileId !== customerId) {
    throw new ForbiddenError('Sie dürfen nur die eigenen Adressen bearbeiten.');
  }
}

export function assertMayReadAddresses(session: SessionUser, customerId: string): void {
  if (can(session.role, 'customer:read')) return;
  if (session.profileId !== customerId) {
    throw new ForbiddenError('Sie dürfen nur die eigenen Adressen einsehen.');
  }
}

/** Was die Masken auf beiden Seiten anzeigen. */
export async function listAddresses(customerId: string) {
  return prisma.address.findMany({
    where: { customerId },
    orderBy: [{ isDefault: 'desc' }, { isBilling: 'desc' }, { createdAt: 'asc' }],
    include: {
      _count: { select: { properties: true, bookings: true, jobs: true } },
    },
  });
}

/** Gehört diese Adresse zu dieser Kundschaft — und die zu diesem Mandanten? */
async function requireAddress(params: {
  organizationId: string;
  customerId: string;
  addressId: string;
}) {
  const address = await prisma.address.findFirst({
    where: {
      id: params.addressId,
      customerId: params.customerId,
      customer: { organizationId: params.organizationId, deletedAt: null },
    },
    include: { _count: { select: { properties: true, bookings: true, jobs: true } } },
  });
  if (!address) throw new NotFoundError('Adresse');
  return address;
}

async function requireCustomer(organizationId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, organizationId, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, companyName: true },
  });
  if (!customer) throw new NotFoundError('Kundschaft');
  return customer;
}

/** Felder, die festlegen, *wo* die Adresse ist — siehe `updateAddress`. */
const ORTSFELDER = ['street', 'streetNo', 'addition', 'postalCode', 'city', 'canton', 'country', 'lat', 'lng', 'placeId'] as const;

const describe = (address:{ street: string; streetNo: string | null; city: string }) =>
  `${address.street} ${address.streetNo ?? ''}`.trim() + `, ${address.city}`;

/**
 * Sperre je Kundschaft über ihre Adressen (2026-09-27).
 *
 * Standard- und Rechnungsadresse werden umgesetzt, indem zuerst alle übrigen
 * Adressen der Kundschaft den Merker verlieren und dann eine ihn bekommt.
 * Gleichzeitige Umsetzungen sperrten dieselben Zeilen in verschiedener
 * Reihenfolge und verklemmten sich — im Release-Lauf auf frischer Datenbank
 * antworteten drei von vier mit 500. „Genau eine Standardadresse" hielt die
 * Zeilensperre zwar, aber eine Verklemmung ist kein Ergebnis, das die
 * Oberfläche erklären kann. Die Sperre reiht die Umsetzungen einer Kundschaft
 * hintereinander; Adressen verschiedener Kundschaften warten nicht
 * aufeinander.
 */
async function adressenSperren(tx: Tx, customerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`adressen:${customerId}`}))`;
}

export async function createAddress(params: {
  organizationId: string;
  customerId: string;
  actorId: string;
  ip?: string | null;
  input: CreateAddressInput;
}) {
  await requireCustomer(params.organizationId, params.customerId);

  const existing = await prisma.address.count({ where: { customerId: params.customerId } });

  // Die erste Adresse ist zwangsläufig die Standardadresse — sonst hätte die
  // Kundschaft eine Adresse und trotzdem keine, die eine Buchung nehmen kann.
  const isDefault = existing === 0 ? true : params.input.isDefault;
  const isBilling = existing === 0 ? true : params.input.isBilling;

  const address = await prisma.$transaction(async (tx) => {
    await adressenSperren(tx, params.customerId);
    if (isDefault) {
      await tx.address.updateMany({
        where: { customerId: params.customerId },
        data: { isDefault: false },
      });
    }
    if (isBilling) {
      await tx.address.updateMany({
        where: { customerId: params.customerId },
        data: { isBilling: false },
      });
    }
    return tx.address.create({
      data: { ...params.input, isDefault, isBilling, customerId: params.customerId },
    });
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Address',
    entityId: address.id,
    summary: `Adresse ${describe(address)} erfasst`,
    ip: params.ip,
  });

  return address;
}

export async function updateAddress(params: {
  organizationId: string;
  customerId: string;
  addressId: string;
  actorId: string;
  ip?: string | null;
  input: UpdateAddressInput;
}) {
  const before = await requireAddress(params);

  /**
   * Die Standardmarkierung lässt sich nicht abwählen, nur weitergeben.
   *
   * Ein Häkchen, das man entfernen kann, hinterliesse eine Kundschaft ohne
   * Standardadresse. Wer eine andere zur Standardadresse macht, nimmt sie
   * dieser hier automatisch weg — das ist der Weg, der gemeint ist.
   */
  if (before.isDefault && params.input.isDefault === false) {
    throw new BusinessRuleError(
      'Diese Adresse ist die Standardadresse. Machen Sie stattdessen eine andere zur Standardadresse — die Markierung wandert dann von selbst.',
    );
  }

  /**
   * Der Ort einer Adresse mit Geschichte bleibt, wie er war (2026-09-27).
   *
   * Buchungen und Einsätze zeigen auf die Adresszeile, sie kopieren sie
   * nicht. Bis hierher liess sich die Strasse einer Adresse ändern, an der
   * abgeschlossene Einsätze hängen — und der Rapport vom letzten März zeigte
   * danach die neue Wohnung, obwohl das Team in der alten gereinigt hatte.
   * Dieselbe Überlegung, aus der das Löschen verweigert wird (siehe unten),
   * nur leiser: Nichts verschwindet, es wird bloss falsch.
   *
   * Erwogen und verworfen: beim Ändern still eine Kopie anlegen und die
   * offenen Aufträge umhängen. Das sähe bequem aus, hinterliesse aber zwei
   * fast gleiche Adressen in der Liste der Kundschaft, ohne dass jemand sie
   * angelegt hätte. Der Umzug ist ein eigener Vorgang — neue Adresse,
   * Standard umsetzen —, und die Meldung sagt genau das.
   *
   * Solange nur offene Aufträge daran hängen, bleibt die Korrektur möglich:
   * Ein Tippfehler in der Hausnummer soll das Team zur richtigen Tür führen,
   * und die offenen Aufträge sollen ihm folgen.
   */
  const ortGeaendert = ORTSFELDER.some(
    (feld) => params.input[feld] !== undefined && String(params.input[feld] ?? '') !== String(before[feld] ?? ''),
  );
  if (ortGeaendert) {
    const [abgeschlosseneBuchungen, abgeschlosseneEinsaetze] = await Promise.all([
      prisma.booking.count({ where: { addressId: params.addressId, status: { in: ['COMPLETED', 'NO_SHOW'] } } }),
      prisma.job.count({ where: { addressId: params.addressId, status: { in: ['COMPLETED', 'VERIFIED'] } } }),
    ]);
    if (abgeschlosseneBuchungen + abgeschlosseneEinsaetze > 0) {
      throw new BusinessRuleError(
        'An dieser Adresse hängen abgeschlossene Aufträge; sie belegt, wo damals gearbeitet wurde, und ihr Ort bleibt deshalb unverändert. ' +
          'Bei einem Umzug legen Sie eine neue Adresse an und machen sie zur Standardadresse. Bezeichnung, Zugangshinweis und Markierungen lassen sich weiterhin ändern.',
      );
    }
  }

  const address = await prisma.$transaction(async (tx) => {
    await adressenSperren(tx, params.customerId);
    if (params.input.isDefault === true) {
      await tx.address.updateMany({
        where: { customerId: params.customerId, id: { not: params.addressId } },
        data: { isDefault: false },
      });
    }
    if (params.input.isBilling === true) {
      await tx.address.updateMany({
        where: { customerId: params.customerId, id: { not: params.addressId } },
        data: { isBilling: false },
      });
    }
    return tx.address.update({ where: { id: params.addressId }, data: params.input });
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Address',
    entityId: address.id,
    summary: `Adresse ${describe(address)} geändert`,
    changes: diff(
      before as unknown as Record<string, unknown>,
      address as unknown as Record<string, unknown>,
    ),
    ip: params.ip,
  });

  return address;
}

export async function deleteAddress(params: {
  organizationId: string;
  customerId: string;
  addressId: string;
  actorId: string;
  ip?: string | null;
}) {
  const address = await requireAddress(params);

  const used =
    address._count.properties + address._count.bookings + address._count.jobs;
  if (used > 0) {
    const parts = [
      address._count.properties && `${address._count.properties} Objekt(e)`,
      address._count.bookings && `${address._count.bookings} Buchung(en)`,
      address._count.jobs && `${address._count.jobs} Einsatz/Einsätze`,
    ].filter(Boolean);

    throw new BusinessRuleError(
      `An dieser Adresse hängen noch ${parts.join(', ')}. Sie bleibt deshalb stehen — ` +
        'sie belegt, wohin damals gefahren wurde. Bei einem Umzug legen Sie eine neue an ' +
        'und machen sie zur Standardadresse.',
    );
  }

  const remaining = await prisma.address.count({ where: { customerId: params.customerId } });
  if (remaining <= 1) {
    throw new BusinessRuleError(
      'Das ist die einzige Adresse dieser Kundschaft. Ohne Adresse lässt sich kein Termin buchen — legen Sie zuerst eine neue an.',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.address.delete({ where: { id: params.addressId } });

    // Ist die Standardadresse weg, rückt die älteste verbleibende nach.
    if (address.isDefault) {
      const next = await tx.address.findFirst({
        where: { customerId: params.customerId },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    if (address.isBilling) {
      const next = await tx.address.findFirst({
        where: { customerId: params.customerId, isDefault: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (next) await tx.address.update({ where: { id: next.id }, data: { isBilling: true } });
    }
  });

  await audit.deleted({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Address',
    entityId: address.id,
    summary: `Adresse ${describe(address)} entfernt`,
    ip: params.ip,
  });
}
