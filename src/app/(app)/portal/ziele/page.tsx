import type { Metadata } from 'next';
import Link from 'next/link';
import { Target } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatDate } from '@/lib/utils';
import { OBJECTIVE_HORIZON_LABELS, OBJECTIVE_LEVEL_LABELS } from '@/lib/bi/labels';
import { getOrganizationId } from '@/server/services/organization.service';
import { getObjective, listObjectives } from '@/server/services/objective.service';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/primitives';
import { EmptyState, PageHeader } from '@/components/app/page-parts';
import { KeyResultsPanel } from '@/features/fuehrung/key-results-panel';
import { statusBadge } from '@/features/fuehrung/roadmap';

export const metadata: Metadata = {
  title: 'Meine Ziele',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Ziele im Mitarbeitendenportal: die eigenen mit Check-in, die Firmenziele
 * zum Lesen. Die Auswahl trifft der Dienst über `objective:read_own` — hier
 * wird nur angezeigt, was zurückkommt.
 */
export default async function PortalObjectivesPage({ searchParams }: { searchParams: Promise<{ ziel?: string }> }) {
  const session = await requirePermission('objective:read_own');
  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const { items } = await listObjectives(session, organizationId, { page: 1, pageSize: 50, order: 'desc', archiv: '0' });
  const own = items.filter((o) => o.ownerId === session.id);
  const company = items.filter((o) => o.ownerId !== session.id);
  const selected = params.ziel ? await getObjective(session, organizationId, params.ziel).catch(() => null) : null;

  return (
    <div className="space-y-8">
      <PageHeader title="Meine Ziele" description="Ihre Ziele mit Check-in — und die Firmenziele, zu denen sie beitragen." />

      {selected ? (
        <div className="space-y-4">
          <Link href="/portal/ziele" className="text-sm text-muted-foreground hover:text-foreground">
            ← Alle Ziele
          </Link>
          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-lg font-semibold">{selected.title}</h2>
              {statusBadge(selected.status)}
            </div>
            {selected.description ? <p className="mt-2 text-sm text-muted-foreground">{selected.description}</p> : null}
            <Progress value={selected.progressPct} className="mt-3" />
            <p className="mt-1 text-xs text-muted-foreground">{selected.progressPct} % · {selected.endsOn ? `bis ${formatDate(selected.endsOn)}` : selected.quarter ? `Q${selected.quarter} ${selected.fiscalYear}` : ''}</p>
          </div>
          <KeyResultsPanel objectiveId={selected.id} keyResults={selected.keyResults as never} kpis={[]} canEdit={false} canCheckin={can(session.role, 'objective:checkin') && selected.ownerId === session.id} />
        </div>
      ) : (
        <>
          <section className="space-y-3" aria-label="Meine Ziele">
            <h2 className="font-display text-base font-semibold">In meiner Verantwortung</h2>
            {own.length === 0 ? (
              <EmptyState icon={<Target aria-hidden />} title="Keine eigenen Ziele" description="Sobald Ihnen ein Ziel zugewiesen wird, erscheint es hier mit Check-in." />
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2">
                {own.map((o) => (
                  <li key={o.id}>
                    <Link href={`/portal/ziele?ziel=${o.id}`} className="block space-y-2 rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/30">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-medium leading-snug">{o.title}</p>
                        {statusBadge(o.status)}
                      </div>
                      <Progress value={o.progressPct} />
                      <p className="text-xs text-muted-foreground">{o.progressPct} % · {o._count.keyResults} Schlüsselergebnisse{o.endsOn ? ` · bis ${formatDate(o.endsOn)}` : ''}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3" aria-label="Firmenziele">
            <h2 className="font-display text-base font-semibold">Firmenziele</h2>
            {company.length === 0 ? (
              <p className="text-sm text-muted-foreground">Keine freigegebenen Firmenziele.</p>
            ) : (
              <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
                {company.map((o) => (
                  <li key={o.id} className="space-y-1.5 px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <Link href={`/portal/ziele?ziel=${o.id}`} className="min-w-0 truncate text-sm font-medium hover:text-primary">{o.title}</Link>
                      <span className="flex items-center gap-2">
                        <Badge size="sm" variant="outline">{OBJECTIVE_HORIZON_LABELS[o.horizon]}</Badge>
                        <span className="text-sm tabular-nums">{o.progressPct} %</span>
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{OBJECTIVE_LEVEL_LABELS[o.level]}{o.owner ? ` · ${o.owner.firstName} ${o.owner.lastName}` : ''}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
