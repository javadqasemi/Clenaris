import 'server-only';

import { revalidatePath } from 'next/cache';
import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { cache } from '@/lib/redis';
import { audit, diff } from '@/lib/audit';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import type {
  BulkServiceAreaInput,
  CreateAutomationInput,
  CreateServiceAreaInput,
  UpdateAutomationInput,
  UpdateEmailTemplateInput,
  UpdateServiceAreaInput,
  UpdateSmsTemplateInput,
} from '@/lib/validation/operations-admin';

/**
 * Einsatzgebiet, Newsletter, Automatisierungen und Vorlagen.
 *
 * Vier Bereiche, die einen gemeinsamen Zug haben: sie stellen ein, *wie* der
 * Betrieb arbeitet, statt Geschäftsvorfälle abzubilden. Deshalb stehen sie
 * zusammen — und deshalb protokolliert jede Änderung hier, auch die
 * unscheinbaren: eine geänderte Anfahrtspauschale verändert jeden künftigen
 * Preis, eine geänderte Vorlage jede künftige E-Mail.
 */

interface Actor {
  organizationId: string;
  actorId: string;
  ip?: string | null;
}

// ---------------------------------------------------------------------------
//  Einsatzgebiet
// ---------------------------------------------------------------------------

export async function listServiceAreas(organizationId: string) {
  return prisma.serviceArea.findMany({
    where: { organizationId },
    orderBy: [{ city: 'asc' }, { postalCode: 'asc' }],
  });
}

/**
 * Das Einsatzgebiet steckt im Preis und in der Verfügbarkeitsprüfung.
 *
 * Beide lesen über einen Zwischenspeicher; ohne dessen Leerung nimmt der
 * Buchungsassistent bis zu fünf Minuten lang noch die alte Anfahrtspauschale.
 * Die öffentliche Gebietsseite ist zusätzlich statisch erzeugt.
 */
async function invalidateAreas(organizationId: string): Promise<void> {
  await cache.del(`areas:${organizationId}`);
  await cache.del(`service-areas:${organizationId}`);
  revalidatePath('/einsatzgebiet');
  revalidatePath('/');
}

export async function createServiceArea({
  organizationId,
  actorId,
  ip,
  input,
}: Actor & { input: CreateServiceAreaInput }) {
  try {
    const area = await prisma.serviceArea.create({
      data: {
        organizationId,
        postalCode: input.postalCode,
        city: input.city,
        canton: input.canton,
        travelFee: input.travelFee,
        travelMinutes: input.travelMinutes,
        active: input.active,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
      },
    });

    await audit.created({
      organizationId,
      userId: actorId,
      entity: 'ServiceArea',
      entityId: area.id,
      summary: `Einsatzgebiet ${area.postalCode} ${area.city} erfasst`,
      ip,
    });

    await invalidateAreas(organizationId);
    return area;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictError('Diese Postleitzahl ist bereits erfasst.');
    }
    throw error;
  }
}

export async function updateServiceArea({
  organizationId,
  actorId,
  ip,
  areaId,
  input,
}: Actor & { areaId: string; input: UpdateServiceAreaInput }) {
  const before = await prisma.serviceArea.findFirst({ where: { id: areaId, organizationId } });
  if (!before) throw new NotFoundError('Einsatzgebiet');

  try {
    const area = await prisma.serviceArea.update({
      where: { id: areaId },
      data: {
        ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.canton !== undefined ? { canton: input.canton } : {}),
        ...(input.travelFee !== undefined ? { travelFee: input.travelFee } : {}),
        ...(input.travelMinutes !== undefined ? { travelMinutes: input.travelMinutes } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.lat !== undefined ? { lat: input.lat ?? null } : {}),
        ...(input.lng !== undefined ? { lng: input.lng ?? null } : {}),
      },
    });

    await audit.updated({
      organizationId,
      userId: actorId,
      entity: 'ServiceArea',
      entityId: areaId,
      summary: `Einsatzgebiet ${area.postalCode} ${area.city} geändert`,
      changes: diff(before as Record<string, unknown>, area as Record<string, unknown>),
      ip,
    });

    await invalidateAreas(organizationId);
    return area;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictError('Diese Postleitzahl ist bereits erfasst.');
    }
    throw error;
  }
}

