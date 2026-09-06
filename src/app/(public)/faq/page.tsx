import type { Metadata } from 'next';
import Link from 'next/link';
import { Mail, Phone } from 'lucide-react';

import { prisma } from '@/lib/db';
import { pageMetadata } from '@/lib/cms/metadata';
import { getOrganizationId, getPublicCompanyInfo } from '@/server/services/organization.service';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/controls';
import { Button } from '@/components/ui/button';
import { Section } from '@/components/marketing/sections';

/**
 * Titel, Beschreibung und Vorschaubild kommen aus der Redaktion
 * (`/admin/seo`); fehlt eine Angabe, gilt der Wert aus dem Register.
 */
export const generateMetadata = (): Promise<Metadata> => pageMetadata('/faq');

export const revalidate = 3600;

export default async function FaqPage() {
  const organizationId = await getOrganizationId();

  const [faqs, company] = await Promise.all([
    prisma.faq.findMany({
      where: { organizationId, active: true, locale: 'DE' },
      orderBy: [{ category: 'asc' }, { position: 'asc' }],
    }),
    getPublicCompanyInfo(),
  ]);

  // Nach Kategorie gruppieren, Reihenfolge der ersten Nennung beibehalten.
  const categories: { name: string; items: typeof faqs }[] = [];
  for (const faq of faqs) {
    const existing = categories.find((category) => category.name === faq.category);
    if (existing) existing.items.push(faq);
    else categories.push({ name: faq.category, items: [faq] });
  }

  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div className="aare-wash pointer-events-none absolute inset-0" aria-hidden />
        <div className="container relative py-16 sm:py-20">
          <div className="max-w-2xl space-y-5">
            <h1 className="text-display font-bold text-balance">Häufige Fragen</h1>
            <p className="text-lg leading-relaxed text-muted-foreground">
              Wenn Ihre Frage hier nicht steht, rufen Sie uns an — wir antworten lieber persönlich
              als ausweichend.
            </p>
          </div>
        </div>
      </section>

      <Section>
        <div className="container space-y-16">
          {categories.map((category) => (
            <div key={category.name} className="grid gap-8 lg:grid-cols-[minmax(0,16rem)_1fr] lg:gap-12">
              <h2 className="text-title font-bold tracking-tight">{category.name}</h2>

              <Accordion type="single" collapsible className="border-t border-border">
                {category.items.map((faq) => (
                  <AccordionItem key={faq.id} value={faq.id}>
                    <AccordionTrigger>{faq.question}</AccordionTrigger>
                    <AccordionContent>{faq.answer}</AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </div>
          ))}
        </div>
      </Section>

      <Section className="bg-surface pb-28">
        <div className="container">
          <div className="mx-auto max-w-xl space-y-6 text-center">
            <h2 className="text-headline font-bold text-balance">Ihre Frage fehlt?</h2>
            <p className="text-lg leading-relaxed text-muted-foreground">
              Schreiben Sie uns oder rufen Sie an. Wir antworten innerhalb eines Arbeitstages, meist
              schneller.
            </p>
            <div className="flex flex-col justify-center gap-3 sm:flex-row">
              {company.phone ? (
                <Button asChild size="lg">
                  <a href={`tel:${company.phone.replace(/\s/g, '')}`}>
                    <Phone aria-hidden />
                    {company.phone}
                  </a>
                </Button>
              ) : null}
              <Button asChild size="lg" variant="outline">
                <Link href="/kontakt">
                  <Mail aria-hidden />
                  Nachricht schreiben
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </Section>

      {faqs.length > 0 ? (
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger -- serverseitig erzeugter JSON-LD-Block
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'FAQPage',
              mainEntity: faqs.map((faq) => ({
                '@type': 'Question',
                name: faq.question,
                acceptedAnswer: { '@type': 'Answer', text: faq.answer },
              })),
            }),
          }}
        />
      ) : null}
    </>
  );
}
