import type { Metadata } from 'next';
import { Clock, FileText, ShieldCheck } from 'lucide-react';

import { prisma } from '@/lib/db';
import { pageMetadata } from '@/lib/cms/metadata';
import { getOrganizationId } from '@/server/services/organization.service';
import { QuoteRequestForm } from '@/features/public/quote-request-form';
import { Section } from '@/components/marketing/sections';

/**
 * Titel, Beschreibung und Vorschaubild kommen aus der Redaktion
 * (`/admin/seo`); fehlt eine Angabe, gilt der Wert aus dem Register.
 */
export const generateMetadata = (): Promise<Metadata> => pageMetadata('/offerte');

export const revalidate = 3600;

/**
 * Offertanfrage.
 *
 * Für alles, was der Preisrechner nicht abbildet: Hauswartung,
 * Liegenschaftsbetreuung, grosse Baustellen, Sonderfälle. Der Rechner bleibt
 * für den Standardfall der schnellere Weg — darauf weisen wir aktiv hin,
 * statt alle durch dieses längere Formular zu schicken.
 */
export default async function QuoteRequestPage() {
  const organizationId = await getOrganizationId();

  const services = await prisma.service.findMany({
    where: { organizationId, active: true },
    orderBy: { position: 'asc' },
    select: { kind: true, name: true, pricingModel: true },
  });

  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div className="aare-wash pointer-events-none absolute inset-0" aria-hidden />
        <div className="container relative py-16 sm:py-20">
          <div className="max-w-2xl space-y-5">
            <h1 className="text-display font-bold text-balance">Offerte anfordern</h1>
            <p className="text-lg leading-relaxed text-muted-foreground">
              Für Hauswartung, grosse Objekte oder Sonderfälle rechnen wir individuell. Beschreiben
              Sie Ihre Situation — Sie erhalten innerhalb von 24 Stunden ein verbindliches Angebot,
              das Sie online annehmen können.
            </p>
          </div>
        </div>
      </section>

      <Section>
        <div className="container grid gap-12 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-16">
          <div className="space-y-6">
            <h2 className="text-headline font-bold">Ihre Anfrage</h2>
            <QuoteRequestForm
              services={services.map((service) => ({ value: service.kind, label: service.name }))}
            />
          </div>

          <aside className="space-y-6">
            <div className="space-y-5 rounded-2xl border border-border bg-card p-6">
              <h2 className="font-display text-lg font-semibold tracking-tight">So läuft es ab</h2>
              <ol className="space-y-4">
                {[
                  {
                    title: 'Sie beschreiben das Objekt',
                    text: 'Je konkreter, desto präziser das Angebot.',
                  },
                  {
                    title: 'Wir prüfen und rechnen',
                    text: 'Bei grösseren Objekten kommen wir vorher gerne vorbei — kostenlos.',
                  },
                  {
                    title: 'Sie erhalten die Offerte',
                    text: 'Innerhalb von 24 Stunden, mit allen Positionen einzeln ausgewiesen.',
                  },
                  {
                    title: 'Annehmen mit einem Klick',
                    text: 'Online unterschreiben, danach vereinbaren wir den Termin.',
                  },
                ].map((step, index) => (
                  <li key={step.title} className="flex gap-3">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold tabular-nums text-primary">
                      {index + 1}
                    </span>
                    <span className="space-y-0.5">
                      <span className="block text-sm font-medium">{step.title}</span>
                      <span className="block text-sm leading-relaxed text-muted-foreground">
                        {step.text}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            <div className="space-y-3 rounded-2xl border border-border bg-surface p-6">
              {[
                { Icon: Clock, text: 'Antwort innerhalb von 24 Stunden' },
                { Icon: FileText, text: 'Offerte 30 Tage gültig, unverbindlich' },
                { Icon: ShieldCheck, text: 'Keine versteckten Positionen' },
              ].map((item) => (
                <p key={item.text} className="flex items-center gap-2.5 text-sm">
                  <item.Icon className="size-4 shrink-0 text-primary" aria-hidden />
                  {item.text}
                </p>
              ))}
            </div>

            <div className="rounded-2xl border border-dashed border-border p-6">
              <h2 className="font-display text-base font-semibold">Standardfall?</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                Für Wohnungs-, Umzugs- und Fensterreinigung geht es über den Preisrechner schneller:
                Preis sofort, Termin direkt gebucht.
              </p>
              <a
                href="/buchen"
                className="mt-3 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                Zum Preisrechner
              </a>
            </div>
          </aside>
        </div>
      </Section>
    </>
  );
}
