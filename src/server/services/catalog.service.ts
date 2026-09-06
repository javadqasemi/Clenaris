import 'server-only';

import { revalidatePath } from 'next/cache';
import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { audit, diff } from '@/lib/audit';
import { logger } from '@/lib/logger';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import type {
  CreateCategoryInput,
  CreateCouponInput,
  CreateExtraInput,
  CreatePriceRuleInput,
  CreateServiceInput,
  CreateTaxRateInput,
  ReorderInput,
  UpdateCategoryInput,
  UpdateCouponInput,
  UpdateExtraInput,
  UpdatePriceRuleInput,
  UpdateServiceInput,
  UpdateTaxRateInput,
} from '@/lib/validation/catalog';

const log = logger('catalog');

/**
 * Pflege des Leistungskatalogs und der Preislogik.
 *
 * Architekturentscheide:
 *
 *  • **Bearbeiten ist sicher, weil Belege einen Abzug tragen.** `BookingItem`
 *    und `InvoiceItem` speichern Name, Einzelpreis und Steuersatz als eigene
 *    Spalten — nicht als Verweis auf die Leistung. Eine Preisänderung wirkt
 *    deshalb ab dem nächsten Vorgang und rührt bestehende Buchungen und
 *    Rechnungen nicht an. Ohne diesen Abzug wäre eine Bearbeitungsmaske
 *    tatsächlich gefährlich; mit ihm ist sie es nicht.
 *
 *  • **Gelöscht wird nur, was nirgends hängt.** Eine Leistung mit Buchungen
 *    lässt sich nicht entfernen — die Datenbank verbietet es über
 *    `onDelete: Restrict`, und das ist richtig so: sonst verlöre die Historie
 *    ihren Bezug. Statt die Fremdschlüsselverletzung als 500 durchzureichen,
 *    prüfen wir vorher und antworten mit einer Erklärung samt Zahl und dem
 *    Hinweis auf „deaktivieren".
 *
 *  • **Jede Änderung räumt zwei Zwischenspeicher.** Der Katalog steht auf
 *    Startseite, Leistungsseiten, Preisseite und im Buchungsassistenten; alle
 *    sind statisch erzeugt. Ohne `revalidatePath` speichert die Verwaltung,
 *    sieht auf der Website nichts und hält das Speichern für kaputt.
 *
 *  • **Der Slug ist eine öffentliche Adresse.** Ändert er sich, ändert sich
 *    die URL einer indexierten Seite. Das ist erlaubt — aber es wird
 *    protokolliert, damit sich später nachvollziehen lässt, warum ein
 *    Suchtreffer ins Leere lief.
 */

// ---------------------------------------------------------------------------
//  Gemeinsames
// ---------------------------------------------------------------------------

/**
 * Alle öffentlichen Seiten neu erzeugen lassen.
 *
 * Bewusst der ganze Baum: Kopfzeile und Navigation führen die Leistungen auf
 * und erscheinen auf *jeder* Seite. Eine gezielte Liste wäre fast vollständig
 * und würde bei jeder neuen Seite stillschweigend unvollständig. Gebaut wird
 * ohnehin erst beim nächsten Aufruf.
 */
function revalidateCatalog(): void {
  revalidatePath('/', 'layout');
  // Leistungsseiten werden über `generateStaticParams` vorerzeugt; ein neuer
  // oder umbenannter Slug braucht deshalb zusätzlich die Segmentangabe.
  revalidatePath('/leistungen/[slug]', 'page');
}

/** Prisma-Fehler bei verletzter Eindeutigkeit in eine lesbare Meldung übersetzen. */
function asConflict(error: unknown, what: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ConflictError(`${what} ist bereits vergeben. Bitte wählen Sie einen anderen.`);
  }
  throw error;
}

interface Actor {
  organizationId: string;
  actorId: string;
  ip?: string | null;
}

// ---------------------------------------------------------------------------
//  Leistungen
// ---------------------------------------------------------------------------

export async function listServices(organizationId: string) {
  return prisma.service.findMany({
    where: { organizationId },
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
    include: {
      category: { select: { id: true, name: true } },
      _count: { select: { extras: true, priceRules: true, bookings: true, jobs: true } },
    },
  });
}

