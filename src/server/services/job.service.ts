import 'server-only';

import type { Job, Prisma, ServiceKind } from '@prisma/client';

import { prisma, toNumber, type Tx } from '@/lib/db';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '@/lib/errors';
import { absoluteUrl, round2 } from '@/lib/utils';
import { orderByFor, resolveSort, type SortOrder } from '@/lib/sort';
import { haversineMeters } from '@/lib/maps/google';
import { jobAssignedEmail } from '@/lib/email/templates';
import { smsTemplates } from '@/lib/sms/client';
import { audit } from '@/lib/audit';
import type {
  ClockInput,
  CompleteJobInput,
  CreateJobInput,
  JobChecklistInput,
  JobChecklistTemplateInput,
  JobCostingInput,
  JobMaterialsInput,
  JobTeamInput,
  UpdateJobInput,
} from '@/lib/validation/operations';

import { nextNumber } from './numbering.service';
import { notify } from './notification.service';
import { invalidateAvailability } from './availability.service';

/**
 * Einsatzsteuerung (Disposition, Zeiterfassung, Abschluss).
 *
 * Architekturentscheide:
 *  1. Job ≠ Buchung. Die Buchung ist die Kundensicht (ein Auftrag, ein Preis),
 *     der Job die Betriebssicht (wer, wann, wo, mit welcher Checkliste). Eine
 *     Buchung kann mehrere Jobs erzeugen (z. B. Grob- + Feinreinigung), und ein
 *     Job kann ohne Buchung existieren (telefonisch erfasste Aufträge).
 *  2. GPS-Stempelung wird plausibilisiert, nicht erzwungen: liegt der Standort
 *     mehr als 500 m von der Einsatzadresse entfernt, wird die Zeit trotzdem
 *     erfasst, aber markiert. Reinigungspersonal arbeitet oft in Kellern und
 *     Tiefgaragen — ein harter Block würde die Lohnabrechnung blockieren.
 *  3. Lohnkosten werden beim Ausstempeln als Snapshot gespeichert, damit
 *     spätere Lohnerhöhungen die Nachkalkulation abgeschlossener Jobs nicht
 *     rückwirkend verändern.
 */

const GPS_TOLERANCE_METERS = 500;

/**
 * Den gemeldeten Standort auswerten — oder ehrlich `null` liefern.
 *
 * `0/0` wird ausdrücklich verworfen: Es ist keine Position, sondern das, was
 * ein Client schickt, der keine hat. Der Punkt liegt im Golf von Guinea; als
 * Standort einer Reinigungskraft im Kanton Bern ist er nie eine Messung,
 * sondern immer eine fehlende.
 */
function resolvePosition(input: {
  lat?: number | null;
  lng?: number | null;
}): { lat: number; lng: number } | null {
  const { lat, lng } = input;
  if (lat === null || lat === undefined || lng === null || lng === undefined) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

/** Entfernung zur Einsatzadresse — `null`, wenn eine der beiden Seiten fehlt. */
function distanceToJob(
  position: { lat: number; lng: number } | null,
  address: { lat: number | null; lng: number | null } | null,
): number | null {
  if (!position || !address?.lat || !address?.lng) return null;
  return haversineMeters(position, { lat: address.lat, lng: address.lng });
}

/** Standard-Checklisten je Leistungsart — als Startpunkt, jederzeit editierbar. */
const CHECKLIST_TEMPLATES: Record<ServiceKind, { label: string; room?: string }[]> = {
  RESIDENTIAL_CLEANING: [
    { label: 'Böden saugen und feucht aufnehmen', room: 'Alle Räume' },
    { label: 'Staub wischen (Möbel, Sockelleisten, Ablagen)', room: 'Alle Räume' },
    { label: 'Küche: Arbeitsflächen, Fronten, Spüle', room: 'Küche' },
    { label: 'Herd und Backofen aussen reinigen', room: 'Küche' },
    { label: 'Bad: WC, Lavabo, Dusche/Badewanne entkalken', room: 'Bad' },
    { label: 'Spiegel und Glasflächen streifenfrei', room: 'Bad' },
    { label: 'Abfall entsorgen, neue Säcke einsetzen' },
    { label: 'Schlusskontrolle und Lüften' },
  ],
  MOVE_OUT_CLEANING: [
    { label: 'Küche: Backofen, Dampfabzug, Kühlschrank innen entfetten', room: 'Küche' },
    { label: 'Küchenschränke innen und aussen reinigen', room: 'Küche' },
    { label: 'Bad vollständig entkalken inkl. Fugen', room: 'Bad' },
    { label: 'Fenster innen und aussen inkl. Rahmen und Storen', room: 'Alle Räume' },
    { label: 'Böden grundreinigen, Sockelleisten', room: 'Alle Räume' },
    { label: 'Türen, Rahmen und Lichtschalter reinigen', room: 'Alle Räume' },
    { label: 'Heizkörper und Nischen reinigen', room: 'Alle Räume' },
    { label: 'Keller / Estrich / Balkon reinigen' },
    { label: 'Abnahmebereitschaft prüfen (Abgabegarantie)' },
  ],
  OFFICE_CLEANING: [
    { label: 'Arbeitsplätze abstauben (ohne Unterlagen zu verschieben)' },
    { label: 'Böden saugen und feucht reinigen' },
    { label: 'Sanitäranlagen reinigen und desinfizieren', room: 'WC' },
    { label: 'Verbrauchsmaterial nachfüllen (Seife, Papier)', room: 'WC' },
    { label: 'Küche / Pausenraum reinigen', room: 'Küche' },
    { label: 'Abfall und Recycling entsorgen' },
    { label: 'Glastüren und Fingerabdrücke entfernen' },
  ],
  WINDOW_CLEANING: [
    { label: 'Fensterglas innen reinigen' },
    { label: 'Fensterglas aussen reinigen' },
    { label: 'Rahmen und Falze feucht reinigen' },
    { label: 'Storen / Rollläden abstauben' },
    { label: 'Fenstersimsen reinigen' },
    { label: 'Streifenfreiheit kontrollieren' },
  ],
  CONSTRUCTION_CLEANING: [
    { label: 'Grobschutt und Verpackungsmaterial entfernen' },
    { label: 'Bauschutt saugen (Industriesauger)' },
    { label: 'Kleberreste, Farbspritzer und Zementschleier entfernen' },
    { label: 'Fenster inkl. Rahmen und Schutzfolien' },
    { label: 'Sanitärbereiche endreinigen' },
    { label: 'Böden nass reinigen und imprägnieren' },
    { label: 'Übergabekontrolle mit Bauleitung' },
  ],
  BUILDING_MAINTENANCE: [
    { label: 'Treppenhaus reinigen (Stufen, Geländer)' },
    { label: 'Eingangsbereich und Briefkastenanlage' },
    { label: 'Lift innen reinigen' },
    { label: 'Waschküche und Trocknungsraum' },
    { label: 'Aussenbereich kehren' },
    { label: 'Container und Entsorgungsstelle kontrollieren' },
    { label: 'Beleuchtung und Schäden protokollieren' },
  ],
  SPECIAL: [{ label: 'Auftrag gemäss Vereinbarung ausführen' }],
};

// ---------------------------------------------------------------------------
//  Anlegen
// ---------------------------------------------------------------------------

/**
 * Erzeugt die Einsätze zu einer bestätigten Buchung.
 * Läuft innerhalb der Transaktion des Aufrufers.
 */
export async function createJobsForBooking(tx: Tx, bookingId: string): Promise<Job[]> {
  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      items: { include: { service: true } },
      customer: { select: { firstName: true, lastName: true, companyName: true } },
    },
  });

  const existing = await tx.job.count({ where: { bookingId } });
  if (existing > 0) return [];

  const service = booking.items[0]?.service;
  const { number } = await nextNumber(tx, booking.organizationId, 'job');

  const checklistTemplate = service ? CHECKLIST_TEMPLATES[service.kind] : [];

  const job = await tx.job.create({
    data: {
      organizationId: booking.organizationId,
      number,
      bookingId: booking.id,
      customerId: booking.customerId,
      addressId: booking.addressId,
      propertyId: booking.propertyId,
      serviceId: service?.id ?? null,
      title: `${service?.name ?? 'Reinigung'} · ${booking.customer.companyName ?? booking.customer.lastName}`,
      status: 'UNASSIGNED',
      scheduledStart: booking.scheduledStart,
      scheduledEnd: booking.scheduledEnd,
      crewSize: booking.crewSize,
      estimatedMin: booking.durationMin,
      customerNote: booking.customerNote,
      internalNote: booking.accessNote,
      revenue: booking.netTotal,
      checklist: {
        create: checklistTemplate.map((item, index) => ({
          label: item.label,
          room: item.room ?? null,
          required: true,
          position: index,
        })),
      },
    },
  });

  return [job];
}

