import type { Metadata } from 'next';
import { ClipboardList } from 'lucide-react';

import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { cn, formatDate, formatRelative } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { Badge } from '@/components/ui/badge';
import { EmptyState, PageHeader } from '@/components/app/page-parts';
import { TaskToggle } from '@/features/admin/task-controls';

export const metadata: Metadata = {
  title: 'Meine Aufgaben',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const PRIORITY_LABELS: Record<string, { label: string; variant: 'destructive' | 'warning' | 'neutral' | 'outline' }> = {
  URGENT: { label: 'Dringend', variant: 'destructive' },
  HIGH: { label: 'Hoch', variant: 'warning' },
  NORMAL: { label: 'Normal', variant: 'neutral' },
  LOW: { label: 'Tief', variant: 'outline' },
};

/**
 * Die eigenen offenen Aufgaben im Mitarbeitendenportal (2026-09-28).
 *
 * Mitarbeitende halten `task:read` und `task:update`, und Aufgaben erreichen
 * sie auf mehreren Wegen: direkt zugewiesen, als Pendenz aus einer Sitzung,
 * als Massnahme, als Erinnerung. Die Benachrichtigungen zeigten bis dahin in
 * die Verwaltung (`/admin/aufgaben`), die die Rolle nicht betreten darf — die
 * Aufgabe war damit für die Person, der sie gehört, nirgends sichtbar.
 *
 * Bewusst schmal: nur Lesen und Abhaken. Anlegen, Umverteilen und Löschen
 * bleiben in der Verwaltung; im Portal ist die Person ausführend, nicht
 * planend. Abhaken läuft über denselben Endpunkt wie im Büro
 * (`PATCH /api/tasks/:id`), der für Mitarbeitende selbst prüft, dass die
 * Aufgabe ihnen zugewiesen ist.
 *
 * Die Eigentümerschaft steht in der Prisma-Abfrage (`assigneeId` der
 * Sitzung, `organizationId`) — nicht in der Anzeige. Keine Verweise auf
 * Kundschaft oder Anfragen: Die Verwaltungsseiten dahinter sind der Rolle
 * verschlossen, und `customer:read` hält sie seit 2026-09-27 nicht mehr.
 */
export default async function PortalTasksPage() {
  const session = await requirePermission('task:read');
  const organizationId = await getOrganizationId();
  const now = new Date();

  const tasks = await prisma.task.findMany({
    where: {
      organizationId,
      assigneeId: session.id,
      status: { in: ['OPEN', 'IN_PROGRESS'] },
    },
    orderBy: [{ dueAt: 'asc' }, { priority: 'desc' }],
    take: 100,
    select: { id: true, title: true, description: true, priority: true, dueAt: true },
  });

  const canUpdate = can(session.role, 'task:update');

  return (
    <div className="space-y-6">
      <PageHeader title="Meine Aufgaben" description="Was Ihnen zugewiesen ist — aus Sitzungen, Massnahmen oder direkt vom Büro. Erledigtes abhaken." />

      {tasks.length === 0 ? (
        <EmptyState
          icon={<ClipboardList aria-hidden />}
          title="Keine offenen Aufgaben"
          description="Sobald Ihnen jemand eine Aufgabe zuweist, erscheint sie hier und Sie erhalten eine Benachrichtigung."
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
          {tasks.map((task) => {
            const isOverdue = task.dueAt !== null && task.dueAt < now;
            const priority = PRIORITY_LABELS[task.priority] ?? PRIORITY_LABELS.NORMAL;
            return (
              <li key={task.id} className="flex items-start gap-4 p-4 sm:px-5">
                {canUpdate ? <TaskToggle taskId={task.id} done={false} /> : null}
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium leading-snug">{task.title}</p>
                  {task.description ? <p className="prose-measure text-sm leading-relaxed text-muted-foreground">{task.description}</p> : null}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <Badge variant={priority.variant} size="sm">
                      {priority.label}
                    </Badge>
                    {task.dueAt ? (
                      <span className={cn('tabular-nums', isOverdue ? 'font-medium text-destructive' : 'text-muted-foreground')}>
                        {isOverdue ? 'Überfällig seit ' : 'Fällig '}
                        {formatDate(task.dueAt)} · {formatRelative(task.dueAt)}
                      </span>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