export async function getService(organizationId: string, id: string) {
  const service = await prisma.service.findFirst({
    where: { id, organizationId },
    include: {
      category: { select: { id: true, name: true } },
      priceRules: { orderBy: { priority: 'asc' } },
      extras: { select: { extraId: true } },
    },
  });
  if (!service) throw new NotFoundError('Dienstleistung');
  return service;
}

export async function createService({
  organizationId,
  actorId,
  ip,
  input,
}: Actor & { input: CreateServiceInput }) {
  // Eine Kategorie aus einem fremden Mandanten wäre ein Datenleck über die
  // Zuordnung — deshalb wird sie geprüft, nicht nur übernommen.
  await assertCategoryBelongs(organizationId, input.categoryId);

  try {
    const service = await prisma.service.create({
      data: {
        organizationId,
        categoryId: input.categoryId ?? null,
        slug: input.slug,
        kind: input.kind,
        name: input.name,
        shortDesc: input.shortDesc,
        description: input.description,
        icon: input.icon,
        heroImage: input.heroImage ?? null,
        active: input.active,
        featured: input.featured,
        position: input.position,
        pricingModel: input.pricingModel,
        basePrice: input.basePrice,
        hourlyRate: input.hourlyRate ?? null,
        pricePerSqm: input.pricePerSqm ?? null,
        minPrice: input.minPrice,
        minHours: input.minHours,
        vatRate: input.vatRate,
        defaultDurationMin: input.defaultDurationMin,
        minutesPerSqm: input.minutesPerSqm,
        defaultCrewSize: input.defaultCrewSize,
        bufferMinutes: input.bufferMinutes,
        bulletPoints: input.bulletPoints,
        includes: input.includes,
        excludes: input.excludes,
        seoTitle: input.seoTitle ?? null,
        seoDescription: input.seoDescription ?? null,
        keywords: input.keywords,
      },
    });

    await audit.created({
      organizationId,
      userId: actorId,
      entity: 'Service',
      entityId: service.id,
      summary: `Leistung „${service.name}" angelegt`,
      changes: { slug: service.slug, pricingModel: service.pricingModel },
      ip,
    });

    revalidateCatalog();
    return service;
  } catch (error) {
    asConflict(error, 'Dieser Kurzname');
  }
}

