import Link from 'next/link';
import { Mail, MapPin, Phone } from 'lucide-react';

import { Logo } from '@/components/marketing/logo';
import { CtaSlot, type CtaData } from '@/components/marketing/cta-button';
import { NewsletterForm } from '@/components/marketing/newsletter-form';
import type { PublicCompanyInfo } from '@/server/services/organization.service';

/**
 * Fusszeile.
 *
 * Enthält bewusst die vollständigen Firmenangaben: in der Schweiz gehören
 * Firma, Adresse und MWST-Nummer zu den Pflichtangaben im Geschäftsverkehr,
 * und Google bewertet lokale Vollständigkeit.
 */

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

export function SiteFooter({
  company,
  services,
  areas,
  ctas = [],
}: {
  company: PublicCompanyInfo;
  services: { slug: string; name: string }[];
  areas: { postalCode: string; city: string }[];
  /** Aufrufe für die Fusszeile — noch ungefiltert, siehe `CtaSlot`. */
  ctas?: CtaData[];
}) {
  const year = new Date().getFullYear();

  // Öffnungszeiten zu Blöcken zusammenfassen (Mo–Fr 07:00–18:00).
  const openDays = company.openingHours.filter((h) => !h.closed && h.opensAt && h.closesAt);
  const grouped = groupOpeningHours(openDays);

  // Für die Fusszeile reichen die grösseren Orte.
  const cities = Array.from(new Set(areas.map((a) => a.city))).slice(0, 14);

  return (
    <footer className="mt-24 border-t border-border bg-surface">
      <div className="container py-16">
        <div className="grid gap-12 lg:grid-cols-[1.4fr_1fr_1fr_1.3fr]">
          {/* Firma */}
          <div className="space-y-5">
            <Logo />
            <p className="prose-measure text-sm leading-relaxed text-muted-foreground">
              Reinigung für Privathaushalte, Unternehmen und Liegenschaften im Kanton Bern.
              Festangestelltes Team, transparente Preise, Abgabegarantie bei Umzügen.
            </p>

            <address className="space-y-2.5 text-sm not-italic">
              <div className="flex items-start gap-2.5">
                <MapPin className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span className="text-muted-foreground">
                  {company.address.street}
                  <br />
                  {company.address.postalCode} {company.address.city}
                </span>
              </div>
              {company.phone ? (
                <div className="flex items-center gap-2.5">
                  <Phone className="size-4 shrink-0 text-primary" aria-hidden />
                  <a
                    href={`tel:${company.phone.replace(/\s/g, '')}`}
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {company.phone}
                  </a>
                </div>
              ) : null}
              <div className="flex items-center gap-2.5">
                <Mail className="size-4 shrink-0 text-primary" aria-hidden />
                <a
                  href={`mailto:${company.email}`}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  {company.email}
                </a>
              </div>
            </address>

            {grouped.length > 0 ? (
              <dl className="protocol-list border-t border-border pt-2 text-sm">
                {grouped.map((block) => (
                  <div key={block.label} className="flex items-baseline justify-between gap-4 py-1.5">
                    <dt className="text-muted-foreground">{block.label}</dt>
                    <dd className="font-medium tabular-nums">{block.time}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>

          {/* Leistungen */}
          <nav aria-label="Leistungen">
            <h2 className="mb-4 font-display text-sm font-semibold">Leistungen</h2>
            <ul className="space-y-2.5 text-sm">
              {services.map((service) => (
                <li key={service.slug}>
                  <Link
                    href={`/leistungen/${service.slug}`}
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {service.name}
                  </Link>
                </li>
              ))}
              <li>
                <Link href="/preise" className="text-muted-foreground transition-colors hover:text-foreground">
                  Preisübersicht
                </Link>
              </li>
              <li>
                <Link href="/offerte" className="text-muted-foreground transition-colors hover:text-foreground">
                  Offerte anfordern
                </Link>
              </li>
            </ul>
          </nav>

          {/* Unternehmen */}
          <nav aria-label="Unternehmen">
            <h2 className="mb-4 font-display text-sm font-semibold">Unternehmen</h2>
            <ul className="space-y-2.5 text-sm">
              {[
                { href: '/ueber-uns', label: 'Über uns' },
                { href: '/galerie', label: 'Vorher / Nachher' },
                { href: '/bewertungen', label: 'Bewertungen' },
                { href: '/karriere', label: 'Offene Stellen' },
                { href: '/blog', label: 'Ratgeber' },
                { href: '/faq', label: 'Häufige Fragen' },
                { href: '/kontakt', label: 'Kontakt' },
              ].map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {/* Newsletter */}
          <div className="space-y-5">
            <div>
              <h2 className="mb-2 font-display text-sm font-semibold">Reinigungstipps im Postfach</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Einmal im Monat ein praktischer Ratgeber und gelegentlich ein Aktionscode. Abmeldung
                jederzeit mit einem Klick.
              </p>
            </div>
            <NewsletterForm />

            {/*
              Handlungsaufrufe der Fusszeile. Sie stehen unter dem Newsletter,
              nicht darüber: wer bis hierher gescrollt hat, sucht meist einen
              konkreten nächsten Schritt und nicht noch ein Formular.
            */}
            <CtaSlot ctas={ctas} size="sm" className="gap-2" />
          </div>
        </div>

        {/* Einsatzgebiet als SEO-relevante Ortsliste */}
        {cities.length > 0 ? (
          <div className="mt-14 border-t border-border pt-8">
            <h2 className="mb-3 font-display text-sm font-semibold">Wir reinigen in</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {cities.map((city, index) => (
                <span key={city}>
                  <Link
                    href={`/einsatzgebiet#${city.toLowerCase().replace(/[^a-z]/g, '')}`}
                    className="transition-colors hover:text-foreground"
                  >
                    {city}
                  </Link>
                  {index < cities.length - 1 ? ' · ' : ''}
                </span>
              ))}
            </p>
          </div>
        ) : null}
      </div>

      <div className="border-t border-border">
        <div className="container flex flex-col gap-4 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {year} {company.legalName ?? company.name}
            {company.vatNumber ? ` · ${company.vatNumber}` : ''}
          </p>
          <nav aria-label="Rechtliches" className="flex flex-wrap gap-x-6 gap-y-2">
            <Link href="/legal/impressum" className="transition-colors hover:text-foreground">
              Impressum
            </Link>
            <Link href="/legal/datenschutz" className="transition-colors hover:text-foreground">
              Datenschutz
            </Link>
            <Link href="/legal/agb" className="transition-colors hover:text-foreground">
              AGB
            </Link>
            <Link href="/legal/cookies" className="transition-colors hover:text-foreground">
              Cookies
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}

/** Aufeinanderfolgende Tage mit gleichen Zeiten zusammenfassen. */
function groupOpeningHours(
  hours: { weekday: number; opensAt: string | null; closesAt: string | null }[],
): { label: string; time: string }[] {
  const sorted = [...hours].sort((a, b) => (a.weekday || 7) - (b.weekday || 7));
  const blocks: { days: number[]; time: string }[] = [];

  for (const hour of sorted) {
    const time = `${hour.opensAt}–${hour.closesAt}`;
    const last = blocks.at(-1);
    if (last && last.time === time && (last.days.at(-1) ?? -9) + 1 === hour.weekday) {
      last.days.push(hour.weekday);
    } else {
      blocks.push({ days: [hour.weekday], time });
    }
  }

  const short = (weekday: number) => WEEKDAYS[weekday].slice(0, 2);

  return blocks.map((block) => ({
    label:
      block.days.length === 1
        ? WEEKDAYS[block.days[0]]
        : `${short(block.days[0])}–${short(block.days.at(-1)!)}`,
    time: `${block.time} Uhr`,
  }));
}
