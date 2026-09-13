import 'server-only';

import type { Absence, Employee, Prisma } from '@prisma/client';

import { prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import { round2 } from '@/lib/utils';
import { audit } from '@/lib/audit';
import type {
  AbsenceRequestInput,
  CreateEmployeeInput,
  UpdateEmployeeInput,
} from '@/lib/validation/operations';

import { nextNumber } from './numbering.service';
import { inviteUser } from './auth.service';
import { notify, notifyStaff } from './notification.service';

/**
 * Personalverwaltung.
 *
 * Architekturentscheide:
 *  1. `Employee` und `User` sind getrennt: der User trägt Login und Rolle, der
 *     Employee die Anstellungsdaten. So kann eine Person Administrator sein,
 *     ohne im Einsatzplan zu erscheinen — und umgekehrt.
 *  2. Ferientage werden nach Schweizer Praxis in Tagen geführt (nicht Stunden)
 *     und pro Kalenderjahr saldiert. Halbtage sind zulässig.
 *  3. Bewilligte Abwesenheiten reduzieren die buchbare Kapazität automatisch —
 *     die Verfügbarkeitsberechnung liest dieselbe Tabelle.
 *  4. Sensible Felder (AHV-Nummer, IBAN) sind nur für ADMIN sichtbar; die
 *     Selektion erfolgt explizit statt über `include`.
 */

const PUBLIC_EMPLOYEE_SELECT = {
  id: true,
  employeeNumber: true,
  position: true,
  department: true,
  employmentType: true,
  workloadPct: true,
  hiredAt: true,
  active: true,
  color: true,
  languages: true,
  driverLicense: true,
  user: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      avatarUrl: true,
      role: true,
      status: true,
      lastLoginAt: true,
    },
  },
} satisfies Prisma.EmployeeSelect;

export async function createEmployee(params: {
  organizationId: string;
  input: CreateEmployeeInput;
  actorId: string;
}): Promise<Employee> {
  const email = params.input.email.toLowerCase();

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    throw new ConflictError('Für diese E-Mail-Adresse besteht bereits ein Benutzerkonto.');
  }

  // Konto anlegen und Einladung versenden.
  const { userId } = await inviteUser({
    organizationId: params.organizationId,
    email,
    firstName: params.input.firstName,
    lastName: params.input.lastName,
    role: params.input.role,
    actorId: params.actorId,
  });

  const employee = await prisma.$transaction(async (tx) => {
    const { number } = await nextNumber(tx, params.organizationId, 'employee');

    await tx.user.update({
      where: { id: userId },
      data: { phone: params.input.phone ?? null },
    });

    return tx.employee.create({
      data: {
        organizationId: params.organizationId,
        userId,
        employeeNumber: number,
        employmentType: params.input.employmentType,
        position: params.input.position,
        department: params.input.department ?? null,
        hiredAt: params.input.hiredAt,
        hourlyRate: params.input.hourlyRate ?? null,
        monthlySalary: params.input.monthlySalary ?? null,
        workloadPct: params.input.workloadPct,
        vacationDaysPerYear: params.input.vacationDaysPerYear,
        ahvNumber: params.input.ahvNumber ?? null,
        iban: params.input.iban ?? null,
        nationality: params.input.nationality ?? null,
        permitType: params.input.permitType ?? null,
        permitValidUntil: params.input.permitValidUntil ?? null,
        emergencyContact: params.input.emergencyContact ?? null,
        emergencyPhone: params.input.emergencyPhone ?? null,
        driverLicense: params.input.driverLicense,
        vehiclePlate: params.input.vehiclePlate ?? null,
        languages: params.input.languages,
        color: params.input.color,
        // Standardverfügbarkeit Mo–Fr 07:00–17:00.
        availability: {
          create: [1, 2, 3, 4, 5].map((weekday) => ({
            weekday,
            startTime: '07:00',
            endTime: '17:00',
          })),
        },
      },
    });
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Employee',
    entityId: employee.id,
    summary: `Mitarbeitende/r ${employee.employeeNumber} (${email}) angelegt`,
  });

  return employee;
}