export async function updateService({
  organizationId,
  actorId,
  ip,
  serviceId,
  input,
}: Actor & { serviceId: string; input: UpdateServiceInput }) {
  const before = await prisma.service.findFirst({ where: { id: serviceId, organizationId } });
  if (!before) throw new NotFoundError('Dienstleistung');

  if (input.categoryId !== undefined) {
    await assertCategoryBelongs(organizationId, input.categoryId);
  }

  /**
   * Das Preismodell zu wechseln, ohne den passenden Ansatz mitzuliefern,
   * ergäbe eine Leistung, die zum Nulltarif rechnet. Das Formularschema fängt
   * das nur ab, wenn beide Felder gesendet werden — beim Teil-Update prüfen
   * wir gegen den *gespeicherten* Stand.
   */
  const model = input.pricingModel ?? before.pricingModel;
  const hourlyRate = input.hourlyRate !== undefined ? input.hourlyRate : before.hourlyRate;
  const pricePerSqm = input.pricePerSqm !== undefined ? input.pricePerSqm : before.pricePerSqm;

  if (model === 'PER_HOUR' && !Number(hourlyRate)) {
    throw new BusinessRuleError('Beim Stundenmodell muss ein Stundenansatz hinterlegt sein.');
  }
  if (model === 'PER_SQM' && !Number(pricePerSqm)) {
    throw new BusinessRuleError('Beim Flächenmodell muss ein Ansatz pro m² hinterlegt sein.');
  }

  try {
    const service = await prisma.service.update({
      where: { id: serviceId },
      data: {
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId ?? null } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.shortDesc !== undefined ? { shortDesc: input.shortDesc } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.heroImage !== undefined ? { heroImage: input.heroImage ?? null } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.featured !== undefined ? { featured: input.featured } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...(input.pricingModel !== undefined ? { pricingModel: input.pricingModel } : {}),
        ...(input.basePrice !== undefined ? { basePrice: input.basePrice } : {}),
        ...(input.hourlyRate !== undefined ? { hourlyRate: input.hourlyRate ?? null } : {}),
        ...(input.pricePerSqm !== undefined ? { pricePerSqm: input.pricePerSqm ?? null } : {}),
        ...(input.minPrice !== undefined ? { minPrice: input.minPrice } : {}),
        ...(input.minHours !== undefined ? { minHours: input.minHours } : {}),
        ...(input.vatRate !== undefined ? { vatRate: input.vatRate } : {}),
        ...(input.defaultDurationMin !== undefined
          ? { defaultDurationMin: input.defaultDurationMin }
          : {}),
        ...(input.minutesPerSqm !== undefined ? { minutesPerSqm: input.minutesPerSqm } : {}),
        ...(input.defaultCrewSize !== undefined ? { defaultCrewSize: input.defaultCrewSize } : {}),
        ...(input.bufferMinutes !== undefined ? { bufferMinutes: input.bufferMinutes } : {}),
        ...(input.bulletPoints !== undefined ? { bulletPoints: input.bulletPoints } : {}),
        ...(input.includes !== undefined ? { includes: input.includes } : {}),
        ...(input.excludes !== undefined ? { excludes: input.excludes } : {}),
        ...(input.seoTitle !== undefined ? { seoTitle: input.seoTitle ?? null } : {}),
        ...(input.seoDescription !== undefined
          ? { seoDescription: input.seoDescription ?? null }
          : {}),
        ...(input.keywords !== undefined ? { keywords: input.keywords } : {}),
      },
    });

    if (input.slug !== undefined && input.slug !== before.slug) {
      log.warn('Öffentliche Adresse einer Leistung geändert', {
        serviceId,
        from: before.slug,
        to: input.slug,
      });
    }

    await audit.updated({
      organizationId,
      userId: actorId,
      entity: 'Service',
      entityId: serviceId,
      summary: `Leistung „${service.name}" geändert`,
      changes: diff(
        toComparable(before) as Record<string, unknown>,
        toComparable(service) as Record<string, unknown>,
      ),
      ip,
    });

    revalidateCatalog();
    return service;
  } catch (error) {
    asConflict(error, 'Dieser Kurzname');
  }
}

/**
 * Leistung löschen — oder erklären, warum das nicht geht.
 *
 * `Decimal`-Felder werden vorher in Zahlen übersetzt, damit das Protokoll
 * lesbare Werte enthält und nicht die Objektform der Dezimalbibliothek.
 */
export async function deleteService({
  organizationId,
  actorId,
  ip,
  serviceId,
}: Actor & { serviceId: string }) {
  const service = await prisma.service.findFirst({
    where: { id: serviceId, organizationId },
    include: { _count: { select: { bookings: true, quoteItems: true, jobs: true } } },
  });
  if (!service) throw new NotFoundError('Dienstleistung');

  const used =
    service._count.bookings + service._count.quoteItems + service._count.jobs;

  if (used > 0) {
    throw new BusinessRuleError(
      `„${service.name}" ist in ${used} Buchungen, Offerten oder Einsätzen verwendet und kann nicht gelöscht werden. ` +
        'Setzen Sie die Leistung stattdessen auf inaktiv — sie verschwindet dann von der Website, ' +
        'und die Belege behalten ihren Bezug.',
    );
  }

  await prisma.service.delete({ where: { id: serviceId } });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'Service',
    entityId: serviceId,
    summary: `Leistung „${service.name}" gelöscht`,
    ip,
  });

  revalidateCatalog();
}

/** Decimal-Spalten für den Protokollvergleich in Zahlen wandeln. */
function toComparable<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'createdAt' || key === 'updatedAt') continue;
    out[key] = value instanceof Prisma.Decimal ? value.toNumber() : value;
  }
  return out;
}

