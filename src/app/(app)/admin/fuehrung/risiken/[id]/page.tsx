import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { toNumber } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/utils';
import { ACTION_KIND_LABELS, PRIORITY_LABELS, RISK_BAND_LABELS, RISK_CATEGORY_LABELS, RISK_STATUS_LABELS, optionsOf } from '@/lib/bi/labels';
import { getOrganizationId } from '@/server/services/organization.service';
import { getRisk } from '@/server/services/governance.service';
import { listStaffOptions } from '@/server/services/fuehrung-options.service';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { Markdown } from '@/components/markdown';
import { ActionButton } from '@/features/fuehrung/action-button';
import { FormDialog } from '@/features/fuehrung/resource-form';
import { riskFields } from '@/features/fuehrung/field-specs';

export const metadata: Metadata = {
  title: 'Risiko',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const BAND_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'neutral'> = { LOW: 'success', MEDIUM: 'neutral', HIGH: 'warning', CRITICAL: 'destructive' };

export default async function RiskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('risk:read');
  const { id } = await params;
  const organizationId = await getOrganizationId();
  const risk = await getRisk(organizationId, id).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const staff = await listStaffOptions(organizationId);
  const canEdit = can(session.role, 'risk:update');
  const overdue = risk.nextReviewAt && risk.nextReviewAt < new Date() && risk.status !== 'CLOSED';
  const log = (Array.isArray(risk.reviewLog) ? risk.reviewLog : []) as { at: string; by: string | null; note: string | null }[];

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/fuehrung/risiken">
          <ArrowLeft aria-hidden />
          Risikoregister
        </Link>
      </Button>

      <PageHeader
        title={risk.title}
        description={`${RISK_CATEGORY_LABELS[risk.category]} · ${RISK_STATUS_LABELS[risk.status]}${risk.owner ? ` · ${risk.owner.firstName} ${risk.owner.lastName}` : ''}`}
        actions={
          <>
            <Badge variant={BAND_VARIANT[risk.band]}>{RISK_BAND_LABELS[risk.band]} · Schwere {risk.severity}</Badge>
            {canEdit ? (
              <>
                <ActionButton endpoint={`/api/bi/risks/${id}/review`} label="Geprüft" withNote noteLabel="Was wurde festgestellt?" successMessage="Prüfung festgehalten." variant={overdue ? 'default' : 'outline'}>
                  <CheckCircle2 aria-hidden />
                </ActionButton>
                <FormDialog
                  title="Risiko bearbeiten"
                  triggerLabel="Bearbeiten"
                  triggerVariant="outline"
                  plainTrigger
                  endpoint={`/api/bi/risks/${id}`}
                  method="PATCH"
                  successMessage="Risiko gespeichert."
                  fields={riskFields(staff, true)}
                  values={{
                    title: risk.title,
                    category: risk.category,
                    status: risk.status,
                    probability: String(risk.probability),
                    impact: String(risk.impact),
                    residualProbability: risk.residualProbability === null ? '' : String(risk.residualProbability),
                    residualImpact: risk.residualImpact === null ? '' : String(risk.residualImpact),
                    potentialLoss: risk.potentialLoss === null ? null : toNumber(risk.potentialLoss),
                    ownerId: risk.ownerId,
                    reviewIntervalDays: risk.reviewIntervalDays,
                    description: risk.description,
                    mitigationPlan: risk.mitigationPlan,
                  }}
                />
              </>
            ) : null}
            {can(session.role, 'risk:delete') ? <ActionButton endpoint={`/api/bi/risks/${id}`} method="DELETE" label="Löschen" confirm="Das Risiko wandert in den Papierkorb; Massnahmen bleiben bestehen." variant="ghost" redirectTo="/admin/fuehrung/risiken" /> : null}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-border bg-card p-5">
              <p className="text-sm text-muted-foreground">Brutto</p>
              <p className="mt-1 font-display text-3xl font-bold tabular-nums">{risk.severity}</p>
              <p className="text-sm text-muted-foreground">Wahrscheinlichkeit {risk.probability} × Auswirkung {risk.impact}</p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-5">
              <p className="text-sm text-muted-foreground">Netto nach Massnahmen</p>
              <p className="mt-1 font-display text-3xl font-bold tabular-nums">{risk.residualSeverity ?? '—'}</p>
              <p className="text-sm text-muted-foreground">{risk.residualSeverity ? `${risk.residualProbability} × ${risk.residualImpact} · ${RISK_BAND_LABELS[risk.residualBand!]}` : 'Noch nicht bewertet'}</p>
            </div>
          </div>

          {risk.description ? (
            <DetailSection title="Beschreibung" body="form">
              <Markdown content={risk.description} />
            </DetailSection>
          ) : null}
          {risk.mitigationPlan ? (
            <DetailSection title="Gegenmassnahmen" body="form">
              <Markdown content={risk.mitigationPlan} />
            </DetailSection>
          ) : null}

          <DetailSection
            title="Massnahmen"
            description="Korrektur, Vorbeugung, Verbesserung — mit Zuständigkeit entsteht eine Aufgabe."
            body="flush"
            action={
              can(session.role, 'action:create') ? (
                <FormDialog
                  title="Massnahme eröffnen"
                  triggerLabel="Massnahme"
                  triggerVariant="outline"
                  triggerSize="sm"
                  endpoint="/api/bi/actions"
                  extra={{ riskId: id }}
                  successMessage="Massnahme eröffnet."
                  fields={[
                    { name: 'title', label: 'Massnahme', required: true },
                    { name: 'kind', label: 'Art', type: 'select', required: true, half: true, options: optionsOf(ACTION_KIND_LABELS) },
                    { name: 'priority', label: 'Priorität', type: 'select', required: true, half: true, options: optionsOf(PRIORITY_LABELS) },
                    { name: 'assigneeId', label: 'Zuständig', type: 'select', half: true, options: staff.map((s) => ({ value: s.id, label: s.name })), placeholder: 'Noch offen', hint: 'Mit Person entsteht eine Aufgabe.' },
                    { name: 'dueOn', label: 'Frist', type: 'date', half: true },
                    { name: 'rootCause', label: 'Ursache', type: 'textarea', rows: 2 },
                    { name: 'description', label: 'Beschreibung', type: 'textarea', rows: 2 },
                  ]}
                  values={{ kind: 'CORRECTIVE', priority: 'NORMAL' }}
                />
              ) : null
            }
          >
            {risk.actions.length === 0 ? (
              <p className="px-6 py-8 text-center text-sm text-muted-foreground">Keine Massnahmen.</p>
            ) : (
              <ul className="divide-y divide-border">
                {risk.actions.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-6 py-3 text-sm">
                    <span className={a.completedAt ? 'text-muted-foreground line-through' : 'font-medium'}>
                      <Badge size="sm" variant="outline" className="mr-2">{ACTION_KIND_LABELS[a.kind]}</Badge>
                      {a.title}
                    </span>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      {a.task?.assignee ? `${a.task.assignee.firstName} ${a.task.assignee.lastName}` : ''}
                      {a.dueOn ? ` · ${formatDate(a.dueOn)}` : ''}
                      {a.task ? <StatusBadge status={a.task.status} size="sm" /> : null}
                      {a.effectivenessCheckedAt ? <Badge size="sm" variant="success">Wirksam</Badge> : null}
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
                {risk.nextReviewAt ? <span className={overdue ? 'text-warning' : ''}>{overdue ? 'überfällig seit ' : 'fällig am '}{formatDate(risk.nextReviewAt)}</span> : '—'}
                <span className="block text-muted-foreground">alle {risk.reviewIntervalDays} Tage{risk.lastReviewedAt ? ` · zuletzt ${formatDate(risk.lastReviewedAt)}` : ''}</span>
              </DetailRow>
              {risk.potentialLoss !== null ? <DetailRow label="Schaden im Eintrittsfall">{formatCurrency(toNumber(risk.potentialLoss))}</DetailRow> : null}
              <DetailRow label="Erfasst">{formatDateTime(risk.createdAt)}</DetailRow>
              {risk.closedAt ? <DetailRow label="Geschlossen">{formatDateTime(risk.closedAt)}</DetailRow> : null}
            </dl>
          </DetailSection>
          {log.length > 0 ? (
            <DetailSection title="Prüfverlauf" body="list">
              <ul className="protocol-list text-sm">
                {log.map((entry, i) => (
                  <li key={i} className="py-2.5">
                    <p className="text-muted-foreground">{formatDateTime(entry.at)}{entry.by ? ` · ${entry.by}` : ''}</p>
                    {entry.note ? <p>{entry.note}</p> : <p className="text-muted-foreground">Ohne Notiz bestätigt.</p>}
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
