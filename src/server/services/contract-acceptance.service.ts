import 'server-only';

import { audit } from '@/lib/audit';
import { prisma, type Tx } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';

import { revokeTokensFor } from './access-token.service';
import { notifyStaff } from './notification.service';
import { appendSignatureEvent, type AnfrageKontext } from './signature-events';

/**
 * Die Geschäftsregeln der Vertragsannahme — getrennt vom Signaturkern.
 *
 * ---------------------------------------------------------------------------
 *  Was hier steht und warum nicht im Kern
 * ---------------------------------------------------------------------------
 *
 * Dieselbe Aufteilung wie bei der Offerte (Gate 4C) und der Vor-Ort-Abnahme
 * (Gate 4D): `signature.service.ts` weiss, wie ein Vorgang abgeschlossen wird
 * — Hashes, Artefakte, Protokoll. Er weiss nicht, was eine Vertragsfassung
 * ist. Das steht hier. Der Kern ruft beim Abschluss eines Vorgangs mit
 * `contractVersionId` genau eine Funktion dieses Moduls —
 * `acceptContractVersionInTx` — in **derselben Transaktion**, in der er den
 * Vorgang auf COMPLETED setzt:
 *
 *     Vertragsfassung angenommen  ⇔  Annahmevorgang COMPLETED
 *
 * Trifft der Übergang keine Zeile, rollt alles zurück, und der Kern beendet
 * den Vorgang als CANCELLED mit Grund. Es gibt keinen stillen Endzustand
 * „unterschrieben, aber nichts geschehen".
 *
 * ---------------------------------------------------------------------------
 *  Was unterschrieben wird
 * ---------------------------------------------------------------------------
 *
 * Eine **Fassung**, nie „der Vertrag". Was die Kundschaft annimmt, sind
 * konkrete Konditionen, und die stehen in der Version. Eine Unterschrift am
 * Vertragskopf wäre eine Zusage auf etwas, das sich danach ändern kann —
 * genau das, was die Versionierung verhindern soll.
 *
 * Deshalb wird eine Fassung mit dem Start des Vorgangs **eingefroren**:
 * `contract.service.ts` weist jede Änderung an einer Fassung ab, zu der ein
 * offener oder abgeschlossener Annahmevorgang gehört. Ohne diese Sperre
 * liesse sich der Preis ändern, während der Kunde den Snapshot vor sich hat —
 * und der Snapshot zeigte weiterhin den alten, während die Datenbank den
 * neuen trüge.
 *
 * ---------------------------------------------------------------------------
 *  Was hier ausdrücklich nicht behauptet wird
 * ---------------------------------------------------------------------------
 *
 * `IN_PERSON_HANDOFF` sagt nur, dass jemand aus dem Betrieb ein Gerät
 * übergeben hat; `REMOTE_LINK` nur, dass ein Link geöffnet wurde. Weder das
 * eine noch das andere ist eine geprüfte Identität, eine Vollmachtsprüfung
 * oder eine qualifizierte elektronische Signatur nach ZertES. Das Produkt
 * behauptet das nirgends, und dieses Modul erst recht nicht.
 *
 * **Sperrreihenfolge** in jeder Transaktion, die beide Zeilen anfasst:
 * `ContractVersion → SignatureRequest → SignatureParticipant`. Sonst könnten
 * sich ein Abbruch (hält die Fassung, will den Vorgang) und ein Abschluss
 * (hält den Vorgang, will die Fassung) gegenseitig blockieren.
 *
 * Dieses Modul importiert weder `contract.service.ts` noch den Signaturkern —
 * so entsteht kein Zyklus.
 */

/** Offene Annahmevorgänge — genau die, die der Teilindex je Fassung auf einen begrenzt. */
export const VERTRAGSANNAHME_AKTIV = ['DRAFT', 'PENDING', 'FINALIZING'] as const;

/** Vorgabe: vierzehn Tage. Ein Vertragsangebot, das länger offen steht, wird neu gerechnet. */
const ANNAHME_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function vertragsannahmeLaeuftAb(now = new Date()): Date {
  return new Date(now.getTime() + ANNAHME_TTL_MS);
}

