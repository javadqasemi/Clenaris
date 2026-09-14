import 'server-only';

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { today } from '@/lib/bi/periods';
import { runKpiSnapshots } from './kpi.service';
import { snapshotHealth } from './health.service';
import { syncAllAutomaticKeyResults } from './objective.service';
import { countDueReviews } from './insight.service';
import { notifyExpiringDocuments } from './document.service';
import { runDueReportSchedules } from './bi-report.service';
import { notify } from './notification.service';

const log = logger('fuehrung');

/**
 * Nachtlauf der Unternehmensführung — die Reihenfolge ist fachlich:
 *
 *  1. Kennzahl-Snapshots (laufende Periode vorläufig, vorherige endgültig)
 *  2. Automatische Schlüsselergebnisse aus den neuen Snapshots
 *  3. Gesundheitswert festschreiben
 *  4. Fällige Prüfungen als *eine* gebündelte Meldung
 *  5. Ablaufende Dokumente
 *  6. Fällige Berichte (die brauchen die frischen Snapshots)
 *
 * Jeder Schritt ist gekapselt: schlägt einer fehl, laufen die übrigen. Ein
 * Fehler in einer Formel darf den Bericht nicht verhindern — der Bericht
 * zeigt dann eine Lücke, und die Lücke ist der Hinweis.
 */
export async function runFuehrungNightly(organizationId: string) {
  const summary: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      summary[name] = await fn();
    } catch (error) {
      summary[name] = { error: error instanceof Error ? error.message : String(error) };
      log.error('Nachtlauf-Schritt fehlgeschlagen', { step: name, error });
    }
  };

  await step('snapshots', () => runKpiSnapshots(organizationId));
  await step('keyResults', () => syncAllAutomaticKeyResults(organizationId));
  await step('health', async () => {
    const h = await snapshotHealth(organizationId);
    return { score: h.score, delta: h.scoreDelta };
  });
  await step('dueReviews', () => notifyDueReviews(organizationId));
  await step('expiringDocuments', () => notifyExpiringDocuments(organizationId));
  await step('reports', () => runDueReportSchedules(organizationId));
  return summary;
}

/**
 * Fällige Prüfungen: eine Meldung je Tag an die Geschäftsleitung, nicht eine
 * je Eintrag. Sieben Einzelmeldungen am Morgen sind der Grund, warum
 * Benachrichtigungen abgeschaltet werden.
 */
async function notifyDueReviews(organizationId: string) {
  const due = await countDueReviews(organizationId);
  if (due.total === 0) return { total: 0 };

  const now = today();
  const recipients = await prisma.user.findMany({
    where: { organizationId, role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE', deletedAt: null },
    select: { id: true, notifications: { where: { title: { startsWith: 'Prüfungen fällig' }, createdAt: { gte: now } }, select: { id: true }, take: 1 } },
  });
  const parts = [
    due.objectives ? `${due.objectives} Ziele` : null,
    due.risks ? `${due.risks} Risiken` : null,
    due.controls ? `${due.controls} Kontrollen` : null,
    due.market ? `${due.market} Markteinträge` : null,
  ].filter(Boolean);
  let sent = 0;
  for (const user of recipients) {
    if (user.notifications.length > 0) continue; // heute schon gemeldet
    await notify({
      userId: user.id,
      channels: ['IN_APP'],
      title: `Prüfungen fällig: ${due.total}`,
      body: parts.join(', '),
      link: '/admin/fuehrung',
      entity: 'Review',
    });
    sent += 1;
  }
  return { ...due, sent };
}
