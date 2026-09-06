import 'server-only';

import { prisma } from '@/lib/db';
import { cache, cacheKeys } from '@/lib/redis';

/**
 * Terminverfügbarkeit.
 *
 * Architekturentscheid: Die Kapazität wird aus drei Quellen abgeleitet —
 * Öffnungszeiten, Feiertage und der real verplanten Mitarbeitendenzeit. Wir
 * modellieren *keine* festen Slots in der Datenbank: bei 6–15 Mitarbeitenden
 * und variablen Einsatzdauern wäre eine Slot-Tabelle sofort inkonsistent.
 * Stattdessen berechnen wir Slots on the fly und cachen sie 5 Minuten.
 *
 * Zeitzone: sämtliche Rechnung erfolgt in Europe/Zurich, gespeichert wird UTC.
 */

const SLOT_STEP_MINUTES = 30;
const ZURICH = 'Europe/Zurich';

export interface TimeSlot {
  /** ISO-8601 in UTC. */
  start: string;
  end: string;
  /** Lokale Anzeige, z. B. "08:00". */
  label: string;
  available: boolean;
  /** Wie viele Teams zu diesem Zeitpunkt noch frei sind. */
  capacity: number;
}

/** Offset von Europe/Zurich gegenüber UTC an einem gegebenen Tag (in Minuten). */
function zurichOffsetMinutes(date: Date): number {
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const local = new Date(date.toLocaleString('en-US', { timeZone: ZURICH }));
  return Math.round((local.getTime() - utc.getTime()) / 60_000);
}

/** Lokale Wandzeit (Zürich) in einen UTC-Zeitstempel umrechnen. */
function zurichToUtc(dateKey: string, timeHHmm: string): Date {
  const [hours, minutes] = timeHHmm.split(':').map(Number);
  // Erster Versuch mit dem Offset des Tagesbeginns, danach mit dem korrekten
  // Offset des Zielzeitpunkts — das behandelt Zeitumstellungstage korrekt.
  const provisional = new Date(`${dateKey}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00Z`);
  const offset = zurichOffsetMinutes(provisional);
  return new Date(provisional.getTime() - offset * 60_000);
}

function localWeekday(dateKey: string): number {
  // dateKey ist bereits ein lokales Datum; der Wochentag ist zeitzonenunabhängig.
  return new Date(`${dateKey}T12:00:00Z`).getUTCDay();
}

export interface AvailabilityParams {
  organizationId: string;
  /** Datum im Format JJJJ-MM-TT (lokale Schweizer Zeit). */
  date: string;
  durationMin: number;
  crewSize: number;
}

