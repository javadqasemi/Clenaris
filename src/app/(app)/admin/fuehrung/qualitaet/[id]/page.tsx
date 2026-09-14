import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertTriangle, ArrowLeft, CheckCircle2 } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { NotFoundError } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/utils';
import { ACTION_KIND_LABELS, CONTROL_KIND_LABELS, CONTROL_STATUS_LABELS, PRIORITY_LABELS, optionsOf } from '@/lib/bi/labels';
import { getOrganizationId } from '@/server/services/organization.service';
import { getControl } from '@/server/services/governance.service';
import { listStaffOptions } from '@/server/services/fuehrung-options.service';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { Markdown } from '@/components/markdown';
import { ActionButton } from '@/features/fuehrung/action-button';
import { FormDialog } from '@/features/fuehrung/resource-form';
import { controlFields } from '@/features/fuehrung/field-specs';

export const metadata: Metadata = {
  title: 'Kontrolle',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function ControlDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('control:read');
  const { id } = await params;
  const organizationId = await getOrganizationId();
  const control = await getControl(organizationId, id).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const staff = await listStaffOptions(organizationId);
  const canEdit = can(session.role, 'control:update');
  const overdue = control.nextReviewAt && control.nextReviewAt < new Date() && control.status !== 'RETIRED';
  const log = (Array.isArray(control.reviewLog) ? control.reviewLog : []) as { at: string; by: string | null; note: string | null; outcome?: string }[];

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/fuehrung/qualitaet">
          <ArrowLeft aria-hidden />
          Qualität und Compliance
        </Link>
      </Button>

      <PageHeader
        title={control.title}
        description={`${CONTROL_KIND_LABELS[control.kind]}${control.reference ? ` · ${control.reference}` : ''}${control.owner ? ` · ${control.owner.firstName} ${control.owner.lastName}` : ''}`}
        actions={
          <>
            <Badge variant={control.status === 'NON_COMPLIANT' ? 'destructive' : control.status === 'ACTIVE' ? 'success' : 'neutral'}>{CONTROL_STATUS_LABELS[control.status]}</Badge>
            {canEdit ? (
              <>
                <ActionButton endpoint={`/api/bi/controls/${id}/review`} body={{ outcome: 'COMPLIANT' }} label="In Ordnung" withNote noteLabel="Nachweis / Bemerkung" successMessage="Prüfung festgehalten." variant={overdue ? 'default' : 'outline'}>
                  <CheckCircle2 aria-hidden />
                </ActionButton>
                <ActionButton endpoint={`/api/bi/controls/${id}/review`} body={{ outcome: 'NON_COMPLIANT' }} label="Abweichung" withNote noteLabel="Was weicht ab?" successMessage="Abweichung festgehalten — eröffnen Sie eine Massnahme." variant="outline">
                  <AlertTriangle aria-hidden />
                </ActionButton>
                <FormDialog
                  title="Kontrolle bearbeiten"
                  triggerLabel="Bearbeiten"
                  triggerVariant="outline"
                  plainTrigger
                  endpoint={`/api/bi/controls/${id}`}
                  method="PATCH"
                  successMessage="Kontrolle gespeichert."
                  fields={controlFields(staff, true)}
                  values={{ title: control.title, kind: control.kind, status: control.status, reference: control.reference, reviewIntervalDays: control.reviewIntervalDays, ownerId: control.ownerId, evidenceNote: control.evidenceNote, description: control.description }}
                />
              </>
            ) : null}
            {can(session.role, 'control:delete') ? <ActionButton endpoint={`/api/bi/controls/${id}`} method="DELETE" label="Löschen" confirm="Die Kontrolle wandert in den Papierkorb." variant="ghost" redirectTo="/admin/fuehrung/qualitaet" /> : null}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          {control.description ? (
            <DetailSection title="Ablauf / Anforderung" body="form">
              <Markdown content={control.description} />
            </DetailSection>
          ) : null}

          <DetailSection
            title="Massnahmen"
            body="flush"
            action={
              can(session.role, 'action:create') ? (
                <FormDialog
                  title="Massnahme eröffnen"
                  triggerLabel="Massnahme"
                  triggerVariant="outline"
                  triggerSize="sm"
                  endpoint="/api/bi/actions"
                  extra={{ controlId: id }}
                  successMessage="Massnahme eröffnet."
                  fields={[
                    { name: 'title', label: 'Massnahme', required: true },
                    { name: 'kind', label: 'Art', type: 'select', required: true, half: true, options: optionsOf(ACTION_KIND_LABELS) },
                    { name: 'priority', label: 'Priorität', type: 'select', required: true, half: true, options: optionsOf(PRIORITY_LABELS) },
                    { name: 'assigneeId', label: 'Zuständig', type: 'select', half: true, options: staff.map((s) => ({ value: s.id, label: s.name })), placeholder: 'Noch offen' },
                    { name: 'dueOn', label: 'Frist', type: 'date', half: true },
                    { name: 'rootCause', label: 'Ursache', type: 'textarea', rows: 2 },
                  ]}
                  values={{ kind: 'CORRECTIVE', priority: 'NORMAL' }}
                />
              ) : null
            }
          >
            {control.actions.length === 0 ? (
              <p className="px-6 py-8 text-center text-sm text-muted-foreground">Keine Massnahmen.</p>
            ) : (
              <ul className="divide-y divide-border">
                {control.actions.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-6 py-3 text-sm">
                    <span className={a.completedAt ? 'text-muted-foreground line-through' : 'font-medium'}>
                      <Badge size="sm" variant="outline" className="mr-2">{ACTION_KIND_LABELS[a.kind]}</Badge>
                      {a.title}
                    </span>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      {a.dueOn ? formatDate(a.dueOn) : ''}
                      {a.task ? <StatusBadge status={a.task.status} size="sm" /> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </DetailSection>
        </div>

        <div className="space-y-6">
          <DetailSection title="Eckdaten" body="list">
            <dl className="protocol-list protocol-list--tight">
              <DetailRow label="Prüfung">
                {control.nextReviewAt ? <span className={overdue ? 'text-warning' : ''}>{overdue ? 'überfällig seit ' : 'fällig am '}{formatDate(control.nextReviewAt)}</span> : '—'}
                <span className="block text-muted-foreground">alle {control.reviewIntervalDays} Tage{control.lastReviewedAt ? ` · zuletzt ${formatDate(control.lastReviewedAt)}` : ''}</span>
              </DetailRow>
              <DetailRow label="Nachweis">{control.evidenceNote ?? '—'}</DetailRow>
              <DetailRow label="Angelegt">{formatDateTime(control.createdAt)}</DetailRow>
            </dl>
          </DetailSection>
          {log.length > 0 ? (
            <DetailSection title="Prüfverlauf" body="list">
              <ul className="protocol-list text-sm">
                {log.map((entry, i) => (
                  <li key={i} className="py-2.5">
                    <p className="flex items-center gap-2 text-muted-foreground">
                      {formatDateTime(entry.at)}{entry.by ? ` · ${entry.by}` : ''}
                      {entry.outcome ? <Badge size="sm" variant={entry.outcome === 'COMPLIANT' ? 'success' : 'destructive'}>{entry.outcome === 'COMPLIANT' ? 'In Ordnung' : 'Abweichung'}</Badge> : null}
                    </p>
                    {entry.note ? <p>{entry.note}</p> : null}
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
