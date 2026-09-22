import 'server-only';

import { abrechnungsperiode, alsTag, plusTage, type Abrechnungszyklus } from '@/lib/contracts/serie';
import { isUniqueConstraintError, prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';

import { aktiveVersion, contractBillingBasis } from './contract.service';
import { createInvoice } from './invoice.service';

/**
 * Rechnungen aus einem Vertrag.
 *
 * ---------------------------------------------------------------------------
 *  Die Zusicherung
 * ---------------------------------------------------------------------------
 *
 * **Eine Periode, eine Rechnung.** Nicht als Prüfung im Code, sondern als
 * Teilindex in der Datenbank:
 *
 * ```sql
 * CREATE UNIQUE INDEX "invoices_vertragsperiode_einmal"
 *   ON "invoices" ("contractId", "contractPeriodStart")
 *   WHERE "contractId" IS NOT NULL AND "status" <> 'CANCELLED' AND "deletedAt" IS NULL;
 * ```
 *
 * Dieselbe Überlegung wie beim Serienplaner: Zwischen „gibt es schon eine
 * Rechnung?" und `INSERT` liegt ein Moment, und ein zweiter Lauf, ein
 * Wiederholungsversuch nach einem Abbruch oder ein zweiter Klick passt genau
 * hinein. Der Dienst prüft deshalb zwar zuerst — das erspart im Normalfall
 * eine vergebliche Transaktion —, verlässt sich aber auf den Index und wertet
 * dessen Verstoss als „war schon da". Eine Prüfung allein wäre eine Wette auf
 * die Zeit.
 *
 * **Storniert zählt nicht mit.** Eine zurückgenommene Rechnung darf die
 * Periode nicht für immer blockieren, sonst liesse sich ein Fehler nie
 * korrigieren. Daher der Teilindex und kein gewöhnlicher.
 *
 * **Die Periode ist kanonisch.** Sie entsteht aus dem Abrechnungszyklus der
 * geltenden Vertragsversion und einem Stichtag; zwei Stichtage im selben Monat
 * ergeben dieselbe Periode. Ein frei wählbarer Zeitraum wäre kein Schlüssel:
 * Man könnte beliebig viele sich überlappende „Perioden" bilden und jede
 * einzeln fakturieren — genau die Doppelabrechnung, die hier ausgeschlossen
 * sein soll.
 *
 * ---------------------------------------------------------------------------
 *  Was hier nicht passiert
 * ---------------------------------------------------------------------------
 *
 * Der Beleg entsteht nicht hier, sondern über `createInvoice`. Nummernkreis,
 * QR-Referenz, Summenrechnung und Audit-Eintrag bleiben damit an einer
 * Stelle; dieser Dienst steuert nur bei, *was* abzurechnen ist und *zu
 * welcher Periode* es gehört. Eine zweite Belegerzeugung neben der
 * bestehenden wäre ein zweiter Nummernkreis mit eigenen Lücken.
 *
 * Eine **ausgestellte** Rechnung wird nie verändert. Korrekturen laufen über
 * Gutschrift und Stornierung — dieselbe Regel wie im ganzen Finanzteil. Der
 * Vertrag darf sich danach beliebig ändern; die Rechnung trägt die Version,
 * unter der sie entstanden ist, und bleibt nachrechenbar.
 */

export interface Vertragsrechnung {
  invoiceId: string;
  number: string;
  status: string;
  /** true = in diesem Aufruf entstanden, false = es gab sie schon. */
  neu: boolean;
  periodStart: Date;
  periodEnd: Date;
  periodLabel: string;
  contractId: string;
  contractVersionId: string;
  versionNumber: number;
  netto: number;
  brutto: number;
}

/** Ein Tag vor heute — liegt also in der vorigen Periode. */
function vorigerTag(): Date {
  return plusTage(alsTag(new Date()), -1);
}

/**
 * Die Rechnung für eine Vertragsperiode erzeugen — oder die bestehende
 * zurückgeben.
 *
 * Idempotent: Ein zweiter Aufruf für dieselbe Periode legt nichts an und
 * meldet `neu: false`. Das ist die Antwort auf „zweimal geklickt", auf einen
 * Wiederholungsversuch nach einem Netzabbruch und auf zwei gleichzeitige
 * Läufe.
 */
export async function createContractInvoice(params: {
  organizationId: string;
  contractId: string;
  actorId: string;
  /** Irgendein Tag in der gewünschten Periode. Ohne Angabe: die vorige Periode. */
  stichtag?: Date;
  /** true = sofort ausstellen (Nummer vergeben, unveränderlich). */
  sofortAusstellen?: boolean;
}): Promise<Vertragsrechnung> {
  const vertrag = await prisma.contract.findFirst({
    where: { id: params.contractId, organizationId: params.organizationId, deletedAt: null },
    include: { versions: { orderBy: { versionNumber: 'desc' } } },
  });
  if (!vertrag) throw new NotFoundError('Vertrag');

  const geltend = aktiveVersion(vertrag.versions);
  if (!geltend) throw new BusinessRuleError('Der Vertrag hat keine geltende Fassung.');

  /**
   * Ein Entwurf wird nicht fakturiert.
   *
   * Der Fall, den das verhindert: Jemand legt einen Vertrag an, klickt sich
   * durch und erzeugt eine Rechnung über eine Leistung, die nie vereinbart
   * wurde. Beendete und gekündigte Verträge dürfen dagegen noch abgerechnet
   * werden — die letzte Periode wird naturgemäss nach dem Ende fakturiert.
   */
  if (!['ACTIVE', 'PAUSED', 'NOTICE_GIVEN', 'ENDED'].includes(vertrag.status)) {
    throw new BusinessRuleError(
      'Nur ein Vertrag, der in Kraft ist oder war, lässt sich abrechnen.',
    );
  }

  const periode = abrechnungsperiode(
    geltend.billingCycle as Abrechnungszyklus,
    params.stichtag ?? vorigerTag(),
  );

  const bestehend = await vorhandeneRechnung(vertrag.id, periode);
  if (bestehend) return bestehend;

  const grundlage = await contractBillingBasis({
    organizationId: params.organizationId,
    contractId: vertrag.id,
    von: periode.start,
    bis: periode.endeExklusiv,
  });

  if (grundlage.netto <= 0) {
    throw new BusinessRuleError(
      `Für ${periode.label} ergibt sich kein Betrag. Bei Abrechnung nach Einsätzen oder Stunden entsteht die Rechnung erst, wenn es etwas abzurechnen gibt.`,
    );
  }

  const ausstellung = alsTag(new Date());

  try {
    const rechnung = await createInvoice({
      organizationId: params.organizationId,
      actorId: params.actorId,
      vertrag: {
        contractId: vertrag.id,
        contractVersionId: geltend.id,
        contractPeriodStart: periode.start,
      },
      input: {
        customerId: vertrag.customerId,
        issueDate: ausstellung,
        dueDate: plusTage(ausstellung, geltend.paymentTermDays),
        periodFrom: periode.start,
        periodTo: plusTage(periode.endeExklusiv, -1),
        /**
         * Die Herkunft steht auf dem Beleg, nicht nur im Protokoll. Eine
         * Vertragsrechnung ohne Hinweis auf Vertrag, Fassung und Zeitraum
         * erzeugt eine Rückfrage je Monat — und lässt sich nach einer
         * Preisanpassung nicht mehr einordnen.
         */
        introText: `${vertrag.title} · Vertrag ${vertrag.number ?? '—'} · Fassung ${geltend.versionNumber} · Zeitraum ${periode.label}`,
        notes: grundlage.herleitung,
        discountAmount: 0,
        issueImmediately: params.sofortAusstellen ?? false,
        items: [
          {
            name: `${vertrag.title} — ${periode.label}`,
            description: grundlage.herleitung,
            quantity: 1,
            unit: 'Pauschale',
            unitPrice: grundlage.netto,
            discount: 0,
            vatRate: grundlage.mwstSatz,
          },
        ],
      },
    });

    return {
      invoiceId: rechnung.id,
      number: rechnung.number,
      status: rechnung.status,
      neu: true,
      periodStart: periode.start,
      periodEnd: plusTage(periode.endeExklusiv, -1),
      periodLabel: periode.label,
      contractId: vertrag.id,
      contractVersionId: geltend.id,
      versionNumber: geltend.versionNumber,
      netto: toNumber(rechnung.netTotal),
      brutto: toNumber(rechnung.grossTotal),
    };
  } catch (error) {
    /**
     * Der Index hat zugeschlagen: Ein gleichzeitiger Lauf war schneller.
     * Das ist kein Fehler, sondern das gewünschte Ergebnis — zurückgegeben
     * wird die Rechnung des anderen Laufs.
     */
    if (!isUniqueConstraintError(error)) throw error;

    const andere = await vorhandeneRechnung(vertrag.id, periode);
    if (!andere) throw error;
    return andere;
  }
}

/** Die nicht stornierte Rechnung dieser Periode, falls es sie gibt. */
async function vorhandeneRechnung(
  contractId: string,
  periode: { start: Date; endeExklusiv: Date; label: string },
): Promise<Vertragsrechnung | null> {
  const treffer = await prisma.invoice.findFirst({
    where: {
      contractId,
      contractPeriodStart: periode.start,
      status: { not: 'CANCELLED' },
      deletedAt: null,
    },
    select: {
      id: true,
      number: true,
      status: true,
      netTotal: true,
      grossTotal: true,
      contractVersion: { select: { id: true, versionNumber: true } },
    },
  });
  if (!treffer) return null;

  return {
    invoiceId: treffer.id,
    number: treffer.number,
    status: treffer.status,
    neu: false,
    periodStart: periode.start,
    periodEnd: plusTage(periode.endeExklusiv, -1),
    periodLabel: periode.label,
    contractId,
    contractVersionId: treffer.contractVersion?.id ?? '',
    versionNumber: treffer.contractVersion?.versionNumber ?? 0,
    netto: toNumber(treffer.netTotal),
    brutto: toNumber(treffer.grossTotal),
  };
}

/**
 * Die Abrechnungsübersicht eines Vertrags: welche Perioden fakturiert sind und
 * welche offen.
 *
 * Beantwortet die Frage, die im Monatsabschluss gestellt wird — „was fehlt
 * noch" — ohne dass jemand die Rechnungsliste nach Verträgen durchsehen muss.
 */
export async function contractBillingOverview(params: {
  organizationId: string;
  contractId: string;
  /** Wie viele Perioden zurück. */
  perioden?: number;
}) {
  const vertrag = await prisma.contract.findFirst({
    where: { id: params.contractId, organizationId: params.organizationId, deletedAt: null },
    include: { versions: { orderBy: { versionNumber: 'desc' } } },
  });
  if (!vertrag) throw new NotFoundError('Vertrag');

  const geltend = aktiveVersion(vertrag.versions);
  if (!geltend) throw new BusinessRuleError('Der Vertrag hat keine geltende Fassung.');

  const zyklus = geltend.billingCycle as Abrechnungszyklus;
  const anzahl = Math.min(Math.max(params.perioden ?? 6, 1), 36);

  const rechnungen = await prisma.invoice.findMany({
    where: { contractId: vertrag.id, deletedAt: null },
    select: {
      id: true,
      number: true,
      status: true,
      contractPeriodStart: true,
      grossTotal: true,
      contractVersion: { select: { versionNumber: true } },
    },
  });
  const nachPeriode = new Map(
    rechnungen
      .filter((r) => r.contractPeriodStart && r.status !== 'CANCELLED')
      .map((r) => [r.contractPeriodStart!.toISOString().slice(0, 10), r]),
  );

  const zeilen: Array<{
    periodStart: Date;
    periodEnd: Date;
    label: string;
    invoice: {
      id: string;
      number: string;
      status: string;
      brutto: number;
      versionNumber: number | null;
    } | null;
  }> = [];

  let stichtag = vorigerTag();
  for (let i = 0; i < anzahl; i++) {
    const periode = abrechnungsperiode(zyklus, stichtag);
    // Vor dem Vertragsbeginn gibt es nichts abzurechnen — die Übersicht endet
    // dort, statt leere Zeilen bis zur Kontogründung aufzuzählen.
    if (periode.endeExklusiv <= alsTag(vertrag.startDate)) break;

    const treffer = nachPeriode.get(periode.start.toISOString().slice(0, 10));
    zeilen.push({
      periodStart: periode.start,
      periodEnd: plusTage(periode.endeExklusiv, -1),
      label: periode.label,
      invoice: treffer
        ? {
            id: treffer.id,
            number: treffer.number,
            status: treffer.status,
            brutto: toNumber(treffer.grossTotal),
            versionNumber: treffer.contractVersion?.versionNumber ?? null,
          }
        : null,
    });
    stichtag = plusTage(periode.start, -1);
  }

  return {
    contractId: vertrag.id,
    contractNumber: vertrag.number,
    billingCycle: zyklus,
    currency: geltend.currency,
    versionNumber: geltend.versionNumber,
    startDate: vertrag.startDate,
    perioden: zeilen,
  };
}