/**
 * Ist diese Fassung zur Annahme geeignet? Sonst wirft es.
 *
 * Eine **geltende** Fassung wird nicht mehr angenommen — sie ist bereits in
 * Kraft; eine Unterschrift darauf wäre eine Zustimmung zu etwas, das ohnehin
 * schon gilt, und würde suggerieren, die Annahme habe sie in Kraft gesetzt.
 * Eine **abgelöste** erst recht nicht. Angenommen wird der Entwurf, der
 * gelten soll.
 */
export function assertFassungAnnehmbar(
  version: { status: string; acceptedAt: Date | null },
  vertrag: { status: string; deletedAt: Date | null },
): void {
  if (vertrag.deletedAt) throw new NotFoundError('Vertrag');
  if (version.acceptedAt) {
    throw new BusinessRuleError('Diese Vertragsfassung wurde bereits angenommen.');
  }
  if (version.status !== 'DRAFT') {
    throw new BusinessRuleError(
      version.status === 'ACTIVE'
        ? 'Diese Fassung gilt bereits. Zur Unterzeichnung eignet sich nur eine Fassung, die noch nicht in Kraft ist.'
        : 'Diese Fassung ist abgelöst und lässt sich nicht mehr annehmen.',
    );
  }
  if (!['DRAFT', 'IN_REVIEW', 'OFFERED'].includes(vertrag.status)) {
    throw new BusinessRuleError(
      'Nur ein Vertrag, der noch nicht in Kraft ist, lässt sich zur Annahme schicken. Für einen laufenden Vertrag gibt es den Änderungsantrag.',
    );
  }
}

/**
 * Der atomare Übergang — in der Transaktion des Aufrufers.
 *
 * Die Bedingungen stehen in der `where`-Klausel: noch nicht angenommen, noch
 * Entwurf. Eine Unterschrift auf einer inzwischen abgelösten oder bereits
 * angenommenen Fassung trifft keine Zeile, und der Kern entscheidet, was das
 * für den Vorgang heisst.
 *
 * **Der Vertrag wird hier nicht aktiviert.** Die Annahme ist die Zusage der
 * Kundschaft; in Kraft setzt ihn der Betrieb, mit `contract:activate` — einer
 * Berechtigung, die die Betriebsleitung ausdrücklich nicht hat. Beides in
 * einem Schritt zu erledigen hiesse, eine Zusage nach aussen von einem Klick
 * der Gegenseite abhängig zu machen; und die Nummer aus dem Nummernkreis
 * entstünde dann in einer Transaktion, die ein Aussenstehender auslöst.
 * Stattdessen wandert der Vertrag nach OFFERED, sofern er noch früher stand,
 * und die Aktivierung findet die angenommene Fassung vor.
 */
export async function acceptContractVersionInTx(
  tx: Tx,
  params: { contractVersionId: string; requestId: string; now: Date },
): Promise<boolean> {
  const uebergang = await tx.contractVersion.updateMany({
    where: { id: params.contractVersionId, status: 'DRAFT', acceptedAt: null },
    data: { acceptedAt: params.now, acceptedRequestId: params.requestId },
  });
  if (uebergang.count !== 1) return false;

  const version = await tx.contractVersion.findUniqueOrThrow({
    where: { id: params.contractVersionId },
    select: { contractId: true },
  });
  /**
   * Der Vertragskopf zieht nach — aber nur aus einem Zustand, der davor
   * liegt. `updateMany` mit Zustandsfilter statt `update`: Ist der Vertrag
   * inzwischen annulliert, soll die Annahme ihn nicht zurückholen.
   */
  await tx.contract.updateMany({
    where: { id: version.contractId, status: { in: ['DRAFT', 'IN_REVIEW'] } },
    data: { status: 'OFFERED' },
  });

  return true;
}

/**
 * Offene Annahmevorgänge einer Fassung abbrechen — in der Transaktion des
 * Aufrufers, **nach** dem Zugriff auf die Fassung (Sperrreihenfolge).
 *
 * Gründe: Der Vertrag wird annulliert, die Fassung verworfen, der Vorgang von
 * Hand zurückgezogen. Snapshot und Protokoll bleiben als Beleg; entwertet
 * werden nur Links und Codes.
 */