async function assertCategoryBelongs(organizationId: string, categoryId?: string | null) {
  if (!categoryId) return;
  const exists = await prisma.serviceCategory.count({ where: { id: categoryId, organizationId } });
  if (!exists) throw new NotFoundError('Kategorie');
}

// ---------------------------------------------------------------------------
//  Kategorien
// ---------------------------------------------------------------------------

export async function listCategories(organizationId: string) {
  return prisma.serviceCategory.findMany({
    where: { organizationId },
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { services: true } } },
  });
}

export async function createCategory({
  organizationId,
  actorId,
  ip,
  input,
}: Actor & { input: CreateCategoryInput }) {
  try {
    const category = await prisma.serviceCategory.create({
      data: {
        organizationId,
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        icon: input.icon,
        position: input.position,
        active: input.active,
      },
    });

    await audit.created({
      organizationId,
      userId: actorId,
      entity: 'ServiceCategory',
      entityId: category.id,
      summary: `Kategorie „${category.name}" angelegt`,
      ip,
    });

    revalidateCatalog();
    return category;
  } catch (error) {
    asConflict(error, 'Dieser Kurzname');
  }
}

export async function updateCategory({
  organizationId,
  actorId,
  ip,
  categoryId,
  input,
}: Actor & { categoryId: string; input: UpdateCategoryInput }) {
  const before = await prisma.serviceCategory.findFirst({
    where: { id: categoryId, organizationId },
  });
  if (!before) throw new NotFoundError('Kategorie');

  try {
    const category = await prisma.serviceCategory.update({
      where: { id: categoryId },
      data: {
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
    });

    await audit.updated({
      organizationId,
      userId: actorId,
      entity: 'ServiceCategory',
      entityId: categoryId,
      summary: `Kategorie „${category.name}" geändert`,
      changes: diff(before as Record<string, unknown>, category as Record<string, unknown>),
      ip,
    });

    revalidateCatalog();
    return category;
  } catch (error) {
    asConflict(error, 'Dieser Kurzname');
  }
}

/**
 * Kategorie löschen.
 *
 * Anders als bei Leistungen ist das ungefährlich: `categoryId` ist auf
 * `SetNull` gestellt, die Leistungen bleiben also bestehen und stehen danach
 * ohne Kategorie da. Weil das auf der Website sichtbar wird, sagen wir vorher,
 * wie viele es betrifft.
 */
export async function deleteCategory({
  organizationId,
  actorId,
  ip,
  categoryId,
}: Actor & { categoryId: string }) {
  const category = await prisma.serviceCategory.findFirst({
    where: { id: categoryId, organizationId },
    include: { _count: { select: { services: true } } },
  });
  if (!category) throw new NotFoundError('Kategorie');

  await prisma.serviceCategory.delete({ where: { id: categoryId } });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'ServiceCategory',
    entityId: categoryId,
    summary: `Kategorie „${category.name}" gelöscht (${category._count.services} Leistungen ohne Kategorie)`,
    ip,
  });

  revalidateCatalog();
  return { unassigned: category._count.services };
}

// ---------------------------------------------------------------------------
//  Zusatzleistungen
// ---------------------------------------------------------------------------

export async function listExtras(organizationId: string) {
  return prisma.serviceExtra.findMany({
    where: { organizationId },
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
    include: {
      services: { select: { serviceId: true } },
      _count: { select: { bookings: true } },
    },
  });
}

export async function createExtra({
  organizationId,
  actorId,
  ip,
  input,
}: Actor & { input: CreateExtraInput }) {
  const serviceIds = await filterOwnServices(organizationId, input.serviceIds);

  try {
    const extra = await prisma.serviceExtra.create({
      data: {
        organizationId,
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        icon: input.icon,
        price: input.price,
        pricingModel: input.pricingModel,
        durationMin: input.durationMin,
        vatRate: input.vatRate,
        active: input.active,
        position: input.position,
        services: { create: serviceIds.map((serviceId) => ({ serviceId })) },
      },
    });

    await audit.created({
      organizationId,
      userId: actorId,
      entity: 'ServiceExtra',
      entityId: extra.id,
      summary: `Zusatzleistung „${extra.name}" angelegt`,
      ip,
    });

    revalidateCatalog();
    return extra;
  } catch (error) {
    asConflict(error, 'Dieser Kurzname');
  }
}