export async function createJob(params: {
  organizationId: string;
  input: CreateJobInput;
  actorId: string;
}): Promise<Job> {
  const { organizationId, input } = params;

  const job = await prisma.$transaction(async (tx) => {
    const { number } = await nextNumber(tx, organizationId, 'job');

    const created = await tx.job.create({
      data: {
        organizationId,
        number,
        bookingId: input.bookingId ?? null,
        customerId: input.customerId,
        addressId: input.addressId ?? null,
        propertyId: input.propertyId ?? null,
        serviceId: input.serviceId ?? null,
        title: input.title,
        status: input.employeeIds.length > 0 ? 'SCHEDULED' : 'UNASSIGNED',
        scheduledStart: input.scheduledStart,
        scheduledEnd: input.scheduledEnd,
        crewSize: input.crewSize,
        estimatedMin: input.estimatedMin,
        travelMin: input.travelMin,
        description: input.description ?? null,
        internalNote: input.internalNote ?? null,
        customerNote: input.customerNote ?? null,
        checklist: {
          create: input.checklist.map((item, index) => ({
            label: item.label,
            room: item.room ?? null,
            required: item.required,
            position: index,
          })),
        },
        assignments: {
          create: input.employeeIds.map((employeeId, index) => ({
            employeeId,
            role: index === 0 ? 'LEAD' : 'MEMBER',
          })),
        },
      },
    });

    return created;
  });

  await invalidateAvailability(organizationId, input.scheduledStart);

  if (input.employeeIds.length > 0) {
    await notifyAssignees(job.id, input.employeeIds);
  }

  await audit.created({
    organizationId,
    userId: params.actorId,
    entity: 'Job',
    entityId: job.id,
    summary: `Einsatz ${job.number} erstellt`,
  });

  return job;
}

export async function updateJob(params: {
  organizationId: string;
  jobId: string;
  input: UpdateJobInput;
  actorId: string;
}): Promise<Job> {
  const job = await prisma.job.findFirst({
    where: { id: params.jobId, organizationId: params.organizationId, deletedAt: null },
  });
  if (!job) throw new NotFoundError('Einsatz');

  const updated = await prisma.job.update({
    where: { id: job.id },
    data: {
      ...(params.input.title !== undefined ? { title: params.input.title } : {}),
      ...(params.input.status !== undefined ? { status: params.input.status } : {}),
      ...(params.input.scheduledStart ? { scheduledStart: params.input.scheduledStart } : {}),
      ...(params.input.scheduledEnd ? { scheduledEnd: params.input.scheduledEnd } : {}),
      ...(params.input.crewSize !== undefined ? { crewSize: params.input.crewSize } : {}),
      ...(params.input.estimatedMin !== undefined ? { estimatedMin: params.input.estimatedMin } : {}),
      ...(params.input.travelMin !== undefined ? { travelMin: params.input.travelMin } : {}),
      ...(params.input.description !== undefined ? { description: params.input.description } : {}),
      ...(params.input.internalNote !== undefined ? { internalNote: params.input.internalNote } : {}),
      ...(params.input.customerNote !== undefined ? { customerNote: params.input.customerNote } : {}),
      ...(params.input.color !== undefined ? { color: params.input.color } : {}),
    },
  });

  await invalidateAvailability(params.organizationId, updated.scheduledStart);

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Job',
    entityId: job.id,
    summary: `Einsatz ${job.number} bearbeitet`,
    changes: params.input,
  });

  return updated;
}

