import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Clock } from 'lucide-react';

import { prisma } from '@/lib/db';
import { formatDate } from '@/lib/utils';
import { pageMetadata } from '@/lib/cms/metadata';
import { getOrganizationId } from '@/server/services/organization.service';
import { Badge } from '@/components/ui/badge';
import { Section } from '@/components/marketing/sections';
import { EmptyState } from '@/components/app/page-parts';

/**
 * Titel, Beschreibung und Vorschaubild kommen aus der Redaktion
 * (`/admin/seo`); fehlt eine Angabe, gilt der Wert aus dem Register.
 */
export const generateMetadata = (): Promise<Metadata> => pageMetadata('/blog');

export const revalidate = 1800;

export default async function BlogPage() {
  const organizationId = await getOrganizationId();

  const posts = await prisma.blogPost.findMany({
    where: { organizationId, status: 'PUBLISHED', locale: 'DE' },
    orderBy: { publishedAt: 'desc' },
    include: {
      category: { select: { name: true, slug: true } },
      author: { select: { firstName: true, lastName: true } },
    },
    take: 30,
  });

  const [lead, ...rest] = posts;

  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div className="aare-wash pointer-events-none absolute inset-0" aria-hidden />
        <div className="container relative py-16 sm:py-20">
          <div className="max-w-2xl space-y-5">
            <h1 className="text-display font-bold text-balance">Ratgeber</h1>
            <p className="text-lg leading-relaxed text-muted-foreground">
              Was wir in über tausend Einsätzen gelernt haben — als praktische Anleitung. Ohne
              Werbefloskeln, ohne erfundene Studien.
            </p>
          </div>
        </div>
      </section>

      <Section>
        <div className="container">
          {posts.length === 0 ? (
            <EmptyState
              title="Noch keine Beiträge"
              description="Wir schreiben regelmässig über Reinigung, Wohnungsübergabe und Haushaltsorganisation. Die ersten Artikel erscheinen bald."
              action={{ href: '/leistungen', label: 'Unsere Leistungen' }}
            />
          ) : (
            <div className="space-y-16">
              {/* Aufmacher */}
              {lead ? (
                <article className="border-b border-border pb-16">
                  <Link href={`/blog/${lead.slug}`} className="group block space-y-5">
                    <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                      {lead.category ? <Badge variant="neutral">{lead.category.name}</Badge> : null}
                      <span className="inline-flex items-center gap-1.5">
                        <Clock className="size-3.5" aria-hidden />
                        {lead.readingMinutes} Min. Lesezeit
                      </span>
                      {lead.publishedAt ? <span>{formatDate(lead.publishedAt)}</span> : null}
                    </div>

                    <h2 className="text-headline font-bold text-balance transition-colors group-hover:text-primary">
                      {lead.title}
                    </h2>

                    <p className="prose-measure text-lg leading-relaxed text-muted-foreground">
                      {lead.excerpt}
                    </p>

                    <span className="inline-flex items-center gap-2 font-medium text-primary">
                      Weiterlesen
                      <ArrowRight
                        className="size-4 transition-transform duration-200 ease-spring group-hover:translate-x-0.5"
                        aria-hidden
                      />
                    </span>
                  </Link>
                </article>
              ) : null}

              {/* Weitere Beiträge */}
              {rest.length > 0 ? (
                <ul className="grid gap-x-10 gap-y-12 md:grid-cols-2 lg:grid-cols-3">
                  {rest.map((post) => (
                    <li key={post.id}>
                      <article>
                        <Link href={`/blog/${post.slug}`} className="group block space-y-3">
                          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                            {post.category ? (
                              <Badge variant="neutral" size="sm">
                                {post.category.name}
                              </Badge>
                            ) : null}
                            <span>{post.readingMinutes} Min.</span>
                          </div>

                          <h2 className="font-display text-xl font-semibold leading-snug tracking-tight transition-colors group-hover:text-primary">
                            {post.title}
                          </h2>

                          <p className="text-body leading-relaxed text-muted-foreground">
                            {post.excerpt}
                          </p>

                          {post.publishedAt ? (
                            <p className="text-sm text-muted-foreground">
                              {formatDate(post.publishedAt)}
                            </p>
                          ) : null}
                        </Link>
                      </article>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
        </div>
      </Section>
    </>
  );
}
