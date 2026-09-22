import 'server-only';

import { audit } from '@/lib/audit';
import {
  alsTag,
  plusTage,
  tagSchluessel,
  termine,
  zuercherZeitpunkt,
  type Ausnahme,
  type Serienregel,
  type Termin,
} from '@/lib/contracts/serie';
import { isUniqueConstraintError, prisma } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { ScheduleExceptionInput, ServiceScheduleInput } from '@/lib/validation/contracts';

import { nextNumber } from './numbering.service';

const log = logger('vertragsplan');

/**
 * Einsatzpläne und der Serienplaner.
 *
 * ---------------------------------------------------------------------------
 *  Die eine Zusicherung, an der alles hängt
 * ---------------------------------------------------------------------------
 *
 * **Derselbe Serientermin erzeugt nie zwei Einsätze.** Nicht „sollte nicht",
 * sondern kann nicht: `@@unique([serviceScheduleId, scheduleDate])` steht in
 * der Datenbank. Eine Prüfung im Code allein reichte nicht — zwischen „gibt es
 * schon?" und `INSERT` liegt ein Moment, und zwei gleichzeitige Läufe passen
 * genau hinein. Der Planer *versucht* deshalb anzulegen und wertet einen
 * Verstoss gegen den Index als „war schon da", statt vorher zu fragen.
 *
 * Die Kennung ist der **Serientag**, nicht der tatsächliche Termin. Wird ein
 * Einsatz wegen eines Feiertags verschoben, bleibt der Serientag derselbe —
 * sonst entstünde beim Nachtragen eines Feiertags ein zweiter Einsatz für
 * denselben Termin.
 *
 * ---------------------------------------------------------------------------
 *  Was der Planer nicht tut
 * ---------------------------------------------------------------------------
 *
 * Er disponiert nicht. Ein erzeugter Einsatz ist `UNASSIGNED`; wer ihn
 * übernimmt, entscheidet die Disposition mit ihrer Eignungsprüfung
 * (`assignment.service.ts`). Ein Planer, der nebenbei zuteilt, wäre eine
 * zweite Zuteilungsstelle neben der einen, die es gibt.
 *
 * Er rechnet auch keine Preise. Der Preis steht an der Vertragsversion, und
 * die Abrechnung leitet ihn dort ab (`contractBillingBasis`).
 */

/** Wie weit der nächtliche Lauf vorausplant. */
export const PLANUNGSHORIZONT_TAGE = 60;

// ---------------------------------------------------------------------------
//  Pflege der Pläne
// ---------------------------------------------------------------------------

/**
 * **Ein Einsatzplan gehört zu den Konditionen — also nur an einem Entwurf.**
 *
 * Die Zusicherung „eine geltende Fassung ist unveränderlich" wäre leer, wenn
 * sich die *Frequenz* daneben frei ändern liesse: Ob zweimal oder dreimal
 * wöchentlich gereinigt wird, ist der Kern dessen, was vereinbart wurde, und
 * es bestimmt bei Abrechnung je Einsatz unmittelbar den Preis. Wer hier
 * änderte, hätte einen Vertrag umgeschrieben, ohne dass eine Version
 * entstünde — und niemand könnte später sagen, was ab wann galt.
 *
 * Der Weg für eine echte Änderung ist der vorgesehene: Änderungsantrag →
 * neue Version → aktivieren. Der Weg für einen einzelnen verlegten Termin ist
 * `addScheduleException`, und der bleibt auf einer geltenden Fassung erlaubt:
 * Eine Ausnahme ist ausdrücklich keine Regeländerung.
 *
 * Die **eine** Ausnahme von dieser Regel ist `generatedUntil` — eine
 * Fortschrittsmarke des Planers, kein Teil der Vereinbarung. Sie wird direkt
 * geschrieben und ist unten eigens begründet.
 */
function nurEntwurf(status: string, was: 'anlegen' | 'ändern' | 'entfernen'): void {
  if (status === 'DRAFT') return;
  throw new BusinessRuleError(
    status === 'ACTIVE'
      ? `Der Einsatzplan einer geltenden Vertragsfassung lässt sich nicht ${was}. Die Frequenz ist Teil der Vereinbarung — dafür braucht es eine neue Version. Einen einzelnen Termin verschiebt man über eine Ausnahme.`
      : `Zu einer abgelösten Vertragsversion lässt sich kein Einsatzplan ${was}.`,
  );
}

