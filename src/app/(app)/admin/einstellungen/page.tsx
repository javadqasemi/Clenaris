import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Clock,
  CreditCard,
  FileText,
  Mail,
  MapPin,
  Percent,
  Plug,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { hasIntegration } from '@/lib/env';
import { formatCurrency, formatIban } from '@/lib/utils';
import { getOrganization, getOrganizationId } from '@/server/services/organization.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTriggerUnderline } from '@/components/ui/controls';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Einstellungen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

/**
 * Einstellungen.
 *
 * Gestaltungsentscheid: die Seite zeigt den *aktuellen Stand* als Protokoll
 * und verlinkt für Änderungen in die jeweiligen Bereiche. Ein einziges
 * Riesenformular mit sechzig Feldern wird selten korrekt ausgefüllt — und
 * Stammdaten ändern sich ohnehin selten.
 */
export default async function SettingsPage() {
  await requirePermission('settings:read');

  const organizationId = await getOrganizationId();

  const [org, hours, holidays, taxRates, services, extras, areas, automations, templates] =
    await Promise.all([
      getOrganization(),
      prisma.openingHours.findMany({
        where: { organizationId },
        orderBy: { weekday: 'asc' },
      }),
      prisma.holiday.findMany({
        where: { organizationId },
        orderBy: { date: 'asc' },
        take: 20,
      }),
      prisma.taxRate.findMany({ where: { organizationId, active: true } }),
      prisma.service.count({ where: { organizationId, active: true } }),
      prisma.serviceExtra.count({ where: { organizationId, active: true } }),
      prisma.serviceArea.count({ where: { organizationId, active: true } }),
      prisma.automation.findMany({
        where: { organizationId },
        include: { _count: { select: { actions: true } } },
        orderBy: { name: 'asc' },
      }),
      prisma.emailTemplate.count({ where: { organizationId } }),
    ]);

  const integrations = [
    { key: 'supabase' as const, label: 'Supabase Storage', purpose: 'Fotos, PDFs und Dokumente' },
    { key: 'stripe' as const, label: 'Stripe', purpose: 'Kartenzahlung und TWINT' },
    { key: 'resend' as const, label: 'Resend', purpose: 'Transaktions-E-Mails' },
    { key: 'twilio' as const, label: 'Twilio', purpose: 'SMS-Erinnerungen' },
    { key: 'maps' as const, label: 'Google Maps', purpose: 'Adressen und Fahrzeiten' },
    { key: 'ai' as const, label: 'Anthropic', purpose: 'KI-Assistent und Entwürfe' },
    { key: 'redis' as const, label: 'Redis', purpose: 'Rate-Limiting und Cache' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Einstellungen"
        description="Stammdaten, Arbeitszeiten, Preise und Integrationen. Änderungen wirken sofort auf Website und Buchungsassistent."
      />

      <Tabs defaultValue="firma">
        <TabsList variant="underline" className="w-full justify-start overflow-x-auto">
          <TabsTriggerUnderline value="firma">Firma</TabsTriggerUnderline>
          <TabsTriggerUnderline value="zeiten">Arbeitszeiten</TabsTriggerUnderline>
          <TabsTriggerUnderline value="katalog">Katalog</TabsTriggerUnderline>
          <TabsTriggerUnderline value="finanzen">Finanzen</TabsTriggerUnderline>
          <TabsTriggerUnderline value="automation">Automationen</TabsTriggerUnderline>
          <TabsTriggerUnderline value="integrationen">Integrationen</TabsTriggerUnderline>
        </TabsList>

        {/* Firma */}
        <TabsContent value="firma" className="space-y-6">
          <DetailSection title="Firmenangaben">
            <dl className="protocol-list">
              <DetailRow label="Name">{org.name}</DetailRow>
              <DetailRow label="Firma (rechtlich)">{org.legalName ?? '—'}</DetailRow>
              <DetailRow label="Adresse">
                {org.street} {org.streetNo}
                <br />
                {org.postalCode} {org.city}, Kanton {org.canton}
              </DetailRow>
              <DetailRow label="E-Mail">{org.email}</DetailRow>
              <DetailRow label="Telefon">{org.phone ?? '—'}</DetailRow>
              <DetailRow label="Website">{org.website ?? '—'}</DetailRow>
              <DetailRow label="MWST-Nummer">{org.vatNumber ?? '—'}</DetailRow>
              <DetailRow label="UID">{org.uid ?? '—'}</DetailRow>
            </dl>
          </DetailSection>

          <DetailSection title="Bankverbindung">
            <dl className="protocol-list">
              <DetailRow label="Bank">{org.bankName ?? '—'}</DetailRow>
              <DetailRow label="IBAN">{org.iban ? formatIban(org.iban) : '—'}</DetailRow>
              <DetailRow label="QR-IBAN">
                {org.qrIban ? (
                  <>
                    {formatIban(org.qrIban)}
                    <Badge variant="success" size="sm" className="ml-2">
                      QR-Rechnung aktiv
                    </Badge>
                  </>
                ) : (
                  <span className="text-warning">
                    Nicht hinterlegt — Rechnungen tragen dann keine QR-Referenz
                  </span>
                )}
              </DetailRow>
            </dl>
          </DetailSection>

          <DetailSection title="Erscheinungsbild">
            <dl className="protocol-list">
              <DetailRow label="Primärfarbe">
                <span className="inline-flex items-center gap-2">
                  <span
                    className="size-4 rounded border border-border"
                    style={{ backgroundColor: org.primaryColor }}
                    aria-hidden
                  />
                  {org.primaryColor}
                </span>
              </DetailRow>
              <DetailRow label="Logo">{org.logoUrl ? 'Hinterlegt' : 'Wortmarke wird verwendet'}</DetailRow>
              <DetailRow label="Sprache">{org.locale}</DetailRow>
              <DetailRow label="Zeitzone">{org.timezone}</DetailRow>
            </dl>
          </DetailSection>

          <DetailSection title="Nummernkreise">
            <dl className="protocol-list">
              <DetailRow label="Rechnungen">{org.invoiceNumberPrefix}-JJJJ-00001</DetailRow>
              <DetailRow label="Offerten">{org.quoteNumberPrefix}-JJJJ-00001</DetailRow>
              <DetailRow label="Buchungen">{org.bookingNumberPrefix}-JJJJ-00001</DetailRow>
              <DetailRow label="Einsätze">{org.jobNumberPrefix}-JJJJ-00001</DetailRow>
              <DetailRow label="Gutschriften">{org.creditNumberPrefix}-JJJJ-00001</DetailRow>
              <DetailRow label="Jahreswechsel">
                {org.numberYearReset
                  ? 'Zähler beginnt jedes Jahr neu bei 1'
                  : 'Zähler läuft durch'}
              </DetailRow>
            </dl>
          </DetailSection>
        </TabsContent>

        {/* Arbeitszeiten */}
        <TabsContent value="zeiten" className="space-y-6">
          <DetailSection title="Öffnungs- und Einsatzzeiten">
            <dl className="protocol-list">
              {hours.map((hour) => (
                <div key={hour.id} className="protocol-row">
                  <dt className="protocol-label">{WEEKDAYS[hour.weekday]}</dt>
                  <dd className="protocol-value tabular-nums">
                    {hour.closed || !hour.opensAt
                      ? 'geschlossen'
                      : `${hour.opensAt} – ${hour.closesAt} Uhr`}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="py-4 text-sm leading-relaxed text-muted-foreground">
              Der Buchungsassistent bietet nur Zeitfenster innerhalb dieser Zeiten an. Ausserhalb
                buchen kann das Büro jederzeit manuell.
            </p>
          </DetailSection>

          <DetailSection title={`Feiertage (${holidays.length})`}>
            <dl className="protocol-list">
              {holidays.map((holiday) => (
                <div key={holiday.id} className="protocol-row">
                  <dt className="protocol-label tabular-nums">
                    {new Intl.DateTimeFormat('de-CH', {
                      timeZone: 'UTC',
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                    }).format(holiday.date)}
                  </dt>
                  <dd className="protocol-value">
                    {holiday.name}
                    {holiday.recurring ? (
                      <span className="ml-2 text-xs text-muted-foreground">jährlich</span>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="py-4 text-sm leading-relaxed text-muted-foreground">
              An diesen Tagen sind keine Online-Buchungen möglich, und bewilligte Abwesenheiten
              zählen nicht als Ferientage.
            </p>
          </DetailSection>
        </TabsContent>

        {/* Katalog */}
        <TabsContent value="katalog" className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              { label: 'Aktive Leistungen', value: services, href: '/admin/einstellungen/leistungen', Icon: Sparkles },
              { label: 'Zusatzleistungen', value: extras, href: '/admin/einstellungen/leistungen', Icon: Percent },
              { label: 'Postleitzahlen im Gebiet', value: areas, href: '/admin/einstellungen/gebiet', Icon: MapPin },
            ].map((item) => (
              <Link
                key={item.label}
                href={item.href}
                className="group flex items-center gap-4 rounded-2xl border border-border bg-card p-5 shadow-soft transition-[border-color,box-shadow] duration-300 ease-spring hover:border-primary/30 hover:shadow-card"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
                  <item.Icon className="size-5" aria-hidden />
                </span>
                <span>
                  <span className="block font-display text-2xl font-bold tabular-nums">
                    {item.value}
                  </span>
                  <span className="block text-sm text-muted-foreground">{item.label}</span>
                </span>
              </Link>
            ))}
          </div>

          <DetailSection title="Preislogik">
            <dl className="protocol-list">
              <DetailRow label="Berechnung">
                Serverseitig in <code className="text-xs">lib/pricing/engine.ts</code> — der Client
                rechnet nie selbst.
              </DetailRow>
              <DetailRow label="Reihenfolge">
                Grundpreis → Zusatzleistungen → Anfahrt → Preisregeln → Abo-Rabatt → Gutschein →
                Mindestpreis → MWST
              </DetailRow>
              <DetailRow label="Abo-Rabatte">
                wöchentlich 15 % · zweiwöchentlich 10 % · monatlich 5 % · vierteljährlich 3 %
              </DetailRow>
              <DetailRow label="Preisregeln">
                Zuschläge und Rabatte werden über Bedingungen gesteuert (Wochentag, Uhrzeit, Fläche,
                Haustiere) und sind pro Leistung oder global gültig.
              </DetailRow>
            </dl>
          </DetailSection>
        </TabsContent>

        {/* Finanzen */}
        <TabsContent value="finanzen" className="space-y-6">
          <DetailSection title="Steuern und Zahlungsziele">
            <dl className="protocol-list">
              <DetailRow label="Standard-MWST">{toNumber(org.defaultVat).toFixed(1)} %</DetailRow>
              <DetailRow label="Zahlungsfrist">{org.paymentTerm} Tage</DetailRow>
              <DetailRow label="Währung">{org.currency}</DetailRow>
              <DetailRow label="Hinterlegte Steuersätze">
                {taxRates
                  .map((rate) => `${rate.name} ${toNumber(rate.rate).toFixed(1)} %`)
                  .join(' · ')}
              </DetailRow>
            </dl>
          </DetailSection>

          <DetailSection title="Mahnwesen">
            <dl className="protocol-list">
              <DetailRow label="Ablauf">
                Nach Ablauf der Zahlungsfrist markiert der nächtliche Lauf die Rechnung als
                überfällig. Danach folgen bis zu drei Stufen im Abstand von 10 Tagen.
              </DetailRow>
              <DetailRow label="Gebühren">
                Zahlungserinnerung {formatCurrency(0)} · 1. Mahnung {formatCurrency(20)} · 2. Mahnung{' '}
                {formatCurrency(40)}
              </DetailRow>
              <DetailRow label="Kanäle">
                Stufe 1 per E-Mail, ab Stufe 2 zusätzlich SMS.
              </DetailRow>
            </dl>
          </DetailSection>

          <DetailSection title="Belegprinzip">
            <dl className="protocol-list">
              <DetailRow label="Unveränderlichkeit">
                Ausgestellte Rechnungen werden nie mutiert. Korrekturen laufen über Gutschriften
                (Art. 957a OR).
              </DetailRow>
              <DetailRow label="Nummernkreis">
                Lückenlos und fortlaufend, über eine Sequenztabelle in derselben Transaktion
                vergeben.
              </DetailRow>
              <DetailRow label="Buchhaltungsexport">
                CSV, bexio, Abacus, Banana und DATEV — unter Auswertungen.
              </DetailRow>
            </dl>
          </DetailSection>
        </TabsContent>

        {/* Automationen */}
        <TabsContent value="automation" className="space-y-6">
          <DetailSection title={`Automationen (${automations.length})`}>
            <dl className="protocol-list">
              {automations.map((automation) => (
                <div key={automation.id} className="protocol-row">
                  <dt className="protocol-label">
                    <span className="flex items-center gap-2">
                      <Zap className="size-3.5 text-primary" aria-hidden />
                      {automation.name}
                    </span>
                  </dt>
                  <dd className="protocol-value flex flex-wrap items-center gap-2 font-normal">
                    <Badge variant={automation.active ? 'success' : 'neutral'} size="sm">
                      {automation.active ? 'Aktiv' : 'Pausiert'}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      {automation._count.actions}{' '}
                      {automation._count.actions === 1 ? 'Aktion' : 'Aktionen'}
                      {automation.delayMinutes > 0
                        ? ` · ${Math.round(automation.delayMinutes / 60)} Std. Verzögerung`
                        : ''}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          </DetailSection>

          <DetailSection title="Zeitgesteuerte Läufe">
            <dl className="protocol-list">
              <DetailRow label="Stündlich">
                Terminerinnerungen an Kundschaft (24 Std. und 2 Std. vorher) und an das Team (2 Std.
                vorher).
              </DetailRow>
              <DetailRow label="Täglich 06:00 Uhr">
                Serientermine erzeugen, überfällige Rechnungen mahnen, ablaufende Offerten
                erinnern, Bewertungen anfragen, Geburtstagsgrüsse, Nachfassaufgaben, abgelaufene
                Tokens löschen.
              </DetailRow>
            </dl>
          </DetailSection>

          <DetailSection title={`E-Mail-Vorlagen (${templates})`}>
            <p className="py-4 text-sm leading-relaxed text-muted-foreground">
              Die Transaktions-E-Mails sind im Code hinterlegt und folgen dem Erscheinungsbild der
              Website. Datenbankvorlagen überschreiben sie pro Sprache, sofern angelegt.
            </p>
          </DetailSection>
        </TabsContent>

        {/* Integrationen */}
        <TabsContent value="integrationen" className="space-y-6">
          <DetailSection title="Angebundene Dienste">
            <dl className="protocol-list">
              {integrations.map((integration) => {
                const configured = hasIntegration(integration.key);
                return (
                  <div key={integration.key} className="protocol-row">
                    <dt className="protocol-label">
                      <span className="flex items-center gap-2">
                        <Plug className="size-3.5" aria-hidden />
                        {integration.label}
                      </span>
                    </dt>
                    <dd className="protocol-value flex flex-wrap items-center gap-3 font-normal">
                      <Badge variant={configured ? 'success' : 'neutral'} size="sm">
                        {configured ? 'Konfiguriert' : 'Nicht konfiguriert'}
                      </Badge>
                      <span className="text-sm text-muted-foreground">{integration.purpose}</span>
                    </dd>
                  </div>
                );
              })}
            </dl>
            <p className="py-4 text-sm leading-relaxed text-muted-foreground">
              Nicht konfigurierte Dienste blockieren den Betrieb nicht: E-Mails und SMS werden dann
              protokolliert statt versendet, Zahlungen laufen über die QR-Rechnung, und die
              KI-Funktionen sind ausgeblendet.
            </p>
          </DetailSection>

          <DetailSection title="Weitere Bereiche">
            <div className="grid gap-3 py-4 sm:grid-cols-2">
              {[
                { href: '/admin/personal', label: 'Mitarbeitende verwalten', Icon: Users },
                { href: '/admin/auswertungen', label: 'Auswertungen und Exporte', Icon: FileText },
                { href: '/admin/zahlungen', label: 'Zahlungen', Icon: CreditCard },
                { href: '/admin/marketing', label: 'Gutscheine und Newsletter', Icon: Mail },
                { href: '/admin/kalender', label: 'Einsatzkalender', Icon: Clock },
                { href: '/admin/ki', label: 'KI-Werkzeuge', Icon: Sparkles },
              ].map((item) => (
                <Button key={item.href} asChild variant="outline" className="justify-start">
                  <Link href={item.href}>
                    <item.Icon aria-hidden />
                    {item.label}
                  </Link>
                </Button>
              ))}
            </div>
          </DetailSection>
        </TabsContent>
      </Tabs>
    </div>
  );
}
