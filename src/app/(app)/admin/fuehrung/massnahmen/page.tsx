import type { Metadata } from 'next';
import Link from 'next/link';
import { Wrench } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatDate } from '@/lib/utils';
import { ACTION_KIND_LABELS } from '@/lib/bi/labels';
import { getOrganizationId } from '@/server/services/organization.service';
import { listActions } from '@/server/services/governance.service';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { FilterBar } from '@/components/app/filter-bar';
import { EmptyState, ListCard, PageHeader, TableScroll } from '@/components/app/page-parts';
import { ActionButton } from '@/features/fuehrung/action-button';

export const metadata: Metadata = {
  title: 'Massnahmen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Alle Massnahmen (CAPA) über Risiken, Kontrollen und Reklamationen hinweg.
 * Eröffnet werden sie am Bezugsobjekt — hier wird abgearbeitet: abschliessen,
 * Wirksamkeit bestätigen.
 */
export default async function ActionsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const session = await requirePermission('action:read');
  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const actions = await listActions(organizationId, { status: params.status === 'alle' ? 'alle' : 'offen' });
  const canUpdate = can(session.role, 'action:update');
  // Den Bezug nur verlinken, wo die Rolle das Register öffnen darf: Die
  // Betriebsleitung hält `action:read`, aber nicht `risk:read` — der Link
  // „Risiko: …" führte sie auf eine 404 (2026-09-28). Der Titel bleibt als
  // Text stehen, denn er erklärt, woher die Massnahme kommt.
  const canReadRisk = can(session.role, 'risk:read');
  const canReadControl = can(session.role, 'control:read');
  const canReadReviews = can(session.role, 'review:read');
  const now = new Date();

  return (
    <div className="space-y-6">
      <PageHeader title="Massnahmen" description="Korrektur-, Vorbeugungs- und Verbesserungsmassnahmen aus Risiken, Kontrollen und Reklamationen. Abgeschlossen ist eine Massnahme erst, wenn ihre Wirksamkeit bestätigt ist.">
        {/*
          Ohne Parameter zeigt die Seite die offenen Massnahmen; „alle" steht
          deshalb ausdrücklich als `?status=alle` in der URL (`defaultValue`).
          Kein Suchfeld: `listActions` wertet `q` nicht aus, und ein Feld, das
          nichts filtert, wäre eine Behauptung ohne Wirkung.
        */}
        <FilterBar search={false} filters={[{ param: 'status', label: 'Status', defaultValue: 'offen', options: [{ value: 'offen', label: 'Offene' }] }]} />
      </PageHeader>

      {actions.length === 0 ? (
        <EmptyState icon={<Wrench aria-hidden />} title="Keine Massnahmen" description="Massnahmen entstehen an einem Risiko, einer Kontrolle oder einer Bewertung — dort, wo die Abweichung festgestellt wird." />
      ) : (
        <ListCard>
          <TableScroll minWidth="60rem">
            <table className="data-table">
              <caption className="sr-only">Massnahmen</caption>
              <thead>
                <tr>
                  <th scope="col">Massnahme</th>
                  <th scope="col">Bezug</th>
                  <th scope="col">Zuständig</th>
                  <th scope="col">Frist</th>
                  <th scope="col">Status</th>
                  {canUpdate ? <th scope="col" /> : null}
                </tr>
              </thead>
              <tbody>
                {actions.map((a) => {
                  const overdue = !a.completedAt && a.dueOn && a.dueOn < now;
                  const ref: { href: string | null; label: string } | null = a.risk
                    ? { href: canReadRisk ? `/admin/fuehrung/risiken/${a.risk.id}` : null, label: `Risiko: ${a.risk.title}` }
                    : a.control
                      ? { href: canReadControl ? `/admin/fuehrung/qualitaet/${a.control.id}` : null, label: `Kontrolle: ${a.control.title}` }
                      : a.review
                        ? { href: canReadReviews ? '/admin/bewertungen' : null, label: `Bewertung: ${a.review.authorName} (${a.review.rating}/5)` }
                        : null;
                  return (
                    <tr key={a.id}>
                      <td>
                        <span className={a.completedAt ? 'text-muted-foreground line-through' : 'font-medium'}>{a.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          <Badge size="sm" variant="outline">{ACTION_KIND_LABELS[a.kind]}</Badge>
                          {a.rootCause ? <span className="ml-2">Ursache: {a.rootCause}</span> : null}
                        </span>
                      </td>
                      <td className="text-muted-foreground">{ref ? ref.href ? <Link href={ref.href} className="hover:text-primary">{ref.label}</Link> : ref.label : '—'}</td>
                      <td className="text-muted-foreground">{a.task?.assignee ? `${a.task.assignee.firstName} ${a.task.assignee.lastName}` : '—'}</td>
                      <td className={overdue ? 'font-medium text-destructive' : 'text-muted-foreground'}>{a.dueOn ? formatDate(a.dueOn) : '—'}</td>
                      <td>
                        {a.effectivenessCheckedAt ? <Badge size="sm" variant="success">Wirksam bestätigt</Badge> : a.completedAt ? <Badge size="sm" variant="info">Abgeschlossen</Badge> : a.task ? <StatusBadge status={a.task.status} size="sm" /> : <Badge size="sm" variant="neutral">Offen</Badge>}
                      </td>
                      {canUpdate ? (
                        <td>
                          <div className="flex justify-end gap-1">
                            {!a.completedAt ? <ActionButton endpoint={`/api/bi/actions/${a.id}`} method="PATCH" body={{ completed: true }} label="Abschliessen" successMessage="Massnahme abgeschlossen." variant="ghost" /> : null}
                            {a.completedAt && !a.effectivenessCheckedAt ? <ActionButton endpoint={`/api/bi/actions/${a.id}`} method="PATCH" body={{ effectivenessChecked: true }} label="Wirksam" withNote noteLabel="Wie wurde die Wirksamkeit geprüft?" noteField="effectivenessNote" successMessage="Wirksamkeit bestätigt." variant="ghost" /> : null}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        </ListCard>
      )}
    </div>
  );
}
