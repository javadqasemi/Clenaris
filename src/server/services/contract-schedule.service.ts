import 'server-only';

import type { JobStatus } from '@prisma/client';

import { audit } from '@/lib/audit';
import {
  alsTag,
  plusTage,
  serientage,
  tagSchluessel,
  termine,
  zuercherHeute,
  zuercherZeitpunkt,
  type Ausnahme,
  type Serienregel,
  type Termin,
} from '@/lib/contracts/serie';
import { isUniqueConstraintError, prisma } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { ScheduleExceptionInput, ServiceScheduleInput } from '@/lib/validation/contracts';

import { fassungIstGebunden } from './contract-acceptance.service';
import { nextNumber } from './numbering.service';

const log = logger('vertragsplan');

/**
 * Einsatzpläne und der Serienplaner.
 *
 * ---------------------------------------------------------------------------
 *  Die eine Zusicherung, an der alles hängt
 * ---------------------------------------------------------------------------
 *
 * **Derselbe Serientermin erzeugt nie zwei geltende Einsätze.** Nicht „sollte
 * nicht", sondern kann nicht: Der partielle eindeutige Index
 * `jobs_serientermin_einmal` über `(contractId, seriesKey, scheduleDate)`
 * steht in der Datenbank. Der Planer *versucht* anzulegen und wertet einen
 * Verstoss als „war schon da", statt vorher zu fragen — zwischen „gibt es
 * schon?" und `INSERT` liegt ein Moment, und zwei gleichzeitige Läufe passen
 * genau hinein.
 *
 * Die Kennung ist die **fachliche Serie** (`seriesKey`) und der **Serientag**:
 *
 *  • Die Serie, nicht die Zeile, weil eine neue Vertragsfassung ihre Pläne
 *    kopiert. Bis 2026-09-23 hing die Sperre an `serviceScheduleId` — nach
 *    einem Fassungswechsel hatte derselbe Termin zwei Schlüssel und entstand
 *    zweimal (Audit, RB-003).
 *  • Der Serientag, nicht der tatsächliche Termin: Wird ein Einsatz wegen
 *    eines Feiertags oder einer Ausnahme verschoben, bleibt er derselbe.
 *
 * Abgesagte und gelöschte Einsätze zählen nicht mit. Nach einer Pause oder
 * einer zurückgenommenen Ausnahme lässt sich derselbe Termin wieder anlegen.
 *
 * ---------------------------------------------------------------------------
 *  Nie in die Vergangenheit
 * ---------------------------------------------------------------------------
 *
 * Der Planer legt nichts vor **heute in Zürich** an (`zuercherHeute`). Bis
 * 2026-09-23 plante er ab der Fortschrittsmarke: Nach einer Pause, einer
 * rückdatierten Inkraftsetzung oder einem Fortsetzen entstanden Einsätze für
 * Tage, die vorbei waren — Arbeit, die niemand geleistet hat, als offene
 * Position in der Disposition und als Grundlage einer Abrechnung nach
 * Einsätzen.
 *
 * ---------------------------------------------------------------------------
 *  Was der Planer nicht tut
 * ---------------------------------------------------------------------------
 *
 * Er disponiert nicht. Ein erzeugter Einsatz ist `UNASSIGNED`; wer ihn
 * übernimmt, entscheidet die Disposition mit ihrer Eignungsprüfung
 * (`assignment.service.ts`). Muss der Abgleich einen bereits zugeteilten
 * Einsatz zeitlich verschieben, hebt er die Zuteilung auf, statt sie auf den
 * neuen Termin mitzunehmen — ob die Person dann kann, hat niemand geprüft.
 *
 * Er rechnet auch keine Preise. Der Preis steht an der Vertragsversion, und
 * die Abrechnung leitet ihn dort ab (`contractBillingBasis`).
 */

/** Wie weit der nächtliche Lauf vorausplant. */
export const PLANUNGSHORIZONT_TAGE = 60;

/**
 * Einsätze, die der Abgleich anfassen darf: geplant, aber nicht begonnen.
 *
 * Ab `EN_ROUTE` ist jemand unterwegs; ein Einsatz in Arbeit, abgeschlossen
 * oder kontrolliert ist Geschichte. `ON_HOLD` hat jemand von Hand
 * angehalten — auch das bleibt, wie es ist.
 */
