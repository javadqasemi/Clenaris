import 'server-only';

import type { ContractStatus, Prisma } from '@prisma/client';

import { audit } from '@/lib/audit';
import { alsTag, kuendigungsfrist, kuendigungswirkung, plusMonate } from '@/lib/contracts/serie';
import { prisma, toNumber, type Tx } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import type {
  ContractCreateInput,
  ContractServiceInput,
  ContractUpdateInput,
  ContractVersionInput,
} from '@/lib/validation/contracts';

import { nextNumber } from './numbering.service';

/**
 * Verträge — Lebenslauf, Versionen, Leistungsumfang, Änderungen, Preise.
 *
 * ---------------------------------------------------------------------------
 *  Was dieser Dienst durchsetzt
 * ---------------------------------------------------------------------------
 *
 * **1. Ein laufender Vertrag wird nicht umgeschrieben.** Preis, Frequenz,
 * Laufzeit, Zahlungsziel und SLA stehen ausschliesslich in einer
 * `ContractVersion`. Eine aktive Version ist unveränderlich — jeder Versuch
 * endet in einem `BusinessRuleError`. Wer etwas ändern will, legt eine neue
 * Version an, und die trägt eine Begründung.
 *
 * **2. Der Zustand wird nicht gesetzt, sondern erreicht.** Es gibt keinen
 * Endpunkt, der `status` entgegennimmt. Es gibt Handlungen — aktivieren,
 * pausieren, kündigen, beenden —, und jede prüft, ob sie aus dem aktuellen
 * Zustand heraus zulässig ist. Die Tabelle steht unten und ist die einzige
 * Stelle, an der die erlaubten Übergänge stehen.
 *
 * **3. Die Vertragsnummer entsteht beim Aktivieren.** Nicht beim Anlegen —
 * dieselbe Regel wie bei der Rechnung: Ein verworfener Entwurf soll keine
 * Lücke hinterlassen. Sie wird in derselben Transaktion gezogen, in der der
 * Vertrag aktiv wird; scheitert die Aktivierung, ist die Nummer nicht
 * verbraucht.
 *
 * **4. Gelöscht wird nur, was nie gegolten hat.** Ein Vertrag, der je aktiv
 * war, ist ein Beleg — er wird beendet, nicht entfernt. Der Dienst verweigert
 * das Löschen, statt es der Oberfläche zu überlassen.
 *
 * **5. Eine Änderung genehmigt nicht, wer sie beantragt hat.** Das steht als
 * Rechteschnitt in `rbac.ts` (`contract:version` gegen `contract:approve`) und
 * hier als Prüfung: Ein Antrag ohne Antragsteller lässt sich nicht freigeben,
 * und wer freigibt, wird festgehalten.
 */

// ---------------------------------------------------------------------------
//  Zustandsautomat
// ---------------------------------------------------------------------------

/**
 * Die erlaubten Übergänge — an **einer** Stelle.
 *
 * Verstreute `if`-Prüfungen in den einzelnen Handlungen wären dasselbe in
 * unübersichtlich: Man sieht dann nie, welche Wege es gibt, und ein
 * vergessener Fall ist ein Weg, den niemand beabsichtigt hat. Diese Tabelle
 * ist auch das, was die Prüfreihe abfragt.
 */
export const ERLAUBTE_UEBERGAENGE: Record<ContractStatus, readonly ContractStatus[]> = {
  DRAFT: ['IN_REVIEW', 'OFFERED', 'ACTIVE', 'CANCELLED'],
  IN_REVIEW: ['DRAFT', 'OFFERED', 'ACTIVE', 'CANCELLED'],
  OFFERED: ['ACTIVE', 'IN_REVIEW', 'CANCELLED'],
  ACTIVE: ['PAUSED', 'NOTICE_GIVEN', 'ENDED'],
  PAUSED: ['ACTIVE', 'NOTICE_GIVEN', 'ENDED'],
  NOTICE_GIVEN: ['ENDED', 'ACTIVE'],
  /** Endzustände. Ein beendeter Vertrag wird nicht wiederbelebt — es entsteht ein neuer. */
  ENDED: [],
  CANCELLED: [],
};

/** Zustände, ab denen ein Vertrag als Beleg gilt und nicht mehr löschbar ist. */
const BELEGZUSTAENDE: readonly ContractStatus[] = ['ACTIVE', 'PAUSED', 'NOTICE_GIVEN', 'ENDED'];

function pruefeUebergang(von: ContractStatus, nach: ContractStatus): void {
  if (von === nach) {
    throw new BusinessRuleError(`Der Vertrag ist bereits im Zustand „${zustandsname(von)}".`);
  }
  if (!ERLAUBTE_UEBERGAENGE[von].includes(nach)) {
    throw new BusinessRuleError(
      `Aus „${zustandsname(von)}" ist „${zustandsname(nach)}" nicht möglich.`,
    );
  }
}

