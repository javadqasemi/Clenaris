import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight, Clock } from 'lucide-react';

import { prisma } from '@/lib/db';
import { formatDate } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/markdown';
import { CallToAction, Section } from '@/components/marketing/sections';
import { ctasFor } from '@/server/services/cta.service';

export const revalidate = 1800;

export async function generateStaticParams() {
  const posts = await prisma.blogPost.findMany({
    where: { status: 'PUBLISHED', locale: 'DE' },
    select: { slug: true },
  });
  return posts.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const organizationId = await getOrganizationId();

  const post = await prisma.blogPost.findUnique({
    where: { organizationId_slug_locale: { organizationId, slug, locale: 'DE' } },
    select: {
      title: true,
      excerpt: true,
      seoTitle: true,
      seoDescription: true,
      keywords: true,
      publishedAt: true,
    },
  });

  if (!post) return { title: 'Beitrag nicht gefunden' };

  return {
    title: post.seoTitle ?? post.title,
    description: post.seoDescription ?? post.excerpt,
    keywords: post.keywords,
    alternates: { canonical: `/blog/${slug}` },
    openGraph: {
      type: 'article',
      title: post.seoTitle ?? post.title,
      description: post.seoDescription ?? post.excerpt,
      publishedTime: post.publishedAt?.toISOString(),
    },
  };
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const organizationId = await getOrganizationId();

  const post = await prisma.blogPost.findUnique({
    where: { organizationId_slug_locale: { organizationId, slug, locale: 'DE' } },
    include: {
      category: { select: { name: true } },
      author: { select: { firstName: true, lastName: true } },
    },
  });

  if (!post || post.status !== 'PUBLISHED') notFound();

  const related = await prisma.blogPost.findMany({
    where: {
      organizationId,
      status: 'PUBLISHED',
      locale: 'DE',
      id: { not: post.id },
      ...(post.categoryId ? { categoryId: post.categoryId } : {}),
    },
    orderBy: { publishedAt: 'desc' },
    take: 2,
    select: { slug: true, title: true, excerpt: true, readingMinutes: true },
  });


  // Verwaltete Handlungsaufrufe für das Abschlussband dieser Seite. Sie
  // ersetzen die eingebauten Schaltflächen, sobald welche gepflegt sind.
  const bandCtas = await ctasFor(organizationId, 'SECTION_BANNER', `/blog/${slug}`);

  return (
    <>
      <article>
        <header className="border-b border-border">
          <div className="container max-w-3xl py-14 sm:py-20">
            <Button asChild variant="ghost" size="sm" className="-ml-3 mb-6">
              <Link href="/blog">
                <ArrowLeft aria-hidden />
                Alle Beiträge
              </Link>
            </Button>

            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                {post.category ? <Badge variant="neutral">{post.category.name}</Badge> : null}
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="size-3.5" aria-hidden />
                  {post.readingMinutes} Min. Lesezeit
                </span>
                {post.publishedAt ? <span>{formatDate(post.publishedAt)}</span> : null}
              </div>

              <h1 className="text-display font-bold text-balance">{post.title}</h1>

              <p className="text-lg leading-relaxed text-muted-foreground">{post.excerpt}</p>

              {post.author ? (
                <p className="text-sm text-muted-foreground">
                  Von {post.author.firstName} {post.author.lastName}
                </p>
              ) : null}
            </div>
          </div>
        </header>

        <div className="container max-w-3xl py-14">
          <Markdown content={post.content} />
        </div>
      </article>

      {related.length > 0 ? (
        <Section className="border-t border-border">
          <div className="container max-w-3xl space-y-8">
            <h2 className="text-title font-bold tracking-tight">Weiterlesen</h2>
            <ul className="grid gap-6 sm:grid-cols-2">
              {related.map((item) => (
                <li key={item.slug}>
                  <Link
                    href={`/blog/${item.slug}`}
                    className="group block space-y-2 rounded-2xl border border-border bg-card p-6 transition-[border-color,box-shadow] duration-300 ease-spring hover:border-primary/30 hover:shadow-card"
                  >
                    <h3 className="font-display text-lg font-semibold leading-snug tracking-tight transition-colors group-hover:text-primary">
                      {item.title}
                    </h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">{item.excerpt}</p>
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-primary">
                      Lesen
                      <ArrowRight
                        className="size-3.5 transition-transform duration-200 ease-spring group-hover:translate-x-0.5"
                        aria-hidden
                      />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      ) : null}

      <Section className="pb-28">
        <div className="container max-w-3xl">
          <CallToAction
        ctas={bandCtas}
            title="Lieber machen lassen?"
            lead="Wir übernehmen die Arbeit — mit festem Team, festem Preis und Abgabegarantie bei Umzügen."
            primary={{ href: '/buchen', label: 'Termin buchen' }}
            secondary={{ href: '/preise', label: 'Preise ansehen' }}
          />
        </div>
      </Section>

      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger -- serverseitig erzeugter JSON-LD-Block
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Article',
            headline: post.title,
            description: post.excerpt,
            datePublished: post.publishedAt?.toISOString(),
            dateModified: post.updatedAt.toISOString(),
            author: post.author
              ? { '@type': 'Person', name: `${post.author.firstName} ${post.author.lastName}` }
              : { '@type': 'Organization', name: 'Clenaris Reinigungen GmbH' },
            publisher: {
              '@type': 'Organization',
              name: 'Clenaris Reinigungen GmbH',
            },
          }),
        }}
      />
    </>
  );
}