export async function updateExtra({
  organizationId,
  actorId,
  ip,
  extraId,
  input,
}: Actor & { extraId: string; input: UpdateExtraInput }) {
  const before = await prisma.serviceExtra.findFirst({ where: { id: extraId, organizationId } });
  if (!before) throw new NotFoundError('Zusatzleistung');

  const serviceIds =
    input.serviceIds !== undefined
      ? await filterOwnServices(organizationId, input.serviceIds)
      : undefined;

  try {
    const extra = await prisma.$transaction(async (tx) => {
      if (serviceIds !== undefined) {
        // Zuordnung vollständig ersetzen: die gesendete Liste *ist* der
        // gewünschte Endzustand. Ein Abgleich einzelner Zeilen wäre bei
        // gleichzeitigen Änderungen nicht eindeutig.
        await tx.serviceExtraOnService.deleteMany({ where: { extraId } });
        if (serviceIds.length) {
          await tx.serviceExtraOnService.createMany({
            data: serviceIds.map((serviceId) => ({ extraId, serviceId })),
          });
        }
      }

      return tx.serviceExtra.update({
        where: { id: extraId },
        data: {
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description ?? null } : {}),
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          ...(input.price !== undefined ? { price: input.price } : {}),
          ...(input.pricingModel !== undefined ? { pricingModel: input.pricingModel } : {}),
          ...(input.durationMin !== undefined ? { durationMin: input.durationMin } : {}),
          ...(input.vatRate !== undefined ? { vatRate: input.vatRate } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
        },
      });
    });

    await audit.updated({
      organizationId,
      userId: actorId,
      entity: 'ServiceExtra',
      entityId: extraId,
      summary: `Zusatzleistung „${extra.name}" geändert`,
      changes: diff(toComparable(before), toComparable(extra)),
      ip,
    });

    revalidateCatalog();
    return extra;
  } catch (error) {
    asConflict(error, 'Dieser Kurzname');
  }
}

export async function deleteExtra({
  organizationId,
  actorId,
  ip,
  extraId,
}: Actor & { extraId: string }) {
  const extra = await prisma.serviceExtra.findFirst({
    where: { id: extraId, organizationId },
    include: { _count: { select: { bookings: true } } },
  });
  if (!extra) throw new NotFoundError('Zusatzleistung');

  if (extra._count.bookings > 0) {
    throw new BusinessRuleError(
      `„${extra.name}" ist in ${extra._count.bookings} Buchungen enthalten und kann nicht gelöscht werden. ` +
        'Setzen Sie die Zusatzleistung stattdessen auf inaktiv.',
    );
  }

  await prisma.serviceExtra.delete({ where: { id: extraId } });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'ServiceExtra',
    entityId: extraId,
    summary: `Zusatzleistung „${extra.name}" gelöscht`,
    ip,
  });

  revalidateCatalog();
}