const ZUSTANDSNAMEN: Record<ContractStatus, string> = {
  DRAFT: 'Entwurf',
  IN_REVIEW: 'In Prüfung',
  OFFERED: 'Offeriert',
  ACTIVE: 'Aktiv',
  PAUSED: 'Pausiert',
  NOTICE_GIVEN: 'Gekündigt',
  ENDED: 'Beendet',
  CANCELLED: 'Storniert',
};

export function zustandsname(status: ContractStatus): string {
  return ZUSTANDSNAMEN[status];
}

// ---------------------------------------------------------------------------
//  Laden
// ---------------------------------------------------------------------------

/**
 * Die Sichtbarkeit steckt in der `where`-Klausel, nicht in der Anzeige.
 *
 * `contract:read_own` haben Kundinnen und Kunden; ohne diese Einschränkung
 * sähe eine Kundschaft über die Schnittstelle jeden Vertrag der Firma. Die
 * Regel aus `CLAUDE.md`: verstecktes HTML ist auf der Leitung trotzdem
 * sichtbar.
 */
export function contractVisibilityWhere(params: {
  organizationId: string;
  /** Gesetzt, wenn die anfragende Person nur die eigenen Verträge sehen darf. */
  nurKundeId?: string | null;
}): Prisma.ContractWhereInput {
  return {
    organizationId: params.organizationId,
    deletedAt: null,
    ...(params.nurKundeId ? { customerId: params.nurKundeId } : {}),
  };
}

async function ladeVertrag(organizationId: string, contractId: string) {
  const vertrag = await prisma.contract.findFirst({
    where: { id: contractId, organizationId, deletedAt: null },
    include: {
      versions: { orderBy: { versionNumber: 'desc' } },
    },
  });
  if (!vertrag) throw new NotFoundError('Vertrag nicht gefunden.');
  return vertrag;
}

/** Die geltende Fassung — oder der jüngste Entwurf, solange keine gilt. */
export function aktiveVersion<T extends { status: string; versionNumber: number }>(
  versionen: readonly T[],
): T | null {
  return versionen.find((v) => v.status === 'ACTIVE') ?? null;
}

// ---------------------------------------------------------------------------
//  Anlegen und ändern
// ---------------------------------------------------------------------------

