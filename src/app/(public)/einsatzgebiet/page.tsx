import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, MapPin } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { formatCurrency, slugify } from '@/lib/utils';
import { pageMetadata } from '@/lib/cms/metadata';
import { getOrganizationId, getServiceAreas } from '@/server/services/organization.service';
import { Button } from '@/components/ui/button';
import { PostalCodeCheck } from '@/features/public/postal-code-check';
import { CallToAction, Section, SectionIntro } from '@/components/marketing/sections';
import { ctasFor } from '@/server/services/cta.service';

/**
 * Titel, Beschreibung und Vorschaubild kommen aus der Redaktion
 * (`/admin/seo`); fehlt eine Angabe, gilt der Wert aus dem Register.
 */
export const generateMetadata = (): Promise<Metadata> => pageMetadata('/einsatzgebiet');

export const revalidate = 3600;

export default async function ServiceAreaPage() {
  const areas = await getServiceAreas();

  // Nach Ort gruppieren: mehrere PLZ pro Ort sind der Normalfall.
  const byCity = new Map<string, { postalCodes: string[]; travelFee: number; minutes: number }>();

  for (const area of areas) {
    const existing = byCity.get(area.city);
    const fee = toNumber(area.travelFee);

    if (existing) {
      existing.postalCodes.push(area.postalCode);
      existing.travelFee = Math.min(existing.travelFee, fee);
      existing.minutes = Math.min(existing.minutes, area.travelMinutes);
    } else {
      byCity.set(area.city, {
        postalCodes: [area.postalCode],
        travelFee: fee,
        minutes: area.travelMinutes,
      });
    }
  }

  const cities = [...byCity.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de-CH'));


  const organizationId = await getOrganizationId();
  // Verwaltete Handlungsaufrufe für das Abschlussband dieser Seite. Sie
  // ersetzen die eingebauten Schaltflächen, sobald welche gepflegt sind.
  const bandCtas = await ctasFor(organizationId, 'SECTION_BANNER', '/einsatzgebiet');

  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div className="aare-wash pointer-events-none absolute inset-0" aria-hidden />
        <div className="container relative py-16 sm:py-20">
          <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
            <div className="space-y-5">
              <h1 className="text-display font-bold text-balance">
                Wir kommen in den ganzen Kanton
              </h1>
              <p className="text-lg leading-relaxed text-muted-foreground">
                {areas.length} Postleitzahlen, von der Berner Altstadt bis nach Thun und Biel. In
                der Stadt Bern ist die Anfahrt kostenlos, darüber hinaus gilt eine faire Pauschale
                nach Distanz.
              </p>
            </div>

            <PostalCodeCheck />
          </div>
        </div>
      </section>

      <Section>
        <div className="container space-y-8">
          <SectionIntro
            title="Alle Orte im Überblick"
            lead="Ihr Ort fehlt? Melden Sie sich trotzdem — bei grösseren Aufträgen fahren wir auch weiter."
          />

          <div className="overflow-x-auto">
            <table className="data-table min-w-[36rem]">
              <caption className="sr-only">Einsatzgebiet mit Anfahrtspauschalen</caption>
              <thead>
                <tr>
                  <th scope="col">Ort</th>
                  <th scope="col">Postleitzahlen</th>
                  <th scope="col" className="text-right">
                    Fahrzeit ab Bern
                  </th>
                  <th scope="col" className="text-right">
                    Anfahrt
                  </th>
                </tr>
              </thead>
              <tbody>
                {cities.map(([city, info]) => (
                  <tr key={city} id={slugify(city)}>
                    <td className="font-medium">
                      <span className="inline-flex items-center gap-2">
                        <MapPin className="size-3.5 text-primary" aria-hidden />
                        {city}
                      </span>
                    </td>
                    <td className="tabular-nums text-muted-foreground">
                      {info.postalCodes.sort().join(', ')}
                    </td>
                    <td className="num text-muted-foreground">
                      {info.minutes > 0 ? `ca. ${info.minutes} Min.` : '—'}
                    </td>
                    <td className="num">
                      {info.travelFee > 0 ? (
                        formatCurrency(info.travelFee)
                      ) : (
                        <span className="font-medium text-success">kostenlos</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Section>

      <Section className="bg-surface">
        <div className="container grid gap-10 md:grid-cols-3">
          {[
            {
              title: 'Kostenlose Anfahrt in Bern',
              text: 'Innerhalb der Stadt Bern (PLZ 3000–3027) verrechnen wir keine Anfahrt. Unser Depot liegt zentral, die Wege sind kurz.',
            },
            {
              title: 'Feste Teams pro Region',
              text: 'Wir teilen dieselben Personen möglichst denselben Quartieren zu. Das spart Fahrzeit und Sie sehen bekannte Gesichter.',
            },
            {
              title: 'Ausserhalb des Gebiets?',
              text: 'Bei Objekten ab rund 200 m² oder bei wiederkehrenden Aufträgen fahren wir auch weiter. Fragen Sie einfach an.',
            },
          ].map((item) => (
            <div key={item.title} className="space-y-2">
              <h2 className="font-display text-lg font-semibold tracking-tight">{item.title}</h2>
              <p className="text-body leading-relaxed text-muted-foreground">{item.text}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section className="pb-28">
        <div className="container">
          <CallToAction
        ctas={bandCtas}
            title="Kommen wir zu Ihnen?"
            lead="Postleitzahl eingeben, Preis sehen, Termin buchen — alles in einem Durchgang."
            primary={{ href: '/buchen', label: 'Termin buchen' }}
            secondary={{ href: '/kontakt', label: 'Nachfragen' }}
          />
        </div>
      </Section>

      <div className="container pb-8">
        <Button asChild variant="ghost" size="sm">
          <Link href="/preise">
            Zu den Preisen
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      </div>
    </>
  );
}
