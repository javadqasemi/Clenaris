import 'server-only';

import type { Prisma } from '@prisma/client';

import { audit } from '@/lib/audit';
import type { ActorRole } from '@/lib/auth/rbac';
import { prisma, toNumber } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { beurteile, bewerte, naechsteKontrolle } from '@/lib/quality/bewertung';
import type {
  QualityInspectionCreateInput,
  QualityInspectionUpdateInput,
  QualityItemInput,
} from '@/lib/validation/quality';

import { nextNumber } from './numbering.service';
import { notifyStaff } from './notification.service';

/**
 * Qualitätskontrolle vor Ort (Wave 11).
 *
 * ---------------------------------------------------------------------------
 *  Was dieser Dienst durchsetzt
 * ---------------------------------------------------------------------------
 *
 * **1. Die Punktzahl rechnet der Server.** `scoreAchieved`, `scorePercent` und
 * `outcome` entstehen aus den Positionen über `src/lib/quality/bewertung.ts`,
 * nie aus einer Angabe des Clients. Dieselbe Regel wie beim Preis — und der
 * Grund ist derselbe: Eine Note, die der Beurteilte selbst mitschickt, ist
 * keine.
 *
 * **2. Der Massstab ist ein Schnappschuss.** Beim Anlegen wird festgehalten,
 * welche Vertragsfassung galt und welchen Zielwert sie zusagte. Eine Begehung,
 * die nach einer Vertragsänderung plötzlich anders ausfiele, wäre kein Beleg —
 * dieselbe Überlegung wie beim Einsatz und bei der Rechnung.
 *
 * **3. Abgeschlossen ist unveränderlich.** Danach gibt es kein Ändern und kein
 * Löschen; korrigiert wird über eine **Nachkontrolle**. Der Teilindex lässt
 * je Kontrolle genau eine zu.
 *
 * **4. Ohne Zusage kein Urteil.** Ein Vertrag ohne `targetQualityScore` ergibt
 * `OHNE_ZIEL`. Das Produkt erfindet keinen Massstab, auf den sich niemand
 * geeinigt hat — dieselbe Haltung wie bei der Indexierung und bei der
 * Wirksamkeit einer Kündigung.
 */

// ---------------------------------------------------------------------------
//  Sichtbarkeit
// ---------------------------------------------------------------------------

/**
 * Wer welche Begehungen sieht — **in der `where`-Klausel**, nicht in der
 * Anzeige.
 *
 * Kundschaft sieht die Kontrollen der eigenen Objekte und Verträge. Was sie
 * nicht sieht, ist `internalNote`; das steht in der Auswahl der Felder, nicht
 * hier. Versteckte Felder im HTML sind auf der Leitung sichtbar — die Regel
 * aus `tests/api/ownership.test.ts`.
 */
export function qualityVisibilityWhere(
  role: ActorRole,
  customerId: string | null,
): Prisma.QualityInspectionWhereInput {
  if (role === 'CUSTOMER') {
    if (!customerId) {
      // Ein Konto ohne Kundenakte sieht nichts — nicht alles.
      return { id: '__keine__' };
    }
    return {
      OR: [{ contract: { customerId } }, { property: { customerId } }],
      /*
        Entwürfe gehören nicht nach aussen: Eine halbe Begehung ist eine
        Momentaufnahme, keine Feststellung, und sie kann sich noch ändern.
      */
      status: 'COMPLETED',
    };
  }
  return {};
}

// ---------------------------------------------------------------------------
//  Anlegen und ändern
// ---------------------------------------------------------------------------

/**
 * Den Massstab zum Zeitpunkt der Begehung ermitteln.
 *
 * Gesucht ist die Fassung, die **an diesem Tag** galt — nicht die heute
 * geltende. Bei einer Begehung, die im Büro nachträglich erfasst wird, sind
 * das verschiedene Dinge, und nur die erste ist ein Beleg.
 */
