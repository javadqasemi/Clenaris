import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Check, X } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { formatCurrency } from '@/lib/utils';
import { pageMetadata } from '@/lib/cms/metadata';
import { getOrganizationId } from '@/server/services/organization.service';
import { Button } from '@/components/ui/button';
import { CallToAction, Section, SectionIntro } from '@/components/marketing/sections';

/**
 * Titel, Beschreibung und Vorschaubild kommen aus der Redaktion
 * (`/admin/seo`); fehlt eine Angabe, gilt der Wert aus dem Register.
 */
export const generateMetadata = (): Promise<Metadata> => pageMetadata('/leistungen');

export const revalidate = 3600;

export default async function ServicesPage() {
  const organizationId = await getOrganizationId();

  const categories = await prisma.serviceCategory.findMany({
    where: { organizationId, active: true },
    orderBy: { position: 'asc' },
    include: {
      services: {
        where: { active: true },
        orderBy: { position: 'asc' },
      },
    },
  });

  const priceLabel = (service: (typeof categories)[number]['services'][number]) => {
    switch (service.pricingModel) {
      case 'PER_HOUR':
        return `ab ${formatCurrency(toNumber(service.hourlyRate))} pro Stunde`;
      case 'PER_SQM':
        return `ab ${formatCurrency(toNumber(service.minPrice))} pauschal`;
      case 'PER_UNIT':
        return `ab ${formatCurrency(toNumber(service.hourlyRate))} pro Einheit`;
      case 'FLAT':
        return `${formatCurrency(toNumber(service.basePrice))} pauschal`;
      default:
        return 'Individuelle Offerte';
    }
  };

  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div className="aare-wash pointer-events-none absolute inset-0" aria-hidden />
        <div className="container relative py-16 sm:py-20">
          <div className="max-w-2xl space-y-5">
            <h1 className="text-display font-bold text-balance">Unsere Leistungen</h1>
            <p className="text-lg leading-relaxed text-muted-foreground">
              Sechs Leistungen, klar abgegrenzt. Bei jeder steht, was inbegriffen ist — und was
              nicht. So gibt es keine Überraschung auf der Rechnung.
            </p>
          </div>
        </div>
      </section>

      {categories.map((category) => (
        <Section key={category.id} className="border-b border-border last:border-b-0">
          <div className="container space-y-12">
            <SectionIntro title={category.name} lead={category.description ?? undefined} />

            <div className="space-y-16">
              {category.services.map((service) => (
                <article
                  key={service.id}
                  className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-12"
                  id={service.slug}
                >
                  <div className="space-y-6">
                    <div className="space-y-3">
                      <h3 className="text-title font-bold tracking-tight">
                        <Link
                          href={`/leistungen/${service.slug}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {service.name}
                        </Link>
                      </h3>
                      <p className="prose-measure text-lg leading-relaxed text-muted-foreground">
                        {service.description}
                      </p>
                    </div>

                    {service.bulletPoints.length > 0 ? (
                      <ul className="grid gap-2.5 sm:grid-cols-2">
                        {service.bulletPoints.map((point) => (
                          <li key={point} className="flex items-start gap-2.5 text-body">
                            <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                            {point}
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    <div className="flex flex-wrap gap-3">
                      <Button asChild>
                        <Link href={`/buchen?leistung=${service.slug}`}>
                          Preis berechnen
                          <ArrowRight aria-hidden />
                        </Link>
                      </Button>
                      <Button asChild variant="outline">
                        <Link href={`/leistungen/${service.slug}`}>Alle Details</Link>
                      </Button>
                    </div>
                  </div>

                  {/* Leistungsumfang als Protokollzeilen */}
                  <div className="space-y-6 rounded-2xl border border-border bg-card p-6">
                    <div>
                      <p className="text-sm text-muted-foreground">Preis</p>
                      <p className="font-display text-xl font-bold tracking-tight">
                        {priceLabel(service)}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">zzgl. 8.1 % MWST</p>
                    </div>

                    {service.includes.length > 0 ? (
                      <div>
                        <p className="mb-2 text-sm font-medium">Inbegriffen</p>
                        <ul className="space-y-1.5">
                          {service.includes.map((item) => (
                            <li
                              key={item}
                              className="flex items-start gap-2 text-sm text-muted-foreground"
                            >
                              <Check
                                className="mt-0.5 size-3.5 shrink-0 text-success"
                                aria-hidden
                              />
                              {item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {service.excludes.length > 0 ? (
                      <div>
                        <p className="mb-2 text-sm font-medium">Nicht inbegriffen</p>
                        <ul className="space-y-1.5">
                          {service.excludes.map((item) => (
                            <li
                              key={item}
                              className="flex items-start gap-2 text-sm text-muted-foreground"
                            >
                              <X
                                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                                aria-hidden
                              />
                              {item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </Section>
      ))}

      <Section className="pb-28">
        <div className="container">
          <CallToAction
            title="Nicht sicher, was Sie brauchen?"
            lead="Beschreiben Sie kurz Ihre Situation — wir melden uns innerhalb von 24 Stunden mit einem Vorschlag."
            primary={{ href: '/offerte', label: 'Offerte anfordern' }}
            secondary={{ href: '/kontakt', label: 'Kontakt aufnehmen' }}
          />
        </div>
      </Section>
    </>
  );
}
