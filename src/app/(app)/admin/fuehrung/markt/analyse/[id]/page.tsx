import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, GitBranchPlus } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { NotFoundError } from '@/lib/errors';
import { formatDate } from '@/lib/utils';
import { ANALYSIS_KIND_LABELS } from '@/lib/bi/labels';
import { getOrganizationId } from '@/server/services/organization.service';
import { getAnalysisBoard } from '@/server/services/knowledge.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { PageHeader } from '@/components/app/page-parts';
import { ActionButton } from '@/features/fuehrung/action-button';
import { AnalysisBoardEditor } from '@/features/fuehrung/analysis-board-editor';

export const metadata: Metadata = {
  title: 'Analysetafel',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AnalysisBoardPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('market:read');
  const { id } = await params;
  const organizationId = await getOrganizationId();
  const board = await getAnalysisBoard(organizationId, id).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const canManage = can(session.role, 'market:manage');
  const readOnly = !canManage || Boolean(board.supersededById);

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/fuehrung/markt">
          <ArrowLeft aria-hidden />
          Markt und Wettbewerb
        </Link>
      </Button>

      <PageHeader
        title={board.title}
        description={`${ANALYSIS_KIND_LABELS[board.kind]} · Stichtag ${formatDate(board.preparedOn)}${board.nextReviewAt ? ` · Prüfung ${formatDate(board.nextReviewAt)}` : ''}`}
        actions={
          <>
            {board.supersededById ? <Badge variant="neutral">Abgelöste Fassung</Badge> : <Badge variant="success">Aktuelle Fassung</Badge>}
            {canManage && !board.supersededById ? (
              <>
                <Button asChild variant="outline">
                  <Link href={`/admin/fuehrung/markt/analyse/neu?art=${board.kind}&abloesen=${board.id}`}>
                    <GitBranchPlus aria-hidden />
                    Neue Fassung
                  </Link>
                </Button>
                <ActionButton endpoint={`/api/bi/analysis/${id}`} method="DELETE" label="Löschen" confirm="Die Tafel wird endgültig gelöscht." variant="ghost" redirectTo="/admin/fuehrung/markt" />
              </>
            ) : null}
          </>
        }
      />

      {board.supersedes ? (
        <Alert variant="info">
          {`Diese Fassung löst „${board.supersedes.title}" vom ${formatDate(board.supersedes.preparedOn)} ab. `}
          <Link href={`/admin/fuehrung/markt/analyse/${board.supersedes.id}`} className="font-medium underline underline-offset-2">Vorgängerin öffnen</Link>
        </Alert>
      ) : null}
      {board.supersededBy ? (
        <Alert variant="warning">
          {`Abgelöst durch „${board.supersededBy.title}" vom ${formatDate(board.supersededBy.preparedOn)}. `}
          <Link href={`/admin/fuehrung/markt/analyse/${board.supersededBy.id}`} className="font-medium underline underline-offset-2">Aktuelle Fassung öffnen</Link>
        </Alert>
      ) : null}

      {board.summary && readOnly ? <p className="prose-measure rounded-2xl border border-border bg-card p-5 text-sm leading-relaxed">{board.summary}</p> : null}

      <AnalysisBoardEditor
        mode="edit"
        kind={board.kind}
        boardId={board.id}
        title={board.title}
        summary={board.summary}
        preparedOn={board.preparedOn.toISOString().slice(0, 10)}
        entries={board.entries.map((e) => ({ bucket: e.bucket, title: e.title, detail: e.detail, weight: e.weight, sortOrder: e.sortOrder }))}
        readOnly={readOnly}
      />
    </div>
  );
}
