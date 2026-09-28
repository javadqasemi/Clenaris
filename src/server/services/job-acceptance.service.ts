import 'server-only';

import { audit } from '@/lib/audit';
import { prisma, type Tx } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';

import { revokeTokensFor } from './access-token.service';
import { notifyStaff } from './notification.service';
import { appendSignatureEvent, type AnfrageKontext } from './signature-events';

/**
 * Die Geschäftsregeln der Vor-Ort-Abnahme — getrennt vom Signaturkern.
 *
 * Dieselbe Aufteilung wie bei der Offertannahme (Gate 4C) und aus demselben
 * Grund: Der Kern (`signature.service.ts`) weiss, wie ein Vorgang
 * abgeschlossen wird — Hashes, Artefakte, Protokoll. Was ein Einsatz ist,
 * wann er abnahmefähig ist und was nach einer Abnahme geschieht, steht hier.
 * Der Kern ruft beim Abschluss eines Vorgangs mit `jobId` genau eine Funktion
 * dieses Moduls — `acceptJobInTx` — in **derselben Transaktion**, in der er
 * den Vorgang auf COMPLETED setzt:
 *
 *     Einsatz kundenseitig abgenommen  ⇔  Abnahmevorgang COMPLETED
 *
 * **Warum `customerAcceptedAt` und kein neuer Status.** `JobStatus.VERIFIED`
 * heisst in diesem Produkt „vom Büro kontrolliert und abrechnungsreif" —
 * nachgeprüft in `updateJobCosting` (`approve`) und in `job-actions.tsx`.
 * Das ist eine *interne* Freigabe. Die Unterschrift der Kundschaft vor Ort
 * ist eine andere Tatsache, und sie darf jene Bedeutung nicht stillschweigend
 * übernehmen: Sonst gälte ein Einsatz als bürogeprüft, weil jemand auf einem
 * Telefon unterschrieben hat. Deshalb ein eigenes Feld, das neben dem Status
 * steht statt in ihm.
 *
 * **Sperrreihenfolge** in jeder Transaktion, die mehrere Zeilen anfasst:
 * `Job → SignatureRequest → SignatureParticipant → DeviceHandoffSession`.
 */

/**
 * Zustände, aus denen heraus eine Kundenabnahme möglich ist.
 *
 * Der Rapport muss stehen — Checkliste, Zeiten, Material —, sonst
 * unterschriebe die Kundschaft ein unfertiges Dokument. `COMPLETED` ist genau
 * dieser Punkt: Das Team hat rapportiert. `VERIFIED` bleibt zugelassen, weil
 * eine nachgeholte Abnahme (Kundschaft war beim Abschluss nicht da, kommt
 * später dazu) fachlich sinnvoll ist und nichts verfälscht.
 */
export const JOB_ABNEHMBAR = ['COMPLETED', 'VERIFIED'] as const;

/** Offene Abnahmevorgänge — genau die, die der Teilindex je Einsatz auf einen begrenzt. */
export const ABNAHME_AKTIV = ['DRAFT', 'PENDING', 'FINALIZING'] as const;

/** Ist der Einsatz jetzt abnahmefähig? Sonst wirft es. */
export function assertJobAbnahmefaehig(
  job: { status: string; deletedAt: Date | null; customerAcceptedAt: Date | null },
): void {
  if (job.deletedAt) throw new NotFoundError('Einsatz');
  if (!JOB_ABNEHMBAR.includes(job.status as never)) {
    throw new BusinessRuleError(
      'Dieser Einsatz ist noch nicht abgeschlossen. Bitte zuerst den Rapport fertigstellen.',
    );
  }
  if (job.customerAcceptedAt) {
    throw new BusinessRuleError('Dieser Einsatz wurde bereits von der Kundschaft abgenommen.');
  }
}