async function ladeLeistung(organizationId: string, contractServiceId: string) {
  const leistung = await prisma.contractService.findFirst({
    where: {
      id: contractServiceId,
      version: { contract: { organizationId, deletedAt: null } },
    },
    include: { version: { select: { id: true, status: true, contractId: true, versionNumber: true } } },
  });
  if (!leistung) throw new NotFoundError('Vertragsleistung nicht gefunden.');
  return leistung;
}

export async function createSchedule(params: {
  organizationId: string;
  contractServiceId: string;
  actorId: string;
  ip?: string | null;
  input: ServiceScheduleInput;
}) {
  const leistung = await ladeLeistung(params.organizationId, params.contractServiceId);
  nurEntwurf(leistung.version.status, 'anlegen');

  const plan = await prisma.serviceSchedule.create({
    data: {
      contractServiceId: leistung.id,
      frequency: params.input.frequency,
      interval: params.input.interval,
      weekdays: params.input.weekdays,
      monthDay: params.input.monthDay ?? null,
      startMinute: params.input.startMinute,
      endMinute: params.input.endMinute,
      effectiveFrom: params.input.effectiveFrom,
      effectiveUntil: params.input.effectiveUntil ?? null,
      holidayHandling: params.input.holidayHandling,
      active: params.input.active,
    },
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ServiceSchedule',
    entityId: plan.id,
    summary: `Einsatzplan zu „${leistung.label}" angelegt (${params.input.frequency})`,
    ip: params.ip,
  });

  return plan;
}

export async function updateSchedule(params: {
  organizationId: string;
  scheduleId: string;
  actorId: string;
  ip?: string | null;
  input: ServiceScheduleInput;
}) {
  const plan = await ladePlan(params.organizationId, params.scheduleId);
  nurEntwurf(plan.contractService.version.status, 'ändern');

  const aktualisiert = await prisma.serviceSchedule.update({
    where: { id: plan.id },
    data: {
      frequency: params.input.frequency,
      interval: params.input.interval,
      weekdays: params.input.weekdays,
      monthDay: params.input.monthDay ?? null,
      startMinute: params.input.startMinute,
      endMinute: params.input.endMinute,
      effectiveFrom: params.input.effectiveFrom,
      effectiveUntil: params.input.effectiveUntil ?? null,
      holidayHandling: params.input.holidayHandling,
      active: params.input.active,
    },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ServiceSchedule',
    entityId: plan.id,
    summary: 'Einsatzplan geändert',
    changes: params.input,
    ip: params.ip,
  });

  return aktualisiert;
}

export async function deleteSchedule(params: {
  organizationId: string;
  scheduleId: string;
  actorId: string;
  ip?: string | null;
}) {
  const plan = await ladePlan(params.organizationId, params.scheduleId);
  nurEntwurf(plan.contractService.version.status, 'entfernen');

  const bereitsGeplant = await prisma.job.count({ where: { serviceScheduleId: plan.id } });
  if (bereitsGeplant > 0) {
    /**
     * Ein Plan, aus dem Einsätze entstanden sind, wird stillgelegt statt
     * gelöscht. Sonst verlören die Einsätze ihre Herkunft — und die Frage
     * „aus welchem Plan kam dieser Termin" wäre für immer unbeantwortbar.
     */
    const stillgelegt = await prisma.serviceSchedule.update({
      where: { id: plan.id },
      data: { active: false, effectiveUntil: alsTag(new Date()) },
    });
    await audit.updated({
      organizationId: params.organizationId,
      userId: params.actorId,
      entity: 'ServiceSchedule',
      entityId: plan.id,
      summary: `Einsatzplan stillgelegt (${bereitsGeplant} Einsätze hängen daran)`,
      ip: params.ip,
    });
    return stillgelegt;
  }

  await prisma.serviceSchedule.delete({ where: { id: plan.id } });
  await audit.deleted({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ServiceSchedule',
    entityId: plan.id,
    summary: 'Einsatzplan entfernt',
    ip: params.ip,
  });
  return null;
}

