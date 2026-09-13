import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CheckCircle2, Copy, Plus } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { NotFoundError } from '@/lib/errors';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/utils';
import { OBJECTIVE_HORIZON_LABELS, OBJECTIVE_LEVEL_LABELS, PRIORITY_LABELS } from '@/lib/bi/labels';
import { getOrganizationId } from '@/server/services/organization.service';
import { getObjective } from '@/server/services/objective.service';
import { listKpiOptions, listObjectiveOptions, listStaffOptions } from '@/server/services/fuehrung-options.service';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/primitives';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { Markdown } from '@/components/markdown';
import { ActionButton } from '@/features/fuehrung/action-button';
import { FormDialog } from '@/features/fuehrung/resource-form';
import { KeyResultsPanel } from '@/features/fuehrung/key-results-panel';
import { objectiveFields } from '@/features/fuehrung/objective-fields';
import { statusBadge } from '@/features/fuehrung/roadmap';

export const metadata: Metadata = {
  title: 'Ziel',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function ObjectiveDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('objective:read');
  const { id } = await params;
  const organizationId = await getOrganizationId();
  const objective = await getObjective(session, organizationId, id).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const [staff, parents, kpis] = await Promise.all([listStaffOptions(organizationId), listObjectiveOptions(organizationId), listKpiOptions(organizationId)]);
  const canEdit = can(session.role, 'objective:update');
  const overdue = objective.nextReviewAt && objective.nextReviewAt < new Date();

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/fuehrung/ziele">
          <ArrowLeft aria-hidden />
          Alle Ziele
        </Link>
      </Button>

      <PageHeader
        title={objective.title}
        description={`${OBJECTIVE_HORIZON_LABELS[objective.horizon]} · ${OBJECTIVE_LEVEL_LABELS[objective.level]}${objective.department ? ` · ${objective.department}` : ''}${objective.parent ? ` · unter „${objective.parent.title}"` : ''}`}
        actions={
          <>
            {statusBadge(objective.status)}
            {canEdit ? (
              <>
                <ActionButton endpoint={`/api/bi/objectives/${id}/review`} label="Geprüft" withNote noteLabel="Was wurde festgestellt?" successMessage="Prüfung festgehalten." variant={overdue ? 'default' : 'outline'}>
                  <CheckCircle2 aria-hidden />
                </ActionButton>
                <FormDialog
                  title="Ziel bearbeiten"
                  triggerLabel="Bearbeiten"
                  triggerVariant="outline"
                  plainTrigger
                  endpoint={`/api/bi/objectives/${id}`}
                  method="PATCH"
                  successMessage="Ziel gespeichert."
                  fields={objectiveFields({ staff, parents: parents.filter((p) => p.id !== id), editing: true })}
                  values={{
                    title: objective.title,
                    horizon: objective.horizon,
                    level: objective.level,
                    status: objective.status,
                    priority: objective.priority,
                    ownerId: objective.ownerId,
                    department: objective.department,
                    parentId: objective.parentId,
                    fiscalYear: objective.fiscalYear,
                    quarter: objective.quarter === null ? '' : String(objective.quarter),
                    startsOn: objective.startsOn,
                    endsOn: objective.endsOn,
                    reviewIntervalDays: objective.reviewIntervalDays,
                    budgetAmount: objective.budgetAmount === null ? null : toNumber(objective.budgetAmount),
                    expectedRoiPct: objective.expectedRoiPct === null ? null : toNumber(objective.expectedRoiPct),
                    description: objective.description,
                  }}
                />
              </>
            ) : null}
            {can(session.role, 'objective:create') ? (
              <ActionButton endpoint={`/api/bi/objectives/${id}/duplicate`} label="Duplizieren" successMessage="Kopie angelegt." variant="ghost">
                <Copy aria-hidden />
              </ActionButton>
            ) : null}
            {can(session.role, 'objective:delete') ? (
              <ActionButton endpoint={`/api/bi/objectives/${id}`} method="DELETE" label="Löschen" confirm="Das Ziel wandert in den Papierkorb. Schlüsselergebnisse und Check-ins bleiben erhalten." variant="ghost" redirectTo="/admin/fuehrung/ziele" />
            ) : null}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <div className="rounded-2xl border border-border bg-card p-6">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">Fortschritt</span>
              <span className="font-display text-2xl font-bold tabular-nums">{objective.progressPct} %</span>
            </div>
            <Progress value={objective.progressPct} className="mt-3 h-3" />
            <p className="mt-2 text-xs text-muted-foreground">
              {objective.keyResults.length > 0 ? 'Mittel der Schlüsselergebnisse.' : objective.children.length > 0 ? 'Mittel der untergeordneten Ziele.' : 'Noch keine Messgrösse.'}
            </p>
          </div>

          {objective.description ? (
            <DetailSection title="Beschreibung" body="form">
              <Markdown content={objective.description} />
            </DetailSection>
          ) : null}

          <KeyResultsPanel objectiveId={id} keyResults={objective.keyResults as never} kpis={kpis} canEdit={canEdit} canCheckin={can(session.role, 'objective:checkin')} />

          <DetailSection
            title="Massnahmen"
            description="Aufgaben zu diesem Ziel — mit Frist, Zuständigkeit und Erinnerung wie jede andere Aufgabe."
            body="flush"
            action={
              canEdit ? (
                <FormDialog
                  title="Massnahme anlegen"
                  triggerLabel="Massnahme"
                  triggerVariant="outline"
                  triggerSize="sm"
                  endpoint={`/api/bi/objectives/${id}/tasks`}
                  successMessage="Massnahme angelegt."
                  fields={[
                    { name: 'title', label: 'Was ist zu tun?', required: true },
                    { name: 'assigneeId', label: 'Zuständig', type: 'select', half: true, options: staff.map((s) => ({ value: s.id, label: s.name })), placeholder: 'Verantwortliche Person des Ziels' },
                    { name: 'dueAt', label: 'Frist', type: 'datetime', half: true },
                    { name: 'priority', label: 'Priorität', type: 'select', half: true, options: Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label })), required: true },
                    { name: 'description', label: 'Details', type: 'textarea', rows: 2 },
                  ]}
                  values={{ priority: 'NORMAL' }}
                />
              ) : null
            }
          >
            {objective.tasks.length === 0 ? (
              <p className="px-6 py-8 text-center text-sm text-muted-foreground">Keine Massnahmen.</p>
            ) : (
              <ul className="divide-y divide-border">
                {objective.tasks.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-6 py-3 text-sm">
                    <span className={t.status === 'DONE' ? 'line-through text-muted-foreground' : 'font-medium'}>{t.title}</span>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      {t.assignee ? `${t.assignee.firstName} ${t.assignee.lastName}` : 'Niemand'}
                      {t.dueAt ? ` · ${formatDate(t.dueAt)}` : ''}
                      <StatusBadge status={t.status} size="sm" />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </DetailSection>

          {objective.children.length > 0 || canEdit ? (
            <DetailSection
              title="Untergeordnete Ziele"
              body="flush"
              action={
                canEdit ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/admin/fuehrung/ziele/neu?eltern=${id}&flughoehe=${objective.horizon === 'STRATEGY' ? 'OBJECTIVE' : 'INITIATIVE'}`}>
                      <Plus aria-hidden />
                      Unterziel
                    </Link>
                  </Button>
                ) : null
              }
            >
              {objective.children.length === 0 ? (
                <p className="px-6 py-8 text-center text-sm text-muted-foreground">Keine untergeordneten Ziele.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {objective.children.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-3 px-6 py-3 text-sm">
                      <Link href={`/admin/fuehrung/ziele/${c.id}`} className="min-w-0 truncate font-medium hover:text-primary">
                        <Badge size="sm" variant="outline" className="mr-2">{OBJECTIVE_HORIZON_LABELS[c.horizon]}</Badge>
                        {c.title}
                      </Link>
                      <span className="flex items-center gap-2">
                        {statusBadge(c.status)}
                        <span className="tabular-nums">{c.progressPct} %</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </DetailSection>
          ) : null}
        </div>

        <div className="space-y-6">
          <DetailSection title="Eckdaten" body="list">
            <dl className="protocol-list protocol-list--tight">
              <DetailRow label="Verantwortlich">{objective.owner ? `${objective.owner.firstName} ${objective.owner.lastName}` : '—'}</DetailRow>
              <DetailRow label="Priorität">{PRIORITY_LABELS[objective.priority]}</DetailRow>
              <DetailRow label="Zeitraum">
                {objective.quarter ? `Q${objective.quarter} ${objective.fiscalYear}` : objective.fiscalYear ? String(objective.fiscalYear) : '—'}
                {objective.startsOn || objective.endsOn ? <span className="block text-muted-foreground">{objective.startsOn ? formatDate(objective.startsOn) : '…'} – {objective.endsOn ? formatDate(objective.endsOn) : '…'}</span> : null}
              </DetailRow>
              <DetailRow label="Prüfung">
                {objective.nextReviewAt ? <span className={overdue ? 'text-warning' : ''}>{overdue ? 'überfällig seit ' : 'fällig am '}{formatDate(objective.nextReviewAt)}</span> : 'Kein Zyklus'}
                {objective.lastReviewedAt ? <span className="block text-muted-foreground">zuletzt {formatDate(objective.lastReviewedAt)}</span> : null}
              </DetailRow>
              {objective.budgetAmount !== null ? <DetailRow label="Budget">{formatCurrency(toNumber(objective.budgetAmount))}</DetailRow> : null}
              {objective.expectedRoiPct !== null ? <DetailRow label="Erwarteter ROI">{toNumber(objective.expectedRoiPct)} %</DetailRow> : null}
              <DetailRow label="Angelegt">{formatDateTime(objective.createdAt)}</DetailRow>
            </dl>
          </DetailSection>

          {objective.meetings.length > 0 ? (
            <DetailSection title="Sitzungen" body="list">
              <ul className="protocol-list text-sm">
                {objective.meetings.map((m) => (
                  <li key={m.id} className="flex justify-between gap-2 py-2.5">
                    <Link href={`/admin/fuehrung/sitzungen/${m.id}`} className="min-w-0 truncate hover:text-primary">{m.title}</Link>
                    <span className="text-muted-foreground">{formatDate(m.heldAt)}</span>
                  </li>
                ))}
              </ul>
            </DetailSection>
          ) : null}
        </div>
      </div>
    </div>
  );
}
