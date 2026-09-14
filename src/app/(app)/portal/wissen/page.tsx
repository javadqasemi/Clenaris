import type { Metadata } from 'next';
import Link from 'next/link';
import { BookOpen } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { getOrganizationId } from '@/server/services/organization.service';
import { listArticles } from '@/server/services/knowledge.service';
import { FilterBar } from '@/components/app/filter-bar';
import { EmptyState, PageHeader } from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Wissen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/** Wissensdatenbank im Portal — nur veröffentlichte Artikel für Mitarbeitende. */
export default async function PortalKnowledgePage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const session = await requirePermission('knowledge:read');
  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const { items } = await listArticles(session, organizationId, { page: 1, pageSize: 100, q: params.q });
  const categories = [...new Set(items.map((a) => a.category))];

  return (
    <div className="space-y-6">
      <PageHeader title="Wissen" description="Abläufe, Anleitungen und Antworten — zum Nachschlagen, auch unterwegs.">
        <FilterBar searchPlaceholder="Wonach suchen Sie?" />
      </PageHeader>
      {items.length === 0 ? (
        <EmptyState icon={<BookOpen aria-hidden />} title="Noch keine Artikel" description="Sobald das Büro Anleitungen veröffentlicht, erscheinen sie hier." />
      ) : (
        categories.map((category) => (
          <section key={category} className="space-y-2" aria-label={category}>
            <h2 className="font-display text-base font-semibold">{category}</h2>
            <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
              {items.filter((a) => a.category === category).map((a) => (
                <li key={a.id}>
                  <Link href={`/portal/wissen/${a.slug}`} className="block px-4 py-3 transition-colors hover:bg-muted/50">
                    <p className="text-sm font-medium">{a.title}</p>
                    {a.summary ? <p className="text-xs text-muted-foreground">{a.summary}</p> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
