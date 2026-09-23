import 'server-only';

import type { ComplaintStatus, Prisma } from '@prisma/client';

import { audit } from '@/lib/audit';
import { toDateOnly } from '@/lib/bi/periods';
import { prisma } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import type {
  ComplaintCreateInput,
  ComplaintOwnCreateInput,
  ComplaintTransitionInput,
  ComplaintUpdateInput,
} from '@/lib/validation/betrieb';

import { notify, notifyStaff } from './notification.service';
import { nextNumber } from './numbering.service';

/**
 * Reklamationen und Vorfälle (Wave 11, 2026-09-23).
 *
 * ---------------------------------------------------------------------------
 *  Warum es das braucht
 * ---------------------------------------------------------------------------
 *
 * Seit Wave 10 steht in der Vertragsfassung eine **Reaktionszeit**
 * (`responseHours`) — eine Zusage an die Kundschaft, die nichts im System
 * einlöste: Es gab keine Stelle, an der eine Reklamation ankam, keine Frist,
 * keinen Nachweis, ob sie eingehalten wurde. Eine Zusage ohne Messung ist
 * eine, deren Bruch niemand bemerkt, bis die Kundschaft kündigt.
 *
 * ---------------------------------------------------------------------------
 *  Die Regeln
 * ---------------------------------------------------------------------------
 *
 *  • **Die Frist kommt aus dem Vertrag.** Gesucht wird die Vertragsfassung,
 *    die am Meldetag galt (aktiv oder abgelöst, Gültigkeit überdeckt den
 *    Tag); ihre Reaktionszeit wird als Momentaufnahme übernommen. Ohne
 *    Vertrag oder ohne Zusage steht keine Frist — und die Liste sagt „keine
 *    Zusage", nicht „überfällig".
 *  • **Reaktion = Bestätigung.** Der erste Schritt aus `OPEN` setzt
 *    `acknowledgedAt` — einmal, nie wieder verschoben. Eine Frist, die sich
 *    durch späteres Bestätigen „einhalten" liesse, misst nichts.
 *  • **Der Meldezeitpunkt ist nicht frei.** Nicht in der Zukunft und höchstens
 *    30 Tage zurück; rückdatieren verschöbe die Frist.
 *  • **Kundschaft nur für Eigenes.** Objekt und Einsatz müssen ihr gehören;
 *    die Bedingung steht in der Abfrage (404, nicht 403, für Fremdes).
 *  • **Interne Notiz bleibt intern.** Die Kundensicht wählt Felder aus, statt
 *    sie auszublenden.
 */

const UEBERGAENGE: Record<ComplaintStatus, Partial<Record<ComplaintTransitionInput['action'], ComplaintStatus>>> = {
  OPEN: { ACKNOWLEDGE: 'ACKNOWLEDGED', START: 'IN_PROGRESS', RESOLVE: 'RESOLVED', REJECT: 'REJECTED' },
  ACKNOWLEDGED: { START: 'IN_PROGRESS', RESOLVE: 'RESOLVED', REJECT: 'REJECTED' },
  IN_PROGRESS: { RESOLVE: 'RESOLVED', REJECT: 'REJECTED' },
  RESOLVED: { CLOSE: 'CLOSED', REOPEN: 'IN_PROGRESS' },
  CLOSED: {},
  REJECTED: {},
};

export const STATUS_BESCHRIFTUNG: Record<ComplaintStatus, string> = {
  OPEN: 'Offen',
  ACKNOWLEDGED: 'Bestätigt',
  IN_PROGRESS: 'In Bearbeitung',
  RESOLVED: 'Erledigt',
  CLOSED: 'Abgeschlossen',
  REJECTED: 'Abgelehnt',
};

const OFFEN: ComplaintStatus[] = ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'];

export type FristStand = 'KEINE_ZUSAGE' | 'LAEUFT' | 'EINGEHALTEN' | 'VERPASST';

/** Der Stand der Reaktionsfrist — gerechnet, nie gespeichert. */
export function fristStand(
  c: { responseDueAt: Date | null; acknowledgedAt: Date | null },
  jetzt: Date = new Date(),
): FristStand {
  if (!c.responseDueAt) return 'KEINE_ZUSAGE';
  if (c.acknowledgedAt) return c.acknowledgedAt.getTime() <= c.responseDueAt.getTime() ? 'EINGEHALTEN' : 'VERPASST';
  return jetzt.getTime() > c.responseDueAt.getTime() ? 'VERPASST' : 'LAEUFT';
}