/**
 * Personalakte ändern.
 *
 * Die Rolle des Kontos ist hier absichtlich nicht änderbar — sie ist eine
 * Rechtevergabe und läuft über `assignRole` mit `role:assign`. Vorher konnte
 * die Betriebsleitung (`employee:update`) über diesen Weg ein Konto zur
 * Administration befördern.
 */
export async function updateEmployee(params: {
  organizationId: string;
  employeeId: string;
  input: UpdateEmployeeInput;
  actorId: string;
}): Promise<Employee> {
  const employee = await prisma.employee.findFirst({
    where: { id: params.employeeId, organizationId: params.organizationId },
  });
  if (!employee) throw new NotFoundError('Mitarbeitende/r');

  const { firstName, lastName, email, phone, ...employeeFields } = params.input;

  const updated = await prisma.$transaction(async (tx) => {
    if (firstName || lastName || email || phone !== undefined) {
      await tx.user.update({
        where: { id: employee.userId },
        data: {
          ...(firstName ? { firstName } : {}),
          ...(lastName ? { lastName } : {}),
          ...(email ? { email: email.toLowerCase() } : {}),
          ...(phone !== undefined ? { phone } : {}),
        },
      });
    }

    const result = await tx.employee.update({
      where: { id: employee.id },
      data: employeeFields as Prisma.EmployeeUpdateInput,
    });

    // Austritt: Konto deaktivieren und laufende Sessions beenden.
    if (params.input.active === false || params.input.terminatedAt) {
      await tx.user.update({
        where: { id: employee.userId },
        data: { status: 'DISABLED' },
      });
      await tx.refreshToken.updateMany({
        where: { userId: employee.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    return result;
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Employee',
    entityId: employee.id,
    summary: `Mitarbeitende/r ${employee.employeeNumber} bearbeitet`,
    changes: params.input,
  });

  return updated;
}

export async function listEmployees(params: {
  organizationId: string;
  includeInactive?: boolean;
  q?: string;
}) {
  return prisma.employee.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.includeInactive ? {} : { active: true }),
      ...(params.q
        ? {
            OR: [
              { employeeNumber: { contains: params.q, mode: 'insensitive' } },
              { position: { contains: params.q, mode: 'insensitive' } },
              { user: { firstName: { contains: params.q, mode: 'insensitive' } } },
              { user: { lastName: { contains: params.q, mode: 'insensitive' } } },
              { user: { email: { contains: params.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    select: PUBLIC_EMPLOYEE_SELECT,
    orderBy: [{ active: 'desc' }, { employeeNumber: 'asc' }],
  });
}

export async function getEmployeeDetail(params: {
  organizationId: string;
  employeeId: string;
  /** ADMIN sieht Lohn- und Personalstammdaten, MANAGER nicht. */
  includeSensitive: boolean;
}) {
  const employee = await prisma.employee.findFirst({
    where: { id: params.employeeId, organizationId: params.organizationId },
    include: {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          avatarUrl: true,
          role: true,
          status: true,
          lastLoginAt: true,
          locale: true,
        },
      },
      skills: true,
      availability: { orderBy: { weekday: 'asc' } },
      absences: { orderBy: { startDate: 'desc' }, take: 30 },
      assignments: {
        take: 20,
        orderBy: { job: { scheduledStart: 'desc' } },
        include: {
          job: {
            select: {
              id: true,
              number: true,
              title: true,
              status: true,
              scheduledStart: true,
              scheduledEnd: true,
            },
          },
        },
      },
      ...(params.includeSensitive ? { payslips: { orderBy: [{ year: 'desc' }, { month: 'desc' }], take: 12 } } : {}),
    },
  });

  if (!employee) throw new NotFoundError('Mitarbeitende/r');

  if (!params.includeSensitive) {
    // Sensible Felder aus der Antwort entfernen.
    return {
      ...employee,
      ahvNumber: null,
      iban: null,
      hourlyRate: null,
      monthlySalary: null,
    };
  }

  return employee;
}

// ---------------------------------------------------------------------------
//  Abwesenheiten
// ---------------------------------------------------------------------------

/** Netto-Abwesenheitstage: Wochenenden und Feiertage zählen nicht. */
async function countAbsenceDays(params: {
  organizationId: string;
  from: Date;
  to: Date;
  halfDay: boolean;
}): Promise<number> {
  if (params.halfDay) return 0.5;

  const holidays = await prisma.holiday.findMany({
    where: {
      organizationId: params.organizationId,
      date: { gte: params.from, lte: params.to },
    },
    select: { date: true },
  });
  const holidayKeys = new Set(holidays.map((h) => h.date.toISOString().slice(0, 10)));

  let days = 0;
  const cursor = new Date(params.from);
  while (cursor <= params.to) {
    const weekday = cursor.getUTCDay();
    const key = cursor.toISOString().slice(0, 10);
    if (weekday !== 0 && weekday !== 6 && !holidayKeys.has(key)) days++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export async function requestAbsence(params: {
  organizationId: string;
  employeeId: string;
  input: AbsenceRequestInput;
}): Promise<Absence> {
  const employee = await prisma.employee.findFirst({
    where: { id: params.employeeId, organizationId: params.organizationId },
    include: { user: { select: { firstName: true, lastName: true } } },
  });
  if (!employee) throw new NotFoundError('Mitarbeitende/r');

  const overlapping = await prisma.absence.findFirst({
    where: {
      employeeId: params.employeeId,
      status: { in: ['REQUESTED', 'APPROVED'] },
      startDate: { lte: params.input.endDate },
      endDate: { gte: params.input.startDate },
    },
  });
  if (overlapping) {
    throw new ConflictError('Für diesen Zeitraum besteht bereits ein Abwesenheitseintrag.');
  }

  const days = await countAbsenceDays({
    organizationId: params.organizationId,
    from: params.input.startDate,
    to: params.input.endDate,
    halfDay: params.input.halfDay,
  });

  if (days === 0) {
    throw new BusinessRuleError('Der gewählte Zeitraum enthält keine Arbeitstage.');
  }

  // Feriensaldo prüfen (nur für Ferien, nicht für Krankheit/Unfall).
  if (params.input.type === 'VACATION') {
    const balance = await getVacationBalance(params.employeeId);
    if (days > balance.remaining) {
      throw new BusinessRuleError(
        `Der Feriensaldo reicht nicht aus: beantragt ${days} Tage, verfügbar ${balance.remaining} Tage.`,
      );
    }
  }

  const absence = await prisma.absence.create({
    data: {
      employeeId: params.employeeId,
      type: params.input.type,
      status: 'REQUESTED',
      startDate: params.input.startDate,
      endDate: params.input.endDate,
      halfDay: params.input.halfDay,
      days,
      reason: params.input.reason ?? null,
    },
  });

  await notifyStaff({
    organizationId: params.organizationId,
    title: 'Neuer Abwesenheitsantrag',
    body: `${employee.user.firstName} ${employee.user.lastName} · ${days} Tage ab ${params.input.startDate.toLocaleDateString('de-CH')}`,
    link: `/admin/personal/abwesenheiten`,
    permission: 'absence:read_all',
  });

  return absence;
}

export async function decideAbsence(params: {
  organizationId: string;
  absenceId: string;
  status: 'APPROVED' | 'REJECTED';
  note?: string;
  actorId: string;
}): Promise<Absence> {
  const absence = await prisma.absence.findFirst({
    where: { id: params.absenceId, employee: { organizationId: params.organizationId } },
    include: { employee: { include: { user: { select: { id: true, firstName: true } } } } },
  });
  if (!absence) throw new NotFoundError('Abwesenheit');

  if (absence.status !== 'REQUESTED') {
    throw new BusinessRuleError('Dieser Antrag wurde bereits entschieden.');
  }

  // Konflikte mit bereits zugeteilten Einsätzen sichtbar machen.
  if (params.status === 'APPROVED') {
    const conflicts = await prisma.jobAssignment.count({
      where: {
        employeeId: absence.employeeId,
        job: {
          deletedAt: null,
          status: { notIn: ['CANCELLED', 'COMPLETED', 'VERIFIED'] },
          scheduledStart: { lte: absence.endDate },
          scheduledEnd: { gte: absence.startDate },
        },
      },
    });
    if (conflicts > 0) {
      throw new BusinessRuleError(
        `In diesem Zeitraum sind noch ${conflicts} Einsätze zugeteilt. Bitte planen Sie diese zuerst um.`,
      );
    }
  }

  const updated = await prisma.absence.update({
    where: { id: absence.id },
    data: {
      status: params.status,
      decidedById: params.actorId,
      decidedAt: new Date(),
      decisionNote: params.note ?? null,
    },
  });

  await notify({
    userId: absence.employee.user.id,
    channels: ['IN_APP', 'EMAIL'],
    title: params.status === 'APPROVED' ? 'Abwesenheit bewilligt' : 'Abwesenheit abgelehnt',
    body:
      params.status === 'APPROVED'
        ? `Dein Antrag vom ${absence.startDate.toLocaleDateString('de-CH')} wurde bewilligt.`
        : `Dein Antrag wurde abgelehnt.${params.note ? ` Begründung: ${params.note}` : ''}`,
    link: '/portal/abwesenheiten',
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Absence',
    entityId: absence.id,
    summary: `Abwesenheit ${params.status === 'APPROVED' ? 'bewilligt' : 'abgelehnt'}`,
  });

  return updated;
}

/**
 * Eigenen Antrag zurückziehen.
 *
 * Nur, solange er noch nicht entschieden ist: Ein bewilligter Antrag hat die
 * Disposition bereits verändert (die Person ist aus den Einsätzen genommen),
 * und ihn stillschweigend zurückzunehmen liesse die Planung im falschen
 * Stand. Wer bewilligte Ferien doch nicht nimmt, meldet sich bei der
 * Betriebsleitung — das ist ein Gespräch, kein Klick.
 *
 * Der Antrag wird nicht gelöscht, sondern auf `CANCELLED` gesetzt: Die
 * Zeile ist der Beleg dafür, dass beantragt und zurückgezogen wurde, und die
 * Saldo-Rechnung zählt nur `APPROVED`.
 *
 * Die Zugehörigkeit steht in der Abfrage (`employeeId`): Ein fremder Antrag
 * wird nicht gefunden, und der 404 verrät nicht, ob er existiert.
 */
export async function withdrawAbsence(params: {
  organizationId: string;
  employeeId: string;
  absenceId: string;
  actorId: string;
  ip?: string | null;
}): Promise<Absence> {
  const absence = await prisma.absence.findFirst({
    where: {
      id: params.absenceId,
      employeeId: params.employeeId,
      employee: { organizationId: params.organizationId },
    },
  });
  if (!absence) throw new NotFoundError('Abwesenheit');

  if (absence.status !== 'REQUESTED') {
    throw new BusinessRuleError(
      absence.status === 'CANCELLED'
        ? 'Dieser Antrag ist bereits zurückgezogen.'
        : 'Dieser Antrag wurde bereits entschieden. Wenden Sie sich für eine Änderung an die Betriebsleitung.',
    );
  }

  const updated = await prisma.absence.update({
    where: { id: absence.id },
    data: { status: 'CANCELLED', decidedAt: new Date(), decisionNote: 'Zurückgezogen' },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Absence',
    entityId: absence.id,
    summary: `Abwesenheitsantrag vom ${absence.startDate.toLocaleDateString('de-CH', { timeZone: 'UTC' })} zurückgezogen`,
    ip: params.ip,
  });

  return updated;
}

export async function getVacationBalance(
  employeeId: string,
  year = new Date().getFullYear(),
): Promise<{ entitlement: number; taken: number; pending: number; remaining: number }> {
  const employee = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: { vacationDaysPerYear: true, workloadPct: true, hiredAt: true },
  });

  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year, 11, 31));

  // Pro-rata-Anspruch im Eintrittsjahr.
  const startOfEntitlement = employee.hiredAt > yearStart ? employee.hiredAt : yearStart;
  const monthsWorked = 12 - startOfEntitlement.getUTCMonth() * (employee.hiredAt > yearStart ? 1 : 0);
  const proRataFactor = employee.hiredAt > yearStart ? monthsWorked / 12 : 1;

  const entitlement = round2(
    toNumber(employee.vacationDaysPerYear) * (employee.workloadPct / 100) * proRataFactor,
  );

  const [taken, pending] = await Promise.all([
    prisma.absence.aggregate({
      where: {
        employeeId,
        type: 'VACATION',
        status: 'APPROVED',
        startDate: { gte: yearStart, lte: yearEnd },
      },
      _sum: { days: true },
    }),
    prisma.absence.aggregate({
      where: {
        employeeId,
        type: 'VACATION',
        status: 'REQUESTED',
        startDate: { gte: yearStart, lte: yearEnd },
      },
      _sum: { days: true },
    }),
  ]);

  const takenDays = round2(toNumber(taken._sum.days));
  const pendingDays = round2(toNumber(pending._sum.days));

  return {
    entitlement,
    taken: takenDays,
    pending: pendingDays,
    remaining: round2(entitlement - takenDays - pendingDays),
  };
}

// ---------------------------------------------------------------------------
//  Zeiterfassung & Lohn
// ---------------------------------------------------------------------------

export async function getTimesheet(params: {
  employeeId: string;
  from: Date;
  to: Date;
}) {
  const entries = await prisma.timeEntry.findMany({
    where: {
      employeeId: params.employeeId,
      startedAt: { gte: params.from, lte: params.to },
    },
    orderBy: { startedAt: 'asc' },
    include: {
      job: {
        select: {
          id: true,
          number: true,
          title: true,
          address: { select: { city: true, postalCode: true } },
        },
      },
    },
  });

  const totalMinutes = entries.reduce((sum, entry) => sum + entry.minutes, 0);
  const byDay = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.startedAt.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + entry.minutes);
  }

  return {
    entries,
    totalMinutes,
    totalHours: round2(totalMinutes / 60),
    byDay: [...byDay.entries()].map(([date, minutes]) => ({
      date,
      minutes,
      hours: round2(minutes / 60),
    })),
  };
}

/**
 * Lohnabrechnung eines Monats.
 *
 * Die Sozialversicherungsansätze entsprechen den Schweizer Werten für 2026
 * (Arbeitnehmeranteil). Sie sind bewusst als Konstanten hier abgelegt und
 * nicht in der Datenbank — die Ansätze ändern jährlich per Verordnung und
 * gehören ins Deployment, nicht in die Stammdaten.
 */
const SOCIAL_RATES = {
  ahvIvEo: 0.053, // AHV/IV/EO Arbeitnehmeranteil
  alv: 0.011, // ALV bis zum versicherten Höchstlohn
  alvCeilingMonthly: 12_350,
  nbu: 0.0073, // Nichtberufsunfall
  bvgApprox: 0.07, // BVG-Näherung; die effektive Prämie liefert die Vorsorgeeinrichtung
};

export async function generatePayslip(params: {
  organizationId: string;
  employeeId: string;
  year: number;
  month: number;
  actorId: string;
}) {
  const employee = await prisma.employee.findFirst({
    where: { id: params.employeeId, organizationId: params.organizationId },
  });
  if (!employee) throw new NotFoundError('Mitarbeitende/r');

  const from = new Date(Date.UTC(params.year, params.month - 1, 1));
  const to = new Date(Date.UTC(params.year, params.month, 0, 23, 59, 59));

  const timeAgg = await prisma.timeEntry.aggregate({
    where: {
      employeeId: params.employeeId,
      startedAt: { gte: from, lte: to },
      endedAt: { not: null },
    },
    _sum: { minutes: true },
  });

  const hours = round2((timeAgg._sum.minutes ?? 0) / 60);
  const hourlyRate = toNumber(employee.hourlyRate);
  const monthlySalary = toNumber(employee.monthlySalary);

  const grossPay =
    monthlySalary > 0 ? round2(monthlySalary * (employee.workloadPct / 100)) : round2(hours * hourlyRate);

  const ahvIv = round2(grossPay * SOCIAL_RATES.ahvIvEo);
  const alvBase = Math.min(grossPay, SOCIAL_RATES.alvCeilingMonthly);
  const alv = round2(alvBase * SOCIAL_RATES.alv);
  const uvg = round2(grossPay * SOCIAL_RATES.nbu);
  const bvg = round2(grossPay * SOCIAL_RATES.bvgApprox);
  const netPay = round2(grossPay - ahvIv - alv - uvg - bvg);

  const payslip = await prisma.payslip.upsert({
    where: {
      employeeId_year_month: {
        employeeId: params.employeeId,
        year: params.year,
        month: params.month,
      },
    },
    create: {
      employeeId: params.employeeId,
      year: params.year,
      month: params.month,
      hours,
      grossPay,
      ahvIv,
      alv,
      bvg,
      uvg,
      netPay,
    },
    update: { hours, grossPay, ahvIv, alv, bvg, uvg, netPay },
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Payslip',
    entityId: payslip.id,
    summary: `Lohnabrechnung ${params.month}/${params.year} für ${employee.employeeNumber}`,
  });

  return payslip;
}

/** Einsatzplan einer Person für das Mitarbeiterportal. */
export async function getEmployeeSchedule(params: {
  employeeId: string;
  from: Date;
  to: Date;
}) {
  const [jobs, absences, openEntry] = await Promise.all([
    prisma.job.findMany({
      where: {
        deletedAt: null,
        status: { notIn: ['CANCELLED'] },
        scheduledStart: { gte: params.from, lte: params.to },
        assignments: { some: { employeeId: params.employeeId } },
      },
      orderBy: { scheduledStart: 'asc' },
      include: {
        customer: { select: { firstName: true, lastName: true, companyName: true, phone: true } },
        address: true,
        service: { select: { name: true, kind: true } },
        assignments: {
          include: {
            employee: {
              select: { id: true, user: { select: { firstName: true, lastName: true } } },
            },
          },
        },
        // Nur das `done`-Flag laden: daraus lässt sich der Fortschritt bilden,
        // ohne die vollständigen Checklistentexte über die Leitung zu schicken.
        checklist: { select: { done: true } },
        _count: { select: { checklist: true, photos: true } },
      },
    }),
    prisma.absence.findMany({
      where: {
        employeeId: params.employeeId,
        status: 'APPROVED',
        startDate: { lte: params.to },
        endDate: { gte: params.from },
      },
    }),
    prisma.timeEntry.findFirst({
      where: { employeeId: params.employeeId, endedAt: null },
      include: { job: { select: { id: true, number: true, title: true } } },
    }),
  ]);

  return {
    jobs: jobs.map((job) => ({
      ...job,
      checklistDone: job.checklist.filter((item) => item.done).length,
    })),
    absences,
    activeTimeEntry: openEntry,
  };
}
