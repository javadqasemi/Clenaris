import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { getOrganizationId } from '@/server/services/organization.service';
import { getObjectiveTimeline } from '@/server/services/objective.service';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-parts';
import { RoadmapKanban, RoadmapTimeline } from '@/features/fuehrung/roadmap';

export const metadata: Metadata = {
  title: 'Roadmap',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const VIEWS = [
  { value: 'zeitachse', label: 'Zeitachse' },
  { value: 'kanban', label: 'Kanban' },
];

/**
 * Die Roadmap ist keine eigene Entität: sie ist die Zeitachsen-Ansicht der
 * Ziele. Die Ansicht steht in der URL (`?ansicht=`), damit sie teilbar ist.
 */
export default async function RoadmapPage({ searchParams }: { searchParams: Promise<{ ansicht?: string; jahr?: string }> }) {
  const session = await requirePermission('objective:read');
  const params = await searchParams;
  const view = params.ansicht === 'kanban' ? 'kanban' : 'zeitachse';
  const year = Number(params.jahr) || new Date().getFullYear();
  const organizationId = await getOrganizationId();
  const items = await getObjectiveTimeline(session, organizationId, {
    from: new Date(Date.UTC(year, 0, 1)),
    to: new Date(Date.UTC(year, 11, 31)),
  });

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/fuehrung/ziele">
          <ArrowLeft aria-hidden />
          Alle Ziele
        </Link>
      </Button>
      <PageHeader
        title="Roadmap"
        description="Strategien, Ziele und Initiativen über das Jahr. Die rote Linie ist heute; die Füllung des Balkens der Fortschritt."
        actions={
          <>
            <div className="inline-flex items-center gap-0.5 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Jahr">
              {[year - 1, year, year + 1].map((y) => (
                <Link key={y} href={`/admin/fuehrung/ziele/roadmap?ansicht=${view}&jahr=${y}`} role="radio" aria-checked={y === year} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${y === year ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground hover:text-foreground'}`}>
                  {y}
                </Link>
              ))}
            </div>
            <div className="inline-flex items-center gap-0.5 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Ansicht">
              {VIEWS.map((v) => (
                <Link key={v.value} href={`/admin/fuehrung/ziele/roadmap?ansicht=${v.value}&jahr=${year}`} role="radio" aria-checked={view === v.value} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${view === v.value ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground hover:text-foreground'}`}>
                  {v.label}
                </Link>
              ))}
            </div>
          </>
        }
      />
      {view === 'kanban' ? <RoadmapKanban items={items} /> : <RoadmapTimeline items={items} year={year} />}
    </div>
  );
}