const OFFENE_EINSATZZUSTAENDE: readonly JobStatus[] = ['UNASSIGNED', 'SCHEDULED', 'DISPATCHED'];

// ---------------------------------------------------------------------------
//  Pflege der Pläne
// ---------------------------------------------------------------------------

/**
 * **Ein Einsatzplan gehört zu den Konditionen — also nur an einem freien
 * Entwurf.**
 *
 * Die Zusicherung „eine geltende Fassung ist unveränderlich" wäre leer, wenn
 * sich die *Frequenz* daneben frei ändern liesse: Ob zweimal oder dreimal
 * wöchentlich gereinigt wird, ist der Kern dessen, was vereinbart wurde, und
 * es bestimmt bei Abrechnung je Einsatz unmittelbar den Preis.
 *
 * **Frei** heisst seit 2026-09-23 auch: nicht angenommen und nicht in
 * Unterzeichnung. Der Einsatzplan steht im Snapshot, den die Kundschaft
 * unterschreibt (`renderContractVersionSnapshot`); ihn danach zu ändern hiesse,
 * dass das unterschriebene Dokument eine andere Frequenz zeigt als die
 * Datenbank (RB-006). Dieselbe Regel steht als Trigger
 * `service_schedules_unveraenderlich` in der Datenbank.
 *
 * Der Weg für eine echte Änderung ist der vorgesehene: Änderungsantrag →
 * neue Version → aktivieren. Der Weg für einen einzelnen verlegten Termin ist
 * `addScheduleException`, und der bleibt auf einer geltenden Fassung erlaubt:
 * Eine Ausnahme ist ausdrücklich keine Regeländerung.
 */
async function nurFreierEntwurf(
  version: { id: string; status: string },
  was: 'anlegen' | 'ändern' | 'entfernen',
): Promise<void> {
  if (version.status !== 'DRAFT') {
    throw new BusinessRuleError(
      version.status === 'ACTIVE'
        ? `Der Einsatzplan einer geltenden Vertragsfassung lässt sich nicht ${was}. Die Frequenz ist Teil der Vereinbarung — dafür braucht es eine neue Version. Einen einzelnen Termin verschiebt man über eine Ausnahme.`
        : `Zu einer abgelösten Vertragsversion lässt sich kein Einsatzplan ${was}.`,
    );
  }
  const bindung = await fassungIstGebunden(version.id);
  if (bindung) {
    throw new BusinessRuleError(
      bindung === 'ANGENOMMEN'
        ? `Diese Fassung wurde elektronisch angenommen. Ihr Einsatzplan lässt sich nicht mehr ${was} — er steht im unterschriebenen Dokument. Für eine Änderung braucht es eine neue Version.`
        : `Diese Fassung liegt zur Unterzeichnung vor. Ihr Einsatzplan lässt sich solange nicht ${was}; ziehen Sie den Annahmevorgang zurück, wenn er noch nicht stimmt.`,
    );
  }
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
  await nurFreierEntwurf(leistung.version, 'anlegen');

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
  await nurFreierEntwurf(plan.contractService.version, 'ändern');

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
  await nurFreierEntwurf(plan.contractService.version, 'entfernen');

  // An einem freien Entwurf hängen keine Einsätze: Der Planer liest nur die
  // geltende Fassung. Die Prüfung bleibt trotzdem stehen — ein Plan, aus dem
  // Einsätze entstanden sind, darf seine Herkunft nicht verlieren.
  const bereitsGeplant = await prisma.job.count({ where: { serviceScheduleId: plan.id } });
  if (bereitsGeplant > 0) {
    throw new BusinessRuleError(
      `An diesem Einsatzplan hängen ${bereitsGeplant} Einsätze. Er lässt sich nicht entfernen.`,
    );
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
    include: {
      contractService: {
        select: { version: { select: { id: true, status: true, contractId: true } } },
      },
    },
  });
  if (!plan) throw new NotFoundError('Einsatzplan nicht gefunden.');
  return plan;
}