export async function deleteServiceArea({
  organizationId,
  actorId,
  ip,
  areaId,
}: Actor & { areaId: string }) {
  const area = await prisma.serviceArea.findFirst({ where: { id: areaId, organizationId } });
  if (!area) throw new NotFoundError('Einsatzgebiet');

  /**
   * Eine Postleitzahl zu entfernen, in der noch Termine liegen, macht diese
   * Termine im Buchungsassistenten unerreichbar — und die Preisberechnung für
   * eine Verschiebung schlägt fehl. Die Adresse selbst bleibt zwar bestehen,
   * aber der Vorgang lässt sich nicht mehr sauber abwickeln.
   */
  const upcoming = await prisma.job.count({
    where: {
      organizationId,
      deletedAt: null,
      scheduledStart: { gte: new Date() },
      address: { postalCode: area.postalCode },
    },
  });

  if (upcoming > 0) {
    throw new BusinessRuleError(
      `In ${area.postalCode} ${area.city} sind ${upcoming} Einsätze geplant. Setzen Sie das Gebiet stattdessen auf inaktiv — ` +
        'es verschwindet dann aus dem Buchungsassistenten, und die laufenden Termine bleiben abwickelbar.',
    );
  }

  await prisma.serviceArea.delete({ where: { id: areaId } });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'ServiceArea',
    entityId: areaId,
    summary: `Einsatzgebiet ${area.postalCode} ${area.city} entfernt`,
    ip,
  });

  await invalidateAreas(organizationId);
}

/**
 * Mehrere Postleitzahlen auf einmal.
 *
 * Ein Einsatzgebiet entsteht selten Zeile für Zeile — meist übernimmt man eine
 * Liste aus einer Karte. Ohne `overwrite` bleiben bestehende Einträge
 * unangetastet; das ist der Normalfall beim Nachtragen einer Region.
 */
export async function bulkUpsertServiceAreas({
  organizationId,
  actorId,
  ip,
  input,
}: Actor & { input: BulkServiceAreaInput }) {
  const existing = await prisma.serviceArea.findMany({
    where: { organizationId, postalCode: { in: input.areas.map((a) => a.postalCode) } },
    select: { postalCode: true },
  });
  const known = new Set(existing.map((row) => row.postalCode));

  const toCreate = input.areas.filter((area) => !known.has(area.postalCode));
  const toUpdate = input.overwrite ? input.areas.filter((area) => known.has(area.postalCode)) : [];

  await prisma.$transaction([
    ...(toCreate.length
      ? [
          prisma.serviceArea.createMany({
            data: toCreate.map((area) => ({
              organizationId,
              postalCode: area.postalCode,
              city: area.city,
              canton: area.canton,
              travelFee: area.travelFee,
              travelMinutes: area.travelMinutes,
              active: area.active,
              lat: area.lat ?? null,
              lng: area.lng ?? null,
            })),
          }),
        ]
      : []),
    ...toUpdate.map((area) =>
      prisma.serviceArea.update({
        where: { organizationId_postalCode: { organizationId, postalCode: area.postalCode } },
        data: {
          city: area.city,
          canton: area.canton,
          travelFee: area.travelFee,
          travelMinutes: area.travelMinutes,
          active: area.active,
          lat: area.lat ?? null,
          lng: area.lng ?? null,
        },
      }),
    ),
  ]);

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'ServiceArea',
    summary: `Einsatzgebiet ergänzt: ${toCreate.length} neu, ${toUpdate.length} überschrieben, ${input.areas.length - toCreate.length - toUpdate.length} übersprungen`,
    ip,
  });

  await invalidateAreas(organizationId);
  return {
    created: toCreate.length,
    updated: toUpdate.length,
    skipped: input.areas.length - toCreate.length - toUpdate.length,
  };
}

// ---------------------------------------------------------------------------
//  Newsletter
// ---------------------------------------------------------------------------

export async function listNewsletterSubscribers(params: {
  organizationId: string;
  q?: string;
  confirmed?: boolean;
  page: number;
  pageSize: number;
}) {
  const where: Prisma.NewsletterSubscriberWhereInput = {
    organizationId: params.organizationId,
    // Ausgetragene erscheinen nicht: sie haben widersprochen, und eine Liste,
    // aus der man sie versehentlich wieder anschreibt, ist genau der Fehler,
    // den das Austragen verhindern soll.
    unsubscribedAt: null,
    ...(params.confirmed !== undefined ? { confirmed: params.confirmed } : {}),
    ...(params.q ? { email: { contains: params.q, mode: 'insensitive' } } : {}),
  };

  const [items, total, confirmedCount] = await Promise.all([
    prisma.newsletterSubscriber.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      select: {
        id: true,
        email: true,
        firstName: true,
        locale: true,
        confirmed: true,
        source: true,
        createdAt: true,
      },
    }),
    prisma.newsletterSubscriber.count({ where }),
    prisma.newsletterSubscriber.count({
      where: { organizationId: params.organizationId, unsubscribedAt: null, confirmed: true },
    }),
  ]);

  return { items, total, confirmedCount };
}