/** Fremde IDs stillschweigend verwerfen — sie gehören einem anderen Mandanten. */
async function filterOwnServices(organizationId: string, ids: string[] | undefined) {
  if (!ids?.length) return [];
  const rows = await prisma.service.findMany({
    where: { organizationId, id: { in: ids } },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
//  Preisregeln
// ---------------------------------------------------------------------------

export async function listPriceRules(organizationId: string) {
  return prisma.priceRule.findMany({
    where: { OR: [{ service: { organizationId } }, { serviceId: null }] },
    orderBy: [{ priority: 'asc' }, { name: 'asc' }],
    include: { service: { select: { id: true, name: true } } },
  });
}

export async function createPriceRule({
  organizationId,
  actorId,
  ip,
  input,
}: Actor & { input: CreatePriceRuleInput }) {
  if (input.serviceId) await assertServiceBelongs(organizationId, input.serviceId);

  const rule = await prisma.priceRule.create({
    data: {
      serviceId: input.serviceId ?? null,
      name: input.name,
      condition: input.condition,
      multiplier: input.multiplier,
      surcharge: input.surcharge,
      priority: input.priority,
      active: input.active,
    },
  });

  await audit.created({
    organizationId,
    userId: actorId,
    entity: 'PriceRule',
    entityId: rule.id,
    summary: `Preisregel „${rule.name}" angelegt`,
    changes: { condition: input.condition, multiplier: input.multiplier, surcharge: input.surcharge },
    ip,
  });

  revalidateCatalog();
  return rule;
}

export async function updatePriceRule({
  organizationId,
  actorId,
  ip,
  ruleId,
  input,
}: Actor & { ruleId: string; input: UpdatePriceRuleInput }) {
  const before = await findOwnRule(organizationId, ruleId);
  if (input.serviceId) await assertServiceBelongs(organizationId, input.serviceId);

  const rule = await prisma.priceRule.update({
    where: { id: ruleId },
    data: {
      ...(input.serviceId !== undefined ? { serviceId: input.serviceId ?? null } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.condition !== undefined ? { condition: input.condition } : {}),
      ...(input.multiplier !== undefined ? { multiplier: input.multiplier } : {}),
      ...(input.surcharge !== undefined ? { surcharge: input.surcharge } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'PriceRule',
    entityId: ruleId,
    summary: `Preisregel „${rule.name}" geändert`,
    changes: diff(toComparable(before), toComparable(rule)),
    ip,
  });

  revalidateCatalog();
  return rule;
}

export async function deletePriceRule({
  organizationId,
  actorId,
  ip,
  ruleId,
}: Actor & { ruleId: string }) {
  const rule = await findOwnRule(organizationId, ruleId);

  await prisma.priceRule.delete({ where: { id: ruleId } });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'PriceRule',
    entityId: ruleId,
    summary: `Preisregel „${rule.name}" gelöscht`,
    ip,
  });

  revalidateCatalog();
}

/**
 * Regel des eigenen Mandanten holen.
 *
 * Eine `PriceRule` ohne `serviceId` gilt für alle Leistungen und hängt an
 * keiner Organisation — die Zugehörigkeit ergibt sich erst über die Leistung.
 * Globale Regeln sind deshalb für jede Verwaltung erreichbar; das ist bei
 * einem Einzelmandanten richtig und bei einer späteren Mehrmandantenfähigkeit
 * die Stelle, die als Erstes angepasst werden muss.
 */
async function findOwnRule(organizationId: string, ruleId: string) {
  const rule = await prisma.priceRule.findFirst({
    where: { id: ruleId, OR: [{ service: { organizationId } }, { serviceId: null }] },
  });
  if (!rule) throw new NotFoundError('Preisregel');
  return rule;
}

async function assertServiceBelongs(organizationId: string, serviceId: string) {
  const exists = await prisma.service.count({ where: { id: serviceId, organizationId } });
  if (!exists) throw new NotFoundError('Dienstleistung');
}

// ---------------------------------------------------------------------------
//  Steuersätze
// ---------------------------------------------------------------------------

export async function listTaxRates(organizationId: string) {
  return prisma.taxRate.findMany({ where: { organizationId }, orderBy: { rate: 'desc' } });
}

export async function createTaxRate({
  organizationId,
  actorId,
  ip,
  input,
}: Actor & { input: CreateTaxRateInput }) {
  try {
    const rate = await prisma.$transaction(async (tx) => {
      // Genau ein Standardsatz — sonst entschiede die Sortierung, welcher gilt.
      if (input.isDefault) {
        await tx.taxRate.updateMany({ where: { organizationId }, data: { isDefault: false } });
      }
      return tx.taxRate.create({
        data: {
          organizationId,
          name: input.name,
          rate: input.rate,
          isDefault: input.isDefault,
          active: input.active,
        },
      });
    });

    await audit.created({
      organizationId,
      userId: actorId,
      entity: 'TaxRate',
      entityId: rate.id,
      summary: `Steuersatz „${rate.name}" angelegt`,
      ip,
    });

    return rate;
  } catch (error) {
    asConflict(error, 'Dieser Name');
  }
}

export async function updateTaxRate({
  organizationId,
  actorId,
  ip,
  taxRateId,
  input,
}: Actor & { taxRateId: string; input: UpdateTaxRateInput }) {
  const before = await prisma.taxRate.findFirst({ where: { id: taxRateId, organizationId } });
  if (!before) throw new NotFoundError('Steuersatz');

  try {
    const rate = await prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.taxRate.updateMany({
          where: { organizationId, id: { not: taxRateId } },
          data: { isDefault: false },
        });
      }
      return tx.taxRate.update({
        where: { id: taxRateId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.rate !== undefined ? { rate: input.rate } : {}),
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      });
    });

    await audit.updated({
      organizationId,
      userId: actorId,
      entity: 'TaxRate',
      entityId: taxRateId,
      summary: `Steuersatz „${rate.name}" geändert`,
      changes: diff(toComparable(before), toComparable(rate)),
      ip,
    });

    return rate;
  } catch (error) {
    asConflict(error, 'Dieser Name');
  }
}

