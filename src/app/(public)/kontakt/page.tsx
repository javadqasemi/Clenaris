import type { Metadata } from 'next';
import { Clock, Mail, MapPin, Phone } from 'lucide-react';

import { getPublicCompanyInfo } from '@/server/services/organization.service';
import { ContactForm } from '@/features/public/contact-form';
import { Section } from '@/components/marketing/sections';
import { pageMetadata } from '@/lib/cms/metadata';

/**
 * Titel, Beschreibung und Vorschaubild kommen aus der Redaktion
 * (`/admin/seo`); fehlt eine Angabe, gilt der Wert aus dem Register.
 */
export const generateMetadata = (): Promise<Metadata> => pageMetadata('/kontakt');

export const revalidate = 3600;

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

export default async function ContactPage() {
  const company = await getPublicCompanyInfo();

  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div className="aare-wash pointer-events-none absolute inset-0" aria-hidden />
        <div className="container relative py-16 sm:py-20">
          <div className="max-w-2xl space-y-5">
            <h1 className="text-display font-bold text-balance">Sprechen wir darüber</h1>
            <p className="text-lg leading-relaxed text-muted-foreground">
              Ob konkrete Anfrage oder erste Frage: Wir antworten innerhalb eines Arbeitstages.
              Dringend? Dann greifen Sie zum Telefon — da geht es am schnellsten.
            </p>
          </div>
        </div>
      </section>

      <Section>
        <div className="container grid gap-12 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-16">
          {/* Formular */}
          <div className="space-y-6">
            <h2 className="text-headline font-bold">Schreiben Sie uns</h2>
            <ContactForm />
          </div>

          {/* Kontaktangaben */}
          <aside className="space-y-8">
            <div className="space-y-5 rounded-2xl border border-border bg-card p-6">
              <h2 className="font-display text-lg font-semibold tracking-tight">Direkt erreichen</h2>

              <dl className="protocol-list">
                {company.phone ? (
                  <div className="flex items-start gap-3 py-3.5">
                    <Phone className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                    <div>
                      <dt className="text-sm text-muted-foreground">Telefon</dt>
                      <dd>
                        <a
                          href={`tel:${company.phone.replace(/\s/g, '')}`}
                          className="font-medium tabular-nums text-primary underline-offset-4 hover:underline"
                        >
                          {company.phone}
                        </a>
                      </dd>
                    </div>
                  </div>
                ) : null}

                <div className="flex items-start gap-3 py-3.5">
                  <Mail className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  <div className="min-w-0">
                    <dt className="text-sm text-muted-foreground">E-Mail</dt>
                    <dd className="truncate">
                      <a
                        href={`mailto:${company.email}`}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {company.email}
                      </a>
                    </dd>
                  </div>
                </div>

                <div className="flex items-start gap-3 py-3.5">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  <div>
                    <dt className="text-sm text-muted-foreground">Adresse</dt>
                    <dd className="font-medium not-italic">
                      {company.name}
                      <br />
                      {company.address.street}
                      <br />
                      {company.address.postalCode} {company.address.city}
                    </dd>
                  </div>
                </div>
              </dl>
            </div>

            {/* Öffnungszeiten */}
            <div className="space-y-4 rounded-2xl border border-border bg-card p-6">
              <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
                <Clock className="size-4 text-primary" aria-hidden />
                Wann wir erreichbar sind
              </h2>

              <dl className="protocol-list">
                {company.openingHours
                  .slice()
                  .sort((a, b) => (a.weekday || 7) - (b.weekday || 7))
                  .map((hour) => (
                    <div
                      key={hour.weekday}
                      className="flex items-baseline justify-between gap-4 py-2"
                    >
                      <dt className="text-sm text-muted-foreground">{WEEKDAYS[hour.weekday]}</dt>
                      <dd className="text-sm font-medium tabular-nums">
                        {hour.closed || !hour.opensAt
                          ? 'geschlossen'
                          : `${hour.opensAt} – ${hour.closesAt}`}
                      </dd>
                    </div>
                  ))}
              </dl>

              <p className="text-sm leading-relaxed text-muted-foreground">
                Ausserhalb dieser Zeiten nehmen wir Ihre Nachricht entgegen und melden uns am
                nächsten Arbeitstag.
              </p>
            </div>

            <div className="rounded-2xl border border-dashed border-border p-6">
              <h2 className="font-display text-base font-semibold">Sie kennen Ihren Bedarf?</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                Dann geht es schneller über den Preisrechner: Leistung wählen, Fläche eingeben,
                Termin buchen — ohne Rückrufschlaufe.
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