/**
 * Eine Ausnahme an einem Serientag — und ihre **Wirkung auf bereits geplante
 * Einsätze**.
 *
 * Bis 2026-09-23 wirkte eine Ausnahme nur auf Einsätze, die der Planer noch
 * nicht erzeugt hatte. Der nächtliche Lauf plant 60 Tage voraus; ein
 * `SKIP` für nächsten Donnerstag traf also einen Einsatz, den es längst gab,
 * und blieb ohne Folge (RB-007). Seither gleicht der Dienst die geplanten
 * Einsätze ab dem betroffenen Tag an: abgesagt, verschoben oder ergänzt.
 *
 * Drei Regeln:
 *
 *  • **Nur an der geltenden Fassung.** Eine abgelöste Fassung erzeugt nichts
 *    mehr, eine Ausnahme dort wäre wirkungslos und irreführend. Am Entwurf
 *    ist sie erlaubt: Sie wird beim Fassungswechsel mitgenommen.
 *  • **Nicht rückwirkend.** Ein Tag, der vorbei ist, wird nicht mehr
 *    geplant; eine Ausnahme dafür ändert nichts und würde das Protokoll
 *    verfälschen.
 *  • **Ein Zusatztermin nicht auf einem Serientag.** `EXTRA` trägt als
 *    Kennung seinen eigenen Tag; fiele er auf einen regulären Serientag,
 *    hätten beide denselben Schlüssel, und der zweite ginge still verloren.
 *    Wer an einem Serientag zweimal reinigen will, legt einen Einzeleinsatz
 *    an.
 */
export async function addScheduleException(params: {
  organizationId: string;
  scheduleId: string;
  actorId: string;
  ip?: string | null;
  input: ScheduleExceptionInput;
}) {
  const plan = await ladePlan(params.organizationId, params.scheduleId);
  const fassung = plan.contractService.version;
  if (fassung.status === 'SUPERSEDED') {
    throw new BusinessRuleError(
      'Diese Fassung ist abgelöst und erzeugt keine Einsätze mehr. Eine Ausnahme gehört an die geltende Fassung.',
    );
  }

  const heute = zuercherHeute();
  const betroffen = alsTag(params.input.originalDate);
  if (betroffen < heute || (params.input.newDate && alsTag(params.input.newDate) < heute)) {
    throw new BusinessRuleError('Eine Ausnahme wirkt nur auf heute oder später. Vergangene Termine werden nicht umgeplant.');
  }

  if (params.input.kind === 'EXTRA') {
    const regel = serienregelAus(plan);
    const regulaer = serientage(regel, betroffen, betroffen);
    if (regulaer.length > 0) {
      throw new BusinessRuleError(
        `Am ${tagSchluessel(betroffen)} ist bereits ein Serientermin. Für einen zweiten Einsatz am selben Tag legen Sie einen Einzeleinsatz an.`,
      );
    }
  }

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

  // Die geltende Fassung plant; am Entwurf wird die Ausnahme erst mit dem
  // Fassungswechsel wirksam.
  if (fassung.status === 'ACTIVE') {
    const frueheste = params.input.newDate && alsTag(params.input.newDate) < betroffen ? alsTag(params.input.newDate) : betroffen;
    await einsaetzeAbgleichen({
      organizationId: params.organizationId,
      contractId: fassung.contractId,
      ab: frueheste,
      actorId: params.actorId,
      grund: `Ausnahme ${params.input.kind} am ${tagSchluessel(betroffen)}`,
    });
  }

  return ausnahme;
}

function serienregelAus(plan: {
  frequency: string;
  interval: number;
  weekdays: number[];
  monthDay: number | null;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  holidayHandling: string;
}): Serienregel {
  return {
    frequency: plan.frequency as Serienregel['frequency'],
    interval: plan.interval,
    weekdays: plan.weekdays,
    monthDay: plan.monthDay,
    effectiveFrom: plan.effectiveFrom,
    effectiveUntil: plan.effectiveUntil,
    holidayHandling: plan.holidayHandling as Serienregel['holidayHandling'],
  };
}

// ---------------------------------------------------------------------------
//  Was ein Vertrag an Terminen verlangt
// ---------------------------------------------------------------------------

/** Ein Termin, wie ihn die geltende Fassung verlangt. */
interface Solltermin {
  schluessel: string;
  termin: Termin;
  versionId: string;
  plan: { id: string; seriesKey: string; startMinute: number; endMinute: number };
  leistung: {
    id: string;
    label: string;
    serviceId: string | null;
    estimatedMinutes: number;
    requiredCrewSize: number;
    /** Qualifikationen der Vertragsleistung — der Einsatz übernimmt sie (Zuteilungsprüfung). */
    requiredSkills: string[];
    specialInstructions: string | null;
  };
}

