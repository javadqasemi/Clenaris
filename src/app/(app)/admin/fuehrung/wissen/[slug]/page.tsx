import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { NotFoundError } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/utils';
import { ARTICLE_STATUS_LABELS } from '@/lib/bi/labels';
import { getOrganizationId } from '@/server/services/organization.service';
import { getArticleBySlug } from '@/server/services/knowledge.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { Markdown } from '@/components/markdown';
import { ActionButton } from '@/features/fuehrung/action-button';
import { FormDialog } from '@/features/fuehrung/resource-form';
import { articleFields } from '@/features/fuehrung/knowledge-fields';

export const metadata: Metadata = {
  title: 'Wissensartikel',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const session = await requirePermission('knowledge:read');
  const { slug } = await params;
  const organizationId = await getOrganizationId();
  const article = await getArticleBySlug(session, organizationId, slug).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const stale = article.nextReviewAt && article.nextReviewAt < new Date();

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/fuehrung/wissen">
          <ArrowLeft aria-hidden />
          Wissen
        </Link>
      </Button>

      <PageHeader
        title={article.title}
        description={article.summary ?? article.category}
        actions={
          <>
            <Badge variant={article.status === 'PUBLISHED' ? 'success' : 'neutral'}>{ARTICLE_STATUS_LABELS[article.status]}</Badge>
            {stale ? <Badge variant="warning">Prüfung fällig</Badge> : null}
            {can(session.role, 'knowledge:update') ? (
              <FormDialog
                title="Artikel bearbeiten"
                triggerLabel="Bearbeiten"
                triggerVariant="outline"
                plainTrigger
                size="xl"
                endpoint={`/api/bi/knowledge/${article.id}`}
                method="PATCH"
                successMessage="Artikel gespeichert."
                redirectTo="/admin/fuehrung/wissen/{slug}"
                fields={articleFields(true)}
                values={{ title: article.title, category: article.category, status: article.status, visibility: article.visibility, tags: article.tags, summary: article.summary, videoUrl: article.videoUrl, reviewIntervalDays: article.reviewIntervalDays, body: article.body }}
              />
            ) : null}
            {can(session.role, 'knowledge:delete') ? <ActionButton endpoint={`/api/bi/knowledge/${article.id}`} method="DELETE" label="Löschen" confirm="Der Artikel wandert in den Papierkorb." variant="ghost" redirectTo="/admin/fuehrung/wissen" /> : null}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <article className="rounded-2xl border border-border bg-card p-6 sm:p-8">
          {article.videoUrl ? (
            <p className="mb-4">
              <a href={article.videoUrl} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                <ExternalLink className="size-4" aria-hidden />
                Video öffnen
              </a>
            </p>
          ) : null}
          <Markdown content={article.body} />
        </article>
        <DetailSection title="Angaben" body="list">
          <dl className="protocol-list protocol-list--tight">
            <DetailRow label="Kategorie">{article.category}</DetailRow>
            {article.tags.length ? <DetailRow label="Schlagwörter">{article.tags.join(', ')}</DetailRow> : null}
            <DetailRow label="Verfasst von">{article.author ? `${article.author.firstName} ${article.author.lastName}` : '—'}</DetailRow>
            <DetailRow label="Geändert">{formatDateTime(article.updatedAt)}</DetailRow>
            {article.publishedAt ? <DetailRow label="Veröffentlicht">{formatDate(article.publishedAt)}</DetailRow> : null}
            {article.nextReviewAt ? <DetailRow label="Nächste Prüfung">{formatDate(article.nextReviewAt)}</DetailRow> : null}
          </dl>
        </DetailSection>
      </div>
    </div>
  );
}