async function ladePlan(organizationId: string, scheduleId: string) {
  const plan = await prisma.serviceSchedule.findFirst({
    where: {
      id: scheduleId,
      contractService: { version: { contract: { organizationId, deletedAt: null } } },
    },
    // Der Zustand der Fassung wird immer mitgeladen: Jeder schreibende Weg
    // hierhin muss ihn prüfen, und eine zweite Abfrage dafür wäre eine
    // Gelegenheit, sie zu vergessen.
    include: { contractService: { select: { version: { select: { id: true, status: true } } } } },
  });
  if (!plan) throw new NotFoundError('Einsatzplan nicht gefunden.');
  return plan;
}

export async function addScheduleException(params: {
  organizationId: string;
  scheduleId: string;
  actorId: string;
  ip?: string | null;
  input: ScheduleExceptionInput;
}) {
  const plan = await ladePlan(params.organizationId, params.scheduleId);

  const ausnahme = await prisma.scheduleException.upsert({
    where: {
      serviceScheduleId_originalDate: {
        serviceScheduleId: plan.id,
        originalDate: params.input.originalDate,
      },
    },
    create: {
      serviceScheduleId: plan.id,
      kind: params.input.kind,
      originalDate: params.input.originalDate,
      newDate: params.input.newDate ?? null,
      reason: params.input.reason ?? null,
      createdById: params.actorId,
    },
    update: {
      kind: params.input.kind,
      newDate: params.input.newDate ?? null,
      reason: params.input.reason ?? null,
      createdById: params.actorId,
    },
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ScheduleException',
    entityId: ausnahme.id,
    summary: `Ausnahme ${params.input.kind} am ${tagSchluessel(params.input.originalDate)}`,
    ip: params.ip,
  });

  return ausnahme;
}

// ---------------------------------------------------------------------------
//  Der Planer
// ---------------------------------------------------------------------------

export interface Planungsergebnis {
  contractId: string;
  contractNumber: string | null;
  bis: Date;
  probelauf: boolean;
  /** Tatsächlich angelegte Einsätze. */
  angelegt: number;
  /** Termine, für die es den Einsatz schon gab — der Beweis der Idempotenz. */
  uebersprungen: number;
  /** Termine, die wegen Pause, Ende oder Kündigung entfielen. */
  ausgelassen: number;
  plaene: Array<{
    scheduleId: string;
    leistung: string;
    termine: number;
    angelegt: number;
    uebersprungen: number;
  }>;
}

/**
 * Einsätze aus den Serien eines Vertrags erzeugen.
 *
 * `probelauf` schreibt nichts und liefert dieselbe Auskunft — gedacht für die
 * Oberfläche („was würde passieren"), aber ebenso für die Prüfreihe: Ein
 * Planer, den man nur durch Schreiben befragen kann, lässt sich schlecht
 * prüfen.
 */