async function massstab(contractId: string | undefined, stichtag: Date) {
  if (!contractId) return { contractVersionId: null, targetScore: null };

  const fassungen = await prisma.contractVersion.findMany({
    where: { contractId },
    orderBy: { effectiveFrom: 'desc' },
    select: { id: true, effectiveFrom: true, effectiveUntil: true, targetQualityScore: true, status: true },
  });

  const galt = fassungen.find(
    (v) =>
      v.effectiveFrom.getTime() <= stichtag.getTime() &&
      (v.effectiveUntil === null || v.effectiveUntil.getTime() > stichtag.getTime()) &&
      // Nur Fassungen, die tatsächlich galten. Ein Entwurf oder ein
      // verworfener Entwurf trägt ein `effectiveFrom`, hat aber nie gegolten.
      (v.status === 'ACTIVE' || v.status === 'SUPERSEDED'),
  );

  /*
    Findet sich keine — die Begehung liegt vor dem Vertragsbeginn oder der
    Vertrag ist noch Entwurf —, gilt kein Massstab. Auf die nächstbeste
    Fassung auszuweichen wäre eine erfundene Zusage.
  */
  return {
    contractVersionId: galt?.id ?? null,
    targetScore: galt?.targetQualityScore ?? null,
  };
}

function positionsdaten(items: QualityItemInput[]) {
  return items.map((item, index) => ({
    label: item.label,
    room: item.room ?? null,
    points: item.points,
    maxPoints: item.maxPoints,
    weight: item.weight,
    note: item.note ?? null,
    position: item.position || index,
  }));
}

/** Die gerechneten Felder aus den Positionen — an genau einer Stelle. */
function ergebnisfelder(items: { points: number; maxPoints: number; weight: number }[], zielwert: number | null) {
  const bewertung = bewerte(
    items.map((i) => ({ punkte: i.points, maximum: i.maxPoints, gewicht: i.weight })),
  );
  return {
    scoreAchieved: bewertung.erreicht,
    scorePossible: bewertung.moeglich,
    scorePercent: bewertung.prozent,
    outcome: beurteile(bewertung.prozent, zielwert),
  };
}

/**
 * Gehören Vertrag, Objekt, Einsatz und prüfende Person zusammen — und zu
 * dieser Organisation?
 *
 * RB-011 aus dem Audit vom 2026-09-23. Geprüft wurden bis dahin nur Vertrag
 * und Vorgängerbegehung. Objekt, Einsatz und Prüfer gingen ungeprüft in die
 * Zeile — und die Kundensicht zeigt eine abgeschlossene Begehung jeder
 * Kundschaft, der der Vertrag **oder** das Objekt gehört
 * (`qualityVisibilityWhere`). Ein Vertrag von Kundschaft A mit einem Objekt
 * von Kundschaft B hätte das Ergebnis also Kundschaft B gezeigt: eine
 * Offenlegung über Kundengrenzen, entstanden aus einem Tippfehler im Büro.
 *
 * Deshalb hier, im Dienst und nicht in der Maske:
 *
 *  • Das Objekt gehört einer Kundschaft dieser Organisation — und, wenn ein
 *    Vertrag angegeben ist, **derselben** Kundschaft wie der Vertrag.
 *  • Der Einsatz gehört dieser Organisation und, wenn angegeben, zu diesem
 *    Vertrag bzw. diesem Objekt.
 *  • Die prüfende Person ist ein Konto dieser Organisation und keine
 *    Kundschaft.
 */
