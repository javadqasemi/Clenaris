import 'server-only';

import { audit } from '@/lib/audit';
import { alsTag } from '@/lib/contracts/serie';
import { prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import type {
  ContractAmendmentCreateInput,
  ContractServiceInput,
  ContractVersionInput,
  PriceAdjustmentCreateInput,
} from '@/lib/validation/contracts';

import { aktiveVersion, createContractVersion } from './contract.service';

/**
 * Vertragsänderungen und Preisanpassungen.
 *
 * ---------------------------------------------------------------------------
 *  Warum der Antrag nicht die Änderung ist
 * ---------------------------------------------------------------------------
 *
 * Ein Änderungsantrag durchläuft Entwurf → Prüfung → Freigabe und wird erst
 * dann wirksam, indem er eine **neue Vertragsversion** erzeugt. Drei Gründe,
 * und der dritte ist der wichtige:
 *
 *  1. Eine Änderung braucht eine Zustimmung, und die ist ein eigener Vorgang
 *     mit eigenem Zeitpunkt und eigener Person.
 *  2. Zwischen Antrag und Wirksamkeit liegt oft ein Stichtag in der Zukunft.
 *  3. **Die Version allein sagt nur, *dass* sich etwas geändert hat.** Warum,
 *     auf wessen Wunsch und wer zugestimmt hat, steht im Antrag — und genau
 *     das wird gefragt, wenn ein halbes Jahr später jemand über den Preis
 *     stolpert.
 *
 * ---------------------------------------------------------------------------
 *  Vier-Augen-Prinzip
 * ---------------------------------------------------------------------------
 *
 * Beantragen (`contract:version`) und freigeben (`contract:approve`) sind
 * getrennte Rechte, und die Betriebsleitung hat nur das erste. Hier steht die
 * zweite Hälfte davon: Wer freigibt, wird festgehalten, und ein Antrag ohne
 * Antragsteller lässt sich nicht freigeben.
 */

async function ladeVertragMitVersionen(organizationId: string, contractId: string) {
  const vertrag = await prisma.contract.findFirst({
    where: { id: contractId, organizationId, deletedAt: null },
    include: { versions: { orderBy: { versionNumber: 'desc' } } },
  });
  if (!vertrag) throw new NotFoundError('Vertrag nicht gefunden.');
  return vertrag;
}

// ---------------------------------------------------------------------------
//  Änderungsanträge
// ---------------------------------------------------------------------------

export async function createAmendment(params: {
  organizationId: string;
  contractId: string;
  actorId: string;
  ip?: string | null;
  input: ContractAmendmentCreateInput;
}) {
  const vertrag = await ladeVertragMitVersionen(params.organizationId, params.contractId);

  if (vertrag.status !== 'ACTIVE' && vertrag.status !== 'PAUSED') {
    throw new BusinessRuleError(
      'Änderungsanträge gibt es nur zu einem laufenden Vertrag. Ein Entwurf wird direkt geändert.',
    );
  }

  const geltend = aktiveVersion(vertrag.versions);
  if (!geltend) throw new BusinessRuleError('Der Vertrag hat keine geltende Fassung.');

  const offen = await prisma.contractAmendment.findFirst({
    where: { contractId: vertrag.id, status: { in: ['DRAFT', 'REVIEW', 'APPROVED'] } },
    select: { id: true, title: true, status: true },
  });
  if (offen) {
    throw new BusinessRuleError(
      `Es läuft bereits ein Änderungsantrag („${offen.title}"). Schliessen Sie ihn ab oder lehnen Sie ihn ab.`,
    );
  }

  const antrag = await prisma.contractAmendment.create({
    data: {
      contractId: vertrag.id,
      type: params.input.type,
      status: 'REVIEW',
      title: params.input.title,
      description: params.input.description ?? null,
      reason: params.input.reason,
      effectiveFrom: params.input.effectiveFrom,
      requestedById: params.actorId,
      previousVersionId: geltend.id,
    },
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ContractAmendment',
    entityId: antrag.id,
    summary: `Änderungsantrag „${antrag.title}" (${antrag.type}) zu Vertrag ${vertrag.number ?? vertrag.title}`,
    ip: params.ip,
  });

  return antrag;
}

export async function decideAmendment(params: {
  organizationId: string;
  contractId: string;
  amendmentId: string;
  actorId: string;
  ip?: string | null;
  entscheidung: 'APPROVE' | 'REJECT';
  reason?: string;
}) {
  const antrag = await prisma.contractAmendment.findFirst({
    where: {
      id: params.amendmentId,
      contractId: params.contractId,
      contract: { organizationId: params.organizationId, deletedAt: null },
    },
  });
  if (!antrag) throw new NotFoundError('Änderungsantrag nicht gefunden.');

  if (antrag.status !== 'REVIEW' && antrag.status !== 'DRAFT') {
    throw new BusinessRuleError('Über diesen Antrag ist bereits entschieden.');
  }

  /**
   * Niemand gibt den eigenen Antrag frei.
   *
   * Der Rechteschnitt allein reichte nicht: Die Administration hat beide
   * Rechte, und genau dort ist die Versuchung am grössten. Die Prüfung steht
   * deshalb im Dienst und nicht nur in der Rollentabelle.
   */
  if (params.entscheidung === 'APPROVE' && antrag.requestedById === params.actorId) {
    throw new BusinessRuleError(
      'Einen selbst gestellten Änderungsantrag kann man nicht freigeben. Eine zweite Person muss zustimmen.',
    );
  }

  const aktualisiert = await prisma.contractAmendment.update({
    where: { id: antrag.id },
    data:
      params.entscheidung === 'APPROVE'
        ? { status: 'APPROVED', approvedAt: new Date(), approvedById: params.actorId }
        : { status: 'REJECTED', rejectedAt: new Date(), rejectReason: params.reason ?? null, approvedById: params.actorId },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ContractAmendment',
    entityId: antrag.id,
    summary:
      params.entscheidung === 'APPROVE'
        ? `Änderungsantrag „${antrag.title}" freigegeben`
        : `Änderungsantrag „${antrag.title}" abgelehnt${params.reason ? ` — ${params.reason}` : ''}`,
    ip: params.ip,
  });

  return aktualisiert;
}

/**
 * Einen freigegebenen Antrag wirksam machen.
 *
 * Das Ergebnis ist eine **neue Vertragsversion im Entwurf** — nicht die
 * sofortige Umstellung. Aktiv wird sie durch das Aktivieren des Vertrags mit
 * dem Stichtag, und das ist eine eigene Handlung mit eigenem Recht.
 *
 * Der Antrag trägt danach beide Versionen: die abgelöste und die neue. Damit
 * ist die Frage „was genau hat sich geändert" beantwortbar, ohne zwei Zeilen
 * von Hand nebeneinanderzulegen.
 */
export async function applyAmendment(params: {
  organizationId: string;
  contractId: string;
  amendmentId: string;
  actorId: string;
  ip?: string | null;
  version: ContractVersionInput;
  services?: ContractServiceInput[];
}) {
  const antrag = await prisma.contractAmendment.findFirst({
    where: {
      id: params.amendmentId,
      contractId: params.contractId,
      contract: { organizationId: params.organizationId, deletedAt: null },
    },
  });
  if (!antrag) throw new NotFoundError('Änderungsantrag nicht gefunden.');
  if (antrag.status !== 'APPROVED') {
    throw new BusinessRuleError('Nur ein freigegebener Antrag lässt sich wirksam machen.');
  }

  const version = await createContractVersion({
    organizationId: params.organizationId,
    contractId: params.contractId,
    actorId: params.actorId,
    ip: params.ip,
    input: { ...params.version, reason: `${antrag.title}: ${antrag.reason}` },
    services: params.services,
  });

  const aktualisiert = await prisma.contractAmendment.update({
    where: { id: antrag.id },
    data: { status: 'EFFECTIVE', appliedAt: new Date(), newVersionId: version.id },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ContractAmendment',
    entityId: antrag.id,
    summary: `Änderungsantrag „${antrag.title}" übernommen — Versionsentwurf ${version.versionNumber} angelegt; wirksam mit „Fassung in Kraft setzen"`,
    ip: params.ip,
  });

  return { amendment: aktualisiert, version };
}

// ---------------------------------------------------------------------------
//  Preisanpassungen
// ---------------------------------------------------------------------------

/**
 * Eine Preisanpassung vorschlagen.
 *
 * **Keine Behauptung über Schweizer Indexierungsregeln.** Ob und wie ein
 * Vertrag indexiert wird, steht im Vertrag; `indexReference` hält fest, worauf
 * sich die Parteien geeinigt haben, und die Indexwerte werden erfasst, nicht
 * abgerufen. Eine Anpassung wird nie automatisch wirksam — sie braucht eine
 * Freigabe und erzeugt dann eine neue Vertragsversion.
 */
export async function createPriceAdjustment(params: {
  organizationId: string;
  contractId: string;
  actorId: string;
  ip?: string | null;
  input: PriceAdjustmentCreateInput;
}) {
  const vertrag = await ladeVertragMitVersionen(params.organizationId, params.contractId);
  const geltend = aktiveVersion(vertrag.versions);
  if (!geltend) throw new BusinessRuleError('Der Vertrag hat keine geltende Fassung.');

  const alt = toNumber(geltend.baseAmount);
  if (params.input.newAmount === alt) {
    throw new BusinessRuleError('Der neue Betrag entspricht dem bisherigen — es gibt nichts anzupassen.');
  }

  const anpassung = await prisma.contractPriceAdjustment.create({
    data: {
      contractId: vertrag.id,
      contractVersionId: geltend.id,
      status: 'PLANNED',
      effectiveFrom: params.input.effectiveFrom,
      reviewDueAt: params.input.reviewDueAt ?? null,
      oldAmount: alt,
      newAmount: params.input.newAmount,
      percent:
        params.input.percent ??
        (alt > 0 ? Math.round(((params.input.newAmount - alt) / alt) * 100_000) / 1000 : null),
      indexReference: params.input.indexReference ?? geltend.indexReference,
      indexOldValue: params.input.indexOldValue ?? geltend.indexBaseValue,
      indexNewValue: params.input.indexNewValue ?? null,
      reason: params.input.reason,
      proposedById: params.actorId,
    },
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ContractPriceAdjustment',
    entityId: anpassung.id,
    summary: `Preisanpassung vorgeschlagen: ${alt.toFixed(2)} → ${params.input.newAmount.toFixed(2)} ${geltend.currency} ab ${alsTag(params.input.effectiveFrom).toISOString().slice(0, 10)}`,
    ip: params.ip,
  });

  return anpassung;
}

export async function decidePriceAdjustment(params: {
  organizationId: string;
  contractId: string;
  adjustmentId: string;
  actorId: string;
  ip?: string | null;
  entscheidung: 'APPROVE' | 'REJECT';
  reason?: string;
}) {
  const anpassung = await prisma.contractPriceAdjustment.findFirst({
    where: {
      id: params.adjustmentId,
      contractId: params.contractId,
      contract: { organizationId: params.organizationId, deletedAt: null },
    },
  });
  if (!anpassung) throw new NotFoundError('Preisanpassung nicht gefunden.');
  if (anpassung.status !== 'PLANNED') {
    throw new BusinessRuleError('Über diese Preisanpassung ist bereits entschieden.');
  }
  if (params.entscheidung === 'APPROVE' && anpassung.proposedById === params.actorId) {
    throw new BusinessRuleError(
      'Eine selbst vorgeschlagene Preisanpassung kann man nicht freigeben. Eine zweite Person muss zustimmen.',
    );
  }

  const aktualisiert = await prisma.contractPriceAdjustment.update({
    where: { id: anpassung.id },
    data:
      params.entscheidung === 'APPROVE'
        ? { status: 'APPROVED', approvedAt: new Date(), approvedById: params.actorId }
        : { status: 'REJECTED', rejectedAt: new Date(), rejectReason: params.reason ?? null, approvedById: params.actorId },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ContractPriceAdjustment',
    entityId: anpassung.id,
    summary:
      params.entscheidung === 'APPROVE'
        ? `Preisanpassung freigegeben (${toNumber(anpassung.oldAmount).toFixed(2)} → ${toNumber(anpassung.newAmount).toFixed(2)})`
        : `Preisanpassung abgelehnt${params.reason ? ` — ${params.reason}` : ''}`,
    ip: params.ip,
  });

  return aktualisiert;
}

/**
 * Eine freigegebene Preisanpassung in eine Vertragsversion überführen.
 *
 * Die neue Version übernimmt alle Konditionen der geltenden Fassung und
 * ändert genau einen Wert — den Betrag. Eine Preisanpassung, die nebenbei
 * etwas anderes verschöbe, wäre keine Preisanpassung mehr.
 */
export async function applyPriceAdjustment(params: {
  organizationId: string;
  contractId: string;
  adjustmentId: string;
  actorId: string;
  ip?: string | null;
}) {
  const anpassung = await prisma.contractPriceAdjustment.findFirst({
    where: {
      id: params.adjustmentId,
      contractId: params.contractId,
      contract: { organizationId: params.organizationId, deletedAt: null },
    },
  });
  if (!anpassung) throw new NotFoundError('Preisanpassung nicht gefunden.');
  if (anpassung.status !== 'APPROVED') {
    throw new BusinessRuleError('Nur eine freigegebene Preisanpassung lässt sich wirksam machen.');
  }

  const vertrag = await ladeVertragMitVersionen(params.organizationId, params.contractId);
  const geltend = aktiveVersion(vertrag.versions);
  if (!geltend) throw new BusinessRuleError('Der Vertrag hat keine geltende Fassung.');

  const version = await createContractVersion({
    organizationId: params.organizationId,
    contractId: params.contractId,
    actorId: params.actorId,
    ip: params.ip,
    input: {
      effectiveFrom: anpassung.effectiveFrom,
      reason: `Preisanpassung: ${anpassung.reason}`,
      minimumTermMonths: geltend.minimumTermMonths ?? undefined,
      renewalType: geltend.renewalType,
      renewalPeriodMonths: geltend.renewalPeriodMonths ?? undefined,
      noticePeriodDays: geltend.noticePeriodDays,
      billingCycle: geltend.billingCycle,
      paymentTermDays: geltend.paymentTermDays,
      currency: geltend.currency,
      pricingModel: geltend.pricingModel,
      baseAmount: toNumber(anpassung.newAmount),
      hourlyRate: geltend.hourlyRate ? toNumber(geltend.hourlyRate) : undefined,
      unitPrice: geltend.unitPrice ? toNumber(geltend.unitPrice) : undefined,
      unitLabel: geltend.unitLabel ?? undefined,
      vatRate: toNumber(geltend.vatRate),
      indexReference: anpassung.indexReference ?? undefined,
      indexBaseValue: anpassung.indexNewValue ? toNumber(anpassung.indexNewValue) : undefined,
      nextReviewAt: anpassung.reviewDueAt ?? undefined,
      targetQualityScore: geltend.targetQualityScore ?? undefined,
      inspectionIntervalDays: geltend.inspectionIntervalDays ?? undefined,
      responseHours: geltend.responseHours ?? undefined,
      slaNote: geltend.slaNote ?? undefined,
      terms: geltend.terms ?? undefined,
      internalNote: geltend.internalNote ?? undefined,
    },
  });

  /**
   * `contractVersionId` bleibt die **Ausgangsfassung**; das Ergebnis steht in
   * `resultVersionId`. Bis 2026-09-23 wurde die Ausgangsfassung hier
   * überschrieben, und die Frage „auf welchen Preis bezog sich +3 %" hatte
   * danach keine Antwort mehr.
   */
  const aktualisiert = await prisma.contractPriceAdjustment.update({
    where: { id: anpassung.id },
    data: { status: 'APPLIED', appliedAt: new Date(), resultVersionId: version.id },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'ContractPriceAdjustment',
    entityId: anpassung.id,
    summary: `Preisanpassung übernommen — Versionsentwurf ${version.versionNumber} angelegt; wirksam mit „Fassung in Kraft setzen"`,
    ip: params.ip,
  });

  return { adjustment: aktualisiert, version };
}
