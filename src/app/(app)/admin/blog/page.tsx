import type { Metadata } from 'next';
import Link from 'next/link';
import { ExternalLink, Newspaper } from 'lucide-react';

import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { formatDate } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { Badge } from '@/components/ui/badge';
import { KpiTile } from '@/components/app/kpi-tile';
import {
  EmptyState,
  ListCard,
  PageHeader,
  TableScroll,
} from '@/components/app/page-parts';
import { BlogDraftDialog } from '@/features/admin/blog-draft-dialog';

export const metadata: Metadata = {
  title: 'Blog',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const STATUS_LABELS: Record<string, { label: string; variant: 'success' | 'neutral' | 'warning' }> = {
  PUBLISHED: { label: 'Veröffentlicht', variant: 'success' },
  DRAFT: { label: 'Entwurf', variant: 'neutral' },
  SCHEDULED: { label: 'Geplant', variant: 'warning' },
  ARCHIVED: { label: 'Archiviert', variant: 'neutral' },
};

export default async function BlogAdminPage() {
  await requirePermission('blog:read');

  const organizationId = await getOrganizationId();

  const [posts, published, drafts, totalViews] = await Promise.all([
    prisma.blogPost.findMany({
      where: { organizationId },
      orderBy: [{ status: 'asc' }, { publishedAt: 'desc' }],
      include: {
        category: { select: { name: true } },
        author: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.blogPost.count({ where: { organizationId, status: 'PUBLISHED' } }),
    prisma.blogPost.count({ where: { organizationId, status: 'DRAFT' } }),
    prisma.blogPost.aggregate({
      where: { organizationId, status: 'PUBLISHED' },
      _sum: { viewCount: true },
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Blog"
        description="Ratgeberartikel bringen Besucherinnen und Besucher über die Suche — und beantworten Fragen, bevor sie im Telefon landen."
        actions={<BlogDraftDialog />}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile label="Veröffentlicht" value={String(published)} />
        <KpiTile label="Entwürfe" value={String(drafts)} />
        <KpiTile
          label="Aufrufe insgesamt"
          value={String(totalViews._sum.viewCount ?? 0)}
        />
      </div>

      {posts.length === 0 ? (
        <EmptyState
          icon={<Newspaper aria-hidden />}
          title="Noch keine Beiträge"
          description="Ein Ratgeberartikel pro Monat reicht, um in der Suche sichtbar zu werden. Mit dem KI-Entwurf entsteht der Rohtext in einer Minute."
        />
      ) : (
        <ListCard>
          <TableScroll>
            <table className="data-table">
              <caption className="sr-only">Blogbeiträge. {posts.length} Einträge.</caption>
              <thead>
                <tr>
                  <th scope="col">Titel</th>
                  <th scope="col">Kategorie</th>
                  <th scope="col">Autor</th>
                  <th scope="col" className="text-right">
                    Aufrufe
                  </th>
                  <th scope="col">Veröffentlicht</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {posts.map((post) => {
                  const status = STATUS_LABELS[post.status] ?? STATUS_LABELS.DRAFT;
                  return (
                    <tr key={post.id}>
                      <td>
                        <span className="block max-w-[24rem] truncate font-medium">
                          {post.title}
                        </span>
                        <span className="block max-w-[24rem] truncate text-xs text-muted-foreground">
                          {post.excerpt}
                        </span>
                      </td>
                      <td className="text-muted-foreground">{post.category?.name ?? '—'}</td>
                      <td className="text-muted-foreground">
                        {post.author ? `${post.author.firstName} ${post.author.lastName}` : '—'}
                      </td>
                      <td className="num text-muted-foreground">{post.viewCount}</td>
                      <td className="text-muted-foreground">
                        {post.publishedAt ? formatDate(post.publishedAt) : '—'}
                      </td>
                      <td>
                        <span className="flex items-center gap-2">
                          <Badge variant={status.variant} size="sm">
                            {status.label}
                          </Badge>
                          {post.status === 'PUBLISHED' ? (
                            <Link
                              href={`/blog/${post.slug}`}
                              target="_blank"
                              className="text-muted-foreground transition-colors hover:text-primary"
                              aria-label={`${post.title} auf der Website ansehen`}
                            >
                              <ExternalLink className="size-3.5" aria-hidden />
                            </Link>
                          ) : null}
                        </span>
                      </td>
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