async function zugehoerigkeitPruefen(params: {
  organizationId: string;
  contractId?: string | null;
  propertyId?: string | null;
  jobId?: string | null;
  inspectorId?: string | null;
}): Promise<void> {
  const vertrag = params.contractId
    ? await prisma.contract.findFirst({
        where: { id: params.contractId, organizationId: params.organizationId, deletedAt: null },
        select: { id: true, customerId: true, propertyId: true },
      })
    : null;
  if (params.contractId && !vertrag) throw new NotFoundError('Vertrag');

  if (params.propertyId) {
    const objekt = await prisma.property.findFirst({
      where: { id: params.propertyId, customer: { organizationId: params.organizationId } },
      select: { id: true, customerId: true },
    });
    if (!objekt) throw new NotFoundError('Objekt');
    if (vertrag && objekt.customerId !== vertrag.customerId) {
      throw new BusinessRuleError(
        'Das Objekt gehört nicht der Kundschaft dieses Vertrags. Eine Begehung verbindet nur Vertrag und Objekt derselben Kundschaft.',
      );
    }
  }

  if (params.jobId) {
    const einsatz = await prisma.job.findFirst({
      where: { id: params.jobId, organizationId: params.organizationId, deletedAt: null },
      select: { id: true, contractId: true, propertyId: true, customerId: true },
    });
    if (!einsatz) throw new NotFoundError('Einsatz');
    if (vertrag && einsatz.contractId !== vertrag.id && einsatz.customerId !== vertrag.customerId) {
      throw new BusinessRuleError('Der Einsatz gehört nicht zu diesem Vertrag.');
    }
    if (params.propertyId && einsatz.propertyId && einsatz.propertyId !== params.propertyId) {
      throw new BusinessRuleError('Der Einsatz fand an einem anderen Objekt statt.');
    }
  }

  if (params.inspectorId) {
    const person = await prisma.user.findFirst({
      where: { id: params.inspectorId, organizationId: params.organizationId, deletedAt: null },
      select: { role: true },
    });
    if (!person) throw new NotFoundError('Prüfende Person');
    if (person.role === 'CUSTOMER') {
      throw new BusinessRuleError('Eine Begehung führt eine Person aus dem Betrieb durch, keine Kundschaft.');
    }
  }
}

export async function createInspection(params: {
  organizationId: string;
  actorId: string;
  ip?: string | null;
  input: QualityInspectionCreateInput;
}) {
  const { input } = params;

  await zugehoerigkeitPruefen({
    organizationId: params.organizationId,
    contractId: input.contractId,
    propertyId: input.propertyId,
    jobId: input.jobId,
    inspectorId: input.inspectorId,
  });

  if (input.followUpOfId) {
    const vorgaenger = await prisma.qualityInspection.findFirst({
      where: { id: input.followUpOfId, organizationId: params.organizationId, deletedAt: null },
      select: { id: true, status: true, contractId: true, propertyId: true, followUp: { select: { id: true } } },
    });
    if (!vorgaenger) throw new NotFoundError('Begehung');
    // Eine Nachkontrolle kontrolliert denselben Gegenstand nach — nicht einen
    // anderen Vertrag oder ein anderes Objekt.
    if (
      (vorgaenger.contractId ?? null) !== (input.contractId ?? null) ||
      (vorgaenger.propertyId && input.propertyId && vorgaenger.propertyId !== input.propertyId)
    ) {
      throw new BusinessRuleError('Eine Nachkontrolle gilt demselben Vertrag und Objekt wie die erste Begehung.');
    }
    /*
      Eine Nachkontrolle zu einem Entwurf ergibt keinen Sinn: Solange die
      erste noch änderbar ist, korrigiert man sie, statt sie nachzuholen.
    */
    if (vorgaenger.status !== 'COMPLETED') {
      throw new BusinessRuleError(
        'Eine Nachkontrolle gibt es nur zu einer abgeschlossenen Begehung. Ein Entwurf lässt sich noch ändern.',
      );
    }
    if (vorgaenger.followUp) {
      throw new BusinessRuleError('Zu dieser Begehung gibt es bereits eine Nachkontrolle.');
    }
  }

  const { contractVersionId, targetScore } = await massstab(input.contractId, input.inspectedAt);
  const positionen = positionsdaten(input.items);
  const ergebnis = ergebnisfelder(positionen, targetScore);

  const begehung = await prisma.qualityInspection.create({
    data: {
      organizationId: params.organizationId,
      contractId: input.contractId ?? null,
      contractVersionId,
      propertyId: input.propertyId ?? null,
      jobId: input.jobId ?? null,
      inspectedAt: input.inspectedAt,
      inspectorId: input.inspectorId ?? params.actorId,
      followUpOfId: input.followUpOfId ?? null,
      note: input.note ?? null,
      internalNote: input.internalNote ?? null,
      targetScore,
      ...ergebnis,
      createdById: params.actorId,
      items: { create: positionen },
    },
    include: { items: { orderBy: { position: 'asc' } } },
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'QualityInspection',
    entityId: begehung.id,
    summary: `Begehung erfasst (${positionen.length} Positionen${
      ergebnis.scorePercent !== null ? `, ${ergebnis.scorePercent} %` : ', nichts beurteilbar'
    })`,
    ip: params.ip,
  });

  return begehung;
}

