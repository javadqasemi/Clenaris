import 'server-only';

import type { ContractStatus, Prisma } from '@prisma/client';

import { audit } from '@/lib/audit';
import {
  alsTag,
  kuendigungsfrist,
  kuendigungswirkung,
  plusMonate,
  plusTage,
  tagSchluessel,
  zuercherHeute,
} from '@/lib/contracts/serie';
import type { SessionUser } from '@/lib/auth/session';
import { prisma, toNumber, type Tx } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { renderContractVersionSnapshot } from '@/lib/pdf/render';
import type {
  ContractCreateInput,
  ContractServiceInput,
  ContractUpdateInput,
  ContractVersionInput,
} from '@/lib/validation/contracts';

import {
  assertFassungAnnehmbar,
  cancelActiveContractAcceptanceInTx,
  cancelAllContractAcceptancesInTx,
  fassungIstGebunden,
  vertragSperren,
  vertragsannahmeLaeuftAb,
} from './contract-acceptance.service';
import { einsaetzeAbgleichen } from './contract-schedule.service';
import { nextNumber } from './numbering.service';
import type { AnfrageKontext } from './signature-events';
import {
  createContractAcceptanceRequest,
  findActiveContractAcceptance,
  sendSignatureRequest,
} from './signature.service';

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

/**
 * **Eine angenommene Fassung macht den Vertrag unwiderruflich** — weder
 * annullieren noch als Entwurf löschen.
 *
 * Die Kundschaft hat zugestimmt; still verschwinden darf die Zusage nicht.
 * Der Weg ist Inkraftsetzen und Kündigen, beides mit Protokoll. Damit gilt
 * die Zusicherung aus RB-005 ohne Zeitvergleich: Es gibt keinen Vertrag, der
 * storniert oder gelöscht ist und zugleich eine angenommene Fassung trägt.
 * Hinter `vertragSperren` gelesen — eine Annahme, die gleichzeitig abschliesst,
 * wartet auf die Sperre oder wird hier gesehen.
 */
async function keineAngenommeneFassung(tx: Tx, contractId: string, was: 'annullieren' | 'löschen'): Promise<void> {
  const angenommen = await tx.contractVersion.count({ where: { contractId, acceptedAt: { not: null } } });
  if (angenommen > 0) {
    throw new BusinessRuleError(
      `Die Kundschaft hat eine Fassung dieses Vertrags angenommen. Er lässt sich nicht mehr ${was} — setzen Sie ihn in Kraft und kündigen Sie ihn, wenn er nicht gelten soll.`,
    );
  }
}

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

/**
 * Den Vertragskopf sperren, den Übergang am **gesperrten** Zustand prüfen und
 * den Vertrag in dieser Transaktion frisch lesen (N-02, 2026-09-27).
 *
 * Pausieren, Fortsetzen, Kündigen, Kündigung zurücknehmen und Beenden
 * schrieben bis hierher ohne Sperre, auf Grund eines Zustands, der vor der
 * Transaktion gelesen war, und mit `update` nur über die Kennung. Zwei
 * gleichzeitige Handlungen bestanden beide die Prüfung, und die spätere
 * überschrieb die frühere: „Beenden" und „Fortsetzen" auf einem pausierten
 * Vertrag ergaben einen Vertrag mit Enddatum im Zustand ACTIVE — beendet in
 * der Akte, laufend für den Planer, der weiter Einsätze erzeugt.
 *
 * Jetzt serialisieren sich alle Lebenslaufschritte über dieselbe Zeile wie
 * Stornieren und Unterschreiben (`vertragSperren`, Sperrreihenfolge
 * `Contract → …`). Wer als zweiter kommt, wartet, liest danach den
 * bestätigten Zustand des ersten und prüft den Übergang **daran** — beim
 * Beispiel oben gewinnt entweder das Beenden (Fortsetzen: 422) oder das
 * Fortsetzen (danach Beenden aus ACTIVE: zulässig). Beide Reihenfolgen enden
 * in einem Zustand, den eine einzelne Handlung auch erreicht hätte.
 *
 * Frisch gelesen wird der ganze Vertrag samt Fassungen, nicht nur der
 * Zustand: Das Beenden nimmt das Wirkungsdatum der Kündigung, die Kündigung
 * die Frist der geltenden Fassung — beides kann ein gleichzeitiger Schritt
 * gerade geändert haben. Die Mandantenprüfung steht im `where`; die Sperre
 * allein kennt nur die Kennung.
 */
