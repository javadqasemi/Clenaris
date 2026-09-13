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
} from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { hasIntegration } from '@/lib/env';
import { formatCurrency, formatIban } from '@/lib/utils';
import { getOrganization, getOrganizationId } from '@/server/services/organization.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTriggerUnderline } from '@/components/ui/controls';
import { Alert } from '@/components/ui/primitives';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { withSettingsDefaults } from '@/lib/validation/settings';
import { listTemplates } from '@/server/services/operations-admin.service';
import { CompanyForm } from '@/features/admin/settings/company-form';
import { OpeningHoursForm } from '@/features/admin/settings/opening-hours-form';
import { OperationsForm } from '@/features/admin/settings/operations-form';
import { HolidayCreateButton, HolidayList } from '@/features/admin/settings/holiday-manager';
import {
  AutomationCreateButton,
  AutomationList,
} from '@/features/admin/settings/automation-manager';
import { TemplateList } from '@/features/admin/settings/template-manager';

export const metadata: Metadata = {
  title: 'Einstellungen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

/**
 * Einstellungen.
 *
 * Gestaltungsentscheide:
 *
 *  • **Bearbeitbar, wo es einen Endpunkt gibt; lesend, wo nicht.** Firmendaten,
 *    Arbeitszeiten und Betriebsschalter lassen sich hier ändern. Nummernkreise,
 *    Preislogik und Belegprinzip stehen weiterhin nur da — sie sind im Code
 *    verankert, und eine Maske, die etwas verspricht, was der Server nicht
 *    annimmt, wäre schlimmer als gar keine. Wo das so ist, steht es dabei.
 *
 *  • **Wer nur lesen darf, sieht das Protokoll und keine ausgegrauten Felder.**
 *    Ein deaktiviertes Eingabefeld suggeriert, es fehle nur ein Klick.
 */
/**
 * Die Register sind über die Adresszeile erreichbar (`?bereich=zeiten`).
 *
 * Zwei Gründe: Ein Verweis auf „die Arbeitszeiten" lässt sich weitergeben,
 * und der Zurück-Knopf landet dort, wo man war. Unbekannte Werte fallen still
 * auf das erste Register zurück — ein manipulierter Link soll die Seite nicht
 * leer lassen.
 */
const TABS = ['firma', 'zeiten', 'katalog', 'finanzen', 'betrieb', 'automation', 'integrationen'];

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ bereich?: string }>;
}) {
  const session = await requirePermission('settings:read');
  const { bereich } = await searchParams;
  const activeTab = bereich && TABS.includes(bereich) ? bereich : 'firma';
  const canEditCompany = can(session.role, 'company:update');
  const canEditSettings = can(session.role, 'settings:update');
  const canEditAutomations = can(session.role, 'automation:update');
  const canEditTemplates = can(session.role, 'template:update');

  const organizationId = await getOrganizationId();

  /**
   * Feiertage ab dem Jahresanfang des Vorjahres: Was älter ist, braucht
   * niemand mehr in der Maske, und die Liste bliebe sonst nach ein paar
   * Jahren unlesbar lang. Die Ferienrechnung liest die Tabelle ohnehin
   * selbst.
   */
  const holidaysFrom = new Date(Date.UTC(new Date().getUTCFullYear() - 1, 0, 1));

  const [org, hours, holidays, taxRates, services, extras, areas, automations, templates] =
    await Promise.all([
      getOrganization(),
      prisma.openingHours.findMany({
        where: { organizationId },
        orderBy: { weekday: 'asc' },
      }),
      prisma.holiday.findMany({
        where: { organizationId, date: { gte: holidaysFrom } },
        orderBy: { date: 'asc' },
      }),
      prisma.taxRate.findMany({ where: { organizationId, active: true } }),
      prisma.service.count({ where: { organizationId, active: true } }),
      prisma.serviceExtra.count({ where: { organizationId, active: true } }),
      prisma.serviceArea.count({ where: { organizationId, active: true } }),
      prisma.automation.findMany({
        where: { organizationId },
        include: {
          actions: { orderBy: { position: 'asc' } },
          _count: { select: { actions: true, runs: true } },
        },
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
      }),
      listTemplates(organizationId),
    ]);

  const settings = withSettingsDefaults(
    (
      await prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { settings: true },
      })
    ).settings,
  );

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

      <Tabs defaultValue={activeTab}>
        <TabsList variant="underline" className="w-full justify-start overflow-x-auto">
          <TabsTriggerUnderline value="firma">Firma</TabsTriggerUnderline>
          <TabsTriggerUnderline value="zeiten">Arbeitszeiten</TabsTriggerUnderline>
          <TabsTriggerUnderline value="katalog">Katalog</TabsTriggerUnderline>
          <TabsTriggerUnderline value="finanzen">Finanzen</TabsTriggerUnderline>
          <TabsTriggerUnderline value="betrieb">Betrieb</TabsTriggerUnderline>
          <TabsTriggerUnderline value="automation">Automationen</TabsTriggerUnderline>
          <TabsTriggerUnderline value="integrationen">Integrationen</TabsTriggerUnderline>
        </TabsList>

        {/* Firma */}
        <TabsContent value="firma" className="space-y-6">
          {canEditCompany ? (
            <CompanyForm
              company={{
                name: org.name,
                legalName: org.legalName ?? '',
                email: org.email,
                phone: org.phone ?? '',
                whatsapp: org.whatsapp ?? '',
                website: org.website ?? '',
                street: org.street,
                streetNo: org.streetNo ?? '',
                postalCode: org.postalCode,
                city: org.city,
                vatNumber: org.vatNumber ?? '',
                iban: org.iban ?? '',
                qrIban: org.qrIban ?? '',
                bankName: org.bankName ?? '',
                logoUrl: org.logoUrl ?? '',
                logoDarkUrl: org.logoDarkUrl ?? '',
                faviconUrl: org.faviconUrl ?? '',
                mapsUrl: org.mapsUrl ?? '',
                facebookUrl: org.facebookUrl ?? '',
                instagramUrl: org.instagramUrl ?? '',
                linkedinUrl: org.linkedinUrl ?? '',
                tiktokUrl: org.tiktokUrl ?? '',
                youtubeUrl: org.youtubeUrl ?? '',
              }}
            />
          ) : (
            <>
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
            </>
          )}

          {/* Immer nur lesend: für diese Werte gibt es keinen Endpunkt. */}
          <DetailSection title="Erscheinungsbild und Kennungen">
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
              <DetailRow label="UID">{org.uid ?? '—'}</DetailRow>
              <DetailRow label="Kanton">{org.canton}</DetailRow>
              <DetailRow label="Sprache">{org.locale}</DetailRow>
              <DetailRow label="Zeitzone">{org.timezone}</DetailRow>
            </dl>
            <p className="prose-measure py-4 text-sm leading-relaxed text-muted-foreground">
              Diese Werte sind im Erscheinungsbild und in den Berechnungen verankert und lassen sich
              nicht über die Oberfläche ändern. Eine Maske dafür wäre ein Versprechen, das der
              Server nicht einlöst.
            </p>
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
            <p className="prose-measure py-4 text-sm leading-relaxed text-muted-foreground">
              Bewusst nicht änderbar: Ein Wechsel des Kürzels mitten im Jahr risse eine Lücke in
              eine Nummernfolge, die nach Art. 957a OR lückenlos sein muss.
            </p>
          </DetailSection>
        </TabsContent>

        {/* Arbeitszeiten */}
        <TabsContent value="zeiten" className="space-y-6">
          {canEditCompany ? (
            <OpeningHoursForm
              hours={hours.map((hour) => ({
                weekday: hour.weekday,
                opensAt: hour.opensAt,
                closesAt: hour.closesAt,
                closed: hour.closed,
              }))}
            />
          ) : (
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
                buchen kann das Büro jederzeit von Hand.
              </p>
            </DetailSection>
          )}

          <DetailSection
            title={`Feiertage (${holidays.length})`}
            description="An diesen Tagen sind keine Online-Buchungen möglich, und bewilligte Abwesenheiten zählen nicht als Ferientage."
            action={canEditCompany ? <HolidayCreateButton /> : undefined}
          >
            <HolidayList
              canEdit={canEditCompany}
              holidays={holidays.map((holiday) => ({
                id: holiday.id,
                name: holiday.name,
                date: holiday.date.toISOString().slice(0, 10),
                recurring: holiday.recurring,
                canton: holiday.canton,
              }))}
            />
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

        {/* Betrieb */}
        <TabsContent value="betrieb" className="space-y-6">
          {canEditSettings ? (
            <OperationsForm settings={settings} />
          ) : (
            <>
              <Alert variant="info">
                Diese Schalter darf nur die Administration ändern. Sie greifen sofort — in den
                Buchungsassistenten, ins Mahnwesen und in die Bewertungsanfragen.
              </Alert>
              <DetailSection title="Buchung">
                <dl className="protocol-list">
                  <DetailRow label="Buchbar im Voraus">{settings.bookingLeadDays} Tage</DetailRow>
                  <DetailRow label="Kürzeste Vorlaufzeit">
                    {settings.bookingMinNoticeHours} Stunden
                  </DetailRow>
                  <DetailRow label="Kostenlose Stornierung bis">
                    {settings.cancellationDeadlineHours} Stunden vorher
                  </DetailRow>
                  <DetailRow label="SMS-Erinnerung">
                    {settings.smsRemindersEnabled ? 'eingeschaltet' : 'ausgeschaltet'}
                  </DetailRow>
                </dl>
              </DetailSection>
              <DetailSection title="Rechnungen und Bewertungen">
                <dl className="protocol-list">
                  <DetailRow label="Mahnläufe">
                    {settings.autoDunningEnabled ? 'automatisch' : 'von Hand'}
                  </DetailRow>
                  <DetailRow label="Erste Mahnung nach">
                    {settings.firstReminderAfterDays} Tagen Verzug
                  </DetailRow>
                  <DetailRow label="Bewertung anfragen nach">
                    {settings.reviewRequestAfterDays} Tagen
                  </DetailRow>
                  <DetailRow label="Bewertungen">
                    {settings.moderateReviews ? 'erst nach Freigabe sichtbar' : 'sofort sichtbar'}
                  </DetailRow>
                </dl>
              </DetailSection>
            </>
          )}
        </TabsContent>

        {/* Automationen */}
        <TabsContent value="automation" className="space-y-6">
          <DetailSection
            title={`Automationen (${automations.length})`}
            description="Regeln, die auf Ereignisse reagieren. Pausierte Regeln bleiben erhalten und laufen nicht."
            action={canEditAutomations ? <AutomationCreateButton /> : undefined}
          >
            <AutomationList
              canEdit={canEditAutomations}
              automations={automations.map((automation) => ({
                id: automation.id,
                name: automation.name,
                description: automation.description,
                trigger: automation.trigger,
                delayMinutes: automation.delayMinutes,
                active: automation.active,
                runs: automation._count.runs,
                actions: automation.actions.map((action) => ({
                  type: action.type,
                  config: (action.config ?? {}) as Record<string, unknown>,
                })),
              }))}
            />
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

          <DetailSection
            title={`Vorlagen (${templates.email.length + templates.sms.length})`}
            description="Die Transaktions-E-Mails sind im Code hinterlegt und folgen dem Erscheinungsbild der Website. Datenbankvorlagen überschreiben sie je Sprache."
          >
            <TemplateList
              canEdit={canEditTemplates}
              email={templates.email.map((template) => ({
                id: template.id,
                key: template.key,
                locale: template.locale,
                subject: template.subject,
                bodyHtml: template.bodyHtml,
                bodyText: template.bodyText,
                active: template.active,
              }))}
              sms={templates.sms.map((template) => ({
                id: template.id,
                key: template.key,
                locale: template.locale,
                body: template.body,
                active: template.active,
              }))}
            />
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