/** Nur Entwürfe lassen sich ändern. */
export async function updateInspection(params: {
  organizationId: string;
  inspectionId: string;
  actorId: string;
  ip?: string | null;
  input: QualityInspectionUpdateInput;
}) {
  const begehung = await ladeBegehung(params.organizationId, params.inspectionId);
  assertEntwurf(begehung.status, 'ändern');
  if (params.input.inspectorId) {
    await zugehoerigkeitPruefen({ organizationId: params.organizationId, inspectorId: params.input.inspectorId });
  }

  const stichtag = params.input.inspectedAt ?? begehung.inspectedAt;
  /*
    Verschiebt jemand das Begehungsdatum, verschiebt sich auch der Massstab —
    sonst trüge die Kontrolle die Zusage eines Tages, an dem sie nicht
    stattfand.
  */
  const { contractVersionId, targetScore } = await massstab(begehung.contractId ?? undefined, stichtag);

  const positionen = params.input.items
    ? positionsdaten(params.input.items)
    : begehung.items.map((i) => ({
        label: i.label,
        room: i.room,
        points: toNumber(i.points),
        maxPoints: toNumber(i.maxPoints),
        weight: toNumber(i.weight),
        note: i.note,
        position: i.position,
      }));

  const ergebnis = ergebnisfelder(positionen, targetScore);

  const aktualisiert = await prisma.$transaction(async (tx) => {
    if (params.input.items) {
      await tx.qualityInspectionItem.deleteMany({ where: { inspectionId: begehung.id } });
      await tx.qualityInspectionItem.createMany({
        data: positionen.map((p) => ({ ...p, inspectionId: begehung.id })),
      });
    }

    return tx.qualityInspection.update({
      where: { id: begehung.id },
      data: {
        inspectedAt: stichtag,
        inspectorId: params.input.inspectorId ?? begehung.inspectorId,
        note: params.input.note ?? begehung.note,
        internalNote: params.input.internalNote ?? begehung.internalNote,
        contractVersionId,
        targetScore,
        ...ergebnis,
      },
      include: { items: { orderBy: { position: 'asc' } } },
    });
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'QualityInspection',
    entityId: begehung.id,
    summary: `Begehungsentwurf geändert (${positionen.length} Positionen${
      ergebnis.scorePercent !== null ? `, ${ergebnis.scorePercent} %` : ''
    })`,
    ip: params.ip,
  });

  return aktualisiert;
}

// ---------------------------------------------------------------------------
//  Abschliessen, verwerfen
// ---------------------------------------------------------------------------

/**
 * Abschliessen — ab hier ist die Begehung ein Beleg.
 *
 * Nummer und Abschlusszeitpunkt entstehen in **einer** Transaktion mit dem
 * Zustand; dieselbe Regel wie bei Rechnung und Vertrag. Die Nummer entsteht
 * erst hier, damit ein verworfener Entwurf keine Lücke hinterlässt — und
 * scheitert der Abschluss, rollt die Nummer mit zurück.
 *
 * Eine Begehung **ohne beurteilbare Position** lässt sich nicht abschliessen.
 * Sie wäre ein Beleg über nichts, und die Zahl darauf (`null`) liesse sich von
 * „null Punkte" nicht unterscheiden, sobald jemand sie abschreibt.
 */
