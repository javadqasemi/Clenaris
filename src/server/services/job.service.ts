import 'server-only';

import type { Job, Prisma, ServiceKind } from '@prisma/client';

import { prisma, toNumber, type Tx } from '@/lib/db';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '@/lib/errors';
import { absoluteUrl, round2 } from '@/lib/utils';
import { orderByFor, resolveSort, type SortOrder } from '@/lib/sort';
import { haversineMeters } from '@/lib/maps/google';
import { CRYPTO_CONTEXT, decryptNullable } from '@/lib/crypto';
import { jobAssignedEmail } from '@/lib/email/templates';
import { smsTemplates } from '@/lib/sms/client';
import { audit } from '@/lib/audit';
import { emitAutomationTrigger } from './automation-engine.service';
import {
  deriveJobCosts,
  effectiveHourlyRate,
  type JobCostBreakdown,
} from '@/lib/costing/job';
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

import { renderJobReportSnapshot } from '@/lib/pdf/render';

import { nextNumber } from './numbering.service';
import { notify } from './notification.service';
import { invalidateAvailability } from './availability.service';
import { assertAssignable } from './assignment.service';
import {
  HANDOFF_TTL_MS,
  assertRapportNichtEingefroren,
  createHandoffInTx,
  stempelSitzungNeu,
} from './device-handoff.service';
import { assertJobAbnahmefaehig, cancelActiveJobAcceptanceInTx } from './job-acceptance.service';
import {
  createJobAcceptanceRequest,
  findActiveJobAcceptance,
  issueJobAcceptanceSession,
} from './signature.service';
import type { AnfrageKontext } from './signature-events';

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
 *     rückwirkend verändern. Der Ansatz ist der *wirksame* Stundenansatz
 *     (`effectiveHourlyRate`): Stundenlohn, sonst der auf Sollstunden
 *     umgelegte Monatslohn — sonst kosteten Festangestellte nichts.
 *  4. Die Herleitung der Nachkalkulation (`breakdownForJob`) ist eine reine
 *     Funktion in `lib/costing/job.ts`. Die Detailseite zeigt sie, „neu
 *     berechnen" übernimmt sie — beide sehen dieselben Zahlen.
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
  /**
   * Zeilensperre auf der Buchung, bevor gezählt wird.
   *
   * Die Doppelklick-Falle: Zwei gleichzeitige Bestätigungen derselben Buchung
   * lasen beide `count === 0` und legten beide einen Einsatz an. Die
   * Nummernfolge rettete nichts — sie serialisiert erst *nach* der Zählung
   * und vergibt der zweiten Transaktion brav eine eigene Nummer. Herausgekommen
   * wären zwei Einsätze für einen Auftrag, zwei Teams und zwei Rapporte.
   *
   * `FOR UPDATE` sperrt die Buchungszeile bis zum Commit. Die zweite
   * Transaktion wartet, sieht danach `count === 1` und gibt eine leere Liste
   * zurück — dieselbe Antwort, die ein wiederholter Aufruf immer schon
   * bekommen hat. Das ist billiger als eine Eindeutigkeitsbedingung auf
   * `bookingId`, die es verböte, einer Buchung je einen zweiten Einsatz zu
   * geben (Nachbesserung, geteilter Auftrag) — und genau das soll möglich
   * bleiben.
   */
  await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${bookingId} FOR UPDATE`;

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
    /**
     * Die Eignungsprüfung steht innerhalb der Transaktion und vor dem
     * Schreiben. Vorher stand hier nur `assertActiveStaff` — ein Einsatz liess
     * sich also mit einem Team anlegen, dessen Mitglieder in den Ferien oder
     * zur selben Zeit anderswo eingeteilt waren. Über den Kalender war das
     * verboten, über das Formular nicht.
     */
    await assertAssignable(tx, {
      organizationId,
      employeeIds: input.employeeIds,
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
    });

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
    include: { assignments: { select: { employeeId: true } } },
  });
  if (!job) throw new NotFoundError('Einsatz');

  // Der Rapport ist eingefroren, solange die Kundschaft ihn liest (§ 12).
  await assertRapportNichtEingefroren(job.id);

  /**
   * Das Bearbeitungsformular kann den Termin verschieben — dann gilt
   * dieselbe Frage wie im Kalender: Kann das eingeteilte Team zur neuen Zeit?
   * Ohne diese Prüfung wäre das Formular der Umweg um die Regel, die der
   * Kalender durchsetzt.
   *
   * Nur wenn sich eine der beiden Zeiten wirklich ändert; sonst kostet jede
   * Notizänderung zwei überflüssige Abfragen.
   */
  const neuerStart = params.input.scheduledStart ?? job.scheduledStart;
  const neuesEnde = params.input.scheduledEnd ?? job.scheduledEnd;
  const terminVerschoben =
    neuerStart.getTime() !== job.scheduledStart.getTime() ||
    neuesEnde.getTime() !== job.scheduledEnd.getTime();

  if (terminVerschoben && job.assignments.length > 0) {
    await assertAssignable(prisma, {
      organizationId: params.organizationId,
      employeeIds: job.assignments.map((assignment) => assignment.employeeId),
      scheduledStart: neuerStart,
      scheduledEnd: neuesEnde,
      ignoreJobId: job.id,
    });
  }

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
      // Leere Zeichenkette heisst „Feld leeren": Das Bearbeitungsformular
      // schickt sie, wenn jemand eine Notiz löscht. `null` in der Datenbank
      // statt `''`, damit die Anzeige-Bedingungen (`job.internalNote ?`) und
      // die Berichte nicht zwischen zwei Arten von „nichts" unterscheiden müssen.
      ...(params.input.description !== undefined
        ? { description: params.input.description || null }
        : {}),
      ...(params.input.internalNote !== undefined
        ? { internalNote: params.input.internalNote || null }
        : {}),
      ...(params.input.customerNote !== undefined
        ? { customerNote: params.input.customerNote || null }
        : {}),
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
    /**
     * Wer nach dem Verschieben vor der Tür steht, muss zur **neuen** Zeit
     * können.
     *
     * Diese Prüfung fehlte hier vollständig — und das war die grösste Lücke
     * der Disposition: Ein Einsatz liess sich per Ziehen auf einen Tag legen,
     * an dem das eingeteilte Team in den Ferien war oder bereits woanders
     * stand. Die Zuteilung blieb bestehen, niemand widersprach, und der
     * Ausfall fiel am Einsatztag auf.
     *
     * Geprüft wird das Team, das der Einsatz *nachher* hat: entweder die neu
     * gezogene Person allein (die Ressourcenspalte ersetzt das Team) oder das
     * bisherige.
     */
    const teamNachher = params.employeeId
      ? [params.employeeId]
      : job.assignments.map((assignment) => assignment.employeeId);

    await assertAssignable(tx, {
      organizationId: params.organizationId,
      employeeIds: teamNachher,
      scheduledStart: params.scheduledStart,
      scheduledEnd: params.scheduledEnd,
      ignoreJobId: job.id,
    });

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

/**
 * Ob eine Person eingeteilt werden darf, beantwortet seit Phase 2
 * ausschliesslich `assignment.service.ts` — aktives Personal, bewilligte
 * Abwesenheiten, Überschneidungen und hinterlegte Arbeitszeit in einer Regel.
 * Das frühere `assertActiveStaff` prüfte nur den ersten Punkt und stand
 * ausserdem vor der Transaktion, also im Rennen mit dem eigenen Schreibvorgang.
 */
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

  await prisma.$transaction(async (tx) => {
    // Eine Regel für alle fünf Stellen, die ein Team setzen — siehe
    // `assignment.service.ts`. Innerhalb der Transaktion, damit zwischen
    // Prüfen und Schreiben nichts dazwischenkommt.
    await assertAssignable(tx, {
      organizationId: params.organizationId,
      employeeIds: params.employeeIds,
      scheduledStart: job.scheduledStart,
      scheduledEnd: job.scheduledEnd,
      ignoreJobId: job.id,
    });

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

  /**
   * Die Kennungen der zugeteilten Personen gehören in den Eintrag, nicht nur
   * ihre Anzahl.
   *
   * „an 3 Person(en) zugeteilt" beantwortet die Frage nicht, die im Ernstfall
   * gestellt wird: *Wer* war an diesem Tag auf diesem Objekt? Diese Frage
   * stellt sich bei einem Schadenfall, bei einem Schlüsselverlust und bei
   * jeder arbeitsrechtlichen Auseinandersetzung — und die Zuteilung selbst
   * wird beim nächsten Umdisponieren überschrieben (`deleteMany` oben). Ohne
   * die Kennungen im Protokoll ist der frühere Stand danach nicht mehr
   * rekonstruierbar.
   *
   * Kennungen und nicht Namen: Der Name steht in der Personalakte und ändert
   * sich; die Kennung ist stabil und verrät für sich genommen nichts.
   */
  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Job',
    entityId: job.id,
    summary: `Einsatz ${job.number} an ${params.employeeIds.length} Person(en) zugeteilt`,
    changes: { employeeIds: params.employeeIds, role: params.role ?? 'MEMBER' },
  });

  await emitAutomationTrigger({
    organizationId: params.organizationId,
    trigger: 'JOB_ASSIGNED',
    entityId: job.id,
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
    select: { hourlyRate: true, monthlySalary: true },
  });
  // Snapshot des wirksamen Ansatzes — auch für Monatslöhner, deren
  // `hourlyRate` leer ist. Null bleibt null: „kein Ansatz hinterlegt" darf
  // nicht als „kostet nichts" in die Marge fliessen, sondern fällt beim
  // Neuberechnen auf den dann gültigen Ansatz zurück.
  const snapshotRate = effectiveHourlyRate({
    hourlyRate: employee.hourlyRate === null ? null : toNumber(employee.hourlyRate),
    monthlySalary: employee.monthlySalary === null ? null : toNumber(employee.monthlySalary),
  });

  const entry = await prisma.$transaction(async (tx) => {
    const created = await tx.timeEntry.create({
      data: {
        jobId: job.id,
        employeeId: params.employeeId,
        startedAt: new Date(),
        note: params.input.note ?? null,
        hourlyRate: snapshotRate > 0 ? snapshotRate : null,
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

  // Ein zweiter Abschluss während der Kundenabnahme würde genau den Rapport
  // verändern, den die Kundschaft gerade vor sich hat (§ 12).
  await assertRapportNichtEingefroren(job.id);

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

  await emitAutomationTrigger({
    organizationId: params.organizationId,
    trigger: 'JOB_COMPLETED',
    entityId: job.id,
  });

  /**
   * Schliesst der Einsatz die letzte offene Position einer Buchung, gilt auch
   * die Buchung als abgeschlossen — das entscheidet die Transaktion oben. Der
   * Auslöser dazu gehört hierher und nicht dorthin: Innerhalb der Transaktion
   * wäre der neue Zustand für die Maschine nicht sichtbar, und ein zweiter
   * Lauf entsteht durch den Teilindex ohnehin nicht.
   */
  if (job.bookingId) {
    const offen = await prisma.job.count({
      where: {
        bookingId: job.bookingId,
        status: { notIn: ['COMPLETED', 'VERIFIED', 'CANCELLED'] },
      },
    });
    if (offen === 0) {
      await emitAutomationTrigger({
        organizationId: params.organizationId,
        trigger: 'BOOKING_COMPLETED',
        entityId: job.bookingId,
      });
    }
  }

  return updated;
}

// ---------------------------------------------------------------------------
//  Vor-Ort-Abnahme (Gate 4D)
// ---------------------------------------------------------------------------

/**
 * Ist diese Person berechtigt, die Kundenabnahme dieses Einsatzes zu starten?
 *
 * **Nicht nur die Berechtigung zählt.** `job:complete_assigned` sagt „darf
 * zugeteilte Einsätze abschliessen" — welche das sind, sagt sie nicht. Wer
 * das Gerät übergibt, muss diesem Einsatz auch tatsächlich zugeteilt sein;
 * sonst könnte jede Reinigungskraft die Abnahme eines fremden Einsatzes
 * eröffnen und dessen Rapport einfrieren.
 *
 * Die Disposition (`job:update`) darf ohne Zuteilung — das ist die
 * bestehende Regel aus `completeJob` und wird hier nicht neu erfunden.
 */
function assertDarfAbnahmeStarten(
  job: { assignments: { employeeId: string }[] },
  params: { employeeId?: string },
): void {
  if (params.employeeId && !job.assignments.some((a) => a.employeeId === params.employeeId)) {
    throw new ForbiddenError('Sie sind diesem Einsatz nicht zugeteilt.');
  }
}

/**
 * Die Kundenabnahme starten: Rapport einfrieren, Gerät übergeben.
 *
 * **Der Ablauf, und warum in dieser Reihenfolge.** Erst wird der Rapport
 * serverseitig gerendert und abgelegt — die Bytes, die die Kundschaft gleich
 * sieht, stehen fest, bevor irgendjemand etwas übergibt (Hash A). Dann
 * entsteht der Vorgang, dann die Signatursitzung für das Gerät, und ganz
 * zuletzt die Sperre. Andersherum gäbe es einen Moment, in dem das Gerät
 * gesperrt ist, aber noch nichts zu unterschreiben da wäre.
 *
 * **Was der Browser nicht schickt.** Keine Positionen, keine Zeiten, kein
 * PDF, kein HTML, keinen Hash, keinen Teilnehmernamen. Der Server lädt den
 * Einsatz aus der Datenbank und rendert selbst; wer unterzeichnen soll,
 * bestimmt die Kundschaft des Einsatzes. Der Name, den die Person vor Ort
 * eintippt, kommt später und getrennt beim Abschluss an (`signedName`) — er
 * ergänzt den Beweis, er bestimmt ihn nicht.
 *
 * Mehrfaches Tippen erzeugt einen Vorgang, nicht vier: Der Teilindex
 * entscheidet, der Verlierer verwendet den Vorgang des Gewinners weiter.
 */
export async function startCustomerHandoff(params: {
  organizationId: string;
  jobId: string;
  userId: string;
  employeeId?: string;
  sessionFamily: string;
  ctx: AnfrageKontext;
}): Promise<{
  requestId: string;
  publicId: string;
  handoffId: string;
  /** Die Signatursitzung für das Gerät — der Aufrufer setzt daraus das Cookie. */
  sessionToken: string;
}> {
  const job = await prisma.job.findFirst({
    where: { id: params.jobId, organizationId: params.organizationId },
    include: {
      assignments: { select: { employeeId: true } },
      customer: { select: { id: true, firstName: true, lastName: true, companyName: true, email: true } },
    },
  });
  if (!job || job.deletedAt) throw new NotFoundError('Einsatz');

  assertDarfAbnahmeStarten(job, params);
  assertJobAbnahmefaehig(job);

  // Läuft bereits eine Abnahme, wird sie fortgesetzt statt verdoppelt.
  const vorhanden = await findActiveJobAcceptance(job.id);
  if (vorhanden && vorhanden.status === 'FINALIZING') {
    throw new BusinessRuleError('Die Abnahme dieses Einsatzes wird gerade abgeschlossen.');
  }

  const kundenName =
    job.customer.companyName ?? `${job.customer.firstName} ${job.customer.lastName}`.trim();
  const kundenMail = job.customer.email;
  if (!kundenName || !kundenMail) {
    throw new BusinessRuleError(
      'Für diese Kundschaft fehlt ein Name oder eine E-Mail-Adresse — die Abnahme lässt sich nicht zuordnen.',
    );
  }

  const person = await prisma.user.findUniqueOrThrow({
    where: { id: params.userId },
    select: { firstName: true, lastName: true },
  });
  const presenterName = `${person.firstName} ${person.lastName}`.trim();
  const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS);

  let requestId = vorhanden?.id ?? null;
  let publicId = vorhanden?.publicId ?? null;
  let participantId = vorhanden?.participants[0]?.id ?? null;

  if (!requestId) {
    const snapshot = await renderJobReportSnapshot(job.id);
    const angelegt = await createJobAcceptanceRequest({
      job: { id: job.id, organizationId: job.organizationId, number: job.number, title: job.title },
      participant: { name: kundenName, email: kundenMail, customerId: job.customer.id },
      snapshot: { bytes: snapshot.buffer, filename: snapshot.filename },
      expiresAt,
      presenter: { userId: params.userId, name: presenterName, employeeId: params.employeeId ?? null },
      ctx: params.ctx,
    });
    if (angelegt) {
      requestId = angelegt.id;
      publicId = angelegt.publicId;
      participantId = angelegt.participantId;
    } else {
      // Jemand war schneller — dessen Vorgang gilt.
      const gewinner = await findActiveJobAcceptance(job.id);
      requestId = gewinner?.id ?? null;
      publicId = gewinner?.publicId ?? null;
      participantId = gewinner?.participants[0]?.id ?? null;
    }
  }

  if (!requestId || !publicId || !participantId) {
    throw new BusinessRuleError('Die Abnahme konnte nicht begonnen werden. Bitte erneut versuchen.');
  }

  const sitzung = await issueJobAcceptanceSession({
    organizationId: job.organizationId,
    requestId,
    participantId,
    expiresAt,
    presenterUserId: params.userId,
    ctx: params.ctx,
  });

  /**
   * Die Sperre zuletzt — und in einer eigenen Transaktion, damit ein
   * verlorenes Rennen um die Familie (zweiter Tab) nicht den bereits
   * angelegten Vorgang zurückrollt.
   */
  let handoffId: string;
  try {
    handoffId = await prisma.$transaction((tx) =>
      createHandoffInTx(tx, {
        organizationId: job.organizationId,
        userId: params.userId,
        jobId: job.id,
        signatureRequestId: requestId,
        sessionFamily: params.sessionFamily,
        expiresAt,
      }),
    );
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
    const bestehend = await prisma.deviceHandoffSession.findFirstOrThrow({
      where: { sessionFamily: params.sessionFamily, status: 'ACTIVE' },
      select: { id: true },
    });
    handoffId = bestehend.id;
  }

  // Das Zugangstoken trägt die Sperre ab jetzt mit sich.
  await stempelSitzungNeu(params.userId);

  await audit.updated({
    organizationId: job.organizationId,
    userId: params.userId,
    entity: 'Job',
    entityId: job.id,
    summary: `Kundenabnahme für Einsatz ${job.number} begonnen — Gerät übergeben (Vorgang ${requestId})`,
    ip: params.ctx.ip,
    userAgent: params.ctx.userAgent,
  });

  return { requestId, publicId, handoffId, sessionToken: sitzung.sessionToken };
}

/**
 * Eine versehentlich begonnene Abnahme abbrechen — erst nach dem Entsperren.
 *
 * Der Kundschaft wird bewusst **keine** Schaltfläche angeboten, die den
 * Mitarbeiterbereich wieder freigäbe; das wäre die Sperre mit einem Klick
 * daneben. Abbrechen darf nur, wer das Gerät zurückbekommen und sein
 * Passwort bestätigt hat.
 */
export async function cancelCustomerHandoff(params: {
  organizationId: string;
  jobId: string;
  userId: string;
  employeeId?: string;
  ctx: AnfrageKontext;
}): Promise<{ abgebrochen: number }> {
  const job = await prisma.job.findFirst({
    where: { id: params.jobId, organizationId: params.organizationId, deletedAt: null },
    include: { assignments: { select: { employeeId: true } } },
  });
  if (!job) throw new NotFoundError('Einsatz');
  assertDarfAbnahmeStarten(job, params);

  const abgebrochen = await prisma.$transaction((tx) =>
    cancelActiveJobAcceptanceInTx(tx, {
      jobId: job.id,
      reason: 'handoff_cancelled',
      ctx: params.ctx,
      cancelledById: params.userId,
    }),
  );

  if (abgebrochen > 0) {
    await audit.updated({
      organizationId: job.organizationId,
      userId: params.userId,
      entity: 'Job',
      entityId: job.id,
      summary: `Kundenabnahme für Einsatz ${job.number} abgebrochen — Rapport wieder bearbeitbar`,
      ip: params.ctx.ip,
      userAgent: params.ctx.userAgent,
    });
  }

  return { abgebrochen };
}

/** Der Abnahmezustand eines Einsatzes — für Seiten und Masken. */
export async function getJobAcceptanceState(jobId: string) {
  const [aktiv, fertig] = await Promise.all([
    findActiveJobAcceptance(jobId),
    prisma.signatureRequest.findFirst({
      where: { jobId, ceremonyMode: 'IN_PERSON_HANDOFF', status: 'COMPLETED' },
      orderBy: { completedAt: 'desc' },
      include: { participants: { orderBy: { order: 'asc' } } },
    }),
  ]);
  const signer = fertig?.participants[0] ?? null;
  return {
    active: aktiv ? { requestId: aktiv.id, publicId: aktiv.publicId, expiresAt: aktiv.expiresAt } : null,
    completed: fertig
      ? {
          requestId: fertig.id,
          signedName: signer?.signedName ?? signer?.nameSnapshot ?? null,
          method: signer?.signatureMethod ?? null,
          signedAt: signer?.signedAt ?? fertig.completedAt,
          presentedByName: fertig.presentedByName,
          hashes: {
            original: fertig.originalDocumentHash,
            signed: fertig.signedArtifactHash,
            evidence: fertig.evidenceArtifactHash,
          },
        }
      : null,
  };
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

  await assertRapportNichtEingefroren(item.job.id);

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

  await assertRapportNichtEingefroren(job.id);

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

  await assertRapportNichtEingefroren(job.id);

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

  const before = new Set(job.assignments.map((assignment) => assignment.employeeId));
  const added = employeeIds.filter((id) => !before.has(id));

  await prisma.$transaction(async (tx) => {
    // Dieselbe Regel wie in `assignJob` — bis hierher stand hier eine
    // wortgleiche zweite Kopie, die Abwesenheiten ebenso wenig kannte.
    await assertAssignable(tx, {
      organizationId: params.organizationId,
      employeeIds,
      scheduledStart: job.scheduledStart,
      scheduledEnd: job.scheduledEnd,
      ignoreJobId: job.id,
    });

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

/** Was `breakdownForJob` von einem Einsatz braucht — Detailseite und Dienst laden es beide. */
export interface JobForCosting {
  estimatedMin: number;
  travelMin: number;
  assignments: {
    employeeId: string;
    employee: {
      hourlyRate: Prisma.Decimal | null;
      monthlySalary: Prisma.Decimal | null;
      user: { firstName: string; lastName: string };
    };
  }[];
  timeEntries: {
    employeeId: string;
    endedAt: Date | null;
    minutes: number;
    hourlyRate: Prisma.Decimal | null;
    employee: { user: { firstName: string; lastName: string } };
  }[];
  materials: {
    name: string;
    quantity: Prisma.Decimal;
    unit: string;
    unitCost: Prisma.Decimal;
    billable: boolean;
  }[];
  booking: { netTotal: Prisma.Decimal } | null;
}

/**
 * Herleitung der Nachkalkulation aus Team, Zeiterfassung, Material und
 * Auftrag. Rechnet nicht selbst — das tut `deriveJobCosts` — sondern
 * übersetzt nur die Datensätze in Zahlen, damit die Rechnung ohne Prisma
 * prüfbar bleibt.
 */
export function breakdownForJob(job: JobForCosting): JobCostBreakdown {
  const decimalOrNull = (value: Prisma.Decimal | null) =>
    value === null ? null : toNumber(value);

  return deriveJobCosts({
    estimatedMin: job.estimatedMin,
    travelMin: job.travelMin,
    assignments: job.assignments.map((assignment) => ({
      employeeId: assignment.employeeId,
      name: `${assignment.employee.user.firstName} ${assignment.employee.user.lastName}`,
      rate: {
        hourlyRate: decimalOrNull(assignment.employee.hourlyRate),
        monthlySalary: decimalOrNull(assignment.employee.monthlySalary),
      },
    })),
    timeEntries: job.timeEntries
      .filter((entry) => entry.endedAt !== null)
      .map((entry) => ({
        employeeId: entry.employeeId,
        name: `${entry.employee.user.firstName} ${entry.employee.user.lastName}`,
        minutes: entry.minutes,
        hourlyRate: decimalOrNull(entry.hourlyRate),
      })),
    materials: job.materials.map((item) => ({
      name: item.name,
      quantity: toNumber(item.quantity),
      unit: item.unit,
      unitCost: toNumber(item.unitCost),
      billable: item.billable,
    })),
    bookingNet: job.booking ? toNumber(job.booking.netTotal) : null,
  });
}

/**
 * Nachkalkulation eines Einsatzes.
 *
 * `recalculate` leitet die Zahlen wieder aus den Quellen ab (`breakdownForJob`):
 *
 *  • **Lohnkosten** aus den erfassten Zeiten mal dem *gespeicherten* Ansatz der
 *    Zeitbuchung, nicht dem heutigen Ansatz der Person. Eine Lohnerhöhung darf
 *    die Marge eines Einsatzes vom letzten Jahr nicht rückwirkend verschlechtern.
 *    Für eingeteilte Personen ohne erfasste Zeit zählt die geplante Dauer mal
 *    ihrem heutigen Ansatz — sonst hätte ein Einsatz vor der Ausführung
 *    Lohnkosten null und eine Marge von hundert Prozent.
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
      assignments: {
        include: {
          employee: {
            select: {
              hourlyRate: true,
              monthlySalary: true,
              user: { select: { firstName: true, lastName: true } },
            },
          },
        },
      },
      timeEntries: {
        where: { endedAt: { not: null } },
        include: { employee: { select: { user: { select: { firstName: true, lastName: true } } } } },
      },
      materials: true,
      booking: { select: { netTotal: true } },
    },
  });
  if (!job) throw new NotFoundError('Einsatz');

  let revenue = toNumber(job.revenue);
  let laborCost = toNumber(job.laborCost);
  let materialCost = toNumber(job.materialCost);

  if (params.input.recalculate) {
    const breakdown = breakdownForJob(job);
    laborCost = breakdown.laborCost;
    materialCost = breakdown.materialCost;
    if (breakdown.revenue !== null) revenue = breakdown.revenue;
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

  await assertRapportNichtEingefroren(job.id);

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

/**
 * Ein Einsatz mit allem, was seine Detailseite braucht.
 *
 * **Der Alarmcode ist der Sonderfall.** Er liegt verschlüsselt in der Spalte
 * (`src/lib/crypto.ts`) und wird hier entschlüsselt — aber nur, wenn der
 * Aufrufer ihn ausdrücklich anfordert. Das ist Absicht: Vorher zog
 * `property: true` die ganze Zeile samt Chiffrat in jede Antwort, auch dorthin,
 * wo sie nie gebraucht wurde. Ein Chiffrat ist zwar unlesbar, aber es hat in
 * einer Nutzlast nichts verloren, die es nicht braucht — und die
 * Entschlüsselung gehört an eine Stelle, die sie begründen kann, nicht in jede
 * Seite, die sie vergessen könnte.
 *
 * Wer ihn bekommt, entscheidet der Aufrufer über `includeAccessSecrets`; die
 * Zuteilungsschranke steckt bereits in `employeeId`.
 */
export async function getJobDetail(params: {
  organizationId: string;
  jobId: string;
  /** Bei Mitarbeitendenzugriff: erzwingt die Zuteilungsprüfung. */
  employeeId?: string;
  /**
   * Alarmcode entschlüsselt mitliefern. Nur für die Personen setzen, die vor
   * der Tür stehen, und für die Disposition, die ihn pflegt.
   */
  includeAccessSecrets?: boolean;
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
      /**
       * Feldweise statt `true`: Der Alarmcode kommt unten getrennt dazu,
       * damit kein künftiges Feld dieser Tabelle unbemerkt in jede Antwort
       * rutscht.
       */
      property: {
        select: {
          id: true,
          label: true,
          kind: true,
          squareMeters: true,
          rooms: true,
          bathrooms: true,
          windows: true,
          floor: true,
          hasBalcony: true,
          hasGarden: true,
          hasPets: true,
          hasElevator: true,
          parkingInfo: true,
          keyLocation: true,
          accessNote: true,
          notes: true,
        },
      },
      service: true,
      // `netTotal` für die Herleitung der Nachkalkulation (`breakdownForJob`).
      booking: { select: { id: true, number: true, customerNote: true, netTotal: true } },
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

  /**
   * Der Alarmcode wird in einer zweiten, engen Abfrage geholt und sofort
   * entschlüsselt. Getrennt, damit der Klartext nur entsteht, wenn er
   * angefordert wurde — und nie im selben Objekt landet, das ohne Anforderung
   * herausgeht.
   *
   * Er wird bewusst **nicht** protokolliert: Ein Prüfprotokoll, das
   * Zugangsdaten mitschreibt, ist ein zweites Versteck für dieselben
   * Geheimnisse. `src/lib/audit.ts` redigiert das Feld deshalb ohnehin.
   */
  let alarmCode: string | null = null;
  if (params.includeAccessSecrets && job.propertyId) {
    const row = await prisma.property.findUnique({
      where: { id: job.propertyId },
      select: { alarmCode: true },
    });
    alarmCode = decryptNullable(row?.alarmCode ?? null, CRYPTO_CONTEXT.alarmCode);
  }

  return { ...job, alarmCode };
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