/**
 * Abonnentin oder Abonnent austragen.
 *
 * Nicht gelöscht, sondern mit `unsubscribedAt` markiert: die Zeile ist der
 * Nachweis, dass widersprochen wurde. Löschte man sie, könnte dieselbe Adresse
 * beim nächsten Import wieder in der Liste landen — und der Widerspruch wäre
 * nicht mehr belegbar.
 */
export async function unsubscribeNewsletter({
  organizationId,
  actorId,
  ip,
  subscriberId,
}: Actor & { subscriberId: string }) {
  const subscriber = await prisma.newsletterSubscriber.findFirst({
    where: { id: subscriberId, organizationId },
  });
  if (!subscriber) throw new NotFoundError('Abonnement');
  if (subscriber.unsubscribedAt) {
    throw new BusinessRuleError('Diese Adresse ist bereits ausgetragen.');
  }

  await prisma.newsletterSubscriber.update({
    where: { id: subscriberId },
    data: { unsubscribedAt: new Date() },
  });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'NewsletterSubscriber',
    entityId: subscriberId,
    summary: `Newsletter-Abonnement ausgetragen (${subscriber.email})`,
    ip,
  });
}

// ---------------------------------------------------------------------------
//  Automatisierungen
// ---------------------------------------------------------------------------

export async function listAutomations(organizationId: string) {
  return prisma.automation.findMany({
    where: { organizationId },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    include: {
      actions: { orderBy: { position: 'asc' } },
      _count: { select: { runs: true } },
    },
  });
}

export async function createAutomation({
  organizationId,
  actorId,
  ip,
  input,
}: Actor & { input: CreateAutomationInput }) {
  const automation = await prisma.automation.create({
    data: {
      organizationId,
      name: input.name,
      description: input.description ?? null,
      trigger: input.trigger,
      conditions: input.conditions as Prisma.InputJsonValue,
      delayMinutes: input.delayMinutes,
      active: input.active,
      actions: {
        create: input.actions.map((action, index) => ({
          type: action.type,
          config: action.config as Prisma.InputJsonValue,
          position: action.position || index,
        })),
      },
    },
  });

  await audit.created({
    organizationId,
    userId: actorId,
    entity: 'Automation',
    entityId: automation.id,
    summary: `Automatisierung „${automation.name}" angelegt`,
    changes: { trigger: automation.trigger, active: automation.active },
    ip,
  });

  return automation;
}

export async function updateAutomation({
  organizationId,
  actorId,
  ip,
  automationId,
  input,
}: Actor & { automationId: string; input: UpdateAutomationInput }) {
  const before = await prisma.automation.findFirst({
    where: { id: automationId, organizationId },
  });
  if (!before) throw new NotFoundError('Automatisierung');

  const automation = await prisma.$transaction(async (tx) => {
    if (input.actions !== undefined) {
      // Die gesendete Liste *ist* der gewünschte Endzustand. Ein Abgleich
      // einzelner Aktionen wäre bei gleichzeitigen Änderungen nicht eindeutig.
      await tx.automationAction.deleteMany({ where: { automationId } });
      await tx.automationAction.createMany({
        data: input.actions.map((action, index) => ({
          automationId,
          type: action.type,
          config: action.config as Prisma.InputJsonValue,
          position: action.position || index,
        })),
      });
    }

    return tx.automation.update({
      where: { id: automationId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
        ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
        ...(input.conditions !== undefined
          ? { conditions: input.conditions as Prisma.InputJsonValue }
          : {}),
        ...(input.delayMinutes !== undefined ? { delayMinutes: input.delayMinutes } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
    });
  });

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'Automation',
    entityId: automationId,
    summary: `Automatisierung „${automation.name}" geändert`,
    changes: diff(before as Record<string, unknown>, automation as Record<string, unknown>),
    ip,
  });

  return automation;
}

