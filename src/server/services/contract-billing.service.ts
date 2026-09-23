import 'server-only';

import {
  alsTag,
  plusTage,
  vertragsperiode,
  zuercherHeute,
  type Abrechnungszyklus,
  type FassungZeitraum,
  type Vertragsperiode,
} from '@/lib/contracts/serie';
import { isUniqueConstraintError, prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';

import { contractBillingBasis } from './contract.service';
import { createInvoice } from './invoice.service';

/**
 * Rechnungen aus einem Vertrag.
 *
 * ---------------------------------------------------------------------------
 *  Die Zusicherungen
 * ---------------------------------------------------------------------------
 *
 * **1. Kein Zeitraum wird zweimal abgerechnet.** Nicht als Prüfung im Code,
 * sondern in der Datenbank, und seit 2026-09-23 doppelt:
 *
 *  • `invoices_vertragsperiode_einmal` — Teilindex über den Periodenbeginn.
 *  • `invoices_vertragsperiode_ueberlappungsfrei` — Ausschlussbedingung über
 *    den Zeitraum `[contractPeriodStart, contractPeriodEnd)`. Sie ist die
 *    eigentliche Zusicherung: Der Teilindex allein sah einen Zykluswechsel
 *    nicht — „Januar" und „1. Quartal" beginnen am selben Tag, „Februar"
 *    aber nicht, und Februar und März liessen sich zusätzlich zum Quartal
 *    abrechnen (RB-008).
 *
 * Dieselbe Überlegung wie beim Serienplaner: Zwischen „gibt es schon eine
 * Rechnung?" und `INSERT` liegt ein Moment, und ein zweiter Lauf, ein
 * Wiederholungsversuch nach einem Abbruch oder ein zweiter Klick passt genau
 * hinein. Der Dienst prüft deshalb zwar zuerst, verlässt sich aber auf die
 * Datenbank und wertet einen Verstoss als „war schon da".
 *
 * **2. Jeder Zeitraum mit der Fassung, die damals galt.** Die Periode entsteht
 * aus dem Stichtag und der an diesem Tag geltenden Fassung
 * (`vertragsperiode`), mit deren Zyklus und Preis. Wechselt die Fassung
 * innerhalb einer Periode, wird an der Grenze geschnitten; eine spätere
 * Fassung ändert an einem früheren Zeitraum nichts. Bis 2026-09-23 rechnete
 * jede Periode mit der **aktuellen** Fassung.
 *
 * **3. Storniert zählt nicht mit.** Eine zurückgenommene Rechnung gibt ihren
 * Zeitraum frei, sonst liesse sich ein Fehler nie korrigieren. Eine
 * Gutschrift ohne Storno lässt ihn belegt — sie korrigiert einen Betrag,
 * nicht die Frage, ob der Zeitraum abgerechnet ist.
 *
 * ---------------------------------------------------------------------------
 *  Was hier nicht passiert
 * ---------------------------------------------------------------------------
 *
 * Der Beleg entsteht nicht hier, sondern über `createInvoice`. Nummernkreis,
 * QR-Referenz, Summenrechnung und Audit-Eintrag bleiben damit an einer
 * Stelle. Eine **ausgestellte** Rechnung wird nie verändert; Korrekturen
 * laufen über Gutschrift und Stornierung.
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

/**
 * Ein Tag in der **zuletzt abgeschlossenen** Periode.
 *
 * Bis 2026-09-23 stand hier „gestern" — mit dem Kommentar, gestern liege in
 * der vorigen Periode. Das stimmt nur am ersten Tag einer Periode. An jedem
 * anderen Tag liegt gestern in der **laufenden**, und „Periode abrechnen"
 * ohne Stichtag fakturierte einen angebrochenen Monat: am 23. September den
 * September, und nach einem Fassungswechsel zum 24. anteilig 23/30 — obwohl
 * die Maske „die vorige" verspricht. Gefunden von der Browserreihe (Fall D).
 *
 * Jetzt: die Periode, in der heute liegt, bestimmen und den Tag davor nehmen.
 * Schneidet ein Fassungswechsel die laufende Periode, ist ihr Beginn der
 * Stichtag der neuen Fassung, und der Tag davor liegt im abgeschlossenen
 * Stück der alten — genau das, was als Nächstes fällig ist. Gilt heute keine
 * Fassung (Vertrag beendet), ist gestern der richtige Tag: Die letzte Periode
 * ist dann abgeschlossen.
 */
function tagDerLetztenAbgeschlossenenPeriode(
  fassungen: FassungZeitraum[],
  vertrag: { startDate: Date; endDate: Date | null; terminationEffectiveAt: Date | null },
): Date {
  const heute = zuercherHeute();
  const laufend = vertragsperiode({
    fassungen,
    stichtag: heute,
    vertragsBeginn: vertrag.startDate,
    vertragsEndeExklusiv: vertragsEndeExklusiv(vertrag),
  });
  return plusTage(laufend ? laufend.start : heute, -1);
}

/** Die Fassungen eines Vertrags, die je galten, in der Form der Periodenrechnung. */
function geltendeFassungen(
  versionen: ReadonlyArray<{
    id: string;
    versionNumber: number;
    status: string;
    billingCycle: string;
    effectiveFrom: Date;
    effectiveUntil: Date | null;
  }>,
): FassungZeitraum[] {
  return versionen
    .filter((v) => v.status === 'ACTIVE' || v.status === 'SUPERSEDED')
    .map((v) => ({
      id: v.id,
      versionNumber: v.versionNumber,
      billingCycle: v.billingCycle as Abrechnungszyklus,
      effectiveFrom: v.effectiveFrom,
      effectiveUntil: v.effectiveUntil,
    }));
}

function vertragsEndeExklusiv(vertrag: { endDate: Date | null; terminationEffectiveAt: Date | null }): Date | null {
  const ende = [vertrag.terminationEffectiveAt, vertrag.endDate]
    .filter((d): d is Date => !!d)
    .map(alsTag)
    .reduce<Date | null>((a, b) => (a && a < b ? a : b), null);
  return ende ? plusTage(ende, 1) : null;
}

/** Ist der Fehler die Überlappungssperre der Rechnungen (SQLSTATE 23P01)? */
function istUeberlappung(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes('invoices_vertragsperiode_ueberlappungsfrei') || text.includes('23P01');
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

  /**
   * Ein Entwurf wird nicht fakturiert.
   *
   * Der Fall, den das verhindert: Jemand legt einen Vertrag an, klickt sich
   * durch und erzeugt eine Rechnung über eine Leistung, die nie vereinbart
   * wurde. Beendete und gekündigte Verträge dürfen dagegen noch abgerechnet
   * werden — die letzte Periode wird naturgemäss nach dem Ende fakturiert.
   */
  if (!['ACTIVE', 'PAUSED', 'NOTICE_GIVEN', 'ENDED'].includes(vertrag.status)) {
    throw new BusinessRuleError('Nur ein Vertrag, der in Kraft ist oder war, lässt sich abrechnen.');
  }

  const fassungen = geltendeFassungen(vertrag.versions);
  const stichtag = alsTag(params.stichtag ?? tagDerLetztenAbgeschlossenenPeriode(fassungen, vertrag));
  const periode = vertragsperiode({
    fassungen,
    stichtag,
    vertragsBeginn: vertrag.startDate,
    vertragsEndeExklusiv: vertragsEndeExklusiv(vertrag),
  });
  if (!periode) {
    throw new BusinessRuleError(
      `Am ${stichtag.toISOString().slice(0, 10)} galt keine Fassung dieses Vertrags — vor Beginn, nach Ende oder in einer Lücke gibt es nichts abzurechnen.`,
    );
  }

  const bestehend = await vorhandeneRechnung(vertrag.id, periode);
  if (bestehend) return bestehend;

  const grundlage = await contractBillingBasis({
    organizationId: params.organizationId,
    contractId: vertrag.id,
    von: periode.start,
    bis: periode.endeExklusiv,
    versionId: periode.fassung.id,
    anteil: periode.anteil,
  });

  if (grundlage.netto <= 0) {
    throw new BusinessRuleError(
      `Für ${periode.label} ergibt sich kein Betrag. Bei Abrechnung nach Einsätzen oder Stunden entsteht die Rechnung erst, wenn es etwas abzurechnen gibt.`,
    );
  }

  const fassung = vertrag.versions.find((v) => v.id === periode.fassung.id)!;
  const ausstellung = zuercherHeute();

  /**
   * Die Positionen verweisen auf die Einsätze, aus denen sie entstehen.
   *
   * Bei Abrechnung je Einsatz eine Zeile je Einsatz mit `jobId` — die Frage
   * „welche Reinigungen stehen auf dieser Rechnung" ist dann eine Abfrage,
   * keine Rekonstruktion. Bei einer Pauschale eine Zeile; die Einsätze des
   * Zeitraums stehen in der Herleitung.
   */
  const positionen =
    grundlage.pricingModel === 'FIXED_PER_VISIT' && grundlage.positionen.length > 0
      ? grundlage.positionen.map((einsatz) => ({
          jobId: einsatz.jobId,
          name: `Einsatz ${einsatz.number} vom ${einsatz.scheduledStart.toISOString().slice(0, 10)}`,
          description: `${vertrag.title} · Fassung ${fassung.versionNumber}`,
          quantity: 1,
          unit: 'Einsatz',
          unitPrice: toNumber(fassung.baseAmount),
          discount: 0,
          vatRate: grundlage.mwstSatz,
        }))
      : [
          {
            name: `${vertrag.title} — ${periode.label}`,
            description: grundlage.herleitung,
            quantity: 1,
            unit: 'Pauschale',
            unitPrice: grundlage.netto,
            discount: 0,
            vatRate: grundlage.mwstSatz,
          },
        ];

  try {
    const rechnung = await createInvoice({
      organizationId: params.organizationId,
      actorId: params.actorId,
      vertrag: {
        contractId: vertrag.id,
        contractVersionId: fassung.id,
        contractPeriodStart: periode.start,
        contractPeriodEnd: periode.endeExklusiv,
      },
      input: {
        customerId: vertrag.customerId,
        issueDate: ausstellung,
        dueDate: plusTage(ausstellung, fassung.paymentTermDays),
        periodFrom: periode.start,
        periodTo: plusTage(periode.endeExklusiv, -1),
        /**
         * Die Herkunft steht auf dem Beleg, nicht nur im Protokoll. Eine
         * Vertragsrechnung ohne Hinweis auf Vertrag, Fassung und Zeitraum
         * erzeugt eine Rückfrage je Monat — und lässt sich nach einer
         * Preisanpassung nicht mehr einordnen.
         */
        introText: `${vertrag.title} · Vertrag ${vertrag.number ?? '—'} · Fassung ${fassung.versionNumber} · Zeitraum ${periode.label}`,
        notes: grundlage.herleitung,
        discountAmount: 0,
        issueImmediately: params.sofortAusstellen ?? false,
        items: positionen,
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
      contractVersionId: fassung.id,
      versionNumber: fassung.versionNumber,
      netto: toNumber(rechnung.netTotal),
      brutto: toNumber(rechnung.grossTotal),
    };
  } catch (error) {
    /**
     * Index oder Ausschlussbedingung hat zugeschlagen.
     *
     * Derselbe Zeitraum: Ein gleichzeitiger Lauf war schneller — seine
     * Rechnung ist das gewünschte Ergebnis. Ein **überlappender** anderer
     * Zeitraum (nach einem Zykluswechsel): Das ist keine Wiederholung,
     * sondern eine Doppelabrechnung, und sie wird abgewiesen.
     */
    if (!isUniqueConstraintError(error) && !istUeberlappung(error)) throw error;

    const andere = await vorhandeneRechnung(vertrag.id, periode);
    if (andere) return andere;
    throw new BusinessRuleError(
      `Der Zeitraum ${periode.label} überschneidet sich mit einer bereits abgerechneten Periode. Eine Doppelabrechnung wird nicht erzeugt; eine falsche Rechnung wird storniert und neu erstellt.`,
    );
  }
}

/** Die nicht stornierte Rechnung genau dieses Zeitraums, falls es sie gibt. */
async function vorhandeneRechnung(contractId: string, periode: Vertragsperiode): Promise<Vertragsrechnung | null> {
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
      contractPeriodEnd: true,
      contractVersion: { select: { id: true, versionNumber: true } },
    },
  });
  if (!treffer) return null;
  // Gleicher Beginn, aber anderes Ende: kein Treffer derselben Periode,
  // sondern eine Überschneidung — die meldet der Aufrufer als solche.
  if (treffer.contractPeriodEnd && treffer.contractPeriodEnd.getTime() !== periode.endeExklusiv.getTime()) {
    return null;
  }

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
 * welche offen — jede mit der Fassung, die damals galt.
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

  const fassungen = geltendeFassungen(vertrag.versions);
  const aktuell = vertrag.versions.find((v) => v.status === 'ACTIVE') ?? vertrag.versions.find((v) => v.status === 'SUPERSEDED');
  if (!aktuell) throw new BusinessRuleError('Der Vertrag hat keine Fassung, die gegolten hätte.');

  const anzahl = Math.min(Math.max(params.perioden ?? 6, 1), 36);
  const ende = vertragsEndeExklusiv(vertrag);

  const rechnungen = await prisma.invoice.findMany({
    where: { contractId: vertrag.id, deletedAt: null, status: { not: 'CANCELLED' } },
    select: {
      id: true,
      number: true,
      status: true,
      contractPeriodStart: true,
      contractPeriodEnd: true,
      grossTotal: true,
      contractVersion: { select: { versionNumber: true } },
    },
  });

  const zeilen: Array<{
    periodStart: Date;
    periodEnd: Date;
    label: string;
    versionNumber: number;
    anteil: number;
    invoice: {
      id: string;
      number: string;
      status: string;
      brutto: number;
      versionNumber: number | null;
    } | null;
  }> = [];

  // Ab der zuletzt abgeschlossenen Periode rückwärts: Die laufende ist nicht
  // „offen", sondern noch nicht fällig, und stünde sonst oben als Lücke da.
  let stichtag = tagDerLetztenAbgeschlossenenPeriode(fassungen, vertrag);
  for (let i = 0; i < anzahl; i++) {
    const periode = vertragsperiode({
      fassungen,
      stichtag,
      vertragsBeginn: vertrag.startDate,
      vertragsEndeExklusiv: ende,
    });
    // Vor dem Vertragsbeginn gibt es nichts abzurechnen — die Übersicht endet
    // dort, statt leere Zeilen bis zur Kontogründung aufzuzählen.
    if (!periode) break;

    // Eine Rechnung, die diesen Zeitraum abdeckt — auch eine aus einem
    // früheren, längeren Zyklus. Offen ist nur, was keine Rechnung berührt.
    const treffer = rechnungen.find(
      (r) =>
        r.contractPeriodStart &&
        r.contractPeriodStart < periode.endeExklusiv &&
        (r.contractPeriodEnd ?? plusTage(r.contractPeriodStart, 1)) > periode.start,
    );
    zeilen.push({
      periodStart: periode.start,
      periodEnd: plusTage(periode.endeExklusiv, -1),
      label: periode.label,
      versionNumber: periode.fassung.versionNumber,
      anteil: periode.anteil,
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
    billingCycle: aktuell.billingCycle,
    currency: aktuell.currency,
    versionNumber: aktuell.versionNumber,
    startDate: vertrag.startDate,
    perioden: zeilen,
  };
}
