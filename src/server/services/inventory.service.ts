import 'server-only';

import { Prisma } from '@prisma/client';

import { audit } from '@/lib/audit';
import { isUniqueConstraintError, prisma, toNumber, type Tx } from '@/lib/db';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import { round2 } from '@/lib/utils';
import type { MaterialCreateInput, MaterialUpdateInput, StockMovementCreateInput } from '@/lib/validation/betrieb';

import { assertRapportNichtEingefroren } from './device-handoff.service';

/**
 * Material und Lager (Wave 11, 2026-09-23).
 *
 * ---------------------------------------------------------------------------
 *  Was vorher war
 * ---------------------------------------------------------------------------
 *
 * `MaterialUsage` hielt je Einsatz fest, was verbraucht wurde — als freier
 * Text mit Preis. Woher das Material kam und was noch im Lager liegt, wusste
 * niemand. Nachbestellt wurde, wenn das Regal leer war.
 *
 * ---------------------------------------------------------------------------
 *  Die Regeln
 * ---------------------------------------------------------------------------
 *
 *  • **Der Bestand ist die Summe der Bewegungen.** Es gibt kein Feld
 *    „Bestand", das jemand überschreiben könnte. Eine falsche Buchung wird
 *    mit einer Gegenbuchung berichtigt; die Datenbank verweigert Änderung und
 *    Löschung (Trigger `stock_movements_nur_anfuegen`).
 *  • **Kein negativer Bestand.** Eine Entnahme über den Bestand hinaus wird
 *    abgelehnt; sie hiesse, dass Material verbraucht wurde, das nie gebucht
 *    war — der Fehler liegt dann beim Eingang, und dort gehört er berichtigt
 *    (Eingang oder Inventurkorrektur mit Begründung).
 *  • **Gleichzeitige Entnahmen** werden über eine Zeilensperre auf dem
 *    Material nacheinander geprüft — sonst sähen zwei Entnahmen denselben
 *    Bestand und bräche jede für sich die Regel nicht.
 *  • **Entnahme für einen Einsatz** schreibt Verbrauchszeile, Lagerbewegung
 *    und den Materialaufwand der Nachkalkulation in einer Transaktion.
 */

const VORZEICHEN: Record<StockMovementCreateInput['kind'], 1 | -1 | 0> = {
  RECEIPT: 1,
  RETURN: 1,
  ISSUE: -1,
  ADJUSTMENT: 0,
};

async function bestand(tx: Tx | typeof prisma, materialId: string): Promise<number> {
  const summe = await tx.stockMovement.aggregate({ where: { materialId }, _sum: { quantity: true } });
  return toNumber(summe._sum.quantity);
}

/** Zeilensperre auf dem Material — Entnahmen desselben Materials laufen nacheinander. */
async function sperren(tx: Tx, organizationId: string, materialId: string) {
  const zeilen = await tx.$queryRaw<{ id: string; active: boolean; unitCost: Prisma.Decimal; name: string; sku: string; unit: string }[]>(
    Prisma.sql`SELECT "id", "active", "unitCost", "name", "sku", "unit" FROM "materials" WHERE "id" = ${materialId} AND "organizationId" = ${organizationId} FOR UPDATE`,
  );
  const m = zeilen[0];
  if (!m) throw new NotFoundError('Material');
  return m;
}

export async function listMaterials(params: { organizationId: string; nachbestellen?: boolean; inaktive?: boolean }) {
  const materialien = await prisma.material.findMany({
    where: { organizationId: params.organizationId, ...(params.inaktive ? {} : { active: true }) },
    orderBy: [{ name: 'asc' }],
    take: 1000,
  });
  const summen = await prisma.stockMovement.groupBy({
    by: ['materialId'],
    where: { organizationId: params.organizationId, materialId: { in: materialien.map((m) => m.id) } },
    _sum: { quantity: true },
  });
  const jeMaterial = new Map(summen.map((s) => [s.materialId, toNumber(s._sum.quantity)]));
  const mitBestand = materialien.map((m) => {
    const b = jeMaterial.get(m.id) ?? 0;
    return { ...m, bestand: b, nachbestellen: b <= toNumber(m.minStock) && toNumber(m.minStock) > 0, lagerwert: round2(b * toNumber(m.unitCost)) };
  });
  return params.nachbestellen ? mitBestand.filter((m) => m.nachbestellen) : mitBestand;
}

