import type { Metadata } from 'next';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Check, MapPin } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { formatCurrency, formatDate } from '@/lib/utils';
import { SEITEN_URL } from '@/lib/seiten-url';
import { seitenMetadaten, stellenSeo } from '@/lib/seo/metadaten';
import { brotkrumen, stellenKnoten } from '@/lib/seo/structured-data';
import { JsonLd } from '@/components/marketing/json-ld';
import { getOrganizationId, getPublicCompanyInfo } from '@/server/services/organization.service';
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
  // Mit Organisation — siehe Leistungsseite.
  const organizationId = await getOrganizationId();
  const postings = await prisma.jobPosting.findMany({
    where: { organizationId, status: 'PUBLISHED' },
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
    select: { slug: true, status: true, title: true, description: true, location: true },
  });

  // Eine geschlossene oder unveröffentlichte Stelle antwortet 404.
  if (!posting || posting.status !== 'PUBLISHED') return { title: 'Stelle nicht gefunden', robots: { index: false } };

  // Vorher ohne `openGraph`: Die Seite erbte `og:url` der Startseite.
  return seitenMetadaten(stellenSeo(posting), SEITEN_URL);
}

export default async function JobPostingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const organizationId = await getOrganizationId();

  const posting = await prisma.jobPosting.findUnique({
    where: { organizationId_slug: { organizationId, slug } },
  });

  if (!posting || posting.status !== 'PUBLISHED') notFound();

  const company = await getPublicCompanyInfo();

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

      {/*
        Stelleninserat und Brotkrumen (Start › Karriere › Stelle; die Seite
        zeigt „Alle Stellen" als Rückweg). Arbeitgeber, Kanton und Land aus
        den Stammdaten statt fest eingetragen; Lehrstelle und Stundenlohn als
        `OTHER` statt fälschlich `PART_TIME`.
      */}
      <JsonLd
        daten={stellenKnoten({
          stelle: {
            slug: posting.slug,
            title: posting.title,
            description: posting.description,
            location: posting.location,
            employmentType: posting.employmentType,
            publishedAt: posting.publishedAt,
            closesAt: posting.closesAt,
            salaryFrom: posting.salaryFrom ? toNumber(posting.salaryFrom) : null,
            salaryTo: posting.salaryTo ? toNumber(posting.salaryTo) : null,
          },
          firma: company,
          herkunft: SEITEN_URL,
        })}
      />
      <JsonLd
        daten={brotkrumen(
          [
            { name: 'Start', pfad: '/' },
            { name: 'Karriere', pfad: '/karriere' },
            { name: posting.title, pfad: `/karriere/${posting.slug}` },
          ],
          SEITEN_URL,
        )}
      />
    </>
  );
}