function terminSchluessel(seriesKey: string, serientag: Date): string {
  return `${seriesKey}|${tagSchluessel(serientag)}`;
}

async function ladeVertragFuerPlanung(organizationId: string, contractId: string) {
  const vertrag = await prisma.contract.findFirst({
    where: { id: contractId, organizationId, deletedAt: null },
    include: {
      versions: {
        where: { status: 'ACTIVE' },
        include: { services: { include: { schedules: { include: { exceptions: true } } } } },
      },
      property: { select: { id: true, addressId: true } },
    },
  });
  if (!vertrag) throw new NotFoundError('Vertrag nicht gefunden.');
  return vertrag;
}

type VertragFuerPlanung = Awaited<ReturnType<typeof ladeVertragFuerPlanung>>;

/**
 * Die Solltermine eines Vertrags im Fenster `[von, bis]`.
 *
 * Ein Ort für die Frage „was verlangt der Vertrag an diesem Tag" — der Planer
 * legt fehlende an, der Abgleich prüft vorhandene dagegen. Zwei getrennte
 * Rechnungen wären zwei Antworten auf dieselbe Frage.
 *
 * Nur ein Vertrag, der läuft (aktiv, pausiert, gekündigt), verlangt etwas —
 * und nur ab der **Gültigkeit der geltenden Fassung**. Ohne diese Grenze
 * erzeugte eine Folgefassung auch für Tage, an denen noch ihre Vorgängerin
 * galt. Pausentage und Tage nach Ende oder Kündigungswirkung entfallen.
 */
