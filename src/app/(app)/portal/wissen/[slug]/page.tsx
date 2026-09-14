import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { NotFoundError } from '@/lib/errors';
import { formatDate } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { getArticleBySlug } from '@/server/services/knowledge.service';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-parts';
import { Markdown } from '@/components/markdown';

export const metadata: Metadata = {
  title: 'Wissensartikel',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function PortalArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const session = await requirePermission('knowledge:read');
  const { slug } = await params;
  const organizationId = await getOrganizationId();
  const article = await getArticleBySlug(session, organizationId, slug).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/portal/wissen">
          <ArrowLeft aria-hidden />
          Wissen
        </Link>
      </Button>
      <PageHeader title={article.title} description={`${article.category} · Stand ${formatDate(article.updatedAt)}`} />
      <article className="rounded-2xl border border-border bg-card p-5 sm:p-8">
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
    </div>
  );
}