/**
 * Die Vertragsfassung, deren Zusage für eine Meldung gilt.
 *
 *  • Ein ausdrücklich genannter Vertrag geht vor.
 *  • Sonst zählen nur **laufende** Verträge (aktiv oder gekündigt, aber noch
 *    nicht beendet) mit einer Fassung, die am Meldetag gilt. Ein beendeter
 *    Vertrag verspricht nichts mehr — auch wenn seine letzte Fassung kein
 *    Enddatum trägt.
 *  • Objektgebundene Verträge vor allgemeinen.
 *  • Gelten mehrere, gilt die **engste** Zusage (kleinste Reaktionszeit):
 *    Die Kundschaft darf sich auf jede Zusage berufen, die für ihr Objekt
 *    gilt, und der Betrieb misst sich an der strengsten — die weitere zu
 *    nehmen hiesse, eine Zusage stillschweigend zu verwässern.
 */
async function zusageAm(params: {
  organizationId: string;
  customerId: string;
  propertyId: string | null;
  contractId: string | null;
  meldetag: Date;
}): Promise<{ contractId: string | null; versionId: string | null; responseHours: number | null }> {
  const tag = toDateOnly(params.meldetag);
  const vertraege = await prisma.contract.findMany({
    where: {
      organizationId: params.organizationId,
      customerId: params.customerId,
      deletedAt: null,
      ...(params.contractId
        ? { id: params.contractId }
        : {
            status: { in: ['ACTIVE', 'NOTICE_GIVEN'] },
            AND: [
              { OR: [{ terminationEffectiveAt: null }, { terminationEffectiveAt: { gte: tag } }] },
              { OR: [{ endDate: null }, { endDate: { gte: tag } }] },
              ...(params.propertyId ? [{ OR: [{ propertyId: params.propertyId }, { propertyId: null }] }] : []),
            ],
          }),
    },
    select: {
      id: true,
      propertyId: true,
      startDate: true,
      versions: {
        where: {
          status: { in: ['ACTIVE', 'SUPERSEDED'] },
          effectiveFrom: { lte: tag },
          OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: tag } }],
        },
        orderBy: { effectiveFrom: 'desc' },
        take: 1,
        select: { id: true, responseHours: true },
      },
    },
  });
  if (params.contractId && vertraege.length === 0) {
    throw new BusinessRuleError('Der genannte Vertrag gehört nicht zu dieser Kundschaft.');
  }
  const mitFassung = vertraege.filter((v) => v.versions[0]);
  const objektgebunden = params.propertyId ? mitFassung.filter((v) => v.propertyId === params.propertyId) : [];
  const gruppe = objektgebunden.length > 0 ? objektgebunden : mitFassung;
  // Engste Zusage zuerst; ohne Zusage der jüngste Vertrag — dann steht wenigstens der Bezug.
  const gewaehlt = [...gruppe].sort((a, b) => {
    const ha = a.versions[0]!.responseHours ?? Number.POSITIVE_INFINITY;
    const hb = b.versions[0]!.responseHours ?? Number.POSITIVE_INFINITY;
    if (ha !== hb) return ha - hb;
    return b.startDate.getTime() - a.startDate.getTime();
  })[0];
  if (gewaehlt) {
    const fassung = gewaehlt.versions[0]!;
    return { contractId: gewaehlt.id, versionId: fassung.id, responseHours: fassung.responseHours };
  }
  return { contractId: params.contractId ?? null, versionId: null, responseHours: null };
}

async function pruefeZugehoerigkeit(params: {
  organizationId: string;
  customerId: string;
  propertyId?: string | null;
  jobId?: string | null;
}) {
  if (params.propertyId) {
    const objekt = await prisma.property.findFirst({
      where: { id: params.propertyId, customerId: params.customerId, customer: { organizationId: params.organizationId }, deletedAt: null },
      select: { id: true },
    });
    if (!objekt) throw new NotFoundError('Objekt');
  }
  if (params.jobId) {
    const einsatz = await prisma.job.findFirst({
      where: { id: params.jobId, organizationId: params.organizationId, customerId: params.customerId },
      select: { id: true },
    });
    if (!einsatz) throw new NotFoundError('Einsatz');
  }
}