export async function getAvailableSlots(params: AvailabilityParams): Promise<{
  date: string;
  closed: boolean;
  reason?: string;
  slots: TimeSlot[];
}> {
  const cacheKey = `${cacheKeys.availability(params.organizationId, params.date)}:${params.durationMin}:${params.crewSize}`;

  return cache.remember(cacheKey, 300, async () => {
    const weekday = localWeekday(params.date);

    const [hours, holiday, activeEmployees] = await Promise.all([
      prisma.openingHours.findUnique({
        where: {
          organizationId_weekday: { organizationId: params.organizationId, weekday },
        },
      }),
      prisma.holiday.findFirst({
        where: {
          organizationId: params.organizationId,
          date: new Date(`${params.date}T00:00:00.000Z`),
        },
      }),
      prisma.employee.count({
        where: { organizationId: params.organizationId, active: true },
      }),
    ]);

    if (holiday) {
      return { date: params.date, closed: true, reason: `Feiertag: ${holiday.name}`, slots: [] };
    }
    if (!hours || hours.closed || !hours.opensAt || !hours.closesAt) {
      return { date: params.date, closed: true, reason: 'An diesem Tag sind wir geschlossen.', slots: [] };
    }

    const dayStart = zurichToUtc(params.date, hours.opensAt);
    const dayEnd = zurichToUtc(params.date, hours.closesAt);

    // Bereits verplante Einsätze des Tages (inkl. Vorlauf/Nachlauf).
    const jobs = await prisma.job.findMany({
      where: {
        organizationId: params.organizationId,
        deletedAt: null,
        status: { notIn: ['CANCELLED'] },
        scheduledStart: { lt: dayEnd },
        scheduledEnd: { gt: dayStart },
      },
      select: { scheduledStart: true, scheduledEnd: true, crewSize: true },
    });

    // Abwesenheiten reduzieren die verfügbare Kapazität.
    const absences = await prisma.absence.count({
      where: {
        status: 'APPROVED',
        employee: { organizationId: params.organizationId, active: true },
        startDate: { lte: new Date(`${params.date}T23:59:59.999Z`) },
        endDate: { gte: new Date(`${params.date}T00:00:00.000Z`) },
      },
    });

    const totalCapacity = Math.max(0, activeEmployees - absences);
    const slots: TimeSlot[] = [];
    const now = Date.now();
    // Buchungen brauchen mindestens 4 Stunden Vorlauf für die Disposition.
    const earliestBookable = now + 4 * 60 * 60 * 1000;

    for (
      let cursor = dayStart.getTime();
      cursor + params.durationMin * 60_000 <= dayEnd.getTime();
      cursor += SLOT_STEP_MINUTES * 60_000
    ) {
      const start = new Date(cursor);
      const end = new Date(cursor + params.durationMin * 60_000);

      const usedCrew = jobs
        .filter((job) => job.scheduledStart < end && job.scheduledEnd > start)
        .reduce((sum, job) => sum + job.crewSize, 0);

      const remaining = totalCapacity - usedCrew;
      const available = remaining >= params.crewSize && cursor >= earliestBookable;

      slots.push({
        start: start.toISOString(),
        end: end.toISOString(),
        label: new Intl.DateTimeFormat('de-CH', {
          timeZone: ZURICH,
          hour: '2-digit',
          minute: '2-digit',
        }).format(start),
        available,
        capacity: Math.max(0, remaining),
      });
    }

    return { date: params.date, closed: false, slots };
  });
}

/** Prüft, ob ein konkreter Termin (noch) buchbar ist — beim Abschluss der Buchung. */
export async function isSlotBookable(params: {
  organizationId: string;
  start: Date;
  durationMin: number;
  crewSize: number;
}): Promise<{ ok: boolean; reason?: string }> {
  const end = new Date(params.start.getTime() + params.durationMin * 60_000);

  if (params.start.getTime() < Date.now() + 60 * 60 * 1000) {
    return { ok: false, reason: 'Der gewünschte Termin liegt zu kurzfristig oder in der Vergangenheit.' };
  }

  const dateKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZURICH,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(params.start);

  const [holiday, hours] = await Promise.all([
    prisma.holiday.findFirst({
      where: {
        organizationId: params.organizationId,
        date: new Date(`${dateKey}T00:00:00.000Z`),
      },
    }),
    prisma.openingHours.findUnique({
      where: {
        organizationId_weekday: {
          organizationId: params.organizationId,
          weekday: localWeekday(dateKey),
        },
      },
    }),
  ]);

  if (holiday) return { ok: false, reason: `An diesem Tag ist Feiertag (${holiday.name}).` };
  if (!hours || hours.closed) return { ok: false, reason: 'An diesem Wochentag arbeiten wir nicht.' };

  const [activeEmployees, absences, overlappingCrew] = await Promise.all([
    prisma.employee.count({ where: { organizationId: params.organizationId, active: true } }),
    prisma.absence.count({
      where: {
        status: 'APPROVED',
        employee: { organizationId: params.organizationId, active: true },
        startDate: { lte: end },
        endDate: { gte: params.start },
      },
    }),
    prisma.job.aggregate({
      where: {
        organizationId: params.organizationId,
        deletedAt: null,
        status: { notIn: ['CANCELLED'] },
        scheduledStart: { lt: end },
        scheduledEnd: { gt: params.start },
      },
      _sum: { crewSize: true },
    }),
  ]);

  const remaining = activeEmployees - absences - (overlappingCrew._sum.crewSize ?? 0);

  if (remaining < params.crewSize) {
    return {
      ok: false,
      reason: 'Für diesen Zeitpunkt sind leider keine Kapazitäten mehr frei. Bitte wählen Sie einen anderen Termin.',
    };
  }

  return { ok: true };
}

/** Cache für einen Tag invalidieren — nach jeder Job-Mutation. */
export async function invalidateAvailability(organizationId: string, date: Date) {
  const dateKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZURICH,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  await cache.delByPattern(`${cacheKeys.availability(organizationId, dateKey)}*`);
}