/**
 * Der atomare Übergang — in der Transaktion des Aufrufers.
 *
 * Die Bedingungen stehen in der `where`-Klausel: Zustand, nicht gelöscht,
 * **noch nicht abgenommen**. Eine Unterschrift auf einem inzwischen
 * abgebrochenen oder bereits abgenommenen Einsatz trifft keine Zeile, und der
 * Aufrufer entscheidet, was das für den Vorgang heisst. Gibt `true` zurück,
 * wenn der Übergang stattgefunden hat.
 */
export async function acceptJobInTx(tx: Tx, jobId: string, now: Date): Promise<boolean> {
  const uebergang = await tx.job.updateMany({
    where: {
      id: jobId,
      status: { in: [...JOB_ABNEHMBAR] },
      deletedAt: null,
      customerAcceptedAt: null,
    },
    data: { customerAcceptedAt: now },
  });
  return uebergang.count === 1;
}

/**
 * Offene Abnahmevorgänge eines Einsatzes abbrechen — in der Transaktion des
 * Aufrufers, **nach** dem Zugriff auf den Einsatz (Sperrreihenfolge).
 *
 * Gründe: Abbruch durch das Personal, Absage des Einsatzes. Der alte Snapshot
 * und das Protokoll bleiben als Beleg; nur Sitzungen und Zugänge werden
 * entwertet. Die Geräteübergabe wird dabei **nicht** freigegeben — das tut
 * ausschliesslich das Entsperren mit Passwort.
 */
export async function cancelActiveJobAcceptanceInTx(
  tx: Tx,
  params: {
    jobId: string;
    reason: 'handoff_cancelled' | 'job_cancelled' | 'report_changed';
    ctx?: AnfrageKontext | null;
    cancelledById?: string | null;
  },
): Promise<number> {
  const offen = await tx.signatureRequest.findMany({
    where: {
      jobId: params.jobId,
      ceremonyMode: 'IN_PERSON_HANDOFF',
      status: { in: [...ABNAHME_AKTIV] },
    },
    select: { id: true, participants: { select: { id: true } } },
  });

  let abgebrochen = 0;
  for (const request of offen) {
    const u = await tx.signatureRequest.updateMany({
      where: { id: request.id, status: { in: [...ABNAHME_AKTIV] } },
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
 * Was nach einer gelungenen Abnahme geschieht — ausserhalb der Transaktion,
 * genau einmal, vom Gewinner des Übergangs aufgerufen.
 *
 * **Der Eintrag im Prüfprotokoll nennt den Unterzeichner, nicht das
 * Personal.** Das Gerät gehörte der Mitarbeiterin, die Unterschrift nicht.
 * Ein Eintrag „X hat den Rapport unterschrieben" mit dem Personalkonto wäre
 * schlicht falsch — deshalb steht dort kein `userId`.
 */
export async function afterJobAccepted(params: {
  jobId: string;
  requestId: string;
  signerName: string;
  presentedByName: string | null;
  ctx?: AnfrageKontext | null;
}): Promise<void> {
  const job = await prisma.job.findUnique({
    where: { id: params.jobId },
    select: {
      id: true,
      number: true,
      organizationId: true,
      title: true,
      customer: { select: { firstName: true, lastName: true, companyName: true } },
    },
  });
  if (!job) return;

  const kunde =
    job.customer.companyName ?? `${job.customer.firstName} ${job.customer.lastName}`.trim();

  await notifyStaff({
    organizationId: job.organizationId,
    title: 'Rapport vor Ort abgenommen',
    body: `${job.number} · ${kunde} · unterzeichnet von ${params.signerName}`,
    link: `/admin/einsaetze/${job.id}`,
    permission: 'job:read',
  });

  await audit.updated({
    organizationId: job.organizationId,
    entity: 'Job',
    entityId: job.id,
    summary:
      `Rapport ${job.number} vor Ort elektronisch abgenommen von ${params.signerName}` +
      (params.presentedByName ? ` (Gerät bereitgestellt durch ${params.presentedByName})` : '') +
      ` — Vorgang ${params.requestId}`,
    ip: params.ctx?.ip,
    userAgent: params.ctx?.userAgent,
  });
}