/** Drag & Drop im Kalender. */
export async function moveJob(params: {
  organizationId: string;
  jobId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  employeeId?: string;
  actorId: string;
}): Promise<Job> {
  const job = await prisma.job.findFirst({
    where: { id: params.jobId, organizationId: params.organizationId, deletedAt: null },
    include: { assignments: true },
  });
  if (!job) throw new NotFoundError('Einsatz');

  if (['COMPLETED', 'VERIFIED'].includes(job.status)) {
    throw new BusinessRuleError('Abgeschlossene Einsätze können nicht verschoben werden.');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.job.update({
      where: { id: job.id },
      data: { scheduledStart: params.scheduledStart, scheduledEnd: params.scheduledEnd },
    });

    // Ressourcenspalte im Kalender gewechselt → Zuteilung anpassen.
    if (params.employeeId) {
      const alreadyAssigned = job.assignments.some((a) => a.employeeId === params.employeeId);
      if (!alreadyAssigned) {
        await tx.jobAssignment.deleteMany({ where: { jobId: job.id } });
        await tx.jobAssignment.create({
          data: { jobId: job.id, employeeId: params.employeeId, role: 'LEAD' },
        });
        await tx.job.update({ where: { id: job.id }, data: { status: 'SCHEDULED' } });
      }
    }

    // Buchungstermin mitziehen, damit Kundensicht und Disposition übereinstimmen.
    if (job.bookingId) {
      await tx.booking.update({
        where: { id: job.bookingId },
        data: { scheduledStart: params.scheduledStart, scheduledEnd: params.scheduledEnd },
      });
    }

    return result;
  });

  await Promise.all([
    invalidateAvailability(params.organizationId, job.scheduledStart),
    invalidateAvailability(params.organizationId, params.scheduledStart),
  ]);

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Job',
    entityId: job.id,
    summary: `Einsatz ${job.number} im Kalender verschoben`,
    changes: { scheduledStart: { from: job.scheduledStart, to: params.scheduledStart } },
  });

  return updated;
}

// ---------------------------------------------------------------------------
//  Zuteilung
// ---------------------------------------------------------------------------