export async function deleteTaxRate({
  organizationId,
  actorId,
  ip,
  taxRateId,
}: Actor & { taxRateId: string }) {
  const rate = await prisma.taxRate.findFirst({ where: { id: taxRateId, organizationId } });
  if (!rate) throw new NotFoundError('Steuersatz');

  if (rate.isDefault) {
    throw new BusinessRuleError(
      'Der Standardsatz kann nicht gelöscht werden. Bestimmen Sie zuerst einen anderen als Standard.',
    );
  }

  await prisma.taxRate.delete({ where: { id: taxRateId } });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'TaxRate',
    entityId: taxRateId,
    summary: `Steuersatz „${rate.name}" gelöscht`,
    ip,
  });
}

// ---------------------------------------------------------------------------
//  Gutscheine
// ---------------------------------------------------------------------------

export async function listCoupons(organizationId: string) {
  return prisma.coupon.findMany({
    where: { organizationId },
    orderBy: [{ status: 'asc' }, { validFrom: 'desc' }],
  });
}

export async function createCoupon({
  organizationId,
  actorId,
  ip,
  input,
}: Actor & { input: CreateCouponInput }) {
  try {
    const coupon = await prisma.coupon.create({
      data: {
        organizationId,
        code: input.code,
        description: input.description ?? null,
        discountType: input.discountType,
        discountValue: input.discountValue,
        minOrderValue: input.minOrderValue,
        maxDiscount: input.maxDiscount ?? null,
        status: input.status,
        validFrom: new Date(`${input.validFrom}T00:00:00.000Z`),
        validUntil: input.validUntil ? new Date(`${input.validUntil}T00:00:00.000Z`) : null,
        usageLimit: input.usageLimit ?? null,
        perCustomerLimit: input.perCustomerLimit,
        firstOrderOnly: input.firstOrderOnly,
        serviceKinds: input.serviceKinds,
      },
    });

    await audit.created({
      organizationId,
      userId: actorId,
      entity: 'Coupon',
      entityId: coupon.id,
      summary: `Gutschein ${coupon.code} angelegt`,
      ip,
    });

    return coupon;
  } catch (error) {
    asConflict(error, 'Dieser Code');
  }
}

