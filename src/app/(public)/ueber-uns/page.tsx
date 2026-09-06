import type { Metadata } from 'next';
import Link from 'next/link';
import { Building2, HeartHandshake, Leaf, ShieldCheck, Users } from 'lucide-react';

import { prisma } from '@/lib/db';
import { pageMetadata } from '@/lib/cms/metadata';
import { getOrganizationId, getPublicCompanyInfo } from '@/server/services/organization.service';
import { getContent, contentText, contentList } from '@/server/services/content.service';
import { PersonAvatar } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import {
  CallToAction,
  Section,
  SectionIntro,
  StatStrip,
  TrustRow,
} from '@/components/marketing/sections';

/**
 * Titel, Beschreibung und Vorschaubild kommen aus der Redaktion
 * (`/admin/seo`); fehlt eine Angabe, gilt der Wert aus dem Register.
 */
export const generateMetadata = (): Promise<Metadata> => pageMetadata('/ueber-uns');

export const revalidate = 3600;

export default async function AboutPage() {
  const organizationId = await getOrganizationId();
  const content = await getContent(organizationId);

  const [company, team, stats] = await Promise.all([
    getPublicCompanyInfo(),
    prisma.employee.findMany({
      where: { organizationId, active: true },
      orderBy: { hiredAt: 'asc' },
      select: {
        id: true,
        position: true,
        color: true,
        hiredAt: true,
        languages: true,
        user: { select: { firstName: true, lastName: true, avatarUrl: true } },
        skills: { select: { name: true }, take: 3 },
      },
    }),
    Promise.all([
      prisma.job.count({ where: { organizationId, status: { in: ['COMPLETED', 'VERIFIED'] } } }),
      prisma.customer.count({ where: { organizationId, deletedAt: null } }),
      prisma.employee.count({ where: { organizationId, active: true } }),
      prisma.serviceArea.count({ where: { organizationId, active: true } }),
    ]),
  ]);

  const [completedJobs, customers, employees, areas] = stats;
  const foundedYear = team[0] ? team[0].hiredAt.getFullYear() : new Date().getFullYear();

  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div className="aare-wash pointer-events-none absolute inset-0" aria-hidden />
        <div className="container relative py-16 sm:py-24">
          <div className="max-w-3xl space-y-6">
            <h1 className="text-display font-bold text-balance">
              Reinigung ist Handwerk. Kein Preisvergleich.
            </h1>
            <p className="prose-measure text-lg leading-relaxed text-muted-foreground">
              {contentText(content, 'about.intro')}
            </p>
          </div>
        </div>
      </section>

      <div className="container py-12">
        <StatStrip
          stats={[
            { value: String(Math.max(completedJobs, 1)), label: 'Abgeschlossene Einsätze' },
            { value: String(Math.max(customers, 1)), label: 'Kundinnen und Kunden' },
            { value: String(employees), label: 'Festangestellte' },
            { value: String(areas), label: 'Postleitzahlen im Gebiet' },
          ]}
        />
      </div>

      {/* Auftrag und Anspruch — redaktionell gepflegt */}
      <Section>
        <div className="container">
          <div className="grid gap-10 border-y border-border py-14 lg:grid-cols-2 lg:gap-16">
            <div className="space-y-3">
              <h2 className="font-display text-title font-bold tracking-tight">Unser Auftrag</h2>
              <p className="prose-measure leading-relaxed text-muted-foreground">
                {contentText(content, 'about.mission')}
              </p>
            </div>
            <div className="space-y-3">
              <h2 className="font-display text-title font-bold tracking-tight">Unser Anspruch</h2>
              <p className="prose-measure leading-relaxed text-muted-foreground">
                {contentText(content, 'about.vision')}
              </p>
            </div>
          </div>

          {/* Die Grundsätze als Protokollzeilen — dasselbe Strukturelement wie
              im Abnahmeprotokoll, weil es hier genauso um Zusagen geht. */}
          <ol className="protocol-list pt-12">
            {contentList(content, 'about.values').map((value, index) => (
              <li key={value} className="protocol-row">
                <span className="protocol-label tabular-nums">
                  Grundsatz {String(index + 1).padStart(2, '0')}
                </span>
                <span className="protocol-value">{value}</span>
              </li>
            ))}
          </ol>
        </div>
      </Section>

      {/* Haltung */}
      <Section>
        <div className="container space-y-14">
          <SectionIntro
            title="Wofür wir stehen"
            lead="Vier Zusagen, die wir tatsächlich einhalten können — und an denen Sie uns messen dürfen."
            align="center"
          />

          <TrustRow
            items={[
              {
                icon: <Users aria-hidden />,
                title: 'Faire Anstellung',
                description:
                  'Alle Mitarbeitenden sind bei uns fest angestellt, nach Gesamtarbeitsvertrag entlöhnt und voll versichert. Keine Subunternehmen, keine Scheinselbstständigkeit.',
              },
              {
                icon: <ShieldCheck aria-hidden />,
                title: 'Wir haften',
                description:
                  'Betriebshaftpflicht bis CHF 5 Millionen. Geht etwas kaputt, regeln wir es — ohne dass Sie darum bitten müssen.',
              },
              {
                icon: <Leaf aria-hidden />,
                title: 'Umweltschonende Mittel',
                description:
                  'Wir arbeiten mit biologisch abbaubaren Produkten mit Schweizer Öko-Zertifizierung. Dosiert wird nach Vorschrift, nicht nach Gefühl.',
              },
              {
                icon: <HeartHandshake aria-hidden />,
                title: 'Feste Ansprechpersonen',
                description:
                  'Sie erreichen immer dieselbe Person im Büro und sehen möglichst dasselbe Team vor Ort. Das spart Erklärungen bei jedem Termin.',
              },
            ]}
          />
        </div>
      </Section>

      {/* Team */}
      {team.length > 0 ? (
        <Section className="bg-surface">
          <div className="container space-y-12">
            <SectionIntro
              title="Das Team"
              lead="Die Personen, die tatsächlich zu Ihnen kommen. Wir stellen sie vor, weil Sie ihnen Ihren Schlüssel anvertrauen."
            />

            <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {team.map((member) => (
                <li
                  key={member.id}
                  className="flex gap-4 rounded-2xl border border-border bg-card p-5"
                >
                  <PersonAvatar
                    firstName={member.user.firstName}
                    lastName={member.user.lastName}
                    src={member.user.avatarUrl}
                    color={member.color}
                    size="lg"
                  />
                  <div className="min-w-0 space-y-1">
                    <p className="font-display font-semibold leading-snug">
                      {member.user.firstName} {member.user.lastName}
                    </p>
                    <p className="text-sm text-muted-foreground">{member.position}</p>
                    <p className="text-xs text-muted-foreground">
                      seit {member.hiredAt.getFullYear()} dabei
                      {member.skills.length > 0
                        ? ` · ${member.skills.map((skill) => skill.name).join(', ')}`
                        : ''}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      ) : null}

      {/* Firmenangaben */}
      <Section>
        <div className="container grid gap-12 lg:grid-cols-[minmax(0,22rem)_1fr]">
          <h2 className="text-headline font-bold">Das Unternehmen</h2>

          <dl className="protocol-list border-t border-border">
            {[
              { label: 'Firma', value: company.legalName ?? company.name },
              {
                label: 'Sitz',
                value: `${company.address.street}, ${company.address.postalCode} ${company.address.city}`,
              },
              { label: 'Gegründet', value: String(foundedYear) },
              { label: 'Rechtsform', value: 'Gesellschaft mit beschränkter Haftung (GmbH)' },
              ...(company.vatNumber ? [{ label: 'MWST-Nummer', value: company.vatNumber }] : []),
              { label: 'Mitarbeitende', value: `${employees} festangestellt` },
              { label: 'Einsatzgebiet', value: 'Kanton Bern und angrenzende Gemeinden' },
              {
                label: 'Versicherung',
                value: 'Betriebshaftpflicht CHF 5 Mio., alle Mitarbeitenden UVG-versichert',
              },
            ].map((row) => (
              <div key={row.label} className="protocol-row">
                <dt className="protocol-label">{row.label}</dt>
                <dd className="protocol-value">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>

      {/* Karriere-Hinweis */}
      <Section className="bg-surface">
        <div className="container">
          <div className="flex flex-wrap items-center justify-between gap-6 rounded-2xl border border-border bg-card p-8">
            <div className="flex items-start gap-4">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
                <Building2 className="size-5" aria-hidden />
              </span>
              <div className="space-y-1">
                <h2 className="font-display text-lg font-semibold tracking-tight">
                  Wir stellen laufend ein
                </h2>
                <p className="prose-measure text-sm leading-relaxed text-muted-foreground">
                  Faire Löhne, 5 Wochen Ferien ab dem ersten Jahr, moderne Geräte und ein Team, das
                  zusammenhält. Schauen Sie sich unsere offenen Stellen an.
                </p>
              </div>
            </div>
            <Button asChild>
              <Link href="/karriere">Offene Stellen</Link>
            </Button>
          </div>
        </div>
      </Section>

      <Section className="pb-28">
        <div className="container">
          <CallToAction
            title="Lernen wir uns kennen"
            lead="Buchen Sie einen ersten Einsatz — ohne Vertrag, ohne Mindestlaufzeit. Überzeugt es Sie, sprechen wir über einen Rhythmus."
            primary={{ href: '/buchen', label: 'Termin buchen' }}
            secondary={{ href: '/kontakt', label: 'Kontakt aufnehmen' }}
          />
        </div>
      </Section>
    </>
  );
}