export async function cancelActiveContractAcceptanceInTx(
  tx: Tx,
  params: {
    contractVersionId: string;
    reason: 'contract_cancelled' | 'version_discarded' | 'withdrawn' | 'contract_changed';
    ctx?: AnfrageKontext | null;
    cancelledById?: string | null;
  },
): Promise<number> {
  const offen = await tx.signatureRequest.findMany({
    where: { contractVersionId: params.contractVersionId, status: { in: [...VERTRAGSANNAHME_AKTIV] } },
    select: { id: true, participants: { select: { id: true } } },
  });

  let abgebrochen = 0;
  for (const request of offen) {
    const u = await tx.signatureRequest.updateMany({
      where: { id: request.id, status: { in: [...VERTRAGSANNAHME_AKTIV] } },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledById: params.cancelledById ?? null,
        finalizingSince: null,
      },
    });
    if (u.count === 0) continue;
    abgebrochen += 1;

    for (const p of request.participants) {
      await revokeTokensFor({
        tx,
        purpose: 'SIGNATURE_ACCESS',
        resourceId: p.id,
        revokedById: params.cancelledById ?? null,
      });
      await tx.signatureOtpChallenge.updateMany({
        where: { participantId: p.id, usedAt: null, invalidatedAt: null },
        data: { invalidatedAt: new Date() },
      });
    }

    await appendSignatureEvent(tx, {
      requestId: request.id,
      type: 'CANCELLED',
      ctx: params.ctx,
      details: { by: 'system', reason: params.reason },
    });
  }
  return abgebrochen;
}

/**
 * Ist diese Fassung gesperrt, weil sie unterschrieben wird oder wurde?
 *
 * Wird von `contract.service.ts` vor jeder Änderung an einer Fassung gefragt.
 * Die Sperre ist bewusst **breiter** als „angenommen": Auch ein laufender
 * Vorgang sperrt, denn sonst liesse sich der Preis ändern, während die
 * Kundschaft den Snapshot vor sich hat.
 */
export async function fassungIstGebunden(contractVersionId: string): Promise<null | 'ANGENOMMEN' | 'IN_UNTERZEICHNUNG'> {
  const version = await prisma.contractVersion.findUnique({
    where: { id: contractVersionId },
    select: { acceptedAt: true },
  });
  if (version?.acceptedAt) return 'ANGENOMMEN';

  const offen = await prisma.signatureRequest.count({
    where: { contractVersionId, status: { in: [...VERTRAGSANNAHME_AKTIV] } },
  });
  return offen > 0 ? 'IN_UNTERZEICHNUNG' : null;
}

/**
 * Was nach einer gelungenen Annahme geschieht — ausserhalb der Transaktion,
 * genau einmal, vom Gewinner des Übergangs aufgerufen.
 */
export async function afterContractVersionAccepted(params: {
  contractVersionId: string;
  requestId: string;
  signerName: string;
  ctx?: AnfrageKontext | null;
}): Promise<void> {
  const version = await prisma.contractVersion.findUnique({
    where: { id: params.contractVersionId },
    include: {
      contract: {
        select: {
          id: true,
          organizationId: true,
          number: true,
          title: true,
          customer: { select: { companyName: true, firstName: true, lastName: true } },
        },
      },
    },
  });
  if (!version) return;

  const vertrag = version.contract;
  const kunde =
    vertrag.customer.companyName ?? `${vertrag.customer.firstName} ${vertrag.customer.lastName}`.trim();
  const bezeichnung = vertrag.number ? `Vertrag ${vertrag.number}` : vertrag.title;

  await notifyStaff({
    organizationId: vertrag.organizationId,
    title: 'Vertragsfassung angenommen',
    body: `${bezeichnung} · Fassung ${version.versionNumber} · ${kunde} — jetzt in Kraft setzen`,
    link: `/admin/vertraege/${vertrag.id}`,
    permission: 'contract:activate',
  });

  await audit.updated({
    organizationId: vertrag.organizationId,
    entity: 'ContractVersion',
    entityId: version.id,
    summary: `Fassung ${version.versionNumber} von ${bezeichnung} elektronisch angenommen durch ${params.signerName} (Vorgang ${params.requestId})`,
    ip: params.ctx?.ip,
    userAgent: params.ctx?.userAgent,
  });
}
