import type { Metadata } from 'next';
import { Download, FileBarChart } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatBytes, formatDate, formatDateTime } from '@/lib/utils';
import { REPORT_CADENCE_LABELS, REPORT_FORMAT_LABELS, REPORT_KIND_LABELS, REPORT_STATUS_LABELS } from '@/lib/bi/labels';
import { getOrganizationId } from '@/server/services/organization.service';
import { listReportRuns, listReportSchedules } from '@/server/services/bi-report.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DetailSection, EmptyState, PageHeader } from '@/components/app/page-parts';
import { ActionButton } from '@/features/fuehrung/action-button';
import { GenerateReportForm, ScheduleDialog } from '@/features/fuehrung/report-tools';

export const metadata: Metadata = {
  title: 'Berichte',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const session = await requirePermission('bireport:read');
  const organizationId = await getOrganizationId();
  const [runs, schedules] = await Promise.all([listReportRuns(organizationId, { limit: 40 }), listReportSchedules(organizationId)]);
  const canManage = can(session.role, 'bireport:manage');

  return (
    <div className="space-y-6">
      <PageHeader title="Berichte" description="Führungsberichte als PDF, Excel oder Word — auf Abruf oder nach Zeitplan an die Geschäftsleitung. Die Datei bleibt liegen; was verschickt wurde, bleibt nachlesbar." actions={canManage ? <ScheduleDialog /> : null} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <DetailSection title="Erzeugte Berichte" body="flush">
          {runs.length === 0 ? (
            <EmptyState className="m-4" icon={<FileBarChart aria-hidden />} title="Noch kein Bericht" description="Erzeugen Sie den ersten Monatsbericht — oder richten Sie einen Zeitplan ein." />
          ) : (
            <ul className="divide-y divide-border">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium">{REPORT_KIND_LABELS[run.kind]}</span>
                    <span className="ml-2 text-muted-foreground">{formatDate(run.periodStart)} – {formatDate(run.periodEnd)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {REPORT_FORMAT_LABELS[run.format]} · {formatDateTime(run.createdAt)}
                      {run.schedule ? ` · Zeitplan „${run.schedule.name}"` : ''}
                      {run.file ? ` · ${formatBytes(run.file.sizeBytes)}` : ''}
                      {run.error ? ` · ${run.error}` : ''}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge size="sm" variant={run.status === 'READY' ? 'success' : run.status === 'FAILED' ? 'destructive' : 'neutral'}>{REPORT_STATUS_LABELS[run.status] ?? run.status}</Badge>
                    {run.status === 'READY' ? (
                      <Button asChild variant="ghost" size="sm">
                        <a href={`/api/bi/reports/${run.id}/download`}>
                          <Download aria-hidden />
                          Öffnen
                        </a>
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>

        <div className="space-y-6">
          {canManage ? <GenerateReportForm /> : null}
          <DetailSection title="Zeitpläne" body="flush">
            {schedules.length === 0 ? (
              <p className="px-6 py-6 text-center text-sm text-muted-foreground">Keine Zeitpläne.</p>
            ) : (
              <ul className="divide-y divide-border">
                {schedules.map((s) => (
                  <li key={s.id} className="space-y-1 px-6 py-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{s.name}</span>
                      <Badge size="sm" variant={s.active ? 'success' : 'neutral'}>{s.active ? 'Aktiv' : 'Pausiert'}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {REPORT_KIND_LABELS[s.kind]} · {REPORT_CADENCE_LABELS[s.cadence]} · {REPORT_FORMAT_LABELS[s.format]}
                      {s.recipients.length ? ` · ${s.recipients.length} Empfänger` : ' · ohne Versand'}
                      {s.nextRunAt ? ` · nächster Lauf ${formatDate(s.nextRunAt)}` : ''}
                    </p>
                    {canManage ? (
                      <div className="flex gap-1">
                        <ActionButton endpoint={`/api/bi/report-schedules/${s.id}`} method="PATCH" body={{ active: !s.active }} label={s.active ? 'Pausieren' : 'Aktivieren'} variant="ghost" successMessage="Zeitplan geändert." />
                        <ActionButton endpoint={`/api/bi/report-schedules/${s.id}`} method="DELETE" label="Löschen" confirm="Zeitplan löschen? Erzeugte Berichte bleiben." variant="ghost" />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </DetailSection>
        </div>
      </div>
    </div>
  );
}