export async function completeInspection(params: {
  organizationId: string;
  inspectionId: string;
  actorId: string;
  ip?: string | null;
  note?: string;
}) {
  const begehung = await ladeBegehung(params.organizationId, params.inspectionId);
  assertEntwurf(begehung.status, 'abschliessen');

  if (begehung.items.length === 0) {
    throw new BusinessRuleError('Eine Begehung ohne Positionen lässt sich nicht abschliessen.');
  }
  if (begehung.scorePercent === null) {
    throw new BusinessRuleError(
      'Keine Position war beurteilbar. Eine Begehung, die nichts misst, ist kein Beleg — bitte mindestens ein Kriterium bewerten.',
    );
  }

  const jetzt = new Date();

  const abgeschlossen = await prisma.$transaction(async (tx) => {
    const { number } = await nextNumber(tx, params.organizationId, 'quality', begehung.inspectedAt);

    /**
     * Der Zustand steht in der `where`-Klausel, nicht nur in der Prüfung
     * oben. Zwei gleichzeitige Abschlüsse lasen beide „Entwurf", und bis
     * 2026-09-23 schrieben beide — mit zwei Nummern aus dem Nummernkreis für
     * eine Begehung. Jetzt trifft der zweite keine Zeile, und seine
     * Transaktion rollt samt Nummer zurück.
     */
    const gesetzt = await tx.qualityInspection.updateMany({
      where: { id: begehung.id, status: 'DRAFT' },
      data: {
        status: 'COMPLETED',
        number,
        completedAt: jetzt,
        note: params.note ?? begehung.note,
      },
    });
    if (gesetzt.count !== 1) {
      throw new BusinessRuleError('Diese Begehung wurde inzwischen abgeschlossen oder verworfen.');
    }
    return tx.qualityInspection.findUniqueOrThrow({
      where: { id: begehung.id },
      include: { items: { orderBy: { position: 'asc' } } },
    });
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'QualityInspection',
    entityId: begehung.id,
    summary: `Begehung ${abgeschlossen.number} abgeschlossen — ${toNumber(abgeschlossen.scorePercent)} % (${abgeschlossen.outcome})`,
    ip: params.ip,
  });

  /*
    Nur beim Durchfallen wird gemeldet. Eine Benachrichtigung über jede
    bestandene Kontrolle wäre eine Meldung, die man nach einer Woche
    wegklickt — und dann auch die eine, auf die es ankommt.
  */
  if (abgeschlossen.outcome === 'NICHT_BESTANDEN') {
    await notifyStaff({
      organizationId: params.organizationId,
      title: 'Qualitätskontrolle nicht bestanden',
      body: `${abgeschlossen.number} · ${toNumber(abgeschlossen.scorePercent)} % gegenüber ${abgeschlossen.targetScore} % zugesagt`,
      link: `/admin/qualitaet/${abgeschlossen.id}`,
      permission: 'quality:read',
    });
  }

  return abgeschlossen;
}

/**
 * Einen Entwurf verwerfen.
 *
 * Nur Entwürfe. Eine abgeschlossene Begehung ist ein Beleg — sie wird
 * annulliert, nicht gelöscht, und auch das nur mit Grund.
 */
export async function discardInspection(params: {
  organizationId: string;
  inspectionId: string;
  actorId: string;
  ip?: string | null;
}) {
  const begehung = await ladeBegehung(params.organizationId, params.inspectionId);
  assertEntwurf(begehung.status, 'verwerfen');

  await prisma.qualityInspection.update({
    where: { id: begehung.id },
    data: { status: 'CANCELLED', deletedAt: new Date() },
  });

  await audit.deleted({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'QualityInspection',
    entityId: begehung.id,
    summary: 'Begehungsentwurf verworfen',
    ip: params.ip,
  });
}

// ---------------------------------------------------------------------------
//  Lesen
// ---------------------------------------------------------------------------

