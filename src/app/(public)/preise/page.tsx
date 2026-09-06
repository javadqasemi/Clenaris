import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Info } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { formatCurrency } from '@/lib/utils';
import { pageMetadata } from '@/lib/cms/metadata';
import { getOrganizationId } from '@/server/services/organization.service';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/controls';
import { CallToAction, Section, SectionIntro } from '@/components/marketing/sections';
import { ctasFor } from '@/server/services/cta.service';

/**
 * Titel, Beschreibung und Vorschaubild kommen aus der Redaktion
 * (`/admin/seo`); fehlt eine Angabe, gilt der Wert aus dem Register.
 */
export const generateMetadata = (): Promise<Metadata> => pageMetadata('/preise');

export const revalidate = 3600;

/**
 * Preisseite.
 *
 * Gestaltungsentscheid: keine „Pakete" mit Häkchenlisten. Reinigung ist keine
 * Software mit Feature-Stufen — der Preis hängt an Fläche, Aufwand und
 * Häufigkeit. Deshalb eine ehrliche Preistabelle plus die Faktoren, die den
 * Preis verändern, und ein Verweis auf den Rechner für die genaue Zahl.
 */
export default async function PricingPage() {
  const organizationId = await getOrganizationId();

  const [services, extras, areas] = await Promise.all([
    prisma.service.findMany({
      where: { organizationId, active: true },
      orderBy: { position: 'asc' },
    }),
    prisma.serviceExtra.findMany({
      where: { organizationId, active: true },
      orderBy: { position: 'asc' },
    }),
    prisma.serviceArea.findMany({
      where: { organizationId, active: true, travelFee: { gt: 0 } },
      orderBy: { travelFee: 'asc' },
      select: { city: true, postalCode: true, travelFee: true },
    }),
  ]);

  const travelBands = groupTravelFees(areas);


  // Verwaltete Handlungsaufrufe für das Abschlussband dieser Seite. Sie
  // ersetzen die eingebauten Schaltflächen, sobald welche gepflegt sind.
  const bandCtas = await ctasFor(organizationId, 'SECTION_BANNER', '/preise');

  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div className="aare-wash pointer-events-none absolute inset-0" aria-hidden />
        <div className="container relative py-16 sm:py-20">
          <div className="max-w-2xl space-y-5">
            <h1 className="text-display font-bold text-balance">Preise ohne Kleingedrucktes</h1>
            <p className="text-lg leading-relaxed text-muted-foreground">
              Alle Ansätze stehen hier. Was Ihr Einsatz konkret kostet, rechnet der Konfigurator in
              einer Minute aus — und dieser Preis gilt dann auch.
            </p>
            <Button asChild size="lg">
              <Link href="/buchen">
                Meinen Preis berechnen
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Grundpreise */}
      <Section>
        <div className="container space-y-8">
          <SectionIntro
            title="Grundpreise"
            lead="Alle Beträge in Schweizer Franken, exklusive 8.1 % Mehrwertsteuer. Material und Reinigungsmittel sind inbegriffen."
          />

          <div className="overflow-x-auto">
            <table className="data-table min-w-[40rem]">
              <caption className="sr-only">Preisübersicht nach Leistung</caption>
              <thead>
                <tr>
                  <th scope="col">Leistung</th>
                  <th scope="col">Abrechnung</th>
                  <th scope="col" className="text-right">
                    Ansatz
                  </th>
                  <th scope="col" className="text-right">
                    Mindestbetrag
                  </th>
                </tr>
              </thead>
              <tbody>
                {services.map((service) => (
                  <tr key={service.id}>
                    <td>
                      <Link
                        href={`/leistungen/${service.slug}`}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {service.name}
                      </Link>
                      <span className="block max-w-md text-xs text-muted-foreground">
                        {service.shortDesc}
                      </span>
                    </td>
                    <td className="text-muted-foreground">
                      {
                        {
                          PER_HOUR: 'nach Stunden',
                          PER_SQM: 'nach Fläche',
                          PER_UNIT: 'pro Einheit',
                          FLAT: 'Pauschale',
                          ON_REQUEST: 'individuell',
                        }[service.pricingModel]
                      }
                    </td>
                    <td className="num font-medium">
                      {service.pricingModel === 'PER_HOUR'
                        ? `${formatCurrency(toNumber(service.hourlyRate))} / Std.`
                        : service.pricingModel === 'PER_SQM'
                          ? `${formatCurrency(toNumber(service.pricePerSqm))} / m²`
                          : service.pricingModel === 'PER_UNIT'
                            ? `${formatCurrency(toNumber(service.hourlyRate))} / Stk.`
                            : service.pricingModel === 'FLAT'
                              ? formatCurrency(toNumber(service.basePrice))
                              : 'auf Anfrage'}
                    </td>
                    <td className="num text-muted-foreground">
                      {toNumber(service.minPrice) > 0
                        ? formatCurrency(toNumber(service.minPrice))
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Alert variant="info">
            <span className="flex items-start gap-2">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              Bei der Umzugs- und Baureinigung rechnen wir nach Quadratmetern und nennen Ihnen einen
              Fixpreis. Dauert es länger als geplant, ist das unser Risiko — nicht Ihres.
            </span>
          </Alert>
        </div>
      </Section>

      {/* Zusatzleistungen */}
      <Section className="bg-surface">
        <div className="container space-y-8">
          <SectionIntro
            title="Zusatzleistungen"
            lead="Einzeln buchbar, jederzeit kombinierbar. Im Buchungsassistenten sehen Sie den Effekt sofort im Total."
          />

          <dl className="grid gap-x-12 border-t border-border sm:grid-cols-2">
            {extras.map((extra) => (
              <div
                key={extra.id}
                className="flex items-baseline justify-between gap-4 border-b border-border py-4"
              >
                <dt className="min-w-0">
                  <span className="block font-medium">{extra.name}</span>
                  {extra.description ? (
                    <span className="block text-sm text-muted-foreground">{extra.description}</span>
                  ) : null}
                </dt>
                <dd className="whitespace-nowrap font-medium tabular-nums">
                  {formatCurrency(toNumber(extra.price))}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>

      {/* Was den Preis beeinflusst */}
      <Section>
        <div className="container space-y-8">
          <SectionIntro
            title="Was den Preis beeinflusst"
            lead="Damit Sie den berechneten Betrag nachvollziehen können, hier alle Faktoren."
          />

          <dl className="protocol-list border-t border-border">
            {[
              {
                label: 'Wiederkehrende Reinigung',
                value:
                  'Wöchentlich 15 %, alle zwei Wochen 10 %, monatlich 5 % Rabatt. Jederzeit kündbar, keine Mindestlaufzeit.',
              },
              {
                label: 'Samstagseinsätze',
                value: '25 % Zuschlag. Am Sonntag arbeiten wir nur nach Absprache.',
              },
              {
                label: 'Abendtermine ab 18 Uhr',
                value: '20 % Zuschlag — bei Büroreinigung ist das der Normalfall und ohne Zuschlag.',
              },
              {
                label: 'Express innert 48 Stunden',
                value: 'CHF 60 Pauschale für die priorisierte Einplanung.',
              },
              {
                label: 'Haustiere im Haushalt',
                value: 'CHF 15 — Tierhaare brauchen mehr Zeit, die wir realistisch einplanen.',
              },
              {
                label: 'Grossobjekte ab 150 m²',
                value: '6 % Rabatt, weil die Rüstzeit sich auf mehr Fläche verteilt.',
              },
              {
                label: 'Anfahrt',
                value:
                  'Innerhalb der Stadt Bern kostenlos. Ausserhalb je nach Distanz — siehe unten.',
              },
            ].map((row) => (
              <div key={row.label} className="protocol-row">
                <dt className="protocol-label">{row.label}</dt>
                <dd className="protocol-value font-normal text-muted-foreground">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>

      {/* Anfahrt */}
      {travelBands.length > 0 ? (
        <Section className="bg-surface">
          <div className="container space-y-8">
            <SectionIntro
              title="Anfahrtspauschalen"
              lead="Einmal pro Einsatz, unabhängig von der Dauer. In der Stadt Bern entfällt sie."
            />
            <dl className="protocol-list border-t border-border">
              {travelBands.map((band) => (
                <div key={band.fee} className="protocol-row">
                  <dt className="protocol-label">{formatCurrency(band.fee)}</dt>
                  <dd className="protocol-value font-normal text-muted-foreground">
                    {band.cities.join(', ')}
                  </dd>
                </div>
              ))}
            </dl>
            <Button asChild variant="outline">
              <Link href="/einsatzgebiet">
                Vollständiges Einsatzgebiet
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </div>
        </Section>
      ) : null}

      {/* Zahlung */}
      <Section>
        <div className="container grid gap-12 lg:grid-cols-[minmax(0,22rem)_1fr]">
          <h2 className="text-headline font-bold">Zahlung und Konditionen</h2>

          <Accordion type="single" collapsible className="border-t border-border">
            {[
              {
                q: 'Wann muss ich bezahlen?',
                a: 'Erst nach dem Einsatz. Sie erhalten eine QR-Rechnung mit 30 Tagen Zahlungsfrist — oder Sie bezahlen online mit Karte oder TWINT.',
              },
              {
                q: 'Ist der berechnete Preis verbindlich?',
                a: 'Ja, solange die Angaben zum Objekt stimmen. Weicht die tatsächliche Situation deutlich ab (etwa doppelte Fläche), melden wir uns vor Arbeitsbeginn — wir stellen nie unangekündigt mehr in Rechnung.',
              },
              {
                q: 'Was passiert, wenn wir länger brauchen?',
                a: 'Bei Pauschalpreisen tragen wir das Risiko. Bei Stundenabrechnung verrechnen wir die tatsächliche Zeit, informieren Sie aber, sobald absehbar ist, dass die Schätzung nicht reicht.',
              },
              {
                q: 'Gibt es eine Mindestbestellmenge?',
                a: 'Ja, pro Leistung ein Mindestbetrag (siehe Tabelle oben). Er deckt Anfahrt und Rüstzeit ab, die auch bei einem kurzen Einsatz anfallen.',
              },
              {
                q: 'Kann ich kostenlos stornieren?',
                a: 'Bis 24 Stunden vor dem Termin ja, über Ihr Kundenkonto oder telefonisch. Danach verrechnen wir 50 % des vereinbarten Betrags, weil das Team bereits eingeplant ist.',
              },
              {
                q: 'Rechnen Sie mit Verwaltungen ab?',
                a: 'Ja. Für Liegenschaftsverwaltungen erstellen wir Sammelrechnungen pro Objekt oder pro Monat, auf Wunsch mit Kostenstellen.',
              },
            ].map((item) => (
              <AccordionItem key={item.q} value={item.q}>
                <AccordionTrigger>{item.q}</AccordionTrigger>
                <AccordionContent>{item.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </Section>

      <Section className="pb-28">
        <div className="container">
          <CallToAction
        ctas={bandCtas}
            title="Ihren Preis in einer Minute"
            lead="Leistung wählen, Fläche eingeben, Termin aussuchen. Der Betrag steht sofort — verbindlich."
            primary={{ href: '/buchen', label: 'Preis berechnen' }}
            secondary={{ href: '/offerte', label: 'Individuelle Offerte' }}
          />
        </div>
      </Section>
    </>
  );
}

/** Orte mit gleicher Anfahrtspauschale zusammenfassen. */
function groupTravelFees(
  areas: { city: string; travelFee: unknown }[],
): { fee: number; cities: string[] }[] {
  const map = new Map<number, Set<string>>();

  for (const area of areas) {
    const fee = toNumber(area.travelFee as never);
    if (!map.has(fee)) map.set(fee, new Set());
    map.get(fee)!.add(area.city);
  }

  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([fee, cities]) => ({ fee, cities: [...cities].sort() }));
}