async function anlegen(params: {
  organizationId: string;
  customerId: string;
  propertyId: string | null;
  contractId: string | null;
  jobId: string | null;
  kind: ComplaintCreateInput['kind'];
  severity: ComplaintCreateInput['severity'];
  channel: ComplaintCreateInput['channel'];
  title: string;
  description: string;
  reportedAt: Date;
  assigneeId: string | null;
  reportedByUserId: string;
}) {
  const zusage = await zusageAm({
    organizationId: params.organizationId,
    customerId: params.customerId,
    propertyId: params.propertyId,
    contractId: params.contractId,
    meldetag: params.reportedAt,
  });
  const responseDueAt = zusage.responseHours ? new Date(params.reportedAt.getTime() + zusage.responseHours * 3_600_000) : null;

  return prisma.$transaction(async (tx) => {
    const { number } = await nextNumber(tx, params.organizationId, 'complaint', params.reportedAt);
    return tx.complaint.create({
      data: {
        organizationId: params.organizationId,
        number,
        kind: params.kind,
        severity: params.severity,
        channel: params.channel,
        title: params.title,
        description: params.description,
        customerId: params.customerId,
        propertyId: params.propertyId,
        contractId: zusage.contractId,
        contractVersionId: zusage.versionId,
        jobId: params.jobId,
        reportedAt: params.reportedAt,
        responseHours: zusage.responseHours,
        responseDueAt,
        assigneeId: params.assigneeId,
        reportedByUserId: params.reportedByUserId,
      },
    });
  });
}

/** Erfassen durch den Betrieb. */
export async function createComplaint(params: {
  organizationId: string;
  actorId: string;
  ip?: string | null;
  input: ComplaintCreateInput;
}) {
  const { input } = params;
  const kunde = await prisma.customer.findFirst({
    where: { id: input.customerId, organizationId: params.organizationId },
    select: { id: true },
  });
  if (!kunde) throw new NotFoundError('Kundschaft');
  await pruefeZugehoerigkeit({ organizationId: params.organizationId, customerId: kunde.id, propertyId: input.propertyId, jobId: input.jobId });

  const jetzt = Date.now();
  const gemeldet = input.reportedAt ? new Date(input.reportedAt) : new Date(jetzt);
  if (gemeldet.getTime() > jetzt + 60_000) throw new BusinessRuleError('Der Meldezeitpunkt liegt in der Zukunft.');
  if (gemeldet.getTime() < jetzt - 30 * 86_400_000) {
    throw new BusinessRuleError('Eine Meldung, die älter als 30 Tage ist, wird nicht rückdatiert erfasst — sie verschöbe die Frist.');
  }
  if (input.assigneeId) await pruefeZustaendig(params.organizationId, input.assigneeId);

  const neu = await anlegen({
    organizationId: params.organizationId,
    customerId: kunde.id,
    propertyId: input.propertyId ?? null,
    contractId: input.contractId ?? null,
    jobId: input.jobId ?? null,
    kind: input.kind,
    severity: input.severity,
    channel: input.channel,
    title: input.title,
    description: input.description,
    reportedAt: gemeldet,
    assigneeId: input.assigneeId ?? null,
    reportedByUserId: params.actorId,
  });
  await nachAnlegen(params.organizationId, neu, params.actorId, params.ip);
  return neu;
}

/** Meldung der Kundschaft — nur für eigene Objekte und Einsätze. */
export async function createOwnComplaint(params: {
  organizationId: string;
  customerId: string;
  userId: string;
  ip?: string | null;
  input: ComplaintOwnCreateInput;
}) {
  await pruefeZugehoerigkeit({
    organizationId: params.organizationId,
    customerId: params.customerId,
    propertyId: params.input.propertyId,
    jobId: params.input.jobId,
  });
  const neu = await anlegen({
    organizationId: params.organizationId,
    customerId: params.customerId,
    propertyId: params.input.propertyId ?? null,
    contractId: null,
    jobId: params.input.jobId ?? null,
    kind: params.input.kind,
    severity: 'MEDIUM',
    channel: 'PORTAL',
    title: params.input.title,
    description: params.input.description,
    reportedAt: new Date(),
    assigneeId: null,
    reportedByUserId: params.userId,
  });
  await nachAnlegen(params.organizationId, neu, params.userId, params.ip);
  return kundensicht(neu);
}