export async function deleteAutomation({
  organizationId,
  actorId,
  ip,
  automationId,
}: Actor & { automationId: string }) {
  const automation = await prisma.automation.findFirst({
    where: { id: automationId, organizationId },
    include: { _count: { select: { runs: true } } },
  });
  if (!automation) throw new NotFoundError('Automatisierung');

  /**
   * Die Laufhistorie ist der Beleg dafür, *warum* eine Kundschaft eine
   * bestimmte E-Mail bekommen hat. Sie ohne die zugehörige Automatisierung
   * stehen zu lassen, macht sie unlesbar — deshalb wird abgeschaltet statt
   * gelöscht, sobald es Läufe gibt.
   */
  if (automation._count.runs > 0) {
    throw new BusinessRuleError(
      `„${automation.name}" wurde ${automation._count.runs}× ausgeführt. Schalten Sie sie stattdessen ab — ` +
        'die Laufhistorie belegt, warum welche Nachricht verschickt wurde, und wäre ohne die Regel nicht mehr lesbar.',
    );
  }

  await prisma.automation.delete({ where: { id: automationId } });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'Automation',
    entityId: automationId,
    summary: `Automatisierung „${automation.name}" gelöscht`,
    ip,
  });
}

// ---------------------------------------------------------------------------
//  Vorlagen
// ---------------------------------------------------------------------------

export async function listTemplates(organizationId: string) {
  const [email, sms] = await Promise.all([
    prisma.emailTemplate.findMany({
      where: { organizationId },
      orderBy: [{ key: 'asc' }, { locale: 'asc' }],
    }),
    prisma.smsTemplate.findMany({
      where: { organizationId },
      orderBy: [{ key: 'asc' }, { locale: 'asc' }],
    }),
  ]);
  return { email, sms };
}

export async function updateEmailTemplate({
  organizationId,
  actorId,
  ip,
  templateId,
  input,
}: Actor & { templateId: string; input: UpdateEmailTemplateInput }) {
  const before = await prisma.emailTemplate.findFirst({
    where: { id: templateId, organizationId },
  });
  if (!before) throw new NotFoundError('E-Mail-Vorlage');

  assertPlaceholdersIntact(before.bodyHtml, input.bodyHtml);

  const template = await prisma.emailTemplate.update({
    where: { id: templateId },
    data: {
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      bodyText: input.bodyText ?? null,
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'EmailTemplate',
    entityId: templateId,
    summary: `E-Mail-Vorlage „${template.key}" geändert`,
    changes: diff(before as Record<string, unknown>, template as Record<string, unknown>),
    ip,
  });

  return template;
}

export async function updateSmsTemplate({
  organizationId,
  actorId,
  ip,
  templateId,
  input,
}: Actor & { templateId: string; input: UpdateSmsTemplateInput }) {
  const before = await prisma.smsTemplate.findFirst({
    where: { id: templateId, organizationId },
  });
  if (!before) throw new NotFoundError('SMS-Vorlage');

  assertPlaceholdersIntact(before.body, input.body);

  const template = await prisma.smsTemplate.update({
    where: { id: templateId },
    data: { body: input.body, ...(input.active !== undefined ? { active: input.active } : {}) },
  });

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'SmsTemplate',
    entityId: templateId,
    summary: `SMS-Vorlage „${template.key}" geändert`,
    changes: diff(before as Record<string, unknown>, template as Record<string, unknown>),
    ip,
  });

  return template;
}

/**
 * Platzhalter dürfen wegfallen, aber keine neuen dazukommen.
 *
 * `{{customer.firstName}}` wird beim Versand ersetzt. Ein Platzhalter, den
 * der Code nicht füllt, erscheint wörtlich in der E-Mail an die Kundschaft —
 * ein Fehler, der erst beim Empfänger sichtbar wird und dort peinlich ist.
 * Weglassen ist dagegen harmlos: eine Anrede ohne Namen liest sich neutral.
 */
function assertPlaceholdersIntact(before: string, after: string): void {
  const find = (text: string) =>
    new Set([...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]));

  const known = find(before);
  const used = find(after);
  const unknown = [...used].filter((name) => !known.has(name));

  if (unknown.length > 0) {
    throw new BusinessRuleError(
      `Unbekannte Platzhalter: ${unknown.map((n) => `{{${n}}}`).join(', ')}. ` +
        'Sie würden wörtlich in der Nachricht erscheinen, weil der Versand sie nicht füllen kann. ' +
        `Verfügbar sind: ${[...known].map((n) => `{{${n}}}`).join(', ') || '(keine)'}.`,
    );
  }
}