export async function getMaterial(organizationId: string, id: string) {
  const m = await prisma.material.findFirst({
    where: { id, organizationId },
    include: {
      movements: {
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: { job: { select: { id: true, number: true } } },
      },
    },
  });
  if (!m) throw new NotFoundError('Material');
  return { ...m, bestand: await bestand(prisma, m.id) };
}

export async function createMaterial(params: { organizationId: string; actorId: string; ip?: string | null; input: MaterialCreateInput }) {
  try {
    const m = await prisma.material.create({
      data: {
        organizationId: params.organizationId,
        sku: params.input.sku,
        barcode: params.input.barcode ?? null,
        name: params.input.name,
        unit: params.input.unit,
        unitCost: params.input.unitCost,
        minStock: params.input.minStock,
        note: params.input.note ?? null,
      },
    });
    await audit.created({
      organizationId: params.organizationId,
      userId: params.actorId,
      entity: 'Material',
      entityId: m.id,
      summary: `Material ${m.sku} „${m.name}" angelegt`,
      ip: params.ip,
    });
    return m;
  } catch (fehler) {
    if (isUniqueConstraintError(fehler)) throw new ConflictError(eindeutigkeitsMeldung(fehler, params.input.sku));
    throw fehler;
  }
}

/**
 * Artikelnummer und Strichcode sind beide je Organisation eindeutig; die
 * Meldung soll sagen, welcher der beiden schon vergeben ist — „Artikelnummer
 * vergeben" beim doppelten Strichcode schickte die Person das falsche Feld
 * ändern.
 */
function eindeutigkeitsMeldung(fehler: unknown, sku?: string): string {
  const ziel = (fehler as { meta?: { target?: unknown } }).meta?.target;
  const felder = Array.isArray(ziel) ? ziel.map(String) : [String(ziel ?? '')];
  if (felder.some((f) => f.includes('barcode'))) return 'Dieser Strichcode gehört bereits zu einem anderen Artikel.';
  return sku ? `Die Artikelnummer ${sku} ist bereits vergeben.` : 'Die Artikelnummer ist bereits vergeben.';
}

export async function updateMaterial(params: { organizationId: string; id: string; actorId: string; ip?: string | null; input: MaterialUpdateInput }) {
  const vorher = await prisma.material.findFirst({ where: { id: params.id, organizationId: params.organizationId } });
  if (!vorher) throw new NotFoundError('Material');
  const nachher = await prisma.material
    .update({
      where: { id: vorher.id },
      data: {
        ...(params.input.name !== undefined ? { name: params.input.name } : {}),
        ...(params.input.barcode !== undefined ? { barcode: params.input.barcode } : {}),
        ...(params.input.unit !== undefined ? { unit: params.input.unit } : {}),
        ...(params.input.unitCost !== undefined ? { unitCost: params.input.unitCost } : {}),
        ...(params.input.minStock !== undefined ? { minStock: params.input.minStock } : {}),
        ...(params.input.active !== undefined ? { active: params.input.active } : {}),
        ...(params.input.note !== undefined ? { note: params.input.note } : {}),
      },
    })
    .catch((fehler: unknown) => {
      if (isUniqueConstraintError(fehler)) throw new ConflictError(eindeutigkeitsMeldung(fehler));
      throw fehler;
    });
  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Material',
    entityId: vorher.id,
    summary: `Material ${vorher.sku} geändert`,
    ip: params.ip,
  });
  return nachher;
}

/**
 * Eine Lagerbewegung buchen. Die Menge kommt ohne Vorzeichen (ausser bei der
 * Inventurkorrektur); die Art bestimmt die Richtung.
 */
