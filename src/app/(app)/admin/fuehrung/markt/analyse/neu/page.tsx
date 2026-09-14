import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { ANALYSIS_KIND_LABELS } from '@/lib/bi/labels';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-parts';
import { AnalysisBoardEditor } from '@/features/fuehrung/analysis-board-editor';

export const metadata: Metadata = {
  title: 'Analyse anlegen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function NewAnalysisPage({ searchParams }: { searchParams: Promise<{ art?: string; abloesen?: string }> }) {
  await requirePermission('market:manage');
  const params = await searchParams;
  const kind = params.art === 'PESTEL' ? 'PESTEL' : 'SWOT';

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/fuehrung/markt">
          <ArrowLeft aria-hidden />
          Markt und Wettbewerb
        </Link>
      </Button>
      <PageHeader title={`${ANALYSIS_KIND_LABELS[kind]} anlegen`} description={kind === 'SWOT' ? 'Stärken und Schwächen nach innen, Chancen und Risiken nach aussen. Drei bis fünf Punkte je Feld, gewichtet.' : 'Politisch, wirtschaftlich, gesellschaftlich, technologisch, ökologisch, rechtlich — was von aussen auf die Firma wirkt.'} />
      <AnalysisBoardEditor mode="create" kind={kind} supersedesId={params.abloesen} />
    </div>
  );
}