export async function assignJob(params: {
  organizationId: string;
  jobId: string;
  employeeIds: string[];
  role?: 'LEAD' | 'MEMBER' | 'TRAINEE' | 'SUPERVISOR';
  notify?: boolean;
  actorId: string;
}): Promise<void> {
  const job = await prisma.job.findFirst({
    where: { id: params.jobId, organizationId: params.organizationId, deletedAt: null },
  });
  if (!job) throw new NotFoundError('Einsatz');

  // Doppelverplanung erkennen: überlappende Einsätze derselben Person.
  const conflicts = await prisma.jobAssignment.findMany({
    where: {
      employeeId: { in: params.employeeIds },
      jobId: { not: job.id },
      job: {
        deletedAt: null,
        status: { notIn: ['CANCELLED', 'COMPLETED', 'VERIFIED'] },
        scheduledStart: { lt: job.scheduledEnd },
        scheduledEnd: { gt: job.scheduledStart },
      },
    },
    include: {
      employee: { include: { user: { select: { firstName: true, lastName: true } } } },
      job: { select: { number: true } },
    },
  });

  if (conflicts.length > 0) {
    throw new BusinessRuleError(
      `Terminkonflikt: ${conflicts
        .map((c) => `${c.employee.user.firstName} ${c.employee.user.lastName} ist bereits für ${c.job.number} eingeteilt`)
        .join('; ')}.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.jobAssignment.deleteMany({ where: { jobId: job.id } });
    await tx.jobAssignment.createMany({
      data: params.employeeIds.map((employeeId, index) => ({
        jobId: job.id,
        employeeId,
        role: index === 0 ? 'LEAD' : (params.role ?? 'MEMBER'),
        notifiedAt: params.notify === false ? null : new Date(),
      })),
    });
    await tx.job.update({
      where: { id: job.id },
      data: { status: job.status === 'UNASSIGNED' ? 'SCHEDULED' : job.status },
    });
  });

  if (params.notify !== false) {
    await notifyAssignees(job.id, params.employeeIds);
  }

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Job',
    entityId: job.id,
    summary: `Einsatz ${job.number} an ${params.employeeIds.length} Person(en) zugeteilt`,
  });
}

async function notifyAssignees(jobId: string, employeeIds: string[]) {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { address: true },
  });
  if (!job) return;

  const employees = await prisma.employee.findMany({
    where: { id: { in: employeeIds } },
    include: { user: { select: { id: true, firstName: true, email: true, phone: true } } },
  });

  const addressLabel = job.address
    ? `${job.address.street} ${job.address.streetNo ?? ''}, ${job.address.postalCode} ${job.address.city}`
    : '—';

  await Promise.allSettled(
    employees.map((employee) =>
      notify({
        userId: employee.user.id,
        channels: ['IN_APP', 'EMAIL', 'SMS'],
        title: 'Neuer Einsatz zugeteilt',
        body: `${job.title} · ${job.scheduledStart.toLocaleString('de-CH')}`,
        link: `/portal/einsaetze/${job.id}`,
        emailContent: jobAssignedEmail({
          firstName: employee.user.firstName,
          jobNumber: job.number,
          title: job.title,
          scheduledStart: job.scheduledStart,
          address: addressLabel,
          portalUrl: absoluteUrl(`/portal/einsaetze/${job.id}`),
        }),
        smsBody: smsTemplates.jobAssigned({
          date: job.scheduledStart.toLocaleDateString('de-CH'),
          time: job.scheduledStart.toLocaleTimeString('de-CH', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Europe/Zurich',
          }),
          address: addressLabel,
        }),
        entity: 'Job',
        entityId: job.id,
      }),
    ),
  );
}

export async function respondToAssignment(params: {
  jobId: string;
  employeeId: string;
  accept: boolean;
  reason?: string;
}): Promise<void> {
  const assignment = await prisma.jobAssignment.findUnique({
    where: { jobId_employeeId: { jobId: params.jobId, employeeId: params.employeeId } },
  });
  if (!assignment) throw new NotFoundError('Zuteilung');

  await prisma.jobAssignment.update({
    where: { id: assignment.id },
    data: params.accept
      ? { acceptedAt: new Date(), declinedAt: null, declineReason: null }
      : { declinedAt: new Date(), acceptedAt: null, declineReason: params.reason ?? null },
  });

  if (!params.accept) {
    // Absage macht die Disposition wieder offen — das Büro muss reagieren.
    const remaining = await prisma.jobAssignment.count({
      where: { jobId: params.jobId, declinedAt: null },
    });
    if (remaining === 0) {
      await prisma.job.update({ where: { id: params.jobId }, data: { status: 'UNASSIGNED' } });
    }
  }
}

// ---------------------------------------------------------------------------
//  Zeiterfassung mit GPS
// ---------------------------------------------------------------------------

export async function clockIn(params: {
  employeeId: string;
  input: ClockInput;
}): Promise<{ timeEntryId: string; distanceMeters: number | null; warning?: string }> {
  const job = await prisma.job.findUnique({
    where: { id: params.input.jobId },
    include: { address: true, assignments: true },
  });
  if (!job) throw new NotFoundError('Einsatz');

  const isAssigned = job.assignments.some((a) => a.employeeId === params.employeeId);
  if (!isAssigned) throw new ForbiddenError('Sie sind diesem Einsatz nicht zugeteilt.');

  const open = await prisma.timeEntry.findFirst({
    where: { employeeId: params.employeeId, endedAt: null },
    include: { job: { select: { number: true, title: true } } },
  });
  if (open) {
    // Mit Nummer statt ohne: „Es läuft bereits eine Zeiterfassung" schickt die
    // Person suchen, „…auf E-2041" sagt ihr, wo sie ausstempeln muss.
    throw new BusinessRuleError(
      open.job
        ? `Es läuft bereits eine Zeiterfassung auf ${open.job.number} (${open.job.title}). Bitte stempeln Sie dort zuerst aus.`
        : 'Es läuft bereits eine Zeiterfassung. Bitte stempeln Sie zuerst aus.',
    );
  }

  const position = resolvePosition(params.input);
  const distanceMeters = distanceToJob(position, job.address);

  const employee = await prisma.employee.findUniqueOrThrow({
    where: { id: params.employeeId },
    select: { hourlyRate: true },
  });

  const entry = await prisma.$transaction(async (tx) => {
    const created = await tx.timeEntry.create({
      data: {
        jobId: job.id,
        employeeId: params.employeeId,
        startedAt: new Date(),
        note: params.input.note ?? null,
        hourlyRate: employee.hourlyRate,
      },
    });

    // Ohne Position kein Standortnachweis. Ein Eintrag mit erfundenen
    // Koordinaten wäre schlimmer als gar keiner: Er sieht aus wie ein Beleg.
    if (position) {
      await tx.gpsEvent.create({
        data: {
          jobId: job.id,
          employeeId: params.employeeId,
          type: 'CHECK_IN',
          lat: position.lat,
          lng: position.lng,
          accuracy: params.input.accuracy ?? null,
          distanceM: distanceMeters,
        },
      });
    }

    if (['SCHEDULED', 'DISPATCHED', 'EN_ROUTE', 'UNASSIGNED', 'ON_HOLD'].includes(job.status)) {
      await tx.job.update({
        where: { id: job.id },
        data: { status: 'IN_PROGRESS', actualStart: job.actualStart ?? new Date() },
      });
      if (job.bookingId) {
        await tx.booking.update({
          where: { id: job.bookingId },
          data: { status: 'IN_PROGRESS' },
        });
      }
    }

    return created;
  });

  const warning =
    distanceMeters !== null && distanceMeters > GPS_TOLERANCE_METERS
      ? `Ihr Standort liegt ${Math.round(distanceMeters)} m von der Einsatzadresse entfernt. Die Zeit wurde erfasst und zur Prüfung markiert.`
      : !position
        ? 'Ohne Standort erfasst — vermutlich kein GPS-Empfang. Die Zeit zählt normal, das Büro sieht den fehlenden Nachweis.'
        : undefined;

  return { timeEntryId: entry.id, distanceMeters, warning };
}

export async function clockOut(params: {
  employeeId: string;
  input: ClockInput;
}): Promise<{ minutes: number; distanceMeters: number | null }> {
  const entry = await prisma.timeEntry.findFirst({
    where: { employeeId: params.employeeId, jobId: params.input.jobId, endedAt: null },
    orderBy: { startedAt: 'desc' },
  });
  if (!entry) throw new BusinessRuleError('Für diesen Einsatz läuft keine Zeiterfassung.');

  const job = await prisma.job.findUniqueOrThrow({
    where: { id: params.input.jobId },
    include: { address: true },
  });

  const endedAt = new Date();
  const minutes = Math.max(
    0,
    Math.round((endedAt.getTime() - entry.startedAt.getTime()) / 60_000) - entry.breakMin,
  );

  const position = resolvePosition(params.input);
  const distanceMeters = distanceToJob(position, job.address);

  await prisma.$transaction(async (tx) => {
    await tx.timeEntry.update({
      where: { id: entry.id },
      data: { endedAt, minutes, note: params.input.note ?? entry.note },
    });

    if (position) {
      await tx.gpsEvent.create({
        data: {
          jobId: job.id,
          employeeId: params.employeeId,
          type: 'CHECK_OUT',
          lat: position.lat,
          lng: position.lng,
          accuracy: params.input.accuracy ?? null,
          distanceM: distanceMeters,
        },
      });
    }

    // Lohnkosten des Einsatzes fortschreiben.
    const rate = toNumber(entry.hourlyRate);
    if (rate > 0) {
      await tx.job.update({
        where: { id: job.id },
        data: { laborCost: { increment: round2((minutes / 60) * rate) } },
      });
    }
  });

  return { minutes, distanceMeters };
}

// ---------------------------------------------------------------------------
//  Abschluss
// ---------------------------------------------------------------------------

export async function completeJob(params: {
  organizationId: string;
  jobId: string;
  employeeId?: string;
  input: CompleteJobInput;
  actorId: string;
}): Promise<Job> {
  const job = await prisma.job.findFirst({
    where: { id: params.jobId, organizationId: params.organizationId, deletedAt: null },
    include: { checklist: true, assignments: true, timeEntries: true },
  });
  if (!job) throw new NotFoundError('Einsatz');

  if (params.employeeId && !job.assignments.some((a) => a.employeeId === params.employeeId)) {
    throw new ForbiddenError('Sie sind diesem Einsatz nicht zugeteilt.');
  }

  const openRequired = job.checklist.filter((item) => item.required && !item.done);
  if (openRequired.length > 0) {
    throw new BusinessRuleError(
      `Es sind noch ${openRequired.length} Pflichtpunkte offen: ${openRequired
        .slice(0, 3)
        .map((i) => i.label)
        .join(', ')}${openRequired.length > 3 ? ' …' : ''}`,
    );
  }

  const materialCost = params.input.materials.reduce(
    (sum, m) => sum + m.quantity * m.unitCost,
    0,
  );

  const updated = await prisma.$transaction(async (tx) => {
    // Offene Zeiterfassungen automatisch schliessen.
    const openEntries = await tx.timeEntry.findMany({
      where: { jobId: job.id, endedAt: null },
    });
    for (const entry of openEntries) {
      const minutes = Math.max(
        0,
        Math.round((Date.now() - entry.startedAt.getTime()) / 60_000) - entry.breakMin,
      );
      await tx.timeEntry.update({
        where: { id: entry.id },
        data: { endedAt: new Date(), minutes },
      });
    }

    if (params.input.materials.length > 0) {
      await tx.materialUsage.createMany({
        data: params.input.materials.map((m) => ({
          jobId: job.id,
          name: m.name,
          sku: m.sku ?? null,
          quantity: m.quantity,
          unit: m.unit,
          unitCost: m.unitCost,
          total: round2(m.quantity * m.unitCost),
          billable: m.billable,
        })),
      });
    }

    const result = await tx.job.update({
      where: { id: job.id },
      data: {
        status: 'COMPLETED',
        actualEnd: new Date(),
        completionNote: params.input.completionNote ?? null,
        signatureDataUrl: params.input.signatureDataUrl ?? null,
        signatureName: params.input.signatureName ?? null,
        signedAt: params.input.signatureDataUrl ? new Date() : null,
        materialCost: { increment: round2(materialCost) },
      },
    });

    // Buchung abschliessen, sobald alle Einsätze erledigt sind.
    if (job.bookingId) {
      const remaining = await tx.job.count({
        where: {
          bookingId: job.bookingId,
          status: { notIn: ['COMPLETED', 'VERIFIED', 'CANCELLED'] },
        },
      });
      if (remaining === 0) {
        await tx.booking.update({
          where: { id: job.bookingId },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
      }
    }

    return result;
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Job',
    entityId: job.id,
    summary: `Einsatz ${job.number} abgeschlossen`,
  });

  return updated;
}

export async function toggleChecklistItem(params: {
  itemId: string;
  employeeId?: string;
  done: boolean;
  note?: string;
}): Promise<void> {
  const item = await prisma.jobChecklistItem.findUnique({
    where: { id: params.itemId },
    include: { job: { include: { assignments: true } } },
  });
  if (!item) throw new NotFoundError('Checklistenpunkt');

  if (params.employeeId && !item.job.assignments.some((a) => a.employeeId === params.employeeId)) {
    throw new ForbiddenError('Sie sind diesem Einsatz nicht zugeteilt.');
  }

  /**
   * Ein abgeschlossener Einsatz ist rapportiert; seine Checkliste ist der
   * Nachweis dessen, was ausgeführt wurde. Nachträglich einen Haken zu setzen
   * hiesse, den Nachweis zu ändern, ohne dass es auffällt.
   */
  if (['COMPLETED', 'VERIFIED', 'CANCELLED'].includes(item.job.status)) {
    throw new BusinessRuleError(
      'Die Checkliste eines abgeschlossenen Einsatzes lässt sich nicht mehr ändern.',
    );
  }

  await prisma.jobChecklistItem.update({
    where: { id: item.id },
    data: {
      done: params.done,
      doneAt: params.done ? new Date() : null,
      doneById: params.done ? (params.employeeId ?? null) : null,
      // `?? item.note` hätte das Löschen einer Notiz unmöglich gemacht: Ein
      // leerer String ist eine Eingabe, `undefined` ist „nicht mitgeschickt".
      ...(params.note !== undefined ? { note: params.note || null } : {}),
    },
  });
}

/**
 * Checkliste eines Einsatzes setzen (Verwaltung).
 *
 * Punkte mit `id` werden aktualisiert, Punkte ohne `id` neu angelegt, nicht
 * genannte Punkte entfernt. Der Erledigt-Zustand hängt an der `id` und überlebt
 * damit eine Umbenennung — würde die Liste stur gelöscht und neu geschrieben,
 * verlöre ein Team mitten im Einsatz seinen Fortschritt, weil das Büro einen
 * Tippfehler korrigiert hat.
 */
export async function replaceChecklist(params: {
  organizationId: string;
  jobId: string;
  input: JobChecklistInput;
  actorId: string;
}): Promise<void> {
  const job = await prisma.job.findFirst({
    where: { id: params.jobId, organizationId: params.organizationId, deletedAt: null },
    include: { checklist: true },
  });
  if (!job) throw new NotFoundError('Einsatz');

  const keptIds = params.input.items
    .map((item) => item.id)
    .filter((id): id is string => Boolean(id));

  // Eine `id`, die nicht zu diesem Einsatz gehört, ist ein Zugriff auf einen
  // fremden Datensatz — nicht bloss eine Fehleingabe.
  const ownIds = new Set(job.checklist.map((item) => item.id));
  if (keptIds.some((id) => !ownIds.has(id))) {
    throw new NotFoundError('Checklistenpunkt');
  }

  await prisma.$transaction(async (tx) => {
    await tx.jobChecklistItem.deleteMany({
      where: { jobId: job.id, id: { notIn: keptIds.length > 0 ? keptIds : ['—'] } },
    });

    for (const [index, item] of params.input.items.entries()) {
      if (item.id) {
        await tx.jobChecklistItem.update({
          where: { id: item.id },
          data: {
            label: item.label,
            room: item.room ?? null,
            required: item.required,
            position: index,
            ...(params.input.keepProgress
              ? {}
              : { done: false, doneAt: null, doneById: null, note: null }),
          },
        });
      } else {
        await tx.jobChecklistItem.create({
          data: {
            jobId: job.id,
            label: item.label,
            room: item.room ?? null,
            required: item.required,
            position: index,
          },
        });
      }
    }
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Job',
    entityId: job.id,
    summary: `Checkliste von Einsatz ${job.number} bearbeitet (${params.input.items.length} Punkte)`,
  });
}

/** Eine Standardcheckliste übernehmen — anhängen oder ersetzen. */
export async function applyChecklistTemplate(params: {
  organizationId: string;
  jobId: string;
  input: JobChecklistTemplateInput;
  actorId: string;
}): Promise<number> {
  const job = await prisma.job.findFirst({
    where: { id: params.jobId, organizationId: params.organizationId, deletedAt: null },
    select: { id: true, number: true },
  });
  if (!job) throw new NotFoundError('Einsatz');

  const template = CHECKLIST_TEMPLATES[params.input.kind];

  const created = await prisma.$transaction(async (tx) => {
    if (params.input.replace) {
      await tx.jobChecklistItem.deleteMany({ where: { jobId: job.id } });
    }

    const offset = params.input.replace
      ? 0
      : await tx.jobChecklistItem.count({ where: { jobId: job.id } });

    await tx.jobChecklistItem.createMany({
      data: template.map((item, index) => ({
        jobId: job.id,
        label: item.label,
        room: item.room ?? null,
        required: true,
        position: offset + index,
      })),
    });

    return template.length;
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Job',
    entityId: job.id,
    summary: `Standardcheckliste auf Einsatz ${job.number} angewendet (${created} Punkte)`,
  });

  return created;
}

/**
 * Team eines Einsatzes setzen — mit Rollen je Person.
 *
 * Benachrichtigt werden nur die *neu* hinzugekommenen Personen. Wer schon
 * eingeteilt war und bleibt, bekommt keine zweite „Neuer Einsatz zugeteilt"-
 * Meldung, nur weil jemand anders dazukam; genau daran gewöhnt man sich ab,
 * die Meldungen zu lesen.
 */
export async function setJobTeam(params: {
  organizationId: string;
  jobId: string;
  input: JobTeamInput;
  actorId: string;
}): Promise<void> {
  const job = await prisma.job.findFirst({
    where: { id: params.jobId, organizationId: params.organizationId, deletedAt: null },
    include: { assignments: true },
  });
  if (!job) throw new NotFoundError('Einsatz');

  if (['COMPLETED', 'VERIFIED'].includes(job.status)) {
    throw new BusinessRuleError(
      'Das Team eines abgeschlossenen Einsatzes lässt sich nicht mehr ändern — daran hängt die Lohnabrechnung.',
    );
  }

  const employeeIds = params.input.members.map((member) => member.employeeId);

  if (employeeIds.length > 0) {
    const known = await prisma.employee.count({
      where: { id: { in: employeeIds }, organizationId: params.organizationId, active: true },
    });
    if (known !== employeeIds.length) throw new NotFoundError('Mitarbeitende');

    // Doppelverplanung erkennen — dieselbe Prüfung wie im Kalender.
    const conflicts = await prisma.jobAssignment.findMany({
      where: {
        employeeId: { in: employeeIds },
        jobId: { not: job.id },
        job: {
          deletedAt: null,
          status: { notIn: ['CANCELLED', 'COMPLETED', 'VERIFIED'] },
          scheduledStart: { lt: job.scheduledEnd },
          scheduledEnd: { gt: job.scheduledStart },
        },
      },
      include: {
        employee: { include: { user: { select: { firstName: true, lastName: true } } } },
        job: { select: { number: true } },
      },
    });

    if (conflicts.length > 0) {
      throw new BusinessRuleError(
        `Terminkonflikt: ${conflicts
          .map(
            (conflict) =>
              `${conflict.employee.user.firstName} ${conflict.employee.user.lastName} ist bereits für ${conflict.job.number} eingeteilt`,
          )
          .join('; ')}.`,
      );
    }
  }

  const before = new Set(job.assignments.map((assignment) => assignment.employeeId));
  const added = employeeIds.filter((id) => !before.has(id));

  await prisma.$transaction(async (tx) => {
    await tx.jobAssignment.deleteMany({
      where: { jobId: job.id, employeeId: { notIn: employeeIds.length > 0 ? employeeIds : ['—'] } },
    });

    for (const member of params.input.members) {
      await tx.jobAssignment.upsert({
        where: { jobId_employeeId: { jobId: job.id, employeeId: member.employeeId } },
        // Die Zusage bleibt beim reinen Rollenwechsel bestehen — sie erneut
        // einzuholen wäre eine unnötige Rückfrage an das Team.
        update: { role: member.role },
        create: {
          jobId: job.id,
          employeeId: member.employeeId,
          role: member.role,
          notifiedAt: params.input.notify ? new Date() : null,
        },
      });
    }

    await tx.job.update({
      where: { id: job.id },
      data: {
        status:
          employeeIds.length === 0
            ? 'UNASSIGNED'
            : job.status === 'UNASSIGNED'
              ? 'SCHEDULED'
              : job.status,
      },
    });
  });

  if (params.input.notify && added.length > 0) {
    await notifyAssignees(job.id, added);
  }

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Job',
    entityId: job.id,
    summary: `Team von Einsatz ${job.number} gesetzt (${employeeIds.length} Person(en))`,
  });
}

/**
 * Nachkalkulation eines Einsatzes.
 *
 * `recalculate` leitet die Zahlen wieder aus den Quellen ab:
 *
 *  • **Lohnkosten** aus den erfassten Zeiten mal dem *gespeicherten* Ansatz der
 *    Zeitbuchung, nicht dem heutigen Ansatz der Person. Eine Lohnerhöhung darf
 *    die Marge eines Einsatzes vom letzten Jahr nicht rückwirkend verschlechtern.
 *  • **Material** aus dem erfassten Verbrauch.
 *  • **Umsatz** aus dem Nettobetrag des Auftrags; hängt kein Auftrag daran,
 *    bleibt der bisherige Wert stehen — eine Null wäre dort eine Behauptung,
 *    keine Rechnung.
 */
export async function updateJobCosting(params: {
  organizationId: string;
  jobId: string;
  input: JobCostingInput;
  actorId: string;
}): Promise<{ revenue: number; laborCost: number; materialCost: number; margin: number }> {
  const job = await prisma.job.findFirst({
    where: { id: params.jobId, organizationId: params.organizationId, deletedAt: null },
    include: {
      timeEntries: { where: { endedAt: { not: null } } },
      materials: true,
      booking: { select: { netTotal: true } },
    },
  });
  if (!job) throw new NotFoundError('Einsatz');

  let revenue = toNumber(job.revenue);
  let laborCost = toNumber(job.laborCost);
  let materialCost = toNumber(job.materialCost);

  if (params.input.recalculate) {
    laborCost = round2(
      job.timeEntries.reduce(
        (sum, entry) => sum + (entry.minutes / 60) * toNumber(entry.hourlyRate),
        0,
      ),
    );
    materialCost = round2(job.materials.reduce((sum, item) => sum + toNumber(item.total), 0));
    if (job.booking) revenue = toNumber(job.booking.netTotal);
  } else {
    if (params.input.revenue !== undefined) revenue = params.input.revenue;
    if (params.input.laborCost !== undefined) laborCost = params.input.laborCost;
    if (params.input.materialCost !== undefined) materialCost = params.input.materialCost;
  }

  if (params.input.approve && !['COMPLETED', 'VERIFIED'].includes(job.status)) {
    throw new BusinessRuleError(
      'Erst abschliessen, dann abnehmen: Eine Nachkalkulation über einen laufenden Einsatz wäre eine Momentaufnahme.',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.job.update({
      where: { id: job.id },
      data: {
        revenue,
        laborCost,
        materialCost,
        ...(params.input.approve ? { status: 'VERIFIED' } : {}),
        ...(params.input.note !== undefined ? { internalNote: params.input.note } : {}),
      },
    });

    await tx.activity.create({
      data: {
        jobId: job.id,
        customerId: job.customerId,
        authorId: params.actorId,
        type: 'SYSTEM',
        subject: params.input.approve
          ? `Nachkalkulation ${job.number} abgenommen`
          : `Nachkalkulation ${job.number} ${params.input.recalculate ? 'neu berechnet' : 'bearbeitet'}`,
        body: `Umsatz ${revenue.toFixed(2)} · Lohn ${laborCost.toFixed(2)} · Material ${materialCost.toFixed(2)} · Deckungsbeitrag ${round2(revenue - laborCost - materialCost).toFixed(2)}`,
      },
    });
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Job',
    entityId: job.id,
    summary: params.input.approve
      ? `Nachkalkulation von Einsatz ${job.number} abgenommen`
      : `Nachkalkulation von Einsatz ${job.number} bearbeitet`,
    changes: {
      revenue: { from: toNumber(job.revenue), to: revenue },
      laborCost: { from: toNumber(job.laborCost), to: laborCost },
      materialCost: { from: toNumber(job.materialCost), to: materialCost },
    },
  });

  return { revenue, laborCost, materialCost, margin: round2(revenue - laborCost - materialCost) };
}

/** Materialverbrauch eines Einsatzes vollständig setzen. */
export async function replaceJobMaterials(params: {
  organizationId: string;
  jobId: string;
  input: JobMaterialsInput;
  actorId: string;
}): Promise<number> {
  const job = await prisma.job.findFirst({
    where: { id: params.jobId, organizationId: params.organizationId, deletedAt: null },
    select: { id: true, number: true },
  });
  if (!job) throw new NotFoundError('Einsatz');

  const materialCost = round2(
    params.input.materials.reduce((sum, item) => sum + item.quantity * item.unitCost, 0),
  );

  await prisma.$transaction(async (tx) => {
    await tx.materialUsage.deleteMany({ where: { jobId: job.id } });
    if (params.input.materials.length > 0) {
      await tx.materialUsage.createMany({
        data: params.input.materials.map((item) => ({
          jobId: job.id,
          name: item.name,
          sku: item.sku ?? null,
          quantity: item.quantity,
          unit: item.unit,
          unitCost: item.unitCost,
          total: round2(item.quantity * item.unitCost),
          billable: item.billable,
        })),
      });
    }

    // Der Materialaufwand in der Nachkalkulation ist die Summe des Verbrauchs —
    // sie hier *nicht* nachzuführen hiesse, dass die Marge nach jeder Korrektur
    // falsch bleibt, bis jemand „neu berechnen" drückt.
    await tx.job.update({ where: { id: job.id }, data: { materialCost } });
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Job',
    entityId: job.id,
    summary: `Material von Einsatz ${job.number} erfasst (${params.input.materials.length} Positionen)`,
  });

  return materialCost;
}

/**
 * Foto eines Einsatzes ändern oder entfernen.
 *
 * Mitarbeitende dürfen die Fotos *ihres* Einsatzes anfassen, solange er läuft;
 * nach dem Abschluss sind die Bilder Teil des Rapports. Die Verwaltung darf
 * jederzeit — sie muss ein versehentlich hochgeladenes Bild auch dann noch
 * entfernen können, wenn es Personen zeigt, die nicht darauf gehören.
 */
export async function assertPhotoAccess(params: {
  organizationId: string;
  photoId: string;
  employeeId?: string;
}) {
  const photo = await prisma.jobPhoto.findFirst({
    where: { id: params.photoId, job: { organizationId: params.organizationId, deletedAt: null } },
    include: { job: { select: { id: true, number: true, status: true, assignments: true } } },
  });
  if (!photo) throw new NotFoundError('Foto');

  if (params.employeeId) {
    if (!photo.job.assignments.some((a) => a.employeeId === params.employeeId)) {
      throw new ForbiddenError('Sie sind diesem Einsatz nicht zugeteilt.');
    }
    if (['COMPLETED', 'VERIFIED', 'CANCELLED'].includes(photo.job.status)) {
      throw new BusinessRuleError(
        'Die Fotos eines abgeschlossenen Einsatzes gehören zum Rapport und bleiben unverändert.',
      );
    }
  }

  return photo;
}

// ---------------------------------------------------------------------------
//  Abfragen
// ---------------------------------------------------------------------------

/** Spalten, nach denen die Einsatzliste sortiert werden darf. */
export const JOB_SORT_FIELDS = [
  'number',
  'title',
  'scheduledStart',
  'status',
  'estimatedMin',
] as const;

export async function listJobs(filter: {
  organizationId: string;
  status?: Job['status'];
  employeeId?: string;
  customerId?: string;
  from?: Date;
  to?: Date;
  q?: string;
  page: number;
  pageSize: number;
  sort?: string;
  order?: SortOrder;
}) {
  const where: Prisma.JobWhereInput = {
    organizationId: filter.organizationId,
    deletedAt: null,
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.customerId ? { customerId: filter.customerId } : {}),
    ...(filter.employeeId ? { assignments: { some: { employeeId: filter.employeeId } } } : {}),
    ...(filter.from || filter.to
      ? {
          scheduledStart: {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lte: filter.to } : {}),
          },
        }
      : {}),
    ...(filter.q
      ? {
          OR: [
            { number: { contains: filter.q, mode: 'insensitive' } },
            { title: { contains: filter.q, mode: 'insensitive' } },
            { customer: { lastName: { contains: filter.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const sorting = resolveSort({ sort: filter.sort, order: filter.order }, JOB_SORT_FIELDS, {
    sort: 'scheduledStart',
    order: 'asc',
  });

  const [items, total] = await Promise.all([
    prisma.job.findMany({
      where,
      orderBy: orderByFor(sorting, 'number'),
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, companyName: true } },
        address: true,
        service: { select: { name: true, kind: true } },
        assignments: {
          include: {
            employee: {
              select: {
                id: true,
                color: true,
                user: { select: { firstName: true, lastName: true, avatarUrl: true } },
              },
            },
          },
        },
        _count: { select: { checklist: true, photos: true } },
      },
    }),
    prisma.job.count({ where }),
  ]);

  return { items, total };
}

export async function getJobDetail(params: {
  organizationId: string;
  jobId: string;
  /** Bei Mitarbeitendenzugriff: erzwingt die Zuteilungsprüfung. */
  employeeId?: string;
}) {
  const job = await prisma.job.findFirst({
    where: {
      id: params.jobId,
      organizationId: params.organizationId,
      deletedAt: null,
      ...(params.employeeId ? { assignments: { some: { employeeId: params.employeeId } } } : {}),
    },
    include: {
      customer: true,
      address: true,
      property: true,
      service: true,
      booking: { select: { id: true, number: true, customerNote: true } },
      checklist: { orderBy: { position: 'asc' } },
      photos: { orderBy: { takenAt: 'desc' } },
      materials: true,
      timeEntries: {
        include: {
          employee: { include: { user: { select: { firstName: true, lastName: true } } } },
        },
        orderBy: { startedAt: 'asc' },
      },
      gpsEvents: { orderBy: { createdAt: 'asc' } },
      assignments: {
        include: {
          employee: {
            include: {
              user: { select: { firstName: true, lastName: true, avatarUrl: true, phone: true } },
            },
          },
        },
      },
      activities: { orderBy: { occurredAt: 'desc' }, take: 30 },
    },
  });

  if (!job) throw new NotFoundError('Einsatz');
  return job;
}

/** Kalenderereignisse für FullCalendar. */
export async function getCalendarJobs(params: {
  organizationId: string;
  from: Date;
  to: Date;
  employeeId?: string;
}) {
  const jobs = await prisma.job.findMany({
    where: {
      organizationId: params.organizationId,
      deletedAt: null,
      scheduledStart: { lt: params.to },
      scheduledEnd: { gt: params.from },
      ...(params.employeeId ? { assignments: { some: { employeeId: params.employeeId } } } : {}),
    },
    include: {
      customer: { select: { firstName: true, lastName: true, companyName: true } },
      address: { select: { street: true, postalCode: true, city: true } },
      service: { select: { name: true, kind: true } },
      assignments: {
        include: {
          employee: {
            select: { id: true, color: true, user: { select: { firstName: true, lastName: true } } },
          },
        },
      },
    },
  });

  const STATUS_COLORS: Record<Job['status'], string> = {
    UNASSIGNED: '#94A3B8',
    SCHEDULED: '#0B7285',
    DISPATCHED: '#1971C2',
    EN_ROUTE: '#5F3DC4',
    IN_PROGRESS: '#E8590C',
    ON_HOLD: '#F59F00',
    COMPLETED: '#2B8A3E',
    VERIFIED: '#0C8599',
    CANCELLED: '#C92A2A',
  };

  return jobs.map((job) => ({
    id: job.id,
    title: `${job.number} · ${job.customer.companyName ?? job.customer.lastName}`,
    start: job.scheduledStart.toISOString(),
    end: job.scheduledEnd.toISOString(),
    backgroundColor: job.color ?? STATUS_COLORS[job.status],
    borderColor: job.color ?? STATUS_COLORS[job.status],
    resourceIds: job.assignments.map((a) => a.employeeId),
    extendedProps: {
      number: job.number,
      status: job.status,
      serviceName: job.service?.name ?? null,
      customerName: job.customer.companyName ?? `${job.customer.firstName} ${job.customer.lastName}`,
      address: job.address
        ? `${job.address.street}, ${job.address.postalCode} ${job.address.city}`
        : null,
      crew: job.assignments.map((a) => `${a.employee.user.firstName} ${a.employee.user.lastName}`),
      crewSize: job.crewSize,
    },
  }));
}

export { CHECKLIST_TEMPLATES };