async function pruefeZustaendig(organizationId: string, userId: string) {
  const person = await prisma.user.findFirst({
    where: { id: userId, organizationId, role: { in: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] }, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!person) throw new BusinessRuleError('Zuständig kann nur ein aktives Konto der Verwaltung sein.');
}

async function nachAnlegen(
  organizationId: string,
  neu: { id: string; number: string; title: string; responseDueAt: Date | null; assigneeId: string | null },
  actorId: string,
  ip?: string | null,
) {
  await audit.created({
    organizationId,
    userId: actorId,
    entity: 'Complaint',
    entityId: neu.id,
    summary: `Reklamation ${neu.number} erfasst${neu.responseDueAt ? ` — Reaktion bis ${neu.responseDueAt.toISOString()}` : ' — keine vertragliche Reaktionszeit'}`,
    ip,
  });
  const inhalt = {
    title: `Neue Reklamation ${neu.number}`,
    body: neu.responseDueAt
      ? `${neu.title} — Reaktion zugesagt bis ${neu.responseDueAt.toLocaleString('de-CH', { timeZone: 'Europe/Zurich' })}.`
      : neu.title,
    link: `/admin/reklamationen/${neu.id}`,
  };
  if (neu.assigneeId) {
    await notify({ userId: neu.assigneeId, channels: ['IN_APP', 'EMAIL'], ...inhalt, entity: 'Complaint', entityId: neu.id });
  } else {
    await notifyStaff({ organizationId, ...inhalt, permission: 'complaint:update', excludeUserId: actorId });
  }
}

/** Die Felder, die die Kundschaft sieht — ausgewählt, nicht ausgeblendet. */
function kundensicht<T extends { id: string; number: string; kind: string; status: ComplaintStatus; title: string; description: string; reportedAt: Date; responseDueAt: Date | null; acknowledgedAt: Date | null; resolvedAt: Date | null; closedAt: Date | null; resolution: string | null; propertyId: string | null }>(c: T) {
  return {
    id: c.id,
    number: c.number,
    kind: c.kind,
    status: c.status,
    title: c.title,
    description: c.description,
    reportedAt: c.reportedAt,
    responseDueAt: c.responseDueAt,
    acknowledgedAt: c.acknowledgedAt,
    resolvedAt: c.resolvedAt,
    closedAt: c.closedAt,
    resolution: c.resolution,
    propertyId: c.propertyId,
  };
}

const KUNDEN_SELECT = {
  id: true,
  number: true,
  kind: true,
  status: true,
  title: true,
  description: true,
  reportedAt: true,
  responseDueAt: true,
  acknowledgedAt: true,
  resolvedAt: true,
  closedAt: true,
  resolution: true,
  propertyId: true,
} satisfies Prisma.ComplaintSelect;

/** Die eigenen Meldungen der Kundschaft — nur kundensichtbare Felder. */
export async function listOwnComplaints(params: { organizationId: string; customerId: string }) {
  const jetzt = new Date();
  const eintraege = await prisma.complaint.findMany({
    where: { organizationId: params.organizationId, customerId: params.customerId },
    orderBy: { reportedAt: 'desc' },
    take: 200,
    select: KUNDEN_SELECT,
  });
  return eintraege.map((c) => ({ ...c, frist: fristStand(c, jetzt) }));
}

export async function listComplaints(params: {
  organizationId: string;
  customerId?: string;
  status?: ComplaintStatus;
  offen?: boolean;
  ueberfaellig?: boolean;
}) {
  const jetzt = new Date();
  const where: Prisma.ComplaintWhereInput = {
    organizationId: params.organizationId,
    ...(params.customerId ? { customerId: params.customerId } : {}),
    ...(params.status ? { status: params.status } : params.offen ? { status: { in: OFFEN } } : {}),
    ...(params.ueberfaellig ? { acknowledgedAt: null, responseDueAt: { lt: jetzt }, status: { in: OFFEN } } : {}),
  };
  const eintraege = await prisma.complaint.findMany({
    where,
    orderBy: [{ status: 'asc' }, { responseDueAt: 'asc' }, { reportedAt: 'desc' }],
    take: 500,
    include: {
      customer: { select: { id: true, number: true, companyName: true, firstName: true, lastName: true } },
      property: { select: { id: true, label: true } },
      assignee: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  return eintraege.map((c) => ({ ...c, frist: fristStand(c, jetzt) }));
}

/** Eine eigene Meldung — Kundensicht; fremde existieren nicht (404). */
export async function getOwnComplaint(params: { organizationId: string; id: string; customerId: string }) {
  const c = await prisma.complaint.findFirst({
    where: { id: params.id, organizationId: params.organizationId, customerId: params.customerId },
    select: KUNDEN_SELECT,
  });
  if (!c) throw new NotFoundError('Reklamation');
  return { ...c, frist: fristStand(c) };
}

export async function getComplaint(params: { organizationId: string; id: string }) {
  const c = await prisma.complaint.findFirst({
    where: { id: params.id, organizationId: params.organizationId },
    include: {
      customer: { select: { id: true, number: true, companyName: true, firstName: true, lastName: true } },
      property: { select: { id: true, label: true } },
      contract: { select: { id: true, number: true, title: true } },
      job: { select: { id: true, number: true } },
      assignee: { select: { id: true, firstName: true, lastName: true } },
      correctiveAction: { select: { id: true, title: true, completedAt: true, dueOn: true } },
    },
  });
  if (!c) throw new NotFoundError('Reklamation');
  return { ...c, frist: fristStand(c) };
}

export async function updateComplaint(params: {
  organizationId: string;
  id: string;
  actorId: string;
  ip?: string | null;
  input: ComplaintUpdateInput;
}) {
  const vorher = await prisma.complaint.findFirst({ where: { id: params.id, organizationId: params.organizationId } });
  if (!vorher) throw new NotFoundError('Reklamation');
  if (!OFFEN.includes(vorher.status) && (params.input.severity || params.input.title)) {
    throw new BusinessRuleError('Eine erledigte oder abgeschlossene Reklamation wird nicht mehr umgedeutet.');
  }
  if (params.input.assigneeId) await pruefeZustaendig(params.organizationId, params.input.assigneeId);
  const nachher = await prisma.complaint.update({
    where: { id: vorher.id },
    data: {
      ...(params.input.severity ? { severity: params.input.severity } : {}),
      ...(params.input.title ? { title: params.input.title } : {}),
      ...(params.input.assigneeId !== undefined ? { assigneeId: params.input.assigneeId } : {}),
      ...(params.input.internalNote !== undefined ? { internalNote: params.input.internalNote } : {}),
    },
  });
  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Complaint',
    entityId: vorher.id,
    summary: `Reklamation ${vorher.number} geändert`,
    changes: {
      ...(params.input.severity ? { severity: { from: vorher.severity, to: nachher.severity } } : {}),
      ...(params.input.assigneeId !== undefined ? { assigneeId: { from: vorher.assigneeId, to: nachher.assigneeId } } : {}),
    },
    ip: params.ip,
  });
  if (params.input.assigneeId && params.input.assigneeId !== vorher.assigneeId) {
    await notify({
      userId: params.input.assigneeId,
      channels: ['IN_APP'],
      title: `Reklamation ${vorher.number} zugewiesen`,
      body: vorher.title,
      link: `/admin/reklamationen/${vorher.id}`,
      entity: 'Complaint',
      entityId: vorher.id,
    });
  }
  return nachher;
}

/**
 * Ein Statusübergang. Die Bedingung auf den bisherigen Status steht im
 * Schreiben selbst — zwei gleichzeitige Übergänge ergeben keinen dritten
 * Zustand, der zweite bekommt 422.
 */
export async function transitionComplaint(params: {
  organizationId: string;
  id: string;
  actorId: string;
  ip?: string | null;
  input: ComplaintTransitionInput;
}) {
  const vorher = await prisma.complaint.findFirst({ where: { id: params.id, organizationId: params.organizationId } });
  if (!vorher) throw new NotFoundError('Reklamation');
  const ziel = UEBERGAENGE[vorher.status][params.input.action];
  if (!ziel) {
    throw new BusinessRuleError(`Aus „${STATUS_BESCHRIFTUNG[vorher.status]}" ist dieser Schritt nicht möglich.`);
  }
  const jetzt = new Date();
  const data: Prisma.ComplaintUpdateManyMutationInput = { status: ziel };
  // Die Reaktion wird einmal festgehalten — auch wenn der erste Schritt gleich „erledigt" ist.
  if (!vorher.acknowledgedAt && ziel !== 'OPEN') data.acknowledgedAt = jetzt;
  if (ziel === 'RESOLVED') {
    data.resolvedAt = jetzt;
    data.resolution = params.input.resolution!.trim();
  }
  if (ziel === 'REJECTED') {
    data.resolution = params.input.resolution!.trim();
    data.closedAt = jetzt;
  }
  if (ziel === 'CLOSED') data.closedAt = jetzt;
  if (params.input.action === 'REOPEN') {
    data.resolvedAt = null;
  }

  const treffer = await prisma.complaint.updateMany({
    where: { id: vorher.id, status: vorher.status },
    data,
  });
  if (treffer.count === 0) throw new BusinessRuleError('Die Reklamation hat sich eben geändert — bitte neu laden.');

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Complaint',
    entityId: vorher.id,
    summary: `Reklamation ${vorher.number}: ${STATUS_BESCHRIFTUNG[vorher.status]} → ${STATUS_BESCHRIFTUNG[ziel]}`,
    changes: { status: { from: vorher.status, to: ziel } },
    ip: params.ip,
  });

  // Die meldende Kundschaft erfährt Erledigung und Ablehnung.
  if ((ziel === 'RESOLVED' || ziel === 'REJECTED') && vorher.reportedByUserId) {
    const melder = await prisma.user.findUnique({ where: { id: vorher.reportedByUserId }, select: { role: true } });
    if (melder?.role === 'CUSTOMER') {
      await notify({
        userId: vorher.reportedByUserId,
        channels: ['IN_APP', 'EMAIL'],
        title: ziel === 'RESOLVED' ? `Reklamation ${vorher.number} erledigt` : `Reklamation ${vorher.number} abgelehnt`,
        body: params.input.resolution ?? '',
        link: '/konto/reklamationen',
        entity: 'Complaint',
        entityId: vorher.id,
      });
    }
  }
  return prisma.complaint.findUniqueOrThrow({ where: { id: vorher.id } });
}

