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
 * **Sperrreihenfolge** in jeder Transaktion, die mehrere dieser Zeilen
 * anfasst: `Contract → ContractVersion → SignatureRequest →
 * SignatureParticipant`. Sonst könnten sich ein Abbruch (hält die Fassung,
 * will den Vorgang) und ein Abschluss (hält den Vorgang, will die Fassung)
 * gegenseitig blockieren. Der Vertragskopf steht seit 2026-09-23 vorne: Er
 * ist die Zeile, über die Stornieren und Unterschreiben sich serialisieren
 * (`vertragSperren`).
 *
 * Dieses Modul importiert weder `contract.service.ts` noch den Signaturkern —
 * so entsteht kein Zyklus.
 */

/** Offene Annahmevorgänge — genau die, die der Teilindex je Fassung auf einen begrenzt. */
export const VERTRAGSANNAHME_AKTIV = ['DRAFT', 'PENDING', 'FINALIZING'] as const;

/**
 * Vertragszustände, in denen eine Fassung angenommen werden darf.
 *
 * Vor dem Inkrafttreten (Entwurf, Prüfung, offeriert) die erste Fassung;
 * während der Vertrag läuft oder pausiert, eine **Folgefassung** aus einem
 * Änderungsantrag — „Änderung → neue Fassung → Annahme → wirksam". Bis
 * 2026-09-23 war nur der erste Fall erlaubt, und eine Preisänderung an einem
 * laufenden Vertrag liess sich nicht von der Kundschaft bestätigen.
 *
 * Nicht dabei: gekündigt, beendet, storniert. Eine Unterschrift auf einer
 * Fassung eines Vertrags, der nicht mehr gilt oder nie gelten wird, wäre die
 * Zusage auf nichts — genau der Zustand „unterschrieben, aber nichts
 * geschehen", den der Signaturkern ausschliesst.
 */
export const ANNAHME_ZULAESSIGE_VERTRAGSZUSTAENDE = ['DRAFT', 'IN_REVIEW', 'OFFERED', 'ACTIVE', 'PAUSED'] as const;

function annahmeZulaessig(status: string): boolean {
  return (ANNAHME_ZULAESSIGE_VERTRAGSZUSTAENDE as readonly string[]).includes(status);
}

/**
 * Den Vertragskopf für die Dauer der Transaktion sperren und seinen Zustand
 * lesen.
 *
 * `FOR UPDATE` ist hier die eigentliche Zusicherung gegen den Wettlauf
 * „stornieren gegen unterschreiben": Beide Transaktionen greifen zuerst auf
 * diese Zeile zu. Wer als zweiter kommt, wartet und liest danach den
 * **bestätigten** Zustand des ersten. Ohne die Sperre sähe die Annahme in
 * READ COMMITTED noch „offeriert", während die Stornierung gerade committet —
 * und am Ende stünde ein stornierter Vertrag mit frisch angenommener Fassung.
 *
 * Sperrreihenfolge in jeder Transaktion, die mehrere dieser Zeilen anfasst:
 * `Contract → ContractVersion → SignatureRequest → SignatureParticipant`.
 */
export async function vertragSperren(
  tx: Tx,
  wo: { contractId: string } | { contractVersionId: string },
): Promise<{ id: string; status: string; deletedAt: Date | null } | null> {
  const zeilen =
    'contractId' in wo
      ? await tx.$queryRaw<{ id: string; status: string; deletedAt: Date | null }[]>`
          SELECT c."id", c."status"::text AS "status", c."deletedAt"
            FROM "contracts" c
           WHERE c."id" = ${wo.contractId}
             FOR UPDATE`
      : await tx.$queryRaw<{ id: string; status: string; deletedAt: Date | null }[]>`
          SELECT c."id", c."status"::text AS "status", c."deletedAt"
            FROM "contracts" c
            JOIN "contract_versions" v ON v."contractId" = c."id"
           WHERE v."id" = ${wo.contractVersionId}
             FOR UPDATE OF c`;
  return zeilen[0] ?? null;
}

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
  if (!annahmeZulaessig(vertrag.status)) {
    throw new BusinessRuleError(
      'Dieser Vertrag ist gekündigt, beendet oder storniert. Eine Fassung lässt sich dafür nicht mehr zur Annahme schicken.',
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
  /**
   * **Fail-closed, und zwar hier — nicht in der Oberfläche.**
   *
   * Bis 2026-09-23 prüfte dieser Übergang nur die Fassung. Ein Vertrag, der
   * nach dem Versand storniert oder als Entwurf gelöscht wurde, liess sich
   * trotzdem unterschreiben: Die Fassung bekam `acceptedAt`, der Vorgang
   * wurde COMPLETED, und das Büro erhielt „jetzt in Kraft setzen". Seither
   * wird der Vertragskopf gesperrt und sein Zustand in derselben Transaktion
   * gelesen, in der die Fassung angenommen wird.
   */
  const vertrag = await vertragSperren(tx, { contractVersionId: params.contractVersionId });
  if (!vertrag || vertrag.deletedAt || !annahmeZulaessig(vertrag.status)) return false;

  const uebergang = await tx.contractVersion.updateMany({
    where: {
      id: params.contractVersionId,
      contractId: vertrag.id,
      status: 'DRAFT',
      acceptedAt: null,
    },
    data: { acceptedAt: params.now, acceptedRequestId: params.requestId },
  });
  if (uebergang.count !== 1) return false;

  /**
   * Der Vertragskopf zieht nach — aber nur aus einem Zustand, der davor
   * liegt. Ein laufender Vertrag bleibt laufend: Die angenommene Folgefassung
   * wird erst mit ihrem Stichtag wirksam (`activateContractVersion`).
   */
  await tx.contract.updateMany({
    where: { id: vertrag.id, status: { in: ['DRAFT', 'IN_REVIEW'] } },
    data: { status: 'OFFERED' },
  });

  return true;
}

/**
 * Alle offenen Annahmevorgänge eines Vertrags abbrechen — beim Stornieren
 * und beim Verwerfen des Entwurfs, in der Transaktion des Aufrufers und
 * **nach** `vertragSperren`.
 *
 * Bis 2026-09-23 rief nur das Zurückziehen den Abbruch auf; Stornieren und
 * Löschen liessen den Link der Kundschaft gültig.
 */
export async function cancelAllContractAcceptancesInTx(
  tx: Tx,
  params: {
    contractId: string;
    reason: 'contract_cancelled' | 'version_discarded';
    ctx?: AnfrageKontext | null;
    cancelledById?: string | null;
  },
): Promise<number> {
  const fassungen = await tx.contractVersion.findMany({
    where: { contractId: params.contractId },
    select: { id: true },
  });
  let abgebrochen = 0;
  for (const fassung of fassungen) {
    abgebrochen += await cancelActiveContractAcceptanceInTx(tx, {
      contractVersionId: fassung.id,
      reason: params.reason,
      ctx: params.ctx,
      cancelledById: params.cancelledById,
    });
  }
  return abgebrochen;
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