export async function generateJobsForContract(params: {
  organizationId: string;
  contractId: string;
  actorId?: string | null;
  ip?: string | null;
  bis: Date;
  probelauf?: boolean;
}): Promise<Planungsergebnis> {
  const vertrag = await prisma.contract.findFirst({
    where: { id: params.contractId, organizationId: params.organizationId, deletedAt: null },
    include: {
      versions: { where: { status: 'ACTIVE' }, include: { services: { include: { schedules: { include: { exceptions: true } } } } } },
      property: { select: { id: true, addressId: true } },
    },
  });
  if (!vertrag) throw new NotFoundError('Vertrag nicht gefunden.');

  const probelauf = params.probelauf ?? false;
  const ergebnis: Planungsergebnis = {
    contractId: vertrag.id,
    contractNumber: vertrag.number,
    bis: alsTag(params.bis),
    probelauf,
    angelegt: 0,
    uebersprungen: 0,
    ausgelassen: 0,
    plaene: [],
  };

  /**
   * Nur ein **aktiver** Vertrag erzeugt Einsätze.
   *
   * Pausiert und gekündigt sind eigene Fälle: Pausiert heisst, es wird in
   * einem Zeitraum nicht geleistet — ein Vertrag, der während einer Pause
   * weiterplant, schickt jemanden vor eine verschlossene Tür. Gekündigt heisst,
   * es wird bis zum Wirkungsdatum geleistet und danach nicht mehr.
   */
  if (vertrag.status === 'PAUSED') return ergebnis;
  if (vertrag.status !== 'ACTIVE' && vertrag.status !== 'NOTICE_GIVEN') return ergebnis;

  const version = vertrag.versions[0];
  if (!version) return ergebnis;

  /** Die harte Obergrenze des Planungsfensters. */
  const grenzen: Date[] = [alsTag(params.bis)];
  if (vertrag.terminationEffectiveAt) grenzen.push(alsTag(vertrag.terminationEffectiveAt));
  if (vertrag.endDate) grenzen.push(alsTag(vertrag.endDate));
  const horizont = grenzen.reduce((a, b) => (a < b ? a : b));

  const feiertage = await ladeFeiertage(params.organizationId, alsTag(vertrag.startDate), horizont);

  for (const leistung of version.services) {
    for (const plan of leistung.schedules) {
      if (!plan.active) continue;

      /**
       * Ab wann geplant wird.
       *
       * `generatedUntil` ist eine Fortschrittsmarke und wandert nur vorwärts.
       * Ohne sie würde jeder Lauf alle vergangenen Termine erneut durchgehen —
       * der Index finge das ab, aber der Lauf wüchse mit der Vertragsdauer.
       */
      const abMarke = plan.generatedUntil ? plusTage(alsTag(plan.generatedUntil), 1) : alsTag(plan.effectiveFrom);
      const von = abMarke > alsTag(plan.effectiveFrom) ? abMarke : alsTag(plan.effectiveFrom);
      if (von > horizont) {
        ergebnis.plaene.push({ scheduleId: plan.id, leistung: leistung.label, termine: 0, angelegt: 0, uebersprungen: 0 });
        continue;
      }

      const regel: Serienregel = {
        frequency: plan.frequency as Serienregel['frequency'],
        interval: plan.interval,
        weekdays: plan.weekdays,
        monthDay: plan.monthDay,
        effectiveFrom: plan.effectiveFrom,
        effectiveUntil: plan.effectiveUntil,
        holidayHandling: plan.holidayHandling,
      };
      const ausnahmen: Ausnahme[] = plan.exceptions.map((a) => ({
        kind: a.kind,
        originalDate: a.originalDate,
        newDate: a.newDate,
      }));

      const alle = termine(regel, von, horizont, feiertage, ausnahmen);
      const offen = alle.filter((termin) => !inPause(termin.datum, vertrag.pausedFrom, vertrag.pausedUntil));
      ergebnis.ausgelassen += alle.length - offen.length;

      let angelegt = 0;
      let uebersprungen = 0;

      for (const termin of offen) {
        if (probelauf) {
          const vorhanden = await prisma.job.count({
            where: { serviceScheduleId: plan.id, scheduleDate: termin.serientag },
          });
          if (vorhanden > 0) uebersprungen += 1;
          else angelegt += 1;
          continue;
        }

        const erzeugt = await einsatzAnlegen({
          organizationId: params.organizationId,
          vertrag: {
            id: vertrag.id,
            customerId: vertrag.customerId,
            propertyId: vertrag.propertyId,
            addressId: vertrag.property?.addressId ?? null,
            title: vertrag.title,
          },
          versionId: version.id,
          leistung: {
            id: leistung.id,
            label: leistung.label,
            serviceId: leistung.serviceId,
            estimatedMinutes: leistung.estimatedMinutes,
            requiredCrewSize: leistung.requiredCrewSize,
            specialInstructions: leistung.specialInstructions,
          },
          plan: { id: plan.id, startMinute: plan.startMinute, endMinute: plan.endMinute },
          termin,
        });
        if (erzeugt) angelegt += 1;
        else uebersprungen += 1;
      }

      if (!probelauf && offen.length > 0) {
        /**
         * **Die eine Schreiboperation auf einer geltenden Fassung.**
         *
         * `generatedUntil` ist kein Teil der Vereinbarung, sondern die
         * Fortschrittsmarke des Planers: bis wohin er gekommen ist. Sie
         * ändert nichts daran, *was* vereinbart wurde, und sie wandert nur
         * vorwärts. Alles andere am Einsatzplan ist auf einer aktiven
         * Fassung gesperrt (`nurEntwurf`); diese Ausnahme steht hier, damit
         * sie beim Lesen nicht wie ein übersehener Fall aussieht.
         */
        await prisma.serviceSchedule.update({
          where: { id: plan.id },
          data: { generatedUntil: horizont },
        });
      }

      ergebnis.angelegt += angelegt;
      ergebnis.uebersprungen += uebersprungen;
      ergebnis.plaene.push({
        scheduleId: plan.id,
        leistung: leistung.label,
        termine: offen.length,
        angelegt,
        uebersprungen,
      });
    }
  }

  if (!probelauf && (ergebnis.angelegt > 0 || ergebnis.uebersprungen > 0)) {
    await audit.created({
      organizationId: params.organizationId,
      userId: params.actorId ?? null,
      entity: 'Contract',
      entityId: vertrag.id,
      summary: `Serienplanung bis ${tagSchluessel(horizont)}: ${ergebnis.angelegt} Einsätze angelegt, ${ergebnis.uebersprungen} bestanden bereits`,
      ip: params.ip,
    });
  }

  return ergebnis;
}