export async function createContract(params: {
  organizationId: string;
  actorId: string;
  ip?: string | null;
  input: ContractCreateInput;
  /** Die Konditionen der ersten Fassung. */
  version: ContractVersionInput;
  services?: ContractServiceInput[];
}) {
  const kunde = await prisma.customer.findFirst({
    where: { id: params.input.customerId, organizationId: params.organizationId, deletedAt: null },
    select: { id: true },
  });
  if (!kunde) throw new NotFoundError('Kundschaft nicht gefunden.');

  if (params.input.quoteId) {
    const offerte = await prisma.quote.findFirst({
      where: { id: params.input.quoteId, organizationId: params.organizationId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!offerte) throw new NotFoundError('Offerte nicht gefunden.');
    /**
     * Nur aus einer **angenommenen** Offerte.
     *
     * Ein Vertrag aus einem Entwurf hiesse: Die Firma hält etwas fest, dem
     * niemand zugestimmt hat. Wer ohne Offerte arbeitet, legt den Vertrag
     * ohne `quoteId` an — das ist der ehrliche Weg und ausdrücklich erlaubt.
     */
    if (offerte.status !== 'ACCEPTED') {
      throw new BusinessRuleError(
        'Ein Vertrag entsteht nur aus einer angenommenen Offerte. Diese Offerte ist noch nicht angenommen.',
      );
    }
  }

  const vertrag = await prisma.$transaction(async (tx) => {
    const angelegt = await tx.contract.create({
      data: {
        organizationId: params.organizationId,
        customerId: params.input.customerId,
        propertyId: params.input.propertyId ?? null,
        quoteId: params.input.quoteId ?? null,
        title: params.input.title,
        description: params.input.description ?? null,
        startDate: params.input.startDate,
        endDate: params.input.endDate ?? null,
        responsibleEmployeeId: params.input.responsibleEmployeeId ?? null,
        salesOwnerId: params.input.salesOwnerId ?? null,
        serviceManagerId: params.input.serviceManagerId ?? null,
        costCenter: params.input.costCenter ?? null,
        internalNote: params.input.internalNote ?? null,
        createdById: params.actorId,
      },
    });

    await versionAnlegen(tx, {
      contractId: angelegt.id,
      versionNumber: 1,
      createdById: params.actorId,
      input: params.version,
      services: params.services ?? [],
    });

    return angelegt;
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Contract',
    entityId: vertrag.id,
    summary: `Vertrag „${vertrag.title}" als Entwurf angelegt`,
    ip: params.ip,
  });

  return vertrag;
}

export async function updateContract(params: {
  organizationId: string;
  contractId: string;
  actorId: string;
  ip?: string | null;
  input: ContractUpdateInput;
}) {
  const vorher = await ladeVertrag(params.organizationId, params.contractId);

  const aktualisiert = await prisma.contract.update({
    where: { id: vorher.id },
    data: {
      ...(params.input.title !== undefined ? { title: params.input.title } : {}),
      ...(params.input.description !== undefined ? { description: params.input.description ?? null } : {}),
      ...(params.input.propertyId !== undefined ? { propertyId: params.input.propertyId ?? null } : {}),
      ...(params.input.responsibleEmployeeId !== undefined
        ? { responsibleEmployeeId: params.input.responsibleEmployeeId ?? null }
        : {}),
      ...(params.input.salesOwnerId !== undefined ? { salesOwnerId: params.input.salesOwnerId ?? null } : {}),
      ...(params.input.serviceManagerId !== undefined
        ? { serviceManagerId: params.input.serviceManagerId ?? null }
        : {}),
      ...(params.input.costCenter !== undefined ? { costCenter: params.input.costCenter ?? null } : {}),
      ...(params.input.internalNote !== undefined ? { internalNote: params.input.internalNote ?? null } : {}),
    },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Contract',
    entityId: aktualisiert.id,
    summary: `Vertrag „${aktualisiert.title}" geändert`,
    changes: params.input,
    ip: params.ip,
  });

  return aktualisiert;
}

export async function deleteContractDraft(params: {
  organizationId: string;
  contractId: string;
  actorId: string;
  ip?: string | null;
}) {
  const vertrag = await ladeVertrag(params.organizationId, params.contractId);

  if (BELEGZUSTAENDE.includes(vertrag.status)) {
    throw new BusinessRuleError(
      'Ein Vertrag, der in Kraft war, lässt sich nicht löschen. Beenden Sie ihn stattdessen — er bleibt als Beleg bestehen.',
    );
  }

  await prisma.contract.update({
    where: { id: vertrag.id },
    data: { deletedAt: new Date() },
  });

  await audit.deleted({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Contract',
    entityId: vertrag.id,
    summary: `Vertragsentwurf „${vertrag.title}" verworfen`,
    ip: params.ip,
  });
}

// ---------------------------------------------------------------------------
//  Versionen
// ---------------------------------------------------------------------------

/** Legt eine Version samt Leistungen an — innerhalb einer Transaktion. */
async function versionAnlegen(
  tx: Tx,
  params: {
    contractId: string;
    versionNumber: number;
    createdById: string;
    input: ContractVersionInput;
    services: ContractServiceInput[];
  },
) {
  const version = await tx.contractVersion.create({
    data: {
      contractId: params.contractId,
      versionNumber: params.versionNumber,
      status: 'DRAFT',
      effectiveFrom: params.input.effectiveFrom,
      reason: params.input.reason,
      minimumTermMonths: params.input.minimumTermMonths ?? null,
      renewalType: params.input.renewalType,
      renewalPeriodMonths: params.input.renewalPeriodMonths ?? null,
      noticePeriodDays: params.input.noticePeriodDays,
      billingCycle: params.input.billingCycle,
      paymentTermDays: params.input.paymentTermDays,
      currency: params.input.currency,
      pricingModel: params.input.pricingModel,
      baseAmount: params.input.baseAmount,
      hourlyRate: params.input.hourlyRate ?? null,
      unitPrice: params.input.unitPrice ?? null,
      unitLabel: params.input.unitLabel ?? null,
      vatRate: params.input.vatRate,
      indexReference: params.input.indexReference ?? null,
      indexBaseValue: params.input.indexBaseValue ?? null,
      nextReviewAt: params.input.nextReviewAt ?? null,
      targetQualityScore: params.input.targetQualityScore ?? null,
      inspectionIntervalDays: params.input.inspectionIntervalDays ?? null,
      responseHours: params.input.responseHours ?? null,
      slaNote: params.input.slaNote ?? null,
      terms: params.input.terms ?? null,
      internalNote: params.input.internalNote ?? null,
      createdById: params.createdById,
    },
  });

  if (params.services.length > 0) {
    await tx.contractService.createMany({
      data: params.services.map((leistung, index) => ({
        contractVersionId: version.id,
        serviceId: leistung.serviceId ?? null,
        label: leistung.label,
        description: leistung.description ?? null,
        buildingId: leistung.buildingId ?? null,
        zone: leistung.zone ?? null,
        estimatedMinutes: leistung.estimatedMinutes,
        requiredCrewSize: leistung.requiredCrewSize,
        requiredSkills: leistung.requiredSkills,
        qualityRequirement: leistung.qualityRequirement ?? null,
        specialInstructions: leistung.specialInstructions ?? null,
        materialsBy: leistung.materialsBy,
        quantity: leistung.quantity ?? null,
        position: leistung.position || index,
      })),
    });
  }

  return version;
}

/**
 * Eine neue Fassung anlegen — mit **kopiertem** Leistungsumfang und
 * Einsatzplan.
 *
 * Das Kopieren ist der Kern: Eine Version, die auf die Leistungen ihrer
 * Vorgängerin zeigte, wäre keine eigene Fassung, sondern ein Zeiger. Ändert
 * dann jemand eine Leistung, ändert sich rückwirkend, was unter der alten
 * Fassung galt — genau das, was die Versionierung verhindern soll.
 *
 * Die Einsatzpläne werden mitkopiert, damit der Planer nach dem Wirksamwerden
 * weiterarbeiten kann. `generatedUntil` wird dabei **übernommen**: Der neue
 * Plan soll nicht rückwirkend Einsätze erzeugen, die unter der alten Fassung
 * bereits geplant sind.
 */
export async function createContractVersion(params: {
  organizationId: string;
  contractId: string;
  actorId: string;
  ip?: string | null;
  input: ContractVersionInput;
  /** Ohne Angabe wird der Leistungsumfang der aktuellen Fassung kopiert. */
  services?: ContractServiceInput[];
}) {
  const vertrag = await ladeVertrag(params.organizationId, params.contractId);

  const offenerEntwurf = vertrag.versions.find((v) => v.status === 'DRAFT');
  if (offenerEntwurf) {
    throw new BusinessRuleError(
      `Es gibt bereits einen Versionsentwurf (Version ${offenerEntwurf.versionNumber}). Schliessen Sie ihn ab oder verwerfen Sie ihn.`,
    );
  }

  const naechsteNummer = Math.max(0, ...vertrag.versions.map((v) => v.versionNumber)) + 1;
  const vorlage = aktiveVersion(vertrag.versions) ?? vertrag.versions[0] ?? null;

  const version = await prisma.$transaction(async (tx) => {
    const neu = await versionAnlegen(tx, {
      contractId: vertrag.id,
      versionNumber: naechsteNummer,
      createdById: params.actorId,
      input: params.input,
      services: params.services ?? [],
    });

    if (!params.services && vorlage) {
      await leistungenKopieren(tx, vorlage.id, neu.id);
    }

    return neu;
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ContractVersion',
    entityId: version.id,
    summary: `Version ${version.versionNumber} zu Vertrag „${vertrag.title}" angelegt: ${params.input.reason}`,
    ip: params.ip,
  });

  return version;
}

/** Leistungen und ihre Einsatzpläne von einer Version in eine andere kopieren. */
async function leistungenKopieren(tx: Tx, vonVersionId: string, nachVersionId: string): Promise<void> {
  const leistungen = await tx.contractService.findMany({
    where: { contractVersionId: vonVersionId },
    include: { schedules: true },
    orderBy: { position: 'asc' },
  });

  for (const leistung of leistungen) {
    const kopie = await tx.contractService.create({
      data: {
        contractVersionId: nachVersionId,
        serviceId: leistung.serviceId,
        label: leistung.label,
        description: leistung.description,
        buildingId: leistung.buildingId,
        zone: leistung.zone,
        estimatedMinutes: leistung.estimatedMinutes,
        requiredCrewSize: leistung.requiredCrewSize,
        requiredSkills: leistung.requiredSkills,
        qualityRequirement: leistung.qualityRequirement,
        specialInstructions: leistung.specialInstructions,
        materialsBy: leistung.materialsBy,
        quantity: leistung.quantity,
        position: leistung.position,
      },
    });

    for (const plan of leistung.schedules) {
      await tx.serviceSchedule.create({
        data: {
          contractServiceId: kopie.id,
          frequency: plan.frequency,
          interval: plan.interval,
          weekdays: plan.weekdays,
          monthDay: plan.monthDay,
          startMinute: plan.startMinute,
          endMinute: plan.endMinute,
          effectiveFrom: plan.effectiveFrom,
          effectiveUntil: plan.effectiveUntil,
          holidayHandling: plan.holidayHandling,
          // Bewusst übernommen: Was unter der alten Fassung bereits geplant
          // ist, soll der neue Plan nicht noch einmal erzeugen.
          generatedUntil: plan.generatedUntil,
          active: plan.active,
        },
      });
    }
  }
}

/** Nur Entwürfe lassen sich ändern. */
export async function updateContractVersion(params: {
  organizationId: string;
  contractId: string;
  versionId: string;
  actorId: string;
  ip?: string | null;
  input: ContractVersionInput;
}) {
  const version = await ladeVersion(params.organizationId, params.contractId, params.versionId);
  if (version.status !== 'DRAFT') {
    throw new BusinessRuleError(
      'Nur ein Versionsentwurf lässt sich ändern. Eine geltende Fassung wird durch eine neue Version abgelöst.',
    );
  }

  const aktualisiert = await prisma.contractVersion.update({
    where: { id: version.id },
    data: {
      effectiveFrom: params.input.effectiveFrom,
      reason: params.input.reason,
      minimumTermMonths: params.input.minimumTermMonths ?? null,
      renewalType: params.input.renewalType,
      renewalPeriodMonths: params.input.renewalPeriodMonths ?? null,
      noticePeriodDays: params.input.noticePeriodDays,
      billingCycle: params.input.billingCycle,
      paymentTermDays: params.input.paymentTermDays,
      currency: params.input.currency,
      pricingModel: params.input.pricingModel,
      baseAmount: params.input.baseAmount,
      hourlyRate: params.input.hourlyRate ?? null,
      unitPrice: params.input.unitPrice ?? null,
      unitLabel: params.input.unitLabel ?? null,
      vatRate: params.input.vatRate,
      indexReference: params.input.indexReference ?? null,
      indexBaseValue: params.input.indexBaseValue ?? null,
      nextReviewAt: params.input.nextReviewAt ?? null,
      targetQualityScore: params.input.targetQualityScore ?? null,
      inspectionIntervalDays: params.input.inspectionIntervalDays ?? null,
      responseHours: params.input.responseHours ?? null,
      slaNote: params.input.slaNote ?? null,
      terms: params.input.terms ?? null,
      internalNote: params.input.internalNote ?? null,
    },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ContractVersion',
    entityId: version.id,
    summary: `Versionsentwurf ${version.versionNumber} geändert`,
    changes: params.input,
    ip: params.ip,
  });

  return aktualisiert;
}

async function ladeVersion(organizationId: string, contractId: string, versionId: string) {
  const version = await prisma.contractVersion.findFirst({
    where: { id: versionId, contractId, contract: { organizationId, deletedAt: null } },
  });
  if (!version) throw new NotFoundError('Vertragsversion nicht gefunden.');
  return version;
}

/** Der Leistungsumfang eines Versionsentwurfs, als Ganzes ersetzt. */
export async function replaceContractServices(params: {
  organizationId: string;
  contractId: string;
  versionId: string;
  actorId: string;
  ip?: string | null;
  services: ContractServiceInput[];
}) {
  const version = await ladeVersion(params.organizationId, params.contractId, params.versionId);
  if (version.status !== 'DRAFT') {
    throw new BusinessRuleError('Der Leistungsumfang einer geltenden Fassung lässt sich nicht ändern.');
  }

  await prisma.$transaction(async (tx) => {
    // Löscht über `onDelete: Cascade` auch die Einsatzpläne der Positionen.
    await tx.contractService.deleteMany({ where: { contractVersionId: version.id } });
    if (params.services.length > 0) {
      await tx.contractService.createMany({
        data: params.services.map((leistung, index) => ({
          contractVersionId: version.id,
          serviceId: leistung.serviceId ?? null,
          label: leistung.label,
          description: leistung.description ?? null,
          buildingId: leistung.buildingId ?? null,
          zone: leistung.zone ?? null,
          estimatedMinutes: leistung.estimatedMinutes,
          requiredCrewSize: leistung.requiredCrewSize,
          requiredSkills: leistung.requiredSkills,
          qualityRequirement: leistung.qualityRequirement ?? null,
          specialInstructions: leistung.specialInstructions ?? null,
          materialsBy: leistung.materialsBy,
          quantity: leistung.quantity ?? null,
          position: leistung.position || index,
        })),
      });
    }
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ContractVersion',
    entityId: version.id,
    summary: `Leistungsumfang von Version ${version.versionNumber} ersetzt (${params.services.length} Positionen)`,
    ip: params.ip,
  });

  return prisma.contractService.findMany({
    where: { contractVersionId: version.id },
    orderBy: { position: 'asc' },
  });
}

// ---------------------------------------------------------------------------
//  Lebenslauf
// ---------------------------------------------------------------------------

/**
 * Den Vertrag in Kraft setzen.
 *
 * Alles, was danach gilt, entsteht hier in **einer** Transaktion: die Nummer,
 * die geltende Version, der Zustand. Die drei Dinge auseinanderzuziehen hiesse,
 * einen Zwischenzustand zu erlauben, in dem ein Vertrag aktiv ist und keine
 * Version hat — und in dem eine Abrechnung mit null rechnet.
 */
export async function activateContract(params: {
  organizationId: string;
  contractId: string;
  actorId: string;
  ip?: string | null;
  effectiveFrom?: Date;
  note?: string;
}) {
  const vertrag = await ladeVertrag(params.organizationId, params.contractId);
  pruefeUebergang(vertrag.status, 'ACTIVE');

  const entwurf = vertrag.versions.find((v) => v.status === 'DRAFT');
  const bisher = aktiveVersion(vertrag.versions);
  if (!entwurf && !bisher) {
    throw new BusinessRuleError('Der Vertrag hat keine Fassung, die in Kraft gesetzt werden könnte.');
  }

  const leistungen = entwurf
    ? await prisma.contractService.count({ where: { contractVersionId: entwurf.id } })
    : 1;
  if (entwurf && leistungen === 0) {
    throw new BusinessRuleError(
      'Ein Vertrag ohne Leistungen kann nicht in Kraft treten — er erzeugt keine Einsätze und keine Abrechnung.',
    );
  }

  const gueltigAb = params.effectiveFrom ? alsTag(params.effectiveFrom) : alsTag(vertrag.startDate);

  const ergebnis = await prisma.$transaction(async (tx) => {
    let nummer = vertrag.number;
    if (!nummer) {
      nummer = (await nextNumber(tx, params.organizationId, 'contract')).number;
    }

    if (entwurf) {
      if (bisher) {
        await tx.contractVersion.update({
          where: { id: bisher.id },
          data: { status: 'SUPERSEDED', effectiveUntil: gueltigAb },
        });
      }
      await tx.contractVersion.update({
        where: { id: entwurf.id },
        data: { status: 'ACTIVE', effectiveFrom: gueltigAb },
      });
    }

    const geltend = entwurf ?? bisher!;
    const frist = kuendigungsfrist(vertrag.endDate, geltend.noticePeriodDays);

    return tx.contract.update({
      where: { id: vertrag.id },
      data: {
        status: 'ACTIVE',
        number: nummer,
        noticeDeadline: frist,
        pausedFrom: null,
        pausedUntil: null,
        pauseReason: null,
      },
    });
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Contract',
    entityId: vertrag.id,
    summary: `Vertrag ${ergebnis.number} in Kraft gesetzt${params.note ? ` — ${params.note}` : ''}`,
    changes: { status: { from: vertrag.status, to: 'ACTIVE' } },
    ip: params.ip,
  });

  return ergebnis;
}

export async function pauseContract(params: {
  organizationId: string;
  contractId: string;
  actorId: string;
  ip?: string | null;
  pausedFrom: Date;
  pausedUntil?: Date;
  reason: string;
}) {
  const vertrag = await ladeVertrag(params.organizationId, params.contractId);
  pruefeUebergang(vertrag.status, 'PAUSED');

  const aktualisiert = await prisma.contract.update({
    where: { id: vertrag.id },
    data: {
      status: 'PAUSED',
      pausedFrom: alsTag(params.pausedFrom),
      pausedUntil: params.pausedUntil ? alsTag(params.pausedUntil) : null,
      pauseReason: params.reason,
    },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Contract',
    entityId: vertrag.id,
    summary: `Vertrag ${vertrag.number ?? vertrag.title} pausiert — ${params.reason}`,
    ip: params.ip,
  });

  return aktualisiert;
}

export async function resumeContract(params: {
  organizationId: string;
  contractId: string;
  actorId: string;
  ip?: string | null;
}) {
  const vertrag = await ladeVertrag(params.organizationId, params.contractId);
  pruefeUebergang(vertrag.status, 'ACTIVE');

  const aktualisiert = await prisma.contract.update({
    where: { id: vertrag.id },
    data: { status: 'ACTIVE', pausedFrom: null, pausedUntil: null, pauseReason: null },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Contract',
    entityId: vertrag.id,
    summary: `Vertrag ${vertrag.number ?? vertrag.title} wieder aufgenommen`,
    ip: params.ip,
  });

  return aktualisiert;
}

/**
 * Eine Kündigung erfassen.
 *
 * **Das System beurteilt sie nicht.** Es hält fest, wer wann gekündigt hat,
 * und rechnet aus Frist und Laufzeit ein Wirkungsdatum aus — nachvollziehbar
 * und überschreibbar. Ob die Kündigung formgerecht, rechtzeitig und wirksam
 * ist, ist eine Rechtsfrage und keine Spalte.
 */
export async function giveNotice(params: {
  organizationId: string;
  contractId: string;
  actorId: string;
  ip?: string | null;
  noticeGivenBy: 'CUSTOMER' | 'PROVIDER';
  noticeGivenAt?: Date;
  terminationEffectiveAt?: Date;
  reason?: string;
}) {
  const vertrag = await ladeVertrag(params.organizationId, params.contractId);
  pruefeUebergang(vertrag.status, 'NOTICE_GIVEN');

  const geltend = aktiveVersion(vertrag.versions);
  if (!geltend) throw new BusinessRuleError('Der Vertrag hat keine geltende Fassung.');

  const gekuendigtAm = params.noticeGivenAt ? alsTag(params.noticeGivenAt) : alsTag(new Date());
  const wirkung =
    params.terminationEffectiveAt
      ? alsTag(params.terminationEffectiveAt)
      : kuendigungswirkung({
          gekuendigtAm,
          noticePeriodDays: geltend.noticePeriodDays,
          vertragsende: vertrag.endDate,
          renewalType: geltend.renewalType,
          renewalPeriodMonths: geltend.renewalPeriodMonths,
        });

  const aktualisiert = await prisma.contract.update({
    where: { id: vertrag.id },
    data: {
      status: 'NOTICE_GIVEN',
      noticeGivenAt: new Date(),
      noticeGivenBy: params.noticeGivenBy,
      terminationEffectiveAt: wirkung,
      terminationReason: params.reason ?? null,
    },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Contract',
    entityId: vertrag.id,
    summary: `Kündigung erfasst (${params.noticeGivenBy === 'CUSTOMER' ? 'Kundschaft' : 'Firma'}), Wirkung ${wirkung.toISOString().slice(0, 10)}`,
    ip: params.ip,
  });

  return aktualisiert;
}

export async function endContract(params: {
  organizationId: string;
  contractId: string;
  actorId: string;
  ip?: string | null;
  reason?: string;
}) {
  const vertrag = await ladeVertrag(params.organizationId, params.contractId);
  pruefeUebergang(vertrag.status, 'ENDED');

  const heute = alsTag(new Date());

  const aktualisiert = await prisma.$transaction(async (tx) => {
    /**
     * Mit dem Ende laufen die Serien aus.
     *
     * Ohne diesen Schritt erzeugte der nächtliche Planer weiter Einsätze für
     * einen beendeten Vertrag — und niemand sähe es, bis jemand vor einer
     * verschlossenen Tür steht. Die Pläne werden nicht gelöscht: Sie sind Teil
     * der Vertragsversion und bleiben lesbar.
     */
    await tx.serviceSchedule.updateMany({
      where: { contractService: { version: { contractId: vertrag.id } }, active: true },
      data: { active: false, effectiveUntil: vertrag.terminationEffectiveAt ?? heute },
    });

    return tx.contract.update({
      where: { id: vertrag.id },
      data: {
        status: 'ENDED',
        endDate: vertrag.terminationEffectiveAt ?? vertrag.endDate ?? heute,
        terminationReason: params.reason ?? vertrag.terminationReason,
      },
    });
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Contract',
    entityId: vertrag.id,
    summary: `Vertrag ${vertrag.number ?? vertrag.title} beendet${params.reason ? ` — ${params.reason}` : ''}`,
    ip: params.ip,
  });

  return aktualisiert;
}

export async function cancelContract(params: {
  organizationId: string;
  contractId: string;
  actorId: string;
  ip?: string | null;
  reason?: string;
}) {
  const vertrag = await ladeVertrag(params.organizationId, params.contractId);
  pruefeUebergang(vertrag.status, 'CANCELLED');

  const aktualisiert = await prisma.contract.update({
    where: { id: vertrag.id },
    data: { status: 'CANCELLED', terminationReason: params.reason ?? null },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Contract',
    entityId: vertrag.id,
    summary: `Vertragsentwurf „${vertrag.title}" storniert`,
    ip: params.ip,
  });

  return aktualisiert;
}

/**
 * Verlängern.
 *
 * Auch die automatische Verlängerung läuft über diese Handlung und nicht über
 * einen stillen Nachtlauf: Eine Verlängerung ist eine Verpflichtung über
 * Monate, und wer sie auslöst, gehört ins Protokoll. Der Nachtlauf erinnert;
 * entscheiden tut ein Mensch.
 */
export async function renewContract(params: {
  organizationId: string;
  contractId: string;
  actorId: string;
  ip?: string | null;
  months?: number;
  reason: string;
}) {
  const vertrag = await ladeVertrag(params.organizationId, params.contractId);
  if (vertrag.status !== 'ACTIVE' && vertrag.status !== 'PAUSED') {
    throw new BusinessRuleError('Nur ein laufender Vertrag lässt sich verlängern.');
  }

  const geltend = aktiveVersion(vertrag.versions);
  if (!geltend) throw new BusinessRuleError('Der Vertrag hat keine geltende Fassung.');

  const monate = params.months ?? geltend.renewalPeriodMonths ?? 0;
  if (monate <= 0) {
    throw new BusinessRuleError(
      'Für diesen Vertrag ist keine Verlängerungsdauer hinterlegt. Bitte geben Sie sie an.',
    );
  }
  if (!vertrag.endDate) {
    throw new BusinessRuleError('Ein unbefristeter Vertrag läuft weiter — eine Verlängerung ergibt hier keinen Sinn.');
  }

  const neuesEnde = plusMonate(alsTag(vertrag.endDate), monate);

  const aktualisiert = await prisma.contract.update({
    where: { id: vertrag.id },
    data: {
      endDate: neuesEnde,
      noticeDeadline: kuendigungsfrist(neuesEnde, geltend.noticePeriodDays),
    },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Contract',
    entityId: vertrag.id,
    summary: `Vertrag ${vertrag.number ?? vertrag.title} um ${monate} Monate verlängert bis ${neuesEnde.toISOString().slice(0, 10)} — ${params.reason}`,
    ip: params.ip,
  });

  return aktualisiert;
}

// ---------------------------------------------------------------------------
//  Abrechnungsgrundlage
// ---------------------------------------------------------------------------

/**
 * Was für eine Periode aus diesem Vertrag zu fakturieren ist.
 *
 * **Rechnet, schreibt aber nichts.** Die Rechnung entsteht über den
 * Rechnungsdienst, damit Nummernkreis, Belegregeln und Append-only an genau
 * einer Stelle bleiben. Hier steht nur die Herleitung — und die zeigt jede
 * Zwischengrösse, weil eine Summe, die sich nicht nachrechnen lässt, eine
 * Rückfrage je Monat erzeugt.
 */
export async function contractBillingBasis(params: {
  organizationId: string;
  contractId: string;
  von: Date;
  bis: Date;
}) {
  const vertrag = await prisma.contract.findFirst({
    where: { id: params.contractId, organizationId: params.organizationId, deletedAt: null },
    include: { versions: { orderBy: { versionNumber: 'desc' } } },
  });
  if (!vertrag) throw new NotFoundError('Vertrag nicht gefunden.');

  const geltend = aktiveVersion(vertrag.versions);
  if (!geltend) throw new BusinessRuleError('Der Vertrag hat keine geltende Fassung.');

  const einsaetze = await prisma.job.findMany({
    where: {
      contractId: vertrag.id,
      scheduledStart: { gte: params.von, lt: params.bis },
      status: { in: ['COMPLETED', 'VERIFIED'] },
      deletedAt: null,
    },
    select: { id: true, number: true, contractVersionId: true, scheduledStart: true, estimatedMin: true },
  });

  const stunden = await prisma.timeEntry.aggregate({
    where: { job: { contractId: vertrag.id, scheduledStart: { gte: params.von, lt: params.bis } }, approved: true },
    _sum: { minutes: true },
  });
  const freigegebeneMinuten = stunden._sum.minutes ?? 0;

  let netto = 0;
  let herleitung = '';

  switch (geltend.pricingModel) {
    case 'FIXED_PERIOD':
      netto = toNumber(geltend.baseAmount);
      herleitung = `Pauschale je Periode (${geltend.billingCycle})`;
      break;
    case 'FIXED_PER_VISIT':
      netto = toNumber(geltend.baseAmount) * einsaetze.length;
      herleitung = `${einsaetze.length} Einsätze × ${toNumber(geltend.baseAmount).toFixed(2)}`;
      break;
    case 'HOURLY':
      netto = (freigegebeneMinuten / 60) * toNumber(geltend.hourlyRate ?? 0);
      herleitung = `${(freigegebeneMinuten / 60).toFixed(2)} freigegebene Stunden × ${toNumber(geltend.hourlyRate ?? 0).toFixed(2)}`;
      break;
    case 'UNIT_BASED': {
      const menge = await prisma.contractService.aggregate({
        where: { contractVersionId: geltend.id },
        _sum: { quantity: true },
      });
      const gesamtmenge = toNumber(menge._sum.quantity);
      netto = gesamtmenge * toNumber(geltend.unitPrice ?? 0);
      herleitung = `${gesamtmenge} ${geltend.unitLabel ?? 'Einheiten'} × ${toNumber(geltend.unitPrice ?? 0).toFixed(4)}`;
      break;
    }
    default:
      netto = toNumber(geltend.baseAmount);
      herleitung = 'Abweichende Vereinbarung — Betrag aus der Vertragsversion';
  }

  const mwstSatz = toNumber(geltend.vatRate);
  const mwst = Math.round(netto * mwstSatz) / 100;

  return {
    contractId: vertrag.id,
    contractNumber: vertrag.number,
    contractVersionId: geltend.id,
    versionNumber: geltend.versionNumber,
    pricingModel: geltend.pricingModel,
    currency: geltend.currency,
    von: params.von,
    bis: params.bis,
    einsaetze: einsaetze.length,
    freigegebeneMinuten,
    netto: Math.round(netto * 100) / 100,
    mwstSatz,
    mwst,
    brutto: Math.round((netto + mwst) * 100) / 100,
    herleitung,
    /**
     * Die Einsätze mit ihrer Vertragsversion — damit später beantwortbar
     * bleibt, unter welchen Konditionen jeder einzelne erbracht wurde. Eine
     * Rechnungssumme ohne diese Zuordnung ist bei einem Vertrag, der sich
     * geändert hat, nicht mehr prüfbar.
     */
    positionen: einsaetze.map((einsatz) => ({
      jobId: einsatz.id,
      number: einsatz.number,
      contractVersionId: einsatz.contractVersionId,
      scheduledStart: einsatz.scheduledStart,
      estimatedMin: einsatz.estimatedMin,
    })),
  };
}