async function solltermine(
  vertrag: VertragFuerPlanung,
  organizationId: string,
  von: Date,
  bis: Date,
): Promise<{ termine: Map<string, Solltermin>; ausgelassen: number; plaene: Array<{ id: string; label: string; anzahl: number }> }> {
  const ergebnis = new Map<string, Solltermin>();
  const plaeneAuskunft: Array<{ id: string; label: string; anzahl: number }> = [];
  let ausgelassen = 0;

  if (!['ACTIVE', 'PAUSED', 'NOTICE_GIVEN'].includes(vertrag.status)) {
    return { termine: ergebnis, ausgelassen, plaene: plaeneAuskunft };
  }
  const version = vertrag.versions[0];
  if (!version) return { termine: ergebnis, ausgelassen, plaene: plaeneAuskunft };

  const grenzen: Date[] = [alsTag(bis)];
  if (vertrag.terminationEffectiveAt) grenzen.push(alsTag(vertrag.terminationEffectiveAt));
  if (vertrag.endDate) grenzen.push(alsTag(vertrag.endDate));
  if (version.effectiveUntil) grenzen.push(plusTage(alsTag(version.effectiveUntil), -1));
  const obergrenze = grenzen.reduce((a, b) => (a < b ? a : b));
  const untergrenze = [alsTag(von), alsTag(version.effectiveFrom), alsTag(vertrag.startDate)].reduce((a, b) =>
    a > b ? a : b,
  );
  if (obergrenze < untergrenze) return { termine: ergebnis, ausgelassen, plaene: plaeneAuskunft };

  const feiertage = await ladeFeiertage(organizationId, untergrenze, obergrenze);

  for (const leistung of version.services) {
    for (const plan of leistung.schedules) {
      if (!plan.active) continue;
      const ausnahmen: Ausnahme[] = plan.exceptions.map((a) => ({
        kind: a.kind,
        originalDate: a.originalDate,
        newDate: a.newDate,
      }));
      const alle = termine(serienregelAus(plan), untergrenze, obergrenze, feiertage, ausnahmen);
      let anzahl = 0;
      for (const termin of alle) {
        if (inPause(termin.datum, vertrag.pausedFrom, vertrag.pausedUntil)) {
          ausgelassen += 1;
          continue;
        }
        anzahl += 1;
        ergebnis.set(terminSchluessel(plan.seriesKey, termin.serientag), {
          schluessel: terminSchluessel(plan.seriesKey, termin.serientag),
          termin,
          versionId: version.id,
          plan: { id: plan.id, seriesKey: plan.seriesKey, startMinute: plan.startMinute, endMinute: plan.endMinute },
          leistung: {
            id: leistung.id,
            label: leistung.label,
            serviceId: leistung.serviceId,
            estimatedMinutes: leistung.estimatedMinutes,
            requiredCrewSize: leistung.requiredCrewSize,
            requiredSkills: leistung.requiredSkills,
            specialInstructions: leistung.specialInstructions,
          },
        });
      }
      plaeneAuskunft.push({ id: plan.id, label: leistung.label, anzahl });
    }
  }
  return { termine: ergebnis, ausgelassen, plaene: plaeneAuskunft };
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
  /** Termine, die wegen einer Pause entfielen. */
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
 * Einsätze aus den Serien eines Vertrags erzeugen — ab heute, bis `bis`.
 *
 * `probelauf` schreibt nichts und liefert dieselbe Auskunft — gedacht für die
 * Oberfläche („was würde passieren"), aber ebenso für die Prüfreihe: Ein
 * Planer, den man nur durch Schreiben befragen kann, lässt sich schlecht
 * prüfen.
 *
 * **Keine Fortschrittsmarke als Untergrenze mehr.** `generatedUntil` wird
 * weiter geschrieben (Auskunft: bis wohin zuletzt geplant wurde), bestimmt
 * aber nicht mehr, *ab* wann geplant wird. Die Untergrenze ist heute; was es
 * schon gibt, erkennt der eindeutige Index. Eine Marke als Untergrenze war
 * die Ursache zweier Fehler: Eine Folgefassung übernahm eine veraltete Marke
 * (Doppeleinsätze), und nach einer Pause lag die Marke hinter Tagen, die nie
 * geplant worden waren (Lücken).
 */
export async function generateJobsForContract(params: {
  organizationId: string;
  contractId: string;
  actorId?: string | null;
  ip?: string | null;
  bis: Date;
  probelauf?: boolean;
  /** Nur für Prüfungen des Rechenwegs; im Betrieb immer heute in Zürich. */
  heute?: Date;
}): Promise<Planungsergebnis> {
  const vertrag = await ladeVertragFuerPlanung(params.organizationId, params.contractId);
  const probelauf = params.probelauf ?? false;
  const heute = params.heute ?? zuercherHeute();

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

  const soll = await solltermine(vertrag, params.organizationId, heute, params.bis);
  ergebnis.ausgelassen = soll.ausgelassen;

  const jePlan = new Map<string, { angelegt: number; uebersprungen: number }>();
  for (const plan of soll.plaene) jePlan.set(plan.id, { angelegt: 0, uebersprungen: 0 });

  for (const termin of soll.termine.values()) {
    const zaehler = jePlan.get(termin.plan.id)!;
    // Der Serientag liegt ab heute, der tatsächliche Tag kann davor liegen —
    // eine Feiertagsverschiebung „vorher" macht aus dem heutigen Serientag
    // einen Termin gestern. Auch der wird nicht mehr angelegt.
    if (alsTag(termin.termin.datum) < heute) continue;
    if (probelauf) {
      const vorhanden = await prisma.job.count({
        where: {
          contractId: vertrag.id,
          seriesKey: termin.plan.seriesKey,
          scheduleDate: termin.termin.serientag,
          status: { not: 'CANCELLED' },
          deletedAt: null,
        },
      });
      if (vorhanden > 0) zaehler.uebersprungen += 1;
      else zaehler.angelegt += 1;
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
      soll: termin,
    });
    if (erzeugt) zaehler.angelegt += 1;
    else zaehler.uebersprungen += 1;
  }

  for (const plan of soll.plaene) {
    const zaehler = jePlan.get(plan.id)!;
    ergebnis.angelegt += zaehler.angelegt;
    ergebnis.uebersprungen += zaehler.uebersprungen;
    ergebnis.plaene.push({ scheduleId: plan.id, leistung: plan.label, termine: plan.anzahl, ...zaehler });
  }

  if (!probelauf && soll.plaene.length > 0) {
    /**
     * **Die eine Schreiboperation auf einer geltenden Fassung.**
     *
     * `generatedUntil` ist kein Teil der Vereinbarung, sondern eine Auskunft
     * des Planers: bis wohin er zuletzt gekommen ist. Der Trigger
     * `service_schedules_unveraenderlich` lässt genau diese Spalte zu.
     */
    await prisma.serviceSchedule.updateMany({
      where: { id: { in: soll.plaene.map((p) => p.id) } },
      data: { generatedUntil: alsTag(params.bis) },
    });
  }

  if (!probelauf && (ergebnis.angelegt > 0 || ergebnis.uebersprungen > 0)) {
    await audit.created({
      organizationId: params.organizationId,
      userId: params.actorId ?? null,
      entity: 'Contract',
      entityId: vertrag.id,
      summary: `Serienplanung bis ${tagSchluessel(alsTag(params.bis))}: ${ergebnis.angelegt} Einsätze angelegt, ${ergebnis.uebersprungen} bestanden bereits`,
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
  soll: Solltermin;
}): Promise<boolean> {
  const { soll } = params;
  const beginn = zuercherZeitpunkt(soll.termin.datum, soll.plan.startMinute);
  const ende = zuercherZeitpunkt(soll.termin.datum, soll.plan.endMinute);

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
          serviceId: soll.leistung.serviceId,
          title: `${soll.leistung.label} — ${params.vertrag.title}`,
          status: 'UNASSIGNED',
          scheduledStart: beginn,
          scheduledEnd: ende,
          crewSize: soll.leistung.requiredCrewSize,
          estimatedMin: soll.leistung.estimatedMinutes,
          requiredSkills: soll.leistung.requiredSkills,
          description: soll.leistung.specialInstructions,
          contractId: params.vertrag.id,
          contractVersionId: soll.versionId,
          serviceScheduleId: soll.plan.id,
          seriesKey: soll.plan.seriesKey,
          scheduleDate: soll.termin.serientag,
        },
      });
    });
    return true;
  } catch (error) {
    if (isUniqueConstraintError(error)) return false;
    log.error('Einsatz aus Serie konnte nicht angelegt werden', {
      scheduleId: soll.plan.id,
      serientag: tagSchluessel(soll.termin.serientag),
      error,
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
//  Abgleich der geplanten Einsätze
// ---------------------------------------------------------------------------

export interface Abgleichsergebnis {
  /** Einsätze, die der Vertrag an diesem Tag nicht mehr verlangt. */
  abgesagt: number;
  /** Einsätze, die auf eine andere Fassung, eine andere Serie oder eine andere Zeit umgestellt wurden. */
  umgestellt: number;
  /** Davon: Zuteilungen, die dabei aufgehoben wurden, weil sich die Zeit änderte. */
  zuteilungenAufgehoben: number;
  /** Einsätze, die unverändert passten. */
  unveraendert: number;
  /** Neu angelegte Einsätze (aus dem anschliessenden Planerlauf). */
  angelegt: number;
}

/**
 * Die bereits geplanten Einsätze eines Vertrags mit dem abgleichen, was er ab
 * `ab` tatsächlich verlangt.
 *
 * Aufgerufen nach jeder Änderung, die das Soll verschiebt: Fassungswechsel,
 * Ausnahme, Pause, Fortsetzen, Kündigung, Ende. Bis 2026-09-23 wirkten diese
 * Handlungen nur auf Einsätze, die noch nicht erzeugt waren (RB-007).
 *
 * Was mit einem offenen Einsatz geschieht — ausdrücklich und abschliessend:
 *
 *  • **abgesagt** (`CANCELLED`), wenn der Vertrag an diesem Serientag nichts
 *    mehr verlangt: Pause, SKIP, Ende, Kündigungswirkung, eine Folgefassung
 *    ohne diesen Termin.
 *  • **umgestellt**, wenn der Termin weiter verlangt wird, aber unter anderer
 *    Fassung, aus einer kopierten Serie oder zu anderer Zeit (MOVE,
 *    geändertes Zeitfenster). Er behält seine Nummer. Ändert sich die Zeit,
 *    wird eine bestehende Zuteilung aufgehoben — die Eignung für den neuen
 *    Termin prüft die Disposition, nicht der Planer.
 *  • **unverändert**, wenn alles passt.
 *
 * Und was **nie** geschieht: Ein Einsatz vor heute oder einer, der nicht mehr
 * offen ist (unterwegs, in Arbeit, abgeschlossen, kontrolliert, angehalten),
 * wird nicht angefasst. Vergangenheit wird nicht umgeschrieben.
 *
 * Danach legt der Planer an, was fehlt.
 */
export async function einsaetzeAbgleichen(params: {
  organizationId: string;
  contractId: string;
  ab: Date;
  actorId?: string | null;
  ip?: string | null;
  grund: string;
  /** Nur für Prüfungen des Rechenwegs; im Betrieb immer heute in Zürich. */
  heute?: Date;
}): Promise<Abgleichsergebnis> {
  const heute = params.heute ?? zuercherHeute();
  const ab = alsTag(params.ab) > heute ? alsTag(params.ab) : heute;
  const horizont = plusTage(heute, PLANUNGSHORIZONT_TAGE);

  const vertrag = await ladeVertragFuerPlanung(params.organizationId, params.contractId);

  const offen = await prisma.job.findMany({
    where: {
      contractId: vertrag.id,
      seriesKey: { not: null },
      scheduleDate: { gte: ab },
      status: { in: [...OFFENE_EINSATZZUSTAENDE] },
      deletedAt: null,
    },
    select: {
      id: true,
      number: true,
      seriesKey: true,
      scheduleDate: true,
      status: true,
      contractVersionId: true,
      serviceScheduleId: true,
      scheduledStart: true,
      scheduledEnd: true,
      internalNote: true,
      _count: { select: { assignments: true } },
    },
  });

  // Das Fenster reicht bis zum spätesten vorhandenen Einsatz, mindestens bis
  // zum Planungshorizont — sonst blieben weiter vorausgeplante Einsätze
  // ungeprüft.
  const spaetester = offen.reduce<Date>(
    (max, job) => (job.scheduleDate && alsTag(job.scheduleDate) > max ? alsTag(job.scheduleDate) : max),
    horizont,
  );
  // Ein verschobener Termin kann vor seinem Serientag liegen; der Serientag
  // bleibt die Kennung. Das Fenster beginnt deshalb eine Woche früher, damit
  // ein MOVE nach vorn seinen Serientag noch findet.
  const soll = await solltermine(vertrag, params.organizationId, plusTage(ab, -7), plusTage(spaetester, 7));

  const ergebnis: Abgleichsergebnis = { abgesagt: 0, umgestellt: 0, zuteilungenAufgehoben: 0, unveraendert: 0, angelegt: 0 };

  for (const job of offen) {
    const erwartet = soll.termine.get(terminSchluessel(job.seriesKey!, alsTag(job.scheduleDate!)));

    if (!erwartet || alsTag(erwartet.termin.datum) < heute) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'CANCELLED',
          internalNote: anmerkung(job.internalNote, `Abgesagt: ${params.grund}`),
        },
      });
      ergebnis.abgesagt += 1;
      continue;
    }

    const beginn = zuercherZeitpunkt(erwartet.termin.datum, erwartet.plan.startMinute);
    const ende = zuercherZeitpunkt(erwartet.termin.datum, erwartet.plan.endMinute);
    const zeitGeaendert =
      beginn.getTime() !== job.scheduledStart.getTime() || ende.getTime() !== job.scheduledEnd.getTime();
    const herkunftGeaendert =
      job.contractVersionId !== erwartet.versionId || job.serviceScheduleId !== erwartet.plan.id;

    if (!zeitGeaendert && !herkunftGeaendert) {
      ergebnis.unveraendert += 1;
      continue;
    }

    const aufheben = zeitGeaendert && job._count.assignments > 0;
    await prisma.$transaction(async (tx) => {
      if (aufheben) await tx.jobAssignment.deleteMany({ where: { jobId: job.id } });
      await tx.job.update({
        where: { id: job.id },
        data: {
          contractVersionId: erwartet.versionId,
          serviceScheduleId: erwartet.plan.id,
          scheduledStart: beginn,
          scheduledEnd: ende,
          crewSize: erwartet.leistung.requiredCrewSize,
          estimatedMin: erwartet.leistung.estimatedMinutes,
          // Eine neue Fassung kann andere Qualifikationen verlangen; der
          // geplante Einsatz folgt ihr wie bei Dauer und Teamgrösse.
          requiredSkills: erwartet.leistung.requiredSkills,
          ...(aufheben ? { status: 'UNASSIGNED' as const } : {}),
          ...(zeitGeaendert
            ? { internalNote: anmerkung(job.internalNote, `Umgeplant: ${params.grund}`) }
            : {}),
        },
      });
    });
    ergebnis.umgestellt += 1;
    if (aufheben) ergebnis.zuteilungenAufgehoben += 1;
  }

  const planung = await generateJobsForContract({
    organizationId: params.organizationId,
    contractId: vertrag.id,
    actorId: params.actorId,
    ip: params.ip,
    bis: horizont,
    heute,
  });
  ergebnis.angelegt = planung.angelegt;

  if (ergebnis.abgesagt + ergebnis.umgestellt + ergebnis.angelegt > 0) {
    await audit.updated({
      organizationId: params.organizationId,
      userId: params.actorId ?? null,
      entity: 'Contract',
      entityId: vertrag.id,
      summary:
        `Einsätze abgeglichen ab ${tagSchluessel(ab)} (${params.grund}): ` +
        `${ergebnis.abgesagt} abgesagt, ${ergebnis.umgestellt} umgestellt` +
        (ergebnis.zuteilungenAufgehoben > 0 ? ` (${ergebnis.zuteilungenAufgehoben} Zuteilungen aufgehoben)` : '') +
        `, ${ergebnis.angelegt} neu angelegt`,
      ip: params.ip,
    });
  }

  return ergebnis;
}