function inPause(tag: Date, von: Date | null, bis: Date | null): boolean {
  if (!von) return false;
  if (tag < alsTag(von)) return false;
  if (bis && tag > alsTag(bis)) return false;
  return true;
}

/**
 * Einen Einsatz anlegen — und einen Verstoss gegen den eindeutigen Index als
 * „gab es schon" werten.
 *
 * Das ist die Stelle, an der die Idempotenz tatsächlich entschieden wird. Der
 * naheliegende Weg wäre `findFirst` und dann `create`; er ist falsch, weil
 * zwei gleichzeitige Läufe beide nichts finden. Hier gewinnt einer, der andere
 * bekommt den Fehler der Datenbank — und den behandeln wir als Ergebnis, nicht
 * als Panne.
 */
async function einsatzAnlegen(params: {
  organizationId: string;
  vertrag: { id: string; customerId: string; propertyId: string | null; addressId: string | null; title: string };
  versionId: string;
  leistung: {
    id: string;
    label: string;
    serviceId: string | null;
    estimatedMinutes: number;
    requiredCrewSize: number;
    specialInstructions: string | null;
  };
  plan: { id: string; startMinute: number; endMinute: number };
  termin: Termin;
}): Promise<boolean> {
  const beginn = zuercherZeitpunkt(params.termin.datum, params.plan.startMinute);
  const ende = zuercherZeitpunkt(params.termin.datum, params.plan.endMinute);

  try {
    await prisma.$transaction(async (tx) => {
      const { number } = await nextNumber(tx, params.organizationId, 'job');
      await tx.job.create({
        data: {
          organizationId: params.organizationId,
          number,
          customerId: params.vertrag.customerId,
          addressId: params.vertrag.addressId,
          propertyId: params.vertrag.propertyId,
          serviceId: params.leistung.serviceId,
          title: `${params.leistung.label} — ${params.vertrag.title}`,
          status: 'UNASSIGNED',
          scheduledStart: beginn,
          scheduledEnd: ende,
          crewSize: params.leistung.requiredCrewSize,
          estimatedMin: params.leistung.estimatedMinutes,
          description: params.leistung.specialInstructions,
          contractId: params.vertrag.id,
          contractVersionId: params.versionId,
          serviceScheduleId: params.plan.id,
          scheduleDate: params.termin.serientag,
        },
      });
    });
    return true;
  } catch (error) {
    if (isUniqueConstraintError(error)) return false;
    log.error('Einsatz aus Serie konnte nicht angelegt werden', {
      scheduleId: params.plan.id,
      serientag: tagSchluessel(params.termin.serientag),
      error,
    });
    throw error;
  }
}