export async function bookMovement(params: {
  organizationId: string;
  materialId: string;
  actorId: string;
  ip?: string | null;
  input: StockMovementCreateInput;
}) {
  const { input } = params;
  if (input.jobId) {
    const einsatz = await prisma.job.findFirst({ where: { id: input.jobId, organizationId: params.organizationId }, select: { id: true } });
    if (!einsatz) throw new NotFoundError('Einsatz');
  }
  const richtung = VORZEICHEN[input.kind];
  const menge = richtung === 0 ? input.quantity : richtung * Math.abs(input.quantity);

  const bewegung = await prisma.$transaction(async (tx) => {
    const m = await sperren(tx, params.organizationId, params.materialId);
    if (!m.active && menge < 0) throw new BusinessRuleError('Das Material ist inaktiv — Entnahmen sind nicht mehr möglich.');
    const neuerBestand = round2((await bestand(tx, m.id)) + menge);
    if (neuerBestand < 0) {
      throw new BusinessRuleError(
        `Der Bestand reicht nicht (danach ${neuerBestand.toLocaleString('de-CH')} ${m.unit}). Zuerst den Eingang buchen oder den Bestand mit Begründung korrigieren.`,
      );
    }
    return tx.stockMovement.create({
      data: {
        organizationId: params.organizationId,
        materialId: m.id,
        kind: input.kind,
        quantity: menge,
        unitCost: input.unitCost ?? m.unitCost,
        jobId: input.jobId ?? null,
        reference: input.reference ?? null,
        note: input.note ?? null,
        createdById: params.actorId,
      },
    });
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'StockMovement',
    entityId: bewegung.id,
    summary: `Lagerbewegung ${input.kind} ${toNumber(bewegung.quantity)} gebucht`,
    ip: params.ip,
  });
  return bewegung;
}

/**
 * Material aus dem Lager für einen Einsatz: Verbrauchszeile, Entnahme und
 * Materialaufwand in einer Transaktion. Nicht nach der Vor-Ort-Abnahme —
 * der Rapport ist dann eingefroren.
 */
export async function issueToJob(params: {
  organizationId: string;
  jobId: string;
  actorId: string;
  ip?: string | null;
  input: { materialId: string; quantity: number; billable: boolean };
}) {
  const einsatz = await prisma.job.findFirst({
    where: { id: params.jobId, organizationId: params.organizationId, deletedAt: null },
    select: { id: true, number: true },
  });
  if (!einsatz) throw new NotFoundError('Einsatz');
  await assertRapportNichtEingefroren(einsatz.id);

  const ergebnis = await prisma.$transaction(async (tx) => {
    const m = await sperren(tx, params.organizationId, params.input.materialId);
    if (!m.active) throw new BusinessRuleError('Das Material ist inaktiv.');
    const vorhanden = await bestand(tx, m.id);
    if (vorhanden < params.input.quantity) {
      throw new BusinessRuleError(`Im Lager sind nur ${vorhanden.toLocaleString('de-CH')} ${m.unit} ${m.name}.`);
    }
    const stueckpreis = toNumber(m.unitCost);
    const total = round2(params.input.quantity * stueckpreis);
    const zeile = await tx.materialUsage.create({
      data: {
        jobId: einsatz.id,
        name: m.name,
        sku: m.sku,
        quantity: params.input.quantity,
        unit: m.unit,
        unitCost: stueckpreis,
        total,
        billable: params.input.billable,
      },
    });
    const bewegung = await tx.stockMovement.create({
      data: {
        organizationId: params.organizationId,
        materialId: m.id,
        kind: 'ISSUE',
        quantity: -params.input.quantity,
        unitCost: stueckpreis,
        jobId: einsatz.id,
        materialUsageId: zeile.id,
        reference: einsatz.number,
        createdById: params.actorId,
      },
    });
    await tx.job.update({ where: { id: einsatz.id }, data: { materialCost: { increment: total } } });
    return { zeile, bewegung };
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'StockMovement',
    entityId: ergebnis.bewegung.id,
    summary: `Material für Einsatz ${einsatz.number} entnommen`,
    ip: params.ip,
  });
  return ergebnis;
}