function anmerkung(bisher: string | null, zusatz: string): string {
  const zeile = `${tagSchluessel(zuercherHeute())} · ${zusatz}`;
  return (bisher ? `${bisher}\n${zeile}` : zeile).slice(-4000);
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
 *
 * **Pausen mit Enddatum laufen von selbst aus.** Bis 2026-09-23 blieb ein
 * Vertrag nach `pausedUntil` pausiert, bis jemand „Fortsetzen" drückte — und
 * der Planer hielt ihn bis dahin für ruhend. Die vereinbarte Pause war also
 * in Wahrheit unbefristet. Jetzt setzt der Lauf den Vertrag am Tag nach dem
 * Pausenende fort, mit Protokolleintrag, und plant ab dann.
 */
export async function runContractScheduling(organizationId: string): Promise<{
  vertraege: number;
  angelegt: number;
  fortgesetzt: number;
  fehler: number;
}> {
  const heute = zuercherHeute();
  const bis = plusTage(heute, PLANUNGSHORIZONT_TAGE);

  const abgelaufen = await prisma.contract.findMany({
    where: { organizationId, deletedAt: null, status: 'PAUSED', pausedUntil: { lt: heute } },
    select: { id: true, number: true, title: true },
  });
  let fortgesetzt = 0;
  for (const vertrag of abgelaufen) {
    const gesetzt = await prisma.contract.updateMany({
      where: { id: vertrag.id, status: 'PAUSED', pausedUntil: { lt: heute } },
      data: { status: 'ACTIVE', pausedFrom: null, pausedUntil: null, pauseReason: null },
    });
    if (gesetzt.count === 1) {
      fortgesetzt += 1;
      await audit.updated({
        organizationId,
        entity: 'Contract',
        entityId: vertrag.id,
        summary: `Vertrag ${vertrag.number ?? vertrag.title}: vereinbarte Pause abgelaufen, automatisch fortgesetzt`,
        changes: { status: { from: 'PAUSED', to: 'ACTIVE' } },
      });
    }
  }

  const vertraege = await prisma.contract.findMany({
    where: { organizationId, deletedAt: null, status: { in: ['ACTIVE', 'PAUSED', 'NOTICE_GIVEN'] } },
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
        heute,
      });
      angelegt += ergebnis.angelegt;
    } catch (error) {
      fehler += 1;
      log.error('Serienplanung eines Vertrags fehlgeschlagen', { contractId: vertrag.id, error });
    }
  }

  return { vertraege: vertraege.length, angelegt, fortgesetzt, fehler };
}

/**
 * Fristen, die auf jemanden warten.
 *
 * Der Lauf **erinnert**, er handelt nicht: Verlängern, kündigen und Preise
 * anpassen sind Verpflichtungen, und die trifft ein Mensch. Was der Lauf tut,
 * ist, dass niemand eine Frist verpasst, weil sie in keiner Liste stand.
 */
export async function contractDeadlines(organizationId: string, tage = 45) {
  // Zürcher Tag statt UTC-Tag (2026-09-27).
  const heute = zuercherHeute();
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
