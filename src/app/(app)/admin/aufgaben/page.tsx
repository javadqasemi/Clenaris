import type { Metadata } from 'next';
import Link from 'next/link';
import { ClipboardList } from 'lucide-react';

import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { cn, formatDate, formatRelative } from '@/lib/utils';
import { TaskRowActions } from '@/features/admin/task-row-actions';
import { getOrganizationId } from '@/server/services/organization.service';
import { Badge } from '@/components/ui/badge';
import { PersonAvatar } from '@/components/ui/primitives';
import { KpiTile } from '@/components/app/kpi-tile';
import { EmptyState, PageHeader } from '@/components/app/page-parts';
import { TaskComposer, TaskToggle } from '@/features/admin/task-controls';

export const metadata: Metadata = {
  title: 'Aufgaben',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const PRIORITY_LABELS: Record<string, { label: string; variant: 'destructive' | 'warning' | 'neutral' | 'outline' }> = {
  URGENT: { label: 'Dringend', variant: 'destructive' },
  HIGH: { label: 'Hoch', variant: 'warning' },
  NORMAL: { label: 'Normal', variant: 'neutral' },
  LOW: { label: 'Tief', variant: 'outline' },
};

export default async function TasksPage() {
  const session = await requirePermission('task:read');
  const organizationId = await getOrganizationId();

  const now = new Date();
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  const [tasks, staff, overdue, dueToday] = await Promise.all([
    prisma.task.findMany({
      where: {
        status: { in: ['OPEN', 'IN_PROGRESS'] },
        OR: [
          { customer: { organizationId } },
          { lead: { organizationId } },
          { job: { organizationId } },
          { customerId: null, leadId: null, jobId: null },
        ],
      },
      orderBy: [{ dueAt: 'asc' }, { priority: 'desc' }],
      take: 100,
      include: {
        assignee: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        customer: { select: { id: true, firstName: true, lastName: true, companyName: true } },
        lead: { select: { id: true, firstName: true, lastName: true, company: true } },
        job: { select: { id: true, number: true } },
      },
    }),
    prisma.user.findMany({
      where: { organizationId, role: { in: ['ADMIN', 'MANAGER', 'EMPLOYEE'] }, status: 'ACTIVE' },
      orderBy: { firstName: 'asc' },
      select: { id: true, firstName: true, lastName: true },
    }),
    prisma.task.count({
      where: { status: { in: ['OPEN', 'IN_PROGRESS'] }, dueAt: { lt: now } },
    }),
    prisma.task.count({
      where: { status: { in: ['OPEN', 'IN_PROGRESS'] }, dueAt: { gte: now, lt: endOfToday } },
    }),
  ]);

  const mine = tasks.filter((task) => task.assigneeId === session.id);
  const staffOptions = staff.map((user) => ({ id: user.id, name: `${user.firstName} ${user.lastName}` }));
  const canEdit = can(session.role, 'task:update');
  const canDelete = can(session.role, 'task:delete');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Aufgaben"
        description="Nachfassen, Rückrufe, interne Erledigungen. Aufgaben aus Automationen erscheinen hier automatisch."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile
          label="Überfällig"
          value={String(overdue)}
          accent={overdue > 0 ? 'destructive' : undefined}
          invertTrend
        />
        <KpiTile label="Heute fällig" value={String(dueToday)} />
        <KpiTile label="Mir zugewiesen" value={String(mine.length)} />
      </div>

      {can(session.role, 'task:create') ? <TaskComposer staff={staffOptions} /> : null}

      {tasks.length === 0 ? (
        <EmptyState
          icon={<ClipboardList aria-hidden />}
          title="Keine offenen Aufgaben"
          description="Alles erledigt. Neue Aufgaben entstehen beim Nachfassen von Leads oder wenn Sie selbst eine erfassen."
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
          {tasks.map((task) => {
            const isOverdue = task.dueAt && task.dueAt < now;
            const priority = PRIORITY_LABELS[task.priority] ?? PRIORITY_LABELS.NORMAL;

            const relatedHref = task.customer
              ? `/admin/kunden/${task.customer.id}`
              : task.lead
                ? `/admin/leads/${task.lead.id}`
                : task.job
                  ? `/admin/einsaetze/${task.job.id}`
                  : null;

            const relatedLabel = task.customer
              ? (task.customer.companyName ?? `${task.customer.firstName} ${task.customer.lastName}`)
              : task.lead
                ? (task.lead.company ?? `${task.lead.firstName} ${task.lead.lastName}`)
                : task.job
                  ? task.job.number
                  : null;

            return (
              <li key={task.id} className="flex items-start gap-4 p-4 sm:px-5">
                <TaskToggle taskId={task.id} done={false} />

                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium leading-snug">{task.title}</p>

                  {task.description ? (
                    <p className="prose-measure text-sm leading-relaxed text-muted-foreground">
                      {task.description}
                    </p>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <Badge variant={priority.variant} size="sm">
                      {priority.label}
                    </Badge>

                    {task.dueAt ? (
                      <span
                        className={cn(
                          'tabular-nums',
                          isOverdue ? 'font-medium text-destructive' : 'text-muted-foreground',
                        )}
                      >
                        {isOverdue ? 'Überfällig seit ' : 'Fällig '}
                        {formatDate(task.dueAt)} · {formatRelative(task.dueAt)}
                      </span>
                    ) : null}

                    {relatedHref && relatedLabel ? (
                      <Link
                        href={relatedHref}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {relatedLabel}
                      </Link>
                    ) : null}
                  </div>
                </div>

                {task.assignee ? (
                  <PersonAvatar
                    firstName={task.assignee.firstName}
                    lastName={task.assignee.lastName}
                    src={task.assignee.avatarUrl}
                    size="sm"
                  />
                ) : (
                  <Badge variant="warning" size="sm">
                    Niemand
                  </Badge>
                )}

                {canEdit || canDelete ? (
                  <TaskRowActions
                    taskId={task.id}
                    staff={staffOptions}
                    canEdit={canEdit}
                    canDelete={canDelete}
                    values={{
                      title: task.title,
                      description: task.description,
                      priority: task.priority,
                      dueAt: task.dueAt ? task.dueAt.toISOString() : null,
                      assigneeId: task.assigneeId,
                    }}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
