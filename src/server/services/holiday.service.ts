import 'server-only';

import { prisma } from '@/lib/db';
import { audit, diff } from '@/lib/audit';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import type { CreateHolidayInput, UpdateHolidayInput } from '@/lib/validation/settings';

/**
 * Feiertage und Betriebsferien.
 *
 * Architekturentscheide:
 *
 *  • **Ein Feiertag ist eine Betriebseinstellung, kein Geschäftsvorfall.** Er
 *    hängt an derselben Berechtigung wie die Öffnungszeiten (`company:update`):
 *    beides beschreibt, wann der Betrieb arbeitet. Eine eigene Berechtigung
 *    hätte in der Rechtematrix eine Zeile ergeben, die niemand anders vergeben
 *    würde als die Öffnungszeiten.
 *
 *  • **Vergangene Feiertage werden nicht gelöscht, sondern bleiben stehen.**
 *    Die Abwesenheitsrechnung zählt für ein vergangenes Ferienjahr die
 *    Feiertage nach; verschwände der Karfreitag des Vorjahres, hätte jede
 *    Person plötzlich einen Ferientag mehr bezogen. Ein Löschen ist deshalb
 *    nur für künftige Tage möglich — ein Fehler von heute lässt sich beheben,
 *    ein Abschluss von gestern nicht umschreiben.
 *
 *  • **Das Datum reist als Kalendertag.** `Holiday.date` ist eine
 *    `@db.Date`-Spalte; gespeichert wird Mitternacht UTC, gelesen wird sie
 *    überall mit `timeZone: 'UTC'`. Ein lokaler Zeitstempel verschöbe den
 *    Tag je nach Server um eins.
 */

interface Actor {
  organizationId: string;
  actorId: string;
  ip?: string | null;
}

/** `JJJJ-MM-TT` → Mitternacht UTC, so wie es die Spalte erwartet. */
function toDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDay(date: Date): string {
  return new Intl.DateTimeFormat('de-CH', {
    timeZone: 'UTC',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function listHolidays(organizationId: string, options: { from?: Date; take?: number } = {}) {
  return prisma.holiday.findMany({
    where: {
      organizationId,
      ...(options.from ? { date: { gte: options.from } } : {}),
    },
    orderBy: { date: 'asc' },
    ...(options.take ? { take: options.take } : {}),
  });
}

export async function createHoliday({
  organizationId,
  actorId,
  ip,
  input,
}: Actor & { input: CreateHolidayInput }) {
  const date = toDateOnly(input.date);

  /**
   * Die Datenbank hat einen eindeutigen Schlüssel über Datum *und* Name —
   * zwei verschiedene Feiertage am selben Tag sind möglich (Ostermontag und
   * Betriebsferien). Derselbe Name am selben Tag ist ein Doppelklick, kein
   * zweiter Feiertag.
   */
  const duplicate = await prisma.holiday.findFirst({
    where: { organizationId, date, name: input.name },
    select: { id: true },
  });
  if (duplicate) {
    throw new ConflictError(`„${input.name}" ist am ${formatDay(date)} bereits erfasst.`);
  }

  const holiday = await prisma.holiday.create({
    data: {
      organizationId,
      name: input.name,
      date,
      recurring: input.recurring,
      canton: input.canton ?? 'BE',
    },
  });

  await audit.created({
    organizationId,
    userId: actorId,
    entity: 'Holiday',
    entityId: holiday.id,
    summary: `Feiertag „${holiday.name}" am ${formatDay(holiday.date)} erfasst${holiday.recurring ? ' (jährlich)' : ''}`,
    ip,
  });

  return holiday;
}

export async function updateHoliday({
  organizationId,
  actorId,
  ip,
  holidayId,
  input,
}: Actor & { holidayId: string; input: UpdateHolidayInput }) {
  const before = await prisma.holiday.findFirst({ where: { id: holidayId, organizationId } });
  if (!before) throw new NotFoundError('Feiertag');

  const date = input.date ? toDateOnly(input.date) : before.date;
  const name = input.name ?? before.name;

  if (input.date || input.name) {
    const duplicate = await prisma.holiday.findFirst({
      where: { organizationId, date, name, id: { not: holidayId } },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictError(`„${name}" ist am ${formatDay(date)} bereits erfasst.`);
    }
  }

  const holiday = await prisma.holiday.update({
    where: { id: holidayId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.date !== undefined ? { date } : {}),
      ...(input.recurring !== undefined ? { recurring: input.recurring } : {}),
      ...(input.canton !== undefined ? { canton: input.canton ?? 'BE' } : {}),
    },
  });

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'Holiday',
    entityId: holiday.id,
    summary: `Feiertag „${holiday.name}" (${formatDay(holiday.date)}) geändert`,
    changes: diff(before as Record<string, unknown>, holiday as Record<string, unknown>),
    ip,
  });

  return holiday;
}

export async function deleteHoliday({
  organizationId,
  actorId,
  ip,
  holidayId,
}: Actor & { holidayId: string }) {
  const holiday = await prisma.holiday.findFirst({ where: { id: holidayId, organizationId } });
  if (!holiday) throw new NotFoundError('Feiertag');

  if (!holiday.recurring && holiday.date < startOfTodayUtc()) {
    throw new BusinessRuleError(
      `Der ${formatDay(holiday.date)} liegt in der Vergangenheit. Vergangene Feiertage bleiben stehen, ` +
        'weil die Ferienabrechnung des Jahres darauf beruht — sonst hätte jede Person rückwirkend einen Ferientag mehr bezogen.',
    );
  }

  await prisma.holiday.delete({ where: { id: holidayId } });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'Holiday',
    entityId: holidayId,
    summary: `Feiertag „${holiday.name}" am ${formatDay(holiday.date)} entfernt`,
    ip,
  });
}