export async function updateCoupon({
  organizationId,
  actorId,
  ip,
  couponId,
  input,
}: Actor & { couponId: string; input: UpdateCouponInput }) {
  const before = await prisma.coupon.findFirst({ where: { id: couponId, organizationId } });
  if (!before) throw new NotFoundError('Gutschein');

  /**
   * Der Zähler `usageCount` bleibt unberührt. Er ist die einzige Zahl hier,
   * die eine Tatsache festhält statt einer Absicht — wer ihn zurücksetzen
   * könnte, könnte ein Nutzungslimit beliebig oft aufheben.
   */
  try {
    const coupon = await prisma.coupon.update({
      where: { id: couponId },
      data: {
        ...(input.code !== undefined ? { code: input.code } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
        ...(input.discountType !== undefined ? { discountType: input.discountType } : {}),
        ...(input.discountValue !== undefined ? { discountValue: input.discountValue } : {}),
        ...(input.minOrderValue !== undefined ? { minOrderValue: input.minOrderValue } : {}),
        ...(input.maxDiscount !== undefined ? { maxDiscount: input.maxDiscount ?? null } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.validFrom !== undefined
          ? { validFrom: new Date(`${input.validFrom}T00:00:00.000Z`) }
          : {}),
        ...(input.validUntil !== undefined
          ? { validUntil: input.validUntil ? new Date(`${input.validUntil}T00:00:00.000Z`) : null }
          : {}),
        ...(input.usageLimit !== undefined ? { usageLimit: input.usageLimit ?? null } : {}),
        ...(input.perCustomerLimit !== undefined
          ? { perCustomerLimit: input.perCustomerLimit }
          : {}),
        ...(input.firstOrderOnly !== undefined ? { firstOrderOnly: input.firstOrderOnly } : {}),
        ...(input.serviceKinds !== undefined ? { serviceKinds: input.serviceKinds } : {}),
      },
    });

    await audit.updated({
      organizationId,
      userId: actorId,
      entity: 'Coupon',
      entityId: couponId,
      summary: `Gutschein ${coupon.code} geändert`,
      changes: diff(toComparable(before), toComparable(coupon)),
      ip,
    });

    return coupon;
  } catch (error) {
    asConflict(error, 'Dieser Code');
  }
}

export async function deleteCoupon({
  organizationId,
  actorId,
  ip,
  couponId,
}: Actor & { couponId: string }) {
  const coupon = await prisma.coupon.findFirst({ where: { id: couponId, organizationId } });
  if (!coupon) throw new NotFoundError('Gutschein');

  if (coupon.usageCount > 0) {
    throw new BusinessRuleError(
      `Der Gutschein ${coupon.code} wurde ${coupon.usageCount}× eingelöst und bleibt als Beleg erhalten. ` +
        'Setzen Sie ihn auf „pausiert", um ihn ausser Kraft zu setzen.',
    );
  }

  await prisma.coupon.delete({ where: { id: couponId } });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'Coupon',
    entityId: couponId,
    summary: `Gutschein ${coupon.code} gelöscht`,
    ip,
  });
}

// ---------------------------------------------------------------------------
//  Reihenfolge
// ---------------------------------------------------------------------------

/**
 * Reihenfolge in einem Zug setzen.
 *
 * Die Position ergibt sich aus dem Index in der gesendeten Liste — der Client
 * schickt die Reihenfolge, nicht einzelne Zahlen. So kann kein Zustand
 * entstehen, in dem zwei Einträge dieselbe Position tragen.
 */
export async function reorder({
  organizationId,
  actorId,
  ip,
  input,
}: Actor & { input: ReorderInput }) {
  const { entity, ids } = input;

  const owned = await ownedIds(organizationId, entity, ids);
  const ordered = ids.filter((id) => owned.has(id));

  if (ordered.length === 0) throw new NotFoundError('Einträge');

  await prisma.$transaction(
    ordered.map((id, index) => {
      const data = { position: index };
      if (entity === 'service') return prisma.service.update({ where: { id }, data });
      if (entity === 'extra') return prisma.serviceExtra.update({ where: { id }, data });
      return prisma.serviceCategory.update({ where: { id }, data });
    }),
  );

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: entity === 'service' ? 'Service' : entity === 'extra' ? 'ServiceExtra' : 'ServiceCategory',
    summary: `Reihenfolge geändert (${ordered.length} Einträge)`,
    ip,
  });

  revalidateCatalog();
  return { updated: ordered.length };
}

async function ownedIds(
  organizationId: string,
  entity: ReorderInput['entity'],
  ids: string[],
): Promise<Set<string>> {
  const where = { organizationId, id: { in: ids } };
  const rows =
    entity === 'service'
      ? await prisma.service.findMany({ where, select: { id: true } })
      : entity === 'extra'
        ? await prisma.serviceExtra.findMany({ where, select: { id: true } })
        : await prisma.serviceCategory.findMany({ where, select: { id: true } });
  return new Set(rows.map((row) => row.id));
}