/**
 * Eine Korrekturmassnahme aus der Reklamation ableiten — die Verbindung zur
 * Qualitätssteuerung der Unternehmensführung. Je Reklamation eine.
 */
export async function createCorrectiveActionFromComplaint(params: {
  organizationId: string;
  id: string;
  actorId: string;
  ip?: string | null;
  input: { title: string; rootCause?: string; dueOn?: string };
}) {
  const c = await prisma.complaint.findFirst({ where: { id: params.id, organizationId: params.organizationId } });
  if (!c) throw new NotFoundError('Reklamation');
  if (c.correctiveActionId) throw new BusinessRuleError('Für diese Reklamation besteht bereits eine Massnahme.');
  const massnahme = await prisma.$transaction(async (tx) => {
    const neu = await tx.correctiveAction.create({
      data: {
        organizationId: params.organizationId,
        kind: 'CORRECTIVE',
        title: params.input.title,
        rootCause: params.input.rootCause ?? null,
        description: `Aus Reklamation ${c.number}: ${c.title}`,
        dueOn: params.input.dueOn ? new Date(`${params.input.dueOn}T00:00:00Z`) : null,
        createdById: params.actorId,
      },
    });
    const gesetzt = await tx.complaint.updateMany({ where: { id: c.id, correctiveActionId: null }, data: { correctiveActionId: neu.id } });
    if (gesetzt.count === 0) throw new BusinessRuleError('Für diese Reklamation besteht bereits eine Massnahme.');
    return neu;
  });
  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'CorrectiveAction',
    entityId: massnahme.id,
    summary: `Massnahme aus Reklamation ${c.number} abgeleitet`,
    ip: params.ip,
  });
  return massnahme;
}

/** Kennzahlen für Übersicht und Cockpit: Anteil fristgerechter Reaktionen. */
export async function complaintSlaSummary(organizationId: string, seit: Date) {
  const faelle = await prisma.complaint.findMany({
    where: { organizationId, reportedAt: { gte: seit }, responseDueAt: { not: null } },
    select: { responseDueAt: true, acknowledgedAt: true },
  });
  const jetzt = new Date();
  const staende = faelle.map((f) => fristStand(f, jetzt));
  const bewertet = staende.filter((s) => s === 'EINGEHALTEN' || s === 'VERPASST');
  return {
    mitZusage: faelle.length,
    eingehalten: staende.filter((s) => s === 'EINGEHALTEN').length,
    verpasst: staende.filter((s) => s === 'VERPASST').length,
    laufend: staende.filter((s) => s === 'LAEUFT').length,
    quotePct: bewertet.length > 0 ? Math.round((staende.filter((s) => s === 'EINGEHALTEN').length / bewertet.length) * 1000) / 10 : null,
  };
}