async function gesperrtLaden(tx: Tx, organizationId: string, contractId: string, nach: ContractStatus) {
  const gesperrt = await vertragSperren(tx, { contractId });
  if (!gesperrt || gesperrt.deletedAt) throw new NotFoundError('Vertrag nicht gefunden.');
  pruefeUebergang(gesperrt.status as ContractStatus, nach);
  const frisch = await tx.contract.findFirst({
    where: { id: contractId, organizationId, deletedAt: null },
    include: { versions: { orderBy: { versionNumber: 'desc' } } },
  });
  if (!frisch) throw new NotFoundError('Vertrag nicht gefunden.');
  return frisch;
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

  /**
   * **Der Einsatzort eines laufenden Vertrags ändert sich nicht am Kopf.**
   *
   * Der Kopf trägt die Identität und bleibt pflegbar — Titel, Zuständige,
   * Kostenstelle. Das Objekt aber bestimmt, wohin jeder künftige Einsatz
   * geht, und es steht im unterschriebenen Dokument. Bis 2026-09-23 liess es
   * sich an einem aktiven Vertrag still umhängen; der nächste Planerlauf
   * schickte das Team dann an eine andere Adresse, ohne dass eine Fassung
   * entstand. Solange der Vertrag nicht in Kraft war, bleibt es frei.
   */
  if (
    params.input.propertyId !== undefined &&
    (params.input.propertyId ?? null) !== vorher.propertyId &&
    BELEGZUSTAENDE.includes(vorher.status)
  ) {
    throw new BusinessRuleError(
      'Das Objekt eines Vertrags, der in Kraft ist oder war, lässt sich nicht ändern. Ein anderer Einsatzort ist eine Vertragsänderung.',
    );
  }

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

  const nichtLoeschbar = () =>
    new BusinessRuleError(
      'Ein Vertrag, der in Kraft war, lässt sich nicht löschen. Beenden Sie ihn stattdessen — er bleibt als Beleg bestehen.',
    );
  if (BELEGZUSTAENDE.includes(vertrag.status)) throw nichtLoeschbar();

  /**
   * In einer Transaktion mit dem Abbruch aller offenen Annahmevorgänge und
   * hinter der Sperre des Vertragskopfs. Bis 2026-09-23 blieb der Link der
   * Kundschaft nach dem Verwerfen gültig, und eine Unterschrift darauf schloss
   * ab. Der Zustand wird unter der Sperre neu gelesen: Zwischen dem Laden oben
   * und hier kann eine Annahme abgeschlossen oder der Vertrag aktiviert worden
   * sein.
   */
  await prisma.$transaction(async (tx) => {
    const gesperrt = await vertragSperren(tx, { contractId: vertrag.id });
    if (!gesperrt || gesperrt.deletedAt) throw new NotFoundError('Vertrag nicht gefunden.');
    if ((BELEGZUSTAENDE as readonly string[]).includes(gesperrt.status)) throw nichtLoeschbar();
    await keineAngenommeneFassung(tx, vertrag.id, 'löschen');

    await tx.contract.update({ where: { id: vertrag.id }, data: { deletedAt: new Date() } });
    await cancelAllContractAcceptancesInTx(tx, {
      contractId: vertrag.id,
      reason: 'version_discarded',
      cancelledById: params.actorId,
    });
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
 * weiterarbeiten kann — mit derselben **Linie** (`seriesKey`), damit ein
 * Termin unter beiden Fassungen derselbe bleibt (`leistungenKopieren`).
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
    include: { schedules: { include: { exceptions: true } } },
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

    const heute = zuercherHeute();
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
          /**
           * **Die Linie wird übernommen, die Marke nicht.**
           *
           * `seriesKey` ist die fachliche Identität der Serie: Derselbe Termin
           * behält unter der neuen Fassung denselben Schlüssel, und der
           * eindeutige Index `jobs_serientermin_einmal` verhindert, dass er ein
           * zweites Mal entsteht.
           *
           * `generatedUntil` wurde bis 2026-09-23 **mitkopiert** — zum
           * Zeitpunkt, an dem der Entwurf entstand. Bis zum Inkrafttreten
           * schob der Nachtlauf die Marke der alten Serie weiter; die Kopie
           * begann dann an einer veralteten Stelle, mit neuer Kennung, und
           * erzeugte Tage ein zweites Mal (RB-003). Heute bestimmt die Marke
           * nicht mehr, ab wann geplant wird; sie beginnt leer.
           */
          seriesKey: plan.seriesKey,
          generatedUntil: null,
          active: plan.active,
          /**
           * Ausnahmen für künftige Tage gehen mit. Ohne sie würde ein
           * abgesagter Termin unter der neuen Fassung wieder geplant, obwohl
           * niemand die Absage zurückgenommen hat. Vergangene Ausnahmen sind
           * Geschichte der alten Fassung und bleiben dort.
           */
          exceptions: {
            create: plan.exceptions
              .filter((a) => alsTag(a.originalDate) >= heute)
              .map((a) => ({
                kind: a.kind,
                originalDate: a.originalDate,
                newDate: a.newDate,
                reason: a.reason,
                createdById: a.createdById,
              })),
          },
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
  await assertFassungFrei(version.id);

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

/**
 * Eine Fassung, die unterschrieben wird oder wurde, ist eingefroren.
 *
 * Der Fall, den das verhindert: Die Kundschaft hat den Snapshot offen, jemand
 * im Büro korrigiert „schnell noch" den Preis — und danach zeigt das
 * unterschriebene Dokument den alten Betrag, die Datenbank den neuen. Welcher
 * gilt, wäre eine Frage, die sich nachträglich nicht mehr beantworten lässt.
 *
 * Die Sperre ist deshalb breiter als „angenommen": Schon der **laufende**
 * Vorgang genügt. Wer trotzdem ändern will, zieht ihn zurück — das ist
 * sichtbar und protokolliert, anders als eine stille Änderung.
 */
async function assertFassungFrei(contractVersionId: string): Promise<void> {
  const bindung = await fassungIstGebunden(contractVersionId);
  if (!bindung) return;
  throw new BusinessRuleError(
    bindung === 'ANGENOMMEN'
      ? 'Diese Fassung wurde elektronisch angenommen und lässt sich nicht mehr ändern. Für eine Änderung braucht es eine neue Version.'
      : 'Diese Fassung liegt zur Unterzeichnung vor und lässt sich solange nicht ändern. Ziehen Sie den Annahmevorgang zurück, wenn die Konditionen noch nicht stimmen.',
  );
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
  await assertFassungFrei(version.id);

  await prisma.$transaction(async (tx) => {
    const bestehend = new Set(
      (await tx.contractService.findMany({ where: { contractVersionId: version.id }, select: { id: true } })).map(
        (zeile) => zeile.id,
      ),
    );
    const behalten = new Set(params.services.map((l) => l.id).filter((id): id is string => !!id && bestehend.has(id)));

    // Entfernt nur, was nicht mehr genannt ist — samt dessen Einsatzplan
    // über die Kaskade. Genannte Zeilen behalten ihren Plan.
    await tx.contractService.deleteMany({
      where: { contractVersionId: version.id, id: { notIn: [...behalten] } },
    });

    for (const [index, leistung] of params.services.entries()) {
      const daten = {
        serviceId: leistung.serviceId ?? null,
        label: leistung.label,
        description: leistung.description ?? null,
        zone: leistung.zone ?? null,
        estimatedMinutes: leistung.estimatedMinutes,
        requiredCrewSize: leistung.requiredCrewSize,
        requiredSkills: leistung.requiredSkills,
        qualityRequirement: leistung.qualityRequirement ?? null,
        specialInstructions: leistung.specialInstructions ?? null,
        materialsBy: leistung.materialsBy,
        quantity: leistung.quantity ?? null,
        position: leistung.position || index,
      };
      if (leistung.id && behalten.has(leistung.id)) {
        await tx.contractService.update({ where: { id: leistung.id }, data: daten });
      } else {
        await tx.contractService.create({ data: { ...daten, contractVersionId: version.id } });
      }
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
//  Elektronische Annahme einer Vertragsfassung (§ 12)
// ---------------------------------------------------------------------------

/**
 * Eine Vertragsfassung zur Unterzeichnung schicken.
 *
 * **Kein zweiter Signaturweg.** Es entsteht ein gewöhnlicher
 * `SignatureRequest` des bestehenden Kerns — mit Snapshot, Hash A,
 * Zustimmungstext, Protokoll und Ablauf. Neu ist allein die vierte Quelle
 * (`contractVersionId`) und die Geschäftsregel, die beim Abschluss greift.
 *
 * **Der Rohtoken geht nicht an die auslösende Person.** Versendet wird über
 * `sendSignatureRequest`, also per E-Mail an die Kundschaft. Gäbe der
 * Endpunkt den Link zurück, könnte die Person aus dem Betrieb den Vertrag
 * selbst „annehmen" — und der Beweis sähe aus wie eine Kundenunterschrift.
 * In der Prüfreihe ist der Postausgang die Stelle, an der der ausgestellte
 * Link sichtbar wird; in der Datenbank steht nur sein Hash.
 *
 * Mehrfaches Auslösen erzeugt **einen** Vorgang: Gibt es einen offenen, wird
 * er erneut versandt (der alte Link verfällt dabei), nicht ein zweiter
 * angelegt. Zwei Vorgänge mit zwei Snapshots derselben Fassung wären zwei
 * echte Unterschriften auf zwei Dokumenten, und welche gilt, wäre eine Frage
 * der Reihenfolge.
 */
export async function startContractAcceptance(params: {
  organizationId: string;
  contractId: string;
  versionId: string;
  session: SessionUser;
  ctx: AnfrageKontext;
}): Promise<{ requestId: string; publicId: string; expiresAt: Date; erneutVersandt: boolean }> {
  const version = await prisma.contractVersion.findFirst({
    where: { id: params.versionId, contractId: params.contractId },
    include: {
      contract: {
        select: {
          id: true,
          organizationId: true,
          number: true,
          title: true,
          status: true,
          deletedAt: true,
          createdById: true,
          customer: {
            select: { id: true, firstName: true, lastName: true, companyName: true, email: true },
          },
        },
      },
      services: { select: { id: true } },
    },
  });
  if (!version || version.contract.organizationId !== params.organizationId) {
    throw new NotFoundError('Vertragsversion nicht gefunden.');
  }

  const vertrag = version.contract;
  assertFassungAnnehmbar(version, vertrag);

  /**
   * Eine Fassung ohne Leistungen ist kein Vertrag, den jemand annehmen
   * könnte — dieselbe Prüfung wie beim Aktivieren, nur früher. Ein Dokument
   * mit leerer Leistungstabelle zur Unterschrift zu schicken, wäre die
   * peinlichste Art, diesen Fehler zu bemerken.
   */
  if (version.services.length === 0) {
    throw new BusinessRuleError('Diese Fassung enthält keine Leistungen und lässt sich nicht zur Annahme schicken.');
  }

  const kunde = vertrag.customer;
  const name = kunde.companyName ?? `${kunde.firstName} ${kunde.lastName}`.trim();
  if (!name || !kunde.email) {
    throw new BusinessRuleError('Für diese Kundschaft ist keine E-Mail-Adresse hinterlegt.');
  }

  const vorhanden = await findActiveContractAcceptance(version.id);
  if (vorhanden) {
    if (vorhanden.status === 'FINALIZING') {
      throw new BusinessRuleError('Die Unterzeichnung dieser Fassung wird gerade abgeschlossen.');
    }
    await sendSignatureRequest(params.session, params.organizationId, vorhanden.id, params.ctx);
    return {
      requestId: vorhanden.id,
      publicId: vorhanden.publicId,
      expiresAt: vorhanden.expiresAt,
      erneutVersandt: true,
    };
  }

  const snapshot = await renderContractVersionSnapshot(version.id);
  const expiresAt = vertragsannahmeLaeuftAb();

  const angelegt = await createContractAcceptanceRequest({
    version: {
      id: version.id,
      versionNumber: version.versionNumber,
      organizationId: vertrag.organizationId,
      contractId: vertrag.id,
    },
    contract: { number: vertrag.number, title: vertrag.title, createdById: vertrag.createdById },
    participant: { name, email: kunde.email, customerId: kunde.id },
    // Dieselbe Naht wie bei der Offerte: `src/lib/pdf` liefert `buffer`, der
    // Signaturkern spricht von `bytes`.
    snapshot: { bytes: snapshot.buffer, filename: snapshot.filename },
    expiresAt,
    actorUserId: params.session.id,
    ctx: params.ctx,
  });

  // Jemand war schneller — dessen Vorgang gilt.
  const vorgang = angelegt ?? (await findActiveContractAcceptance(version.id));
  if (!vorgang) {
    throw new BusinessRuleError('Der Annahmevorgang konnte nicht begonnen werden. Bitte erneut versuchen.');
  }

  await sendSignatureRequest(params.session, params.organizationId, vorgang.id, params.ctx);

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.session.id,
    entity: 'ContractVersion',
    entityId: version.id,
    summary: `Fassung ${version.versionNumber} von ${vertrag.number ?? vertrag.title} zur elektronischen Annahme versandt (Vorgang ${vorgang.id})`,
    ip: params.ctx.ip,
    userAgent: params.ctx.userAgent,
  });

  return {
    requestId: vorgang.id,
    publicId: vorgang.publicId,
    expiresAt,
    erneutVersandt: false,
  };
}

/**
 * Einen laufenden Annahmevorgang zurückziehen.
 *
 * Der Weg, den `assertFassungFrei` offenlässt: Wer die Konditionen doch noch
 * ändern will, zieht die Unterzeichnung zurück — sichtbar, protokolliert und
 * mit entwertetem Link. Eine stille Änderung am unterschriebenen Stand gibt
 * es dafür nicht.
 *
 * Eine bereits **angenommene** Fassung lässt sich nicht zurückziehen; dafür
 * gibt es die neue Version.
 */
export async function withdrawContractAcceptance(params: {
  organizationId: string;
  contractId: string;
  versionId: string;
  actorId: string;
  ip?: string | null;
  ctx?: AnfrageKontext | null;
}): Promise<{ abgebrochen: number }> {
  const version = await ladeVersion(params.organizationId, params.contractId, params.versionId);
  if (version.acceptedAt) {
    throw new BusinessRuleError(
      'Diese Fassung wurde bereits angenommen. Eine Annahme lässt sich nicht zurücknehmen — dafür gibt es eine neue Version.',
    );
  }

  const abgebrochen = await prisma.$transaction((tx) =>
    cancelActiveContractAcceptanceInTx(tx, {
      contractVersionId: version.id,
      reason: 'withdrawn',
      ctx: params.ctx,
      cancelledById: params.actorId,
    }),
  );

  if (abgebrochen > 0) {
    await audit.updated({
      organizationId: params.organizationId,
      userId: params.actorId,
      entity: 'ContractVersion',
      entityId: version.id,
      summary: `Annahmevorgang zu Fassung ${version.versionNumber} zurückgezogen`,
      ip: params.ip,
    });
  }

  return { abgebrochen };
}

// ---------------------------------------------------------------------------
//  Lebenslauf
// ---------------------------------------------------------------------------

/**
 * Den Vertrag in Kraft setzen — **erstmals**, oder aus Pause bzw. Kündigung
 * zurück.
 *
 * Bis 2026-09-23 tat diese Handlung drei Dinge in einem, und zwei davon
 * falsch (RB-002, RB-004):
 *
 *  • Aus PAUSED oder NOTICE_GIVEN heraus löste sie die geltende Fassung ab
 *    und setzte **beide** Gültigkeiten auf den Vertragsbeginn. Fassung 1
 *    hatte danach einen leeren Zeitraum, und jede Frage „was galt am 3. März"
 *    fand Fassung 2 — für die ganze Vergangenheit.
 *  • Einen Fassungswechsel an einem laufenden Vertrag konnte sie gar nicht:
 *    ACTIVE → ACTIVE ist kein Übergang. Nach dem ersten Änderungsantrag war
 *    jeder Vertrag für weitere Fassungen blockiert.
 *
 * Jetzt gibt es zwei Handlungen mit je einer Bedeutung. Diese hier ändert
 * den **Lebenslauf** und fasst keine Fassung an, die schon galt:
 *
 *  • *Erstmals* (Entwurf, in Prüfung, offeriert): Der Entwurf wird geltend,
 *    die Nummer entsteht — in einer Transaktion. `effectiveFrom` ist der
 *    vereinbarte Stichtag der Fassung; ein abweichender lässt sich nur setzen,
 *    solange die Fassung nicht angenommen ist oder in Unterzeichnung steht —
 *    er steht im unterschriebenen Dokument.
 *  • *Pausiert* → wie `resumeContract`.
 *  • *Gekündigt* → die Kündigung wird zurückgenommen; die Fassungen bleiben.
 *
 * Den Wechsel auf eine Folgefassung macht `activateContractVersion`.
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

  if (vertrag.status === 'PAUSED') {
    return resumeContract(params);
  }
  if (vertrag.status === 'NOTICE_GIVEN') {
    return withdrawNotice(params);
  }

  const entwurf = vertrag.versions.find((v) => v.status === 'DRAFT');
  if (!entwurf) {
    throw new BusinessRuleError('Der Vertrag hat keine Fassung, die in Kraft gesetzt werden könnte.');
  }

  const leistungen = await prisma.contractService.count({ where: { contractVersionId: entwurf.id } });
  if (leistungen === 0) {
    throw new BusinessRuleError(
      'Ein Vertrag ohne Leistungen kann nicht in Kraft treten — er erzeugt keine Einsätze und keine Abrechnung.',
    );
  }

  const gueltigAb = await stichtagDerFassung(entwurf, params.effectiveFrom);

  const ergebnis = await prisma.$transaction(async (tx) => {
    const gesperrt = await vertragSperren(tx, { contractId: vertrag.id });
    if (!gesperrt || gesperrt.deletedAt) throw new NotFoundError('Vertrag nicht gefunden.');
    pruefeUebergang(gesperrt.status as ContractStatus, 'ACTIVE');

    const nummer = vertrag.number ?? (await nextNumber(tx, params.organizationId, 'contract')).number;

    // Der Stichtag zuerst, solange die Fassung noch Entwurf ist — der Trigger
    // lässt `effectiveFrom` an einer geltenden Fassung nicht mehr zu.
    if (gueltigAb.getTime() !== alsTag(entwurf.effectiveFrom).getTime()) {
      await tx.contractVersion.update({ where: { id: entwurf.id }, data: { effectiveFrom: gueltigAb } });
    }
    const aktiviert = await tx.contractVersion.updateMany({
      where: { id: entwurf.id, status: 'DRAFT' },
      data: { status: 'ACTIVE' },
    });
    if (aktiviert.count !== 1) {
      throw new BusinessRuleError('Die Fassung hat sich inzwischen geändert. Bitte die Seite neu laden.');
    }

    return tx.contract.update({
      where: { id: vertrag.id },
      data: {
        status: 'ACTIVE',
        number: nummer,
        noticeDeadline: kuendigungsfrist(vertrag.endDate, entwurf.noticePeriodDays),
      },
    });
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Contract',
    entityId: vertrag.id,
    summary: `Vertrag ${ergebnis.number} in Kraft gesetzt, Fassung ${entwurf.versionNumber} ab ${tagSchluessel(gueltigAb)}${params.note ? ` — ${params.note}` : ''}`,
    changes: { status: { from: vertrag.status, to: 'ACTIVE' } },
    ip: params.ip,
  });

  return ergebnis;
}

/**
 * Der Stichtag, zu dem eine Fassung gilt.
 *
 * Ohne Angabe der, den die Fassung trägt — er ist Teil dessen, was vereinbart
 * wurde. Eine abweichende Angabe nur, solange die Fassung frei ist; an einer
 * angenommenen oder in Unterzeichnung befindlichen Fassung wäre sie eine
 * Änderung am unterschriebenen Dokument (RB-006).
 */
async function stichtagDerFassung(
  fassung: { id: string; effectiveFrom: Date },
  gewuenscht: Date | undefined,
): Promise<Date> {
  const vereinbart = alsTag(fassung.effectiveFrom);
  if (!gewuenscht || alsTag(gewuenscht).getTime() === vereinbart.getTime()) return vereinbart;
  const bindung = await fassungIstGebunden(fassung.id);
  if (bindung) {
    throw new BusinessRuleError(
      `Diese Fassung ${bindung === 'ANGENOMMEN' ? 'wurde angenommen' : 'liegt zur Unterzeichnung vor'} und gilt ab ${tagSchluessel(vereinbart)}. Ein anderer Stichtag wäre eine Änderung am unterschriebenen Dokument.`,
    );
  }
  return alsTag(gewuenscht);
}

/**
 * **Fassung wechseln** — eine Folgefassung an einem laufenden Vertrag in
 * Kraft setzen.
 *
 * Der Weg „V1 aktiv → Änderung → V2 Entwurf → (Annahme) → V2 aktiv, V1
 * abgelöst", beliebig oft fortsetzbar: V2 → V3 → … Bis 2026-09-23 gab es
 * ihn nicht (RB-002).
 *
 * Was hier zugesichert wird:
 *
 *  • **Genau eine gilt.** Alte Fassung SUPERSEDED mit `effectiveUntil` =
 *    Stichtag, neue ACTIVE — in einer Transaktion, hinter der Sperre des
 *    Vertragskopfs, und zusätzlich durch den Teilindex
 *    `contract_versions_eine_aktive`.
 *  • **Die Vergangenheit bleibt.** Der Stichtag liegt nicht vor heute und
 *    nach dem Beginn der bisherigen Fassung. Die bisherige behält ihren
 *    ganzen Zeitraum bis zum Stichtag; nichts an ihr ändert sich ausser
 *    Zustand und Gültigkeitsende (Trigger `contract_versions_unveraenderlich`).
 *  • **Keine halbe Unterschrift.** Läuft ein Annahmevorgang für die neue
 *    Fassung, wird erst abgeschlossen oder zurückgezogen. Eine angenommene
 *    Fassung gilt zu ihrem vereinbarten Stichtag.
 *  • **Die Einsätze folgen.** Offene Einsätze ab dem Stichtag werden auf die
 *    neue Fassung umgestellt oder abgesagt, fehlende angelegt
 *    (`einsaetzeAbgleichen`). Einsätze vor dem Stichtag bleiben bei der alten
 *    Fassung — sie wurden unter ihr erbracht.
 */
export async function activateContractVersion(params: {
  organizationId: string;
  contractId: string;
  versionId: string;
  actorId: string;
  ip?: string | null;
  effectiveFrom?: Date;
  note?: string;
}) {
  const vertrag = await ladeVertrag(params.organizationId, params.contractId);
  if (!['ACTIVE', 'PAUSED', 'NOTICE_GIVEN'].includes(vertrag.status)) {
    throw new BusinessRuleError(
      vertrag.status === 'ENDED' || vertrag.status === 'CANCELLED'
        ? 'Ein beendeter oder stornierter Vertrag bekommt keine neue Fassung mehr.'
        : 'Der Vertrag ist noch nicht in Kraft. Die erste Fassung setzt „In Kraft setzen" wirksam.',
    );
  }

  const neu = vertrag.versions.find((v) => v.id === params.versionId);
  if (!neu) throw new NotFoundError('Vertragsversion nicht gefunden.');
  if (neu.status !== 'DRAFT') {
    throw new BusinessRuleError(
      neu.status === 'ACTIVE' ? 'Diese Fassung gilt bereits.' : 'Eine abgelöste Fassung kehrt nicht zurück.',
    );
  }
  const bisher = aktiveVersion(vertrag.versions);
  if (!bisher) throw new BusinessRuleError('Der Vertrag hat keine geltende Fassung, die abgelöst werden könnte.');

  if (!neu.acceptedAt && (await fassungIstGebunden(neu.id)) === 'IN_UNTERZEICHNUNG') {
    throw new BusinessRuleError(
      'Diese Fassung liegt zur Unterzeichnung vor. Warten Sie die Annahme ab oder ziehen Sie den Vorgang zurück.',
    );
  }

  const leistungen = await prisma.contractService.count({ where: { contractVersionId: neu.id } });
  if (leistungen === 0) {
    throw new BusinessRuleError('Eine Fassung ohne Leistungen kann nicht in Kraft treten.');
  }

  const stichtag = await stichtagDerFassung(neu, params.effectiveFrom);
  const heute = zuercherHeute();
  if (stichtag < heute) {
    throw new BusinessRuleError(
      `Eine neue Fassung gilt frühestens ab heute (${tagSchluessel(heute)}). Rückwirkend liesse sie bereits erbrachte und abgerechnete Leistungen unter anderen Konditionen erscheinen.`,
    );
  }
  if (stichtag <= alsTag(bisher.effectiveFrom)) {
    throw new BusinessRuleError(
      `Die neue Fassung muss nach dem Beginn der geltenden (${tagSchluessel(alsTag(bisher.effectiveFrom))}) wirksam werden.`,
    );
  }
  if (vertrag.endDate && stichtag > alsTag(vertrag.endDate)) {
    throw new BusinessRuleError('Der Stichtag liegt nach dem Vertragsende.');
  }

  await prisma.$transaction(async (tx) => {
    const gesperrt = await vertragSperren(tx, { contractId: vertrag.id });
    if (!gesperrt || gesperrt.deletedAt || !['ACTIVE', 'PAUSED', 'NOTICE_GIVEN'].includes(gesperrt.status)) {
      throw new BusinessRuleError('Der Vertrag hat sich inzwischen geändert. Bitte die Seite neu laden.');
    }

    const abgeloest = await tx.contractVersion.updateMany({
      where: { id: bisher.id, status: 'ACTIVE' },
      data: { status: 'SUPERSEDED', effectiveUntil: stichtag },
    });
    if (abgeloest.count !== 1) {
      throw new BusinessRuleError('Die geltende Fassung hat sich inzwischen geändert. Bitte die Seite neu laden.');
    }
    if (stichtag.getTime() !== alsTag(neu.effectiveFrom).getTime()) {
      await tx.contractVersion.update({ where: { id: neu.id }, data: { effectiveFrom: stichtag } });
    }
    const aktiviert = await tx.contractVersion.updateMany({
      where: { id: neu.id, status: 'DRAFT' },
      data: { status: 'ACTIVE' },
    });
    if (aktiviert.count !== 1) {
      throw new BusinessRuleError('Die Fassung hat sich inzwischen geändert. Bitte die Seite neu laden.');
    }

    await tx.contract.update({
      where: { id: vertrag.id },
      data: { noticeDeadline: kuendigungsfrist(vertrag.endDate, neu.noticePeriodDays) },
    });
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Contract',
    entityId: vertrag.id,
    summary: `Vertrag ${vertrag.number ?? vertrag.title}: Fassung ${neu.versionNumber} gilt ab ${tagSchluessel(stichtag)}, Fassung ${bisher.versionNumber} abgelöst${params.note ? ` — ${params.note}` : ''}`,
    changes: {
      geltendeFassung: { from: bisher.versionNumber, to: neu.versionNumber },
      stichtag: tagSchluessel(stichtag),
    },
    ip: params.ip,
  });

  const abgleich = await einsaetzeAbgleichen({
    organizationId: params.organizationId,
    contractId: vertrag.id,
    ab: stichtag,
    actorId: params.actorId,
    ip: params.ip,
    grund: `Fassung ${neu.versionNumber} ab ${tagSchluessel(stichtag)}`,
  });

  return { contractId: vertrag.id, versionId: neu.id, versionNumber: neu.versionNumber, stichtag, abgleich };
}

/**
 * Einen Versionsentwurf verwerfen.
 *
 * Ohne diese Handlung blieb ein Entwurf, den niemand mehr wollte, für immer
 * stehen — und weil es je Vertrag nur einen gibt, war der Vertrag für jede
 * weitere Änderung blockiert.
 *
 * Nicht verwerfbar ist eine **angenommene** Fassung: Die Kundschaft hat ihr
 * zugestimmt; sie verschwindet nicht still aus der Akte. Eine laufende
 * Unterzeichnung wird mit dem Verwerfen abgebrochen, in derselben
 * Transaktion.
 *
 * Verworfen heisst `DISCARDED`, nicht gelöscht: Ein zurückgezogener
 * Signaturvorgang zeigt auf die Fassung (`ON DELETE RESTRICT`) und ist ein
 * Beleg. Die Fassung bleibt lesbar und erzeugt nie etwas.
 */
export async function discardContractVersion(params: {
  organizationId: string;
  contractId: string;
  versionId: string;
  actorId: string;
  ip?: string | null;
}) {
  const version = await ladeVersion(params.organizationId, params.contractId, params.versionId);
  if (version.status !== 'DRAFT') {
    throw new BusinessRuleError('Nur ein Versionsentwurf lässt sich verwerfen. Eine Fassung, die galt, bleibt als Beleg.');
  }
  if (version.acceptedAt) {
    throw new BusinessRuleError(
      'Diese Fassung wurde von der Kundschaft angenommen und lässt sich nicht verwerfen. Sie bleibt als Beleg in der Akte.',
    );
  }
  if (version.versionNumber === 1) {
    throw new BusinessRuleError('Die erste Fassung gehört zum Vertragsentwurf. Verwerfen Sie stattdessen den Entwurf.');
  }

  await prisma.$transaction(async (tx) => {
    const gesperrt = await vertragSperren(tx, { contractId: params.contractId });
    if (!gesperrt || gesperrt.deletedAt) throw new NotFoundError('Vertrag nicht gefunden.');

    await cancelActiveContractAcceptanceInTx(tx, {
      contractVersionId: version.id,
      reason: 'version_discarded',
      cancelledById: params.actorId,
    });
    const verworfen = await tx.contractVersion.updateMany({
      where: { id: version.id, status: 'DRAFT', acceptedAt: null },
      data: { status: 'DISCARDED' },
    });
    if (verworfen.count !== 1) {
      throw new BusinessRuleError('Die Fassung hat sich inzwischen geändert. Bitte die Seite neu laden.');
    }
  });

  await audit.deleted({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ContractVersion',
    entityId: version.id,
    summary: `Versionsentwurf ${version.versionNumber} verworfen`,
    ip: params.ip,
  });
}

/**
 * Eine Kündigung zurücknehmen — der Vertrag läuft weiter wie zuvor.
 *
 * Eigener Lebenslaufschritt mit eigenem Protokolleintrag. Die Fassungen
 * bleiben unberührt; der Planer plant wieder über das Wirkungsdatum hinaus.
 */
async function withdrawNotice(params: {
  organizationId: string;
  contractId: string;
  actorId: string;
  ip?: string | null;
  note?: string;
}) {
  const vertrag = await ladeVertrag(params.organizationId, params.contractId);
  pruefeUebergang(vertrag.status, 'ACTIVE');

  const aktualisiert = await prisma.$transaction(async (tx) => {
    const frisch = await gesperrtLaden(tx, params.organizationId, vertrag.id, 'ACTIVE');
    // Zurücknehmen lässt sich nur eine Kündigung. Ohne diese Prüfung am
    // gesperrten Zustand würde ein gleichzeitig pausierter Vertrag hier
    // „fortgesetzt" — ACTIVE ist aus PAUSED ebenfalls erreichbar.
    if (frisch.status !== 'NOTICE_GIVEN') {
      throw new BusinessRuleError('Der Vertrag hat sich inzwischen geändert. Bitte die Seite neu laden.');
    }
    const geltend = aktiveVersion(frisch.versions);
    return tx.contract.update({
      where: { id: vertrag.id },
      data: {
        status: 'ACTIVE',
        noticeGivenAt: null,
        noticeGivenBy: null,
        terminationEffectiveAt: null,
        terminationReason: null,
        noticeDeadline: geltend ? kuendigungsfrist(frisch.endDate, geltend.noticePeriodDays) : frisch.noticeDeadline,
      },
    });
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Contract',
    entityId: vertrag.id,
    summary: `Kündigung von Vertrag ${vertrag.number ?? vertrag.title} zurückgenommen${params.note ? ` — ${params.note}` : ''}`,
    changes: { status: { from: 'NOTICE_GIVEN', to: 'ACTIVE' } },
    ip: params.ip,
  });

  await einsaetzeAbgleichen({
    organizationId: params.organizationId,
    contractId: vertrag.id,
    ab: zuercherHeute(),
    actorId: params.actorId,
    ip: params.ip,
    grund: 'Kündigung zurückgenommen',
  });

  return aktualisiert;
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

  /**
   * Eine Pause wirkt ab heute oder später, nie rückwirkend.
   *
   * Rückwirkend hiesse: Einsätze, die schon geleistet wurden, lägen in einer
   * „Pause" — und die Abrechnung nach Einsätzen fragte, ob sie zählen. Und
   * das Ende liegt nach dem Beginn, sonst wäre es keine Pause.
   */
  const heute = zuercherHeute();
  const von = alsTag(params.pausedFrom);
  const bis = params.pausedUntil ? alsTag(params.pausedUntil) : null;
  if (von < heute) {
    throw new BusinessRuleError(`Eine Pause beginnt frühestens heute (${tagSchluessel(heute)}).`);
  }
  if (bis && bis < von) {
    throw new BusinessRuleError('Das Ende der Pause liegt vor ihrem Beginn.');
  }

  const aktualisiert = await prisma.$transaction(async (tx) => {
    await gesperrtLaden(tx, params.organizationId, vertrag.id, 'PAUSED');
    return tx.contract.update({
      where: { id: vertrag.id },
      data: { status: 'PAUSED', pausedFrom: von, pausedUntil: bis, pauseReason: params.reason },
    });
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Contract',
    entityId: vertrag.id,
    summary:
      `Vertrag ${vertrag.number ?? vertrag.title} pausiert ab ${tagSchluessel(von)}` +
      `${bis ? ` bis ${tagSchluessel(bis)}` : ' (unbefristet)'} — ${params.reason}`,
    ip: params.ip,
  });

  /**
   * Die Pause wirkt auf bereits geplante Einsätze. Bis 2026-09-23 hielt sie
   * nur den Planer an; die 60 Tage, die er schon erzeugt hatte, blieben
   * stehen, und das Team fuhr vor eine verschlossene Tür (RB-007). Vor der
   * Pause liegende Termine bleiben; danach plant der Planer wieder.
   */
  await einsaetzeAbgleichen({
    organizationId: params.organizationId,
    contractId: vertrag.id,
    ab: von,
    actorId: params.actorId,
    ip: params.ip,
    grund: `Pause ab ${tagSchluessel(von)}`,
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
  if (vertrag.status !== 'PAUSED') {
    throw new BusinessRuleError('Fortsetzen lässt sich nur ein pausierter Vertrag.');
  }

  const aktualisiert = await prisma.$transaction(async (tx) => {
    const frisch = await gesperrtLaden(tx, params.organizationId, vertrag.id, 'ACTIVE');
    // Wie oben beim Zurücknehmen: ACTIVE ist auch aus NOTICE_GIVEN
    // erreichbar, Fortsetzen aber nur aus der Pause.
    if (frisch.status !== 'PAUSED') {
      throw new BusinessRuleError('Fortsetzen lässt sich nur ein pausierter Vertrag.');
    }
    return tx.contract.update({
      where: { id: vertrag.id },
      data: { status: 'ACTIVE', pausedFrom: null, pausedUntil: null, pauseReason: null },
    });
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Contract',
    entityId: vertrag.id,
    summary: `Vertrag ${vertrag.number ?? vertrag.title} wieder aufgenommen`,
    changes: { status: { from: 'PAUSED', to: 'ACTIVE' } },
    ip: params.ip,
  });

  /**
   * **Ab heute, nicht ab der Pause.** Bis 2026-09-23 plante der nächste Lauf
   * ab seiner Fortschrittsmarke — also für das ganze Pausenfenster,
   * rückwirkend. Der Abgleich setzt die Untergrenze auf heute in Zürich; was
   * in der Pause lag und vorbei ist, bleibt ungeplant.
   */
  await einsaetzeAbgleichen({
    organizationId: params.organizationId,
    contractId: vertrag.id,
    ab: zuercherHeute(),
    actorId: params.actorId,
    ip: params.ip,
    grund: 'Vertrag fortgesetzt',
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

  if (!aktiveVersion(vertrag.versions)) throw new BusinessRuleError('Der Vertrag hat keine geltende Fassung.');

  /**
   * Ohne Angabe: **heute in Zürich**, nicht der UTC-Tag (N-02, 2026-09-27).
   * `alsTag(new Date())` schnitt die Uhrzeit in UTC ab; zwischen Mitternacht
   * und 01:00 (Winter) bzw. 02:00 (Sommer) Zürcher Zeit ist das noch der
   * Vortag. Eine Kündigung, die kurz nach Mitternacht erfasst wurde, trug so
   * das Datum von gestern — und rechnete ihre Frist ab dort, einen Tag zu
   * früh. Alle anderen Vorgaben dieses Dienstes nehmen bereits
   * `zuercherHeute()`.
   */
  const gekuendigtAm = params.noticeGivenAt ? alsTag(params.noticeGivenAt) : zuercherHeute();

  const { aktualisiert, wirkung } = await prisma.$transaction(async (tx) => {
    const frisch = await gesperrtLaden(tx, params.organizationId, vertrag.id, 'NOTICE_GIVEN');
    // Die Frist der Fassung, die **jetzt** gilt — ein gleichzeitiger
    // Fassungswechsel hält dieselbe Sperre und ist vorher oder nachher fertig.
    const geltend = aktiveVersion(frisch.versions);
    if (!geltend) throw new BusinessRuleError('Der Vertrag hat keine geltende Fassung.');
    const wirkung =
      params.terminationEffectiveAt
        ? alsTag(params.terminationEffectiveAt)
        : kuendigungswirkung({
            gekuendigtAm,
            noticePeriodDays: geltend.noticePeriodDays,
            vertragsende: frisch.endDate,
            renewalType: geltend.renewalType,
            renewalPeriodMonths: geltend.renewalPeriodMonths,
          });

    const aktualisiert = await tx.contract.update({
      where: { id: vertrag.id },
      data: {
        status: 'NOTICE_GIVEN',
        // Der Tag, an dem gekündigt wurde — nicht der, an dem es jemand
        // erfasst hat. Bis 2026-09-23 stand hier `new Date()`, und eine
        // nachgetragene Kündigung trug das falsche Datum.
        noticeGivenAt: gekuendigtAm,
        noticeGivenBy: params.noticeGivenBy,
        terminationEffectiveAt: wirkung,
        terminationReason: params.reason ?? null,
      },
    });
    return { aktualisiert, wirkung };
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Contract',
    entityId: vertrag.id,
    summary: `Kündigung erfasst (${params.noticeGivenBy === 'CUSTOMER' ? 'Kundschaft' : 'Firma'}) am ${tagSchluessel(gekuendigtAm)}, Wirkung ${tagSchluessel(wirkung)}`,
    ip: params.ip,
  });

  // Nach der Wirkung verlangt der Vertrag nichts mehr — bereits geplante
  // Einsätze dahinter werden abgesagt.
  await einsaetzeAbgleichen({
    organizationId: params.organizationId,
    contractId: vertrag.id,
    ab: plusTage(wirkung, 1),
    actorId: params.actorId,
    ip: params.ip,
    grund: `Kündigung, Wirkung ${tagSchluessel(wirkung)}`,
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

  // Heute in Zürich, nicht der UTC-Tag — siehe `giveNotice` (N-02).
  const heute = zuercherHeute();

  /**
   * Mit dem Ende verlangt der Vertrag nichts mehr.
   *
   * Bis 2026-09-23 wurden dazu die Einsatzpläne **aller** Fassungen
   * stillgelegt (`active: false`, `effectiveUntil`) — ein Schreibzugriff auf
   * die Konditionen geltender und abgelöster Fassungen, den der Trigger
   * `service_schedules_unveraenderlich` jetzt verweigert. Er war auch unnötig:
   * Der Planer plant für einen beendeten Vertrag nichts
   * (`solltermine`). Stattdessen werden bereits geplante Einsätze nach dem
   * Ende abgesagt.
   */
  const { aktualisiert, ende } = await prisma.$transaction(async (tx) => {
    // Wirkungsdatum und Grund vom gesperrten Stand: Eine gleichzeitig
    // zurückgenommene Kündigung hat beides womöglich gerade geleert.
    const frisch = await gesperrtLaden(tx, params.organizationId, vertrag.id, 'ENDED');
    const ende = frisch.terminationEffectiveAt ?? frisch.endDate ?? heute;
    const aktualisiert = await tx.contract.update({
      where: { id: vertrag.id },
      data: {
        status: 'ENDED',
        endDate: ende,
        terminationReason: params.reason ?? frisch.terminationReason,
      },
    });
    return { aktualisiert, ende };
  });

  await einsaetzeAbgleichen({
    organizationId: params.organizationId,
    contractId: vertrag.id,
    ab: plusTage(alsTag(ende), 1),
    actorId: params.actorId,
    ip: params.ip,
    grund: `Vertrag beendet per ${tagSchluessel(alsTag(ende))}`,
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

  /**
   * Stornieren und Unterschreiben serialisieren sich über die Sperre des
   * Vertragskopfs (`vertragSperren`). Gewinnt die Stornierung, findet die
   * Annahme danach „storniert" vor und schliesst nicht ab; gewinnt die
   * Annahme, sieht die Stornierung „offeriert" mit angenommener Fassung —
   * das ist der zulässige Hergang „angenommen, danach verworfen". Was nie
   * entsteht, ist ein stornierter Vertrag mit einer **danach** angenommenen
   * Fassung (RB-005).
   */
  const aktualisiert = await prisma.$transaction(async (tx) => {
    const gesperrt = await vertragSperren(tx, { contractId: vertrag.id });
    if (!gesperrt || gesperrt.deletedAt) throw new NotFoundError('Vertrag nicht gefunden.');
    pruefeUebergang(gesperrt.status as ContractStatus, 'CANCELLED');
    await keineAngenommeneFassung(tx, vertrag.id, 'annullieren');

    const storniert = await tx.contract.update({
      where: { id: vertrag.id },
      data: { status: 'CANCELLED', terminationReason: params.reason ?? null },
    });
    await cancelAllContractAcceptancesInTx(tx, {
      contractId: vertrag.id,
      reason: 'contract_cancelled',
      cancelledById: params.actorId,
    });
    return storniert;
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
  /**
   * Die Fassung, unter der dieser Zeitraum abgerechnet wird. Ohne Angabe die,
   * die am **ersten Tag des Zeitraums** galt — nicht die heute geltende. Bis
   * 2026-09-23 war es die heute geltende, und wer im April den Januar
   * abrechnete, bekam den Aprilpreis (RB-008).
   */
  versionId?: string;
  /**
   * Zeitlicher Anteil an der vollen Periode (0 < anteil ≤ 1), wenn der
   * Zeitraum an einer Fassungs- oder Vertragsgrenze gekürzt ist. Betrifft
   * nur Pauschalen; nach Einsätzen, Stunden oder Einheiten wird ohnehin
   * gezählt, was im Zeitraum lag.
   */
  anteil?: number;
}) {
  const vertrag = await prisma.contract.findFirst({
    where: { id: params.contractId, organizationId: params.organizationId, deletedAt: null },
    include: { versions: { orderBy: { versionNumber: 'desc' } } },
  });
  if (!vertrag) throw new NotFoundError('Vertrag nicht gefunden.');

  const beginn = alsTag(params.von);
  const geltend = params.versionId
    ? vertrag.versions.find((v) => v.id === params.versionId)
    : vertrag.versions.find(
        (v) =>
          (v.status === 'ACTIVE' || v.status === 'SUPERSEDED') &&
          alsTag(v.effectiveFrom) <= beginn &&
          (!v.effectiveUntil || beginn < alsTag(v.effectiveUntil)),
      );
  if (!geltend) {
    throw new BusinessRuleError(`Am ${tagSchluessel(beginn)} galt keine Fassung dieses Vertrags.`);
  }
  const anteil = Math.min(1, Math.max(0, params.anteil ?? 1));

  const einsaetze = await prisma.job.findMany({
    where: {
      contractId: vertrag.id,
      scheduledStart: { gte: params.von, lt: params.bis },
      status: { in: ['COMPLETED', 'VERIFIED'] },
      deletedAt: null,
    },
    select: { id: true, number: true, contractVersionId: true, scheduledStart: true, estimatedMin: true },
    orderBy: { scheduledStart: 'asc' },
  });

  const stunden = await prisma.timeEntry.aggregate({
    where: {
      // Abgesagte und gelöschte Einsätze zählen nicht — auch wenn jemand
      // darauf Zeit erfasst hat. Das gehört geklärt, nicht verrechnet.
      job: {
        contractId: vertrag.id,
        scheduledStart: { gte: params.von, lt: params.bis },
        status: { not: 'CANCELLED' },
        deletedAt: null,
      },
      approved: true,
    },
    _sum: { minutes: true },
  });
  const freigegebeneMinuten = stunden._sum.minutes ?? 0;

  let netto = 0;
  let herleitung = '';

  switch (geltend.pricingModel) {
    case 'FIXED_PERIOD':
      netto = toNumber(geltend.baseAmount) * anteil;
      herleitung =
        anteil < 1
          ? `Pauschale je Periode (${geltend.billingCycle}) ${toNumber(geltend.baseAmount).toFixed(2)} × ${(anteil * 100).toFixed(2)} % Zeitanteil (Kalendertage)`
          : `Pauschale je Periode (${geltend.billingCycle})`;
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
      netto = gesamtmenge * toNumber(geltend.unitPrice ?? 0) * anteil;
      herleitung =
        `${gesamtmenge} ${geltend.unitLabel ?? 'Einheiten'} × ${toNumber(geltend.unitPrice ?? 0).toFixed(4)}` +
        (anteil < 1 ? ` × ${(anteil * 100).toFixed(2)} % Zeitanteil (Kalendertage)` : '');
      break;
    }
    default:
      netto = toNumber(geltend.baseAmount) * anteil;
      herleitung =
        'Abweichende Vereinbarung — Betrag aus der Vertragsversion' +
        (anteil < 1 ? `, ${(anteil * 100).toFixed(2)} % Zeitanteil (Kalendertage)` : '');
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
