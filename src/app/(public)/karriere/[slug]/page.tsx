import type { Metadata } from 'next';

import { jsonLd } from '@/lib/json-ld';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Check, MapPin } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { formatCurrency, formatDate } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/markdown';
import { Section } from '@/components/marketing/sections';
import { ApplicationForm } from '@/features/public/application-form';

export const revalidate = 1800;

const EMPLOYMENT_LABELS: Record<string, string> = {
  FULL_TIME: 'Vollzeit',
  PART_TIME: 'Teilzeit',
  HOURLY: 'Im Stundenlohn',
  TEMPORARY: 'Befristet',
  APPRENTICE: 'Lehrstelle',
  CONTRACTOR: 'Auftrag',
};

export async function generateStaticParams() {
  const postings = await prisma.jobPosting.findMany({
    where: { status: 'PUBLISHED' },
    select: { slug: true },
  });
  return postings.map((posting) => ({ slug: posting.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const organizationId = await getOrganizationId();

  const posting = await prisma.jobPosting.findUnique({
    where: { organizationId_slug: { organizationId, slug } },
    select: { title: true, description: true, location: true },
  });

  if (!posting) return { title: 'Stelle nicht gefunden' };

  return {
    title: `${posting.title} — ${posting.location}`,
    description: posting.description.slice(0, 155),
    alternates: { canonical: `/karriere/${slug}` },
  };
}

export default async function JobPostingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const organizationId = await getOrganizationId();

  const posting = await prisma.jobPosting.findUnique({
    where: { organizationId_slug: { organizationId, slug } },
  });

  if (!posting || posting.status !== 'PUBLISHED') notFound();

  return (
    <>
      <header className="border-b border-border">
        <div className="container max-w-3xl py-14 sm:py-20">
          <Button asChild variant="ghost" size="sm" className="-ml-3 mb-6">
            <Link href="/karriere">
              <ArrowLeft aria-hidden />
              Alle Stellen
            </Link>
          </Button>

          <div className="space-y-5">
            <h1 className="text-display font-bold text-balance">{posting.title}</h1>

            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="neutral">
                {EMPLOYMENT_LABELS[posting.employmentType] ?? posting.employmentType}
              </Badge>
              <Badge variant="outline">
                {posting.workloadFrom === posting.workloadTo
                  ? `${posting.workloadTo} %`
                  : `${posting.workloadFrom}–${posting.workloadTo} %`}
              </Badge>
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                <MapPin className="size-3.5" aria-hidden />
                {posting.location}
              </span>
              {posting.salaryFrom ? (
                <span className="text-sm tabular-nums text-muted-foreground">
                  {formatCurrency(toNumber(posting.salaryFrom))}
                  {posting.salaryTo ? ` – ${formatCurrency(toNumber(posting.salaryTo))}` : ''} /
                  Monat
                </span>
              ) : null}
            </div>

            {posting.closesAt ? (
              <p className="text-sm text-muted-foreground">
                Bewerbungsfrist: {formatDate(posting.closesAt)}
              </p>
            ) : null}
          </div>
        </div>
      </header>

      <Section>
        <div className="container grid max-w-5xl gap-12 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
          <div className="space-y-10">
            <div className="space-y-4">
              <h2 className="text-title font-bold tracking-tight">Deine Aufgabe</h2>
              <Markdown content={posting.description} />
            </div>

            {posting.requirements.length > 0 ? (
              <div className="space-y-4">
                <h2 className="text-title font-bold tracking-tight">Das bringst du mit</h2>
                <ul className="space-y-2.5 border-t border-border pt-4">
                  {posting.requirements.map((item) => (
                    <li
                      key={item}
                      className="flex items-start gap-3 text-body leading-relaxed text-muted-foreground"
                    >
                      <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {posting.benefits.length > 0 ? (
              <div className="space-y-4">
                <h2 className="text-title font-bold tracking-tight">Das bieten wir</h2>
                <ul className="space-y-2.5 border-t border-border pt-4">
                  {posting.benefits.map((item) => (
                    <li
                      key={item}
                      className="flex items-start gap-3 text-body leading-relaxed text-muted-foreground"
                    >
                      <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <aside className="lg:sticky lg:top-24">
            <ApplicationForm postingId={posting.id} postingTitle={posting.title} />
          </aside>
        </div>
      </Section>

      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger -- serverseitig erzeugter JSON-LD-Block
        dangerouslySetInnerHTML={{
          __html: jsonLd({
            '@context': 'https://schema.org',
            '@type': 'JobPosting',
            title: posting.title,
            description: posting.description,
            datePosted: posting.publishedAt?.toISOString(),
            validThrough: posting.closesAt?.toISOString(),
            employmentType: posting.employmentType === 'FULL_TIME' ? 'FULL_TIME' : 'PART_TIME',
            hiringOrganization: {
              '@type': 'Organization',
              name: 'Clenaris Reinigungen GmbH',
            },
            jobLocation: {
              '@type': 'Place',
              address: {
                '@type': 'PostalAddress',
                addressLocality: posting.location,
                addressRegion: 'BE',
                addressCountry: 'CH',
              },
            },
            ...(posting.salaryFrom
              ? {
                  baseSalary: {
                    '@type': 'MonetaryAmount',
                    currency: 'CHF',
                    value: {
                      '@type': 'QuantitativeValue',
                      minValue: toNumber(posting.salaryFrom),
                      maxValue: posting.salaryTo ? toNumber(posting.salaryTo) : undefined,
                      unitText: 'MONTH',
                    },
                  },
                }
              : {}),
          }),
        }}
      />
    </>
  );
}