export async function listInspections(params: {
  organizationId: string;
  role: ActorRole;
  customerId: string | null;
  filter: {
    status?: 'DRAFT' | 'COMPLETED' | 'CANCELLED';
    outcome?: 'BESTANDEN' | 'KNAPP' | 'NICHT_BESTANDEN' | 'OHNE_ZIEL';
    contractId?: string;
    propertyId?: string;
    von?: Date;
    bis?: Date;
    page: number;
    perPage: number;
  };
}) {
  const { filter } = params;

  // Die Sichtregel als eigenes `AND`-Glied (2026-09-27): Verbreitet
  // überschrieb `?status=DRAFT` ihr `status: 'COMPLETED'`, und die Kundschaft
  // sah die internen Entwürfe ihrer Kontrollen.
  const where: Prisma.QualityInspectionWhereInput = {
    organizationId: params.organizationId,
    deletedAt: null,
    AND: [qualityVisibilityWhere(params.role, params.customerId)],
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.outcome ? { outcome: filter.outcome } : {}),
    ...(filter.contractId ? { contractId: filter.contractId } : {}),
    ...(filter.propertyId ? { propertyId: filter.propertyId } : {}),
    ...(filter.von || filter.bis
      ? {
          inspectedAt: {
            ...(filter.von ? { gte: filter.von } : {}),
            ...(filter.bis ? { lte: filter.bis } : {}),
          },
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.qualityInspection.findMany({
      where,
      orderBy: { inspectedAt: 'desc' },
      skip: (filter.page - 1) * filter.perPage,
      take: filter.perPage,
      select: {
        id: true,
        number: true,
        status: true,
        inspectedAt: true,
        scorePercent: true,
        targetScore: true,
        outcome: true,
        note: true,
        /*
          `internalNote` fehlt hier bewusst: Die Kundschaft liest dieselbe
          Liste. Ein Feld, das nur die Anzeige ausblendet, stünde trotzdem auf
          der Leitung.
        */
        contract: { select: { id: true, number: true, title: true } },
        property: { select: { id: true, label: true } },
        inspector: { select: { firstName: true, lastName: true } },
        _count: { select: { items: true } },
      },
    }),
    prisma.qualityInspection.count({ where }),
  ]);

  return { items, total };
}

/**
 * Die Fälligkeit je Vertrag — für die Akte und den Nachtlauf.
 *
 * Gerechnet aus dem Intervall der geltenden Fassung und der letzten
 * **abgeschlossenen** Begehung. Ein Entwurf zählt nicht: Er sagt, dass jemand
 * begonnen hat, nicht dass kontrolliert wurde.
 */
export async function inspectionDue(params: { organizationId: string; contractId: string }) {
  const vertrag = await prisma.contract.findFirst({
    where: { id: params.contractId, organizationId: params.organizationId, deletedAt: null },
    select: {
      id: true,
      startDate: true,
      versions: {
        where: { status: 'ACTIVE' },
        select: { inspectionIntervalDays: true, targetQualityScore: true },
        take: 1,
      },
    },
  });
  if (!vertrag) throw new NotFoundError('Vertrag');

  const letzte = await prisma.qualityInspection.findFirst({
    where: { contractId: vertrag.id, status: 'COMPLETED', deletedAt: null },
    orderBy: { inspectedAt: 'desc' },
    select: { id: true, number: true, inspectedAt: true, scorePercent: true, outcome: true },
  });

  const fassung = vertrag.versions[0];
  const faelligkeit = naechsteKontrolle({
    intervallTage: fassung?.inspectionIntervalDays,
    letzteKontrolleAm: letzte?.inspectedAt,
    vertragsbeginn: vertrag.startDate,
  });

  return {
    contractId: vertrag.id,
    zielwert: fassung?.targetQualityScore ?? null,
    intervallTage: fassung?.inspectionIntervalDays ?? null,
    letzte: letzte
      ? {
          id: letzte.id,
          number: letzte.number,
          inspectedAt: letzte.inspectedAt,
          prozent: letzte.scorePercent === null ? null : toNumber(letzte.scorePercent),
          outcome: letzte.outcome,
        }
      : null,
    ...faelligkeit,
  };
}

// ---------------------------------------------------------------------------
//  Gemeinsames
// ---------------------------------------------------------------------------

async function ladeBegehung(organizationId: string, inspectionId: string) {
  const begehung = await prisma.qualityInspection.findFirst({
    where: { id: inspectionId, organizationId, deletedAt: null },
    include: { items: { orderBy: { position: 'asc' } } },
  });
  if (!begehung) throw new NotFoundError('Begehung');
  return begehung;
}

function assertEntwurf(status: string, was: 'ändern' | 'abschliessen' | 'verwerfen'): void {
  if (status === 'DRAFT') return;
  throw new BusinessRuleError(
    status === 'COMPLETED'
      ? `Eine abgeschlossene Begehung lässt sich nicht ${was}. Sie ist ein Beleg — korrigiert wird über eine Nachkontrolle.`
      : `Diese Begehung wurde verworfen und lässt sich nicht ${was}.`,
  );
}
