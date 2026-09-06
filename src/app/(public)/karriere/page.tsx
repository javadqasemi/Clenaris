import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Briefcase, Check, MapPin } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { formatCurrency } from '@/lib/utils';
import { pageMetadata } from '@/lib/cms/metadata';
import { getOrganizationId } from '@/server/services/organization.service';
import { Badge } from '@/components/ui/badge';
import { CallToAction, Section, SectionIntro } from '@/components/marketing/sections';
import { ctasFor } from '@/server/services/cta.service';
import { EmptyState } from '@/components/app/page-parts';

/**
 * Titel, Beschreibung und Vorschaubild kommen aus der Redaktion
 * (`/admin/seo`); fehlt eine Angabe, gilt der Wert aus dem Register.
 */
export const generateMetadata = (): Promise<Metadata> => pageMetadata('/karriere');

export const revalidate = 1800;

const EMPLOYMENT_LABELS: Record<string, string> = {
  FULL_TIME: 'Vollzeit',
  PART_TIME: 'Teilzeit',
  HOURLY: 'Im Stundenlohn',
  TEMPORARY: 'Befristet',
  APPRENTICE: 'Lehrstelle',
  CONTRACTOR: 'Auftrag',
};

export default async function CareerPage() {
  const organizationId = await getOrganizationId();

  const postings = await prisma.jobPosting.findMany({
    where: { organizationId, status: 'PUBLISHED' },
    orderBy: { publishedAt: 'desc' },
  });


  // Verwaltete Handlungsaufrufe für das Abschlussband dieser Seite. Sie
  // ersetzen die eingebauten Schaltflächen, sobald welche gepflegt sind.
  const bandCtas = await ctasFor(organizationId, 'SECTION_BANNER', '/karriere');

  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div className="aare-wash pointer-events-none absolute inset-0" aria-hidden />
        <div className="container relative py-16 sm:py-24">
          <div className="max-w-2xl space-y-5">
            <h1 className="text-display font-bold text-balance">Arbeiten bei uns</h1>
            <p className="prose-measure text-lg leading-relaxed text-muted-foreground">
              Reinigung ist ehrliche Arbeit — und sie verdient ehrliche Bedingungen. Bei uns sind
              alle fest angestellt, nach Gesamtarbeitsvertrag entlöhnt und voll versichert. Keine
              Einsätze auf Abruf, kein Lohn unter dem Mindestansatz.
            </p>
          </div>
        </div>
      </section>

      {/* Was wir bieten */}
      <Section>
        <div className="container space-y-10">
          <SectionIntro title="Was wir bieten" />

          <ul className="grid gap-x-10 gap-y-4 border-t border-border sm:grid-cols-2">
            {[
              'Festanstellung nach Gesamtarbeitsvertrag der Reinigungsbranche',
              '5 Wochen Ferien ab dem ersten Anstellungsjahr',
              'Bezahlte Weiterbildungen, auch zum eidgenössischen Fachausweis',
              'Moderne Arbeitsgeräte und Firmenfahrzeuge',
              'Feste Einsatzgebiete — keine Fahrten quer durch den Kanton',
              'Kein Wochenenddienst ausser nach Absprache',
              'Digitale Zeiterfassung: jede Minute wird erfasst und bezahlt',
              'Ein Team, das sich kennt, und ein Büro, das erreichbar ist',
            ].map((benefit) => (
              <li
                key={benefit}
                className="flex items-start gap-3 border-b border-border py-4 text-body leading-relaxed"
              >
                <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                {benefit}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* Stellen */}
      <Section className="bg-surface">
        <div className="container space-y-10">
          <SectionIntro
            title="Offene Stellen"
            lead="Nichts Passendes dabei? Senden Sie uns trotzdem eine Spontanbewerbung — wir suchen laufend."
          />

          {postings.length === 0 ? (
            <EmptyState
              icon={<Briefcase aria-hidden />}
              title="Zurzeit keine offenen Stellen"
              description="Wir stellen laufend ein. Schicken Sie uns eine Spontanbewerbung — wir melden uns, sobald etwas frei wird."
              action={{ href: '/kontakt', label: 'Spontanbewerbung senden' }}
            />
          ) : (
            <ul className="space-y-4">
              {postings.map((posting) => (
                <li key={posting.id}>
                  <Link
                    href={`/karriere/${posting.slug}`}
                    className="group flex flex-wrap items-center justify-between gap-6 rounded-2xl border border-border bg-card p-6 transition-[border-color,box-shadow] duration-300 ease-spring hover:border-primary/30 hover:shadow-card"
                  >
                    <div className="min-w-0 space-y-2">
                      <h3 className="font-display text-xl font-semibold tracking-tight transition-colors group-hover:text-primary">
                        {posting.title}
                      </h3>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="neutral" size="sm">
                          {EMPLOYMENT_LABELS[posting.employmentType] ?? posting.employmentType}
                        </Badge>
                        <Badge variant="outline" size="sm">
                          {posting.workloadFrom === posting.workloadTo
                            ? `${posting.workloadTo} %`
                            : `${posting.workloadFrom}–${posting.workloadTo} %`}
                        </Badge>
                        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                          <MapPin className="size-3.5" aria-hidden />
                          {posting.location}
                        </span>
                      </div>
                      <p className="prose-measure text-body leading-relaxed text-muted-foreground">
                        {posting.description.split('\n')[0]}
                      </p>
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-2">
                      {posting.salaryFrom ? (
                        <span className="text-sm tabular-nums text-muted-foreground">
                          {formatCurrency(toNumber(posting.salaryFrom))}
                          {posting.salaryTo
                            ? ` – ${formatCurrency(toNumber(posting.salaryTo))}`
                            : ''}{' '}
                          / Monat
                        </span>
                      ) : null}
                      <span className="inline-flex items-center gap-1.5 font-medium text-primary">
                        Stelle ansehen
                        <ArrowRight
                          className="size-4 transition-transform duration-200 ease-spring group-hover:translate-x-0.5"
                          aria-hidden
                        />
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section className="pb-28">
        <div className="container">
          <CallToAction
        ctas={bandCtas}
            title="Fragen zur Stelle?"
            lead="Rufen Sie an und sprechen Sie direkt mit der Betriebsleitung — kein Bewerbungsportal, keine Standardantwort."
            primary={{ href: '/kontakt', label: 'Kontakt aufnehmen' }}
            secondary={{ href: '/ueber-uns', label: 'Über uns' }}
          />
        </div>
      </Section>
    </>
  );
}