/** Feiertage der Organisation im Fenster, als Menge von `YYYY-MM-DD`. */
async function ladeFeiertage(organizationId: string, von: Date, bis: Date): Promise<Set<string>> {
  const zeilen = await prisma.holiday.findMany({
    where: { organizationId },
    select: { date: true, recurring: true },
  });

  const menge = new Set<string>();
  const vonJahr = von.getUTCFullYear();
  const bisJahr = bis.getUTCFullYear();

  for (const zeile of zeilen) {
    if (!zeile.recurring) {
      const tag = alsTag(zeile.date);
      if (tag >= von && tag <= bis) menge.add(tagSchluessel(tag));
      continue;
    }
    // Jährlich wiederkehrend: derselbe Tag in jedem Jahr des Fensters.
    for (let jahr = vonJahr; jahr <= bisJahr; jahr++) {
      const tag = new Date(Date.UTC(jahr, zeile.date.getUTCMonth(), zeile.date.getUTCDate()));
      if (tag >= von && tag <= bis) menge.add(tagSchluessel(tag));
    }
  }
  return menge;
}

/**
 * Der nächtliche Lauf über alle laufenden Verträge.
 *
 * Fehler eines einzelnen Vertrags beenden den Lauf nicht: Ein kaputter Plan
 * darf nicht dazu führen, dass alle anderen Betriebe ohne Einsätze dastehen.
 * Er wird gezählt, protokolliert und der Lauf geht weiter — dieselbe Haltung
 * wie im Führungs-Nachtlauf.
 */
export async function runContractScheduling(organizationId: string): Promise<{
  vertraege: number;
  angelegt: number;
  fehler: number;
}> {
  const bis = plusTage(alsTag(new Date()), PLANUNGSHORIZONT_TAGE);

  const vertraege = await prisma.contract.findMany({
    where: { organizationId, deletedAt: null, status: { in: ['ACTIVE', 'NOTICE_GIVEN'] } },
    select: { id: true },
  });

  let angelegt = 0;
  let fehler = 0;

  for (const vertrag of vertraege) {
    try {
      const ergebnis = await generateJobsForContract({
        organizationId,
        contractId: vertrag.id,
        bis,
      });
      angelegt += ergebnis.angelegt;
    } catch (error) {
      fehler += 1;
      log.error('Serienplanung eines Vertrags fehlgeschlagen', { contractId: vertrag.id, error });
    }
  }

  return { vertraege: vertraege.length, angelegt, fehler };
}

/**
 * Fristen, die auf jemanden warten.
 *
 * Der Lauf **erinnert**, er handelt nicht: Verlängern, kündigen und Preise
 * anpassen sind Verpflichtungen, und die trifft ein Mensch. Was der Lauf tut,
 * ist, dass niemand eine Frist verpasst, weil sie in keiner Liste stand.
 */
export async function contractDeadlines(organizationId: string, tage = 45) {
  const heute = alsTag(new Date());
  const horizont = plusTage(heute, tage);

  const [fristen, enden, preisPruefungen] = await Promise.all([
    prisma.contract.findMany({
      where: {
        organizationId,
        deletedAt: null,
        status: { in: ['ACTIVE', 'PAUSED'] },
        noticeDeadline: { gte: heute, lte: horizont },
      },
      select: { id: true, number: true, title: true, noticeDeadline: true, customerId: true },
      orderBy: { noticeDeadline: 'asc' },
    }),
    prisma.contract.findMany({
      where: {
        organizationId,
        deletedAt: null,
        status: { in: ['ACTIVE', 'PAUSED', 'NOTICE_GIVEN'] },
        endDate: { gte: heute, lte: horizont },
      },
      select: { id: true, number: true, title: true, endDate: true, customerId: true },
      orderBy: { endDate: 'asc' },
    }),
    prisma.contractVersion.findMany({
      where: {
        status: 'ACTIVE',
        nextReviewAt: { gte: heute, lte: horizont },
        contract: { organizationId, deletedAt: null, status: { in: ['ACTIVE', 'PAUSED'] } },
      },
      select: {
        id: true,
        nextReviewAt: true,
        indexReference: true,
        contract: { select: { id: true, number: true, title: true } },
      },
      orderBy: { nextReviewAt: 'asc' },
    }),
  ]);

  return { kuendigungsfristen: fristen, vertragsenden: enden, preisPruefungen };
}
