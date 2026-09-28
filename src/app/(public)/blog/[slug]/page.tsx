import type { Metadata } from 'next';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight, Clock } from 'lucide-react';

import { prisma } from '@/lib/db';
import { formatDate } from '@/lib/utils';
import { SEITEN_URL } from '@/lib/seiten-url';
import { beitragsSeo, seitenMetadaten } from '@/lib/seo/metadaten';
import { artikelKnoten, brotkrumen } from '@/lib/seo/structured-data';
import { JsonLd } from '@/components/marketing/json-ld';
import { getOrganizationId, getPublicCompanyInfo } from '@/server/services/organization.service';
import { getContent } from '@/server/services/content.service';
import { createCms } from '@/lib/cms/editable';
import { isPreview } from '@/lib/cms/preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/markdown';
import { CallToAction, Section } from '@/components/marketing/sections';
import { ctasFor } from '@/server/services/cta.service';

export const revalidate = 1800;

export async function generateStaticParams() {
  // Mit Organisation — siehe Leistungsseite.
  const organizationId = await getOrganizationId();
  const posts = await prisma.blogPost.findMany({
    where: { organizationId, status: 'PUBLISHED', locale: 'DE' },
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
      slug: true,
      status: true,
      title: true,
      excerpt: true,
      seoTitle: true,
      seoDescription: true,
      keywords: true,
      publishedAt: true,
    },
  });

  // Ein Entwurf antwortet 404 — sein Titel gehört nicht in die Metadaten.
  if (!post || post.status !== 'PUBLISHED') return { title: 'Beitrag nicht gefunden', robots: { index: false } };

  return seitenMetadaten(beitragsSeo(post), SEITEN_URL);
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

  const content = await getContent(organizationId);
  const cms = createCms(content, await isPreview());
  const company = await getPublicCompanyInfo();

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
            title={cms.text('blog.cta.title')}
            lead={cms.text('blog.cta.text')}
            primary={{ href: '/buchen', label: 'Termin buchen' }}
            secondary={{ href: '/preise', label: 'Preise ansehen' }}
          />
        </div>
      </Section>

      {/*
        Beitrag und Brotkrumen (Start › Ratgeber › Beitrag — die Seite zeigt
        „Alle Beiträge" als Rückweg; die Hierarchie ist eindeutig). Verlag ist
        die Firma aus den Stammdaten, nicht ein fest eingetragener Name.
      */}
      <JsonLd
        daten={artikelKnoten({
          beitrag: {
            slug: post.slug,
            title: post.title,
            excerpt: post.excerpt,
            publishedAt: post.publishedAt,
            updatedAt: post.updatedAt,
            autor: post.author ? `${post.author.firstName} ${post.author.lastName}` : null,
          },
          firma: company,
          herkunft: SEITEN_URL,
        })}
      />
      <JsonLd
        daten={brotkrumen(
          [
            { name: 'Start', pfad: '/' },
            { name: 'Ratgeber', pfad: '/blog' },
            { name: post.title, pfad: `/blog/${post.slug}` },
          ],
          SEITEN_URL,
        )}
      />
    </>
  );
}
