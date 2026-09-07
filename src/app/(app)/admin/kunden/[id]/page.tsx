import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  CalendarPlus,
  FileText,
  Home,
  Mail,
  MapPin,
  Phone,
  Receipt,
  ShoppingBag,
} from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { NotFoundError } from '@/lib/errors';
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatPhone,
  formatRelative,
} from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { getCustomerDetail } from '@/server/services/crm.service';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PersonAvatar } from '@/components/ui/primitives';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTriggerUnderline,
} from '@/components/ui/controls';
import { KpiTile } from '@/components/app/kpi-tile';
import { DetailRow, DetailSection, EmptyState, PageHeader } from '@/components/app/page-parts';
import { DataCell, DataList, DataListHeader, DataRow } from '@/components/app/data-list';
import { ActivityComposer } from '@/features/admin/activity-composer';

export const metadata: Metadata = {
  title: 'Kunde',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Spaltenspuren der Listen.
 *
 * Sie stehen als Konstanten, weil Kopfzeile und Datenzeilen dieselben Spuren
 * brauchen — stünden sie zweimal ausgeschrieben, wäre die Kopfzeile beim
 * nächsten Eingriff um eine Spalte verschoben.
 *
 * `minmax(0,1fr)` statt `1fr` ist entscheidend: ohne die Null als Untergrenze
 * verweigert eine Rasterspur das Schrumpfen unter ihren Inhalt, und ein langer
 * Titel schiebt die Nachbarspalten aus dem Rahmen.
 */
const BOOKING_COLUMNS = '6.5rem minmax(0,1fr) 6.5rem 7rem 8rem';
const INVOICE_COLUMNS = '7.5rem 7rem 7rem 7rem 8rem';
const QUOTE_COLUMNS = '7.5rem minmax(0,1fr) 7rem 8rem';

const ACTIVITY_LABELS: Record<string, string> = {
  NOTE: 'Notiz',
  CALL: 'Telefonat',
  EMAIL: 'E-Mail',
  SMS: 'SMS',
  MEETING: 'Termin',
  TASK: 'Aufgabe',
  STATUS_CHANGE: 'Statuswechsel',
  FILE_UPLOAD: 'Datei',
  SYSTEM: 'System',
};

export default async function AdminCustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission('customer:read');

  const { id } = await params;
  const organizationId = await getOrganizationId();

  const { customer, stats } = await getCustomerDetail({ organizationId, customerId: id }).catch(
    (error) => {
      if (error instanceof NotFoundError) notFound();
      throw error;
    },
  );

  const displayName = customer.companyName ?? `${customer.firstName} ${customer.lastName}`;
  const billing = customer.addresses.find((address) => address.isBilling) ?? customer.addresses[0];

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/kunden">
          <ArrowLeft aria-hidden />
          Alle Kunden
        </Link>
      </Button>

      <PageHeader
        title={displayName}
        description={`Kunde seit ${formatDate(customer.createdAt)} · ${customer.number}`}
        actions={
          <>
            <Button asChild variant="outline">
              <Link href={`/admin/offerten/neu?kunde=${customer.id}`}>
                <FileText aria-hidden />
                Offerte
              </Link>
            </Button>
            <Button asChild>
              <Link href={`/buchen?kunde=${customer.id}`}>
                <CalendarPlus aria-hidden />
                Termin buchen
              </Link>
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <PersonAvatar firstName={customer.firstName} lastName={customer.lastName} />
          <Badge variant={customer.type === 'BUSINESS' ? 'neutral' : 'outline'}>
            {customer.type === 'BUSINESS' ? 'Geschäftskunde' : 'Privatkunde'}
          </Badge>
          {customer.blocked ? <Badge variant="destructive">Gesperrt</Badge> : null}
          {customer.tags.map((link) => (
            <Badge
              key={link.tagId}
              variant="outline"
              style={{ borderColor: `${link.tag.color}55`, color: link.tag.color }}
            >
              {link.tag.name}
            </Badge>
          ))}
        </div>
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile label="Umsatz total" value={formatCurrency(stats.lifetimeValue)} />
        <KpiTile label="Buchungen" value={String(stats.totalBookings)} />
        <KpiTile
          label="Offene Posten"
          value={formatCurrency(stats.outstandingAmount)}
          hint={`${stats.outstandingCount} Rechnungen`}
          accent={stats.outstandingAmount > 0 ? 'warning' : undefined}
        />
        <KpiTile
          label="Letzte Buchung"
          value={customer.lastBookingAt ? formatDate(customer.lastBookingAt) : '—'}
          hint={customer.lastBookingAt ? formatRelative(customer.lastBookingAt) : undefined}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <Tabs defaultValue="verlauf">
          <TabsList variant="underline" className="w-full justify-start overflow-x-auto">
            <TabsTriggerUnderline value="verlauf">Verlauf</TabsTriggerUnderline>
            <TabsTriggerUnderline value="buchungen">
              Buchungen ({customer.bookings.length})
            </TabsTriggerUnderline>
            <TabsTriggerUnderline value="rechnungen">
              Rechnungen ({customer.invoices.length})
            </TabsTriggerUnderline>
            <TabsTriggerUnderline value="offerten">
              Offerten ({customer.quotes.length})
            </TabsTriggerUnderline>
            <TabsTriggerUnderline value="objekte">
              Objekte ({customer.properties.length})
            </TabsTriggerUnderline>
          </TabsList>

          {/* Verlauf */}
          <TabsContent value="verlauf" className="space-y-6">
            <ActivityComposer customerId={customer.id} />

            {customer.activities.length === 0 ? (
              <EmptyState
                title="Noch kein Verlauf"
                description="Halten Sie Telefonate, E-Mails und Absprachen hier fest — so weiss das ganze Team, was zuletzt besprochen wurde."
              />
            ) : (
              <ol className="space-y-1">
                {customer.activities.map((activity) => (
                  <li
                    key={activity.id}
                    className="relative border-l border-border py-4 pl-6 last:border-l-transparent"
                  >
                    <span
                      className="absolute -left-[5px] top-6 size-2.5 rounded-full bg-primary ring-4 ring-surface"
                      aria-hidden
                    />
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <Badge variant="neutral" size="sm">
                        {ACTIVITY_LABELS[activity.type] ?? activity.type}
                      </Badge>
                      <p className="font-medium">{activity.subject}</p>
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(activity.occurredAt)}
                        {activity.author
                          ? ` · ${activity.author.firstName} ${activity.author.lastName}`
                          : ''}
                      </span>
                    </div>
                    {activity.body ? (
                      <p className="prose-measure mt-1.5 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                        {activity.body}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </TabsContent>

          {/* Buchungen */}
          <TabsContent value="buchungen">
            {customer.bookings.length === 0 ? (
              <EmptyState
                icon={<ShoppingBag aria-hidden />}
                title="Noch keine Buchungen"
                description="Sobald ein Termin gebucht wird, erscheint er hier."
                action={{ href: '/buchen', label: 'Termin buchen' }}
              />
            ) : (
              <DataList label="Buchungen dieser Kundschaft">
                <DataListHeader columns={BOOKING_COLUMNS}>
                  <span>Nummer</span>
                  <span>Leistung</span>
                  <span className="text-right">Termin</span>
                  <span className="text-right">Betrag</span>
                  <span>Status</span>
                </DataListHeader>

                {customer.bookings.map((booking) => (
                  <DataRow
                    key={booking.id}
                    href={`/admin/buchungen/${booking.id}`}
                    columns={BOOKING_COLUMNS}
                  >
                    <DataCell strong className="tabular-nums text-primary">
                      {booking.number}
                    </DataCell>
                    <DataCell truncate>{booking.items[0]?.name ?? 'Reinigung'}</DataCell>
                    <DataCell numeric muted label="Termin">
                      {formatDate(booking.scheduledStart)}
                    </DataCell>
                    <DataCell numeric strong label="Betrag">
                      {formatCurrency(toNumber(booking.grossTotal))}
                    </DataCell>
                    <DataCell>
                      <StatusBadge status={booking.status} />
                    </DataCell>
                  </DataRow>
                ))}
              </DataList>
            )}
          </TabsContent>

          {/* Rechnungen */}
          <TabsContent value="rechnungen">
            {customer.invoices.length === 0 ? (
              <EmptyState
                icon={<Receipt aria-hidden />}
                title="Noch keine Rechnungen"
                description="Rechnungen entstehen aus abgeschlossenen Einsätzen."
              />
            ) : (
              <DataList label="Rechnungen dieser Kundschaft">
                <DataListHeader columns={INVOICE_COLUMNS}>
                  <span>Nummer</span>
                  <span className="text-right">Ausgestellt</span>
                  <span className="text-right">Betrag</span>
                  <span className="text-right">Offen</span>
                  <span>Status</span>
                </DataListHeader>

                {customer.invoices.map((invoice) => {
                  const balance = toNumber(invoice.balance);
                  return (
                    <DataRow
                      key={invoice.id}
                      href={`/admin/rechnungen/${invoice.id}`}
                      columns={INVOICE_COLUMNS}
                    >
                      <DataCell strong className="tabular-nums text-primary">
                        {invoice.number}
                      </DataCell>
                      <DataCell numeric muted label="Ausgestellt">
                        {formatDate(invoice.issueDate)}
                      </DataCell>
                      <DataCell numeric strong label="Betrag">
                        {formatCurrency(toNumber(invoice.grossTotal))}
                      </DataCell>
                      {/* Die Spur bleibt auch bei bezahlten Rechnungen belegt —
                          sonst rutschen die Spalten von Zeile zu Zeile. */}
                      <DataCell numeric className={balance > 0 ? 'text-warning' : 'text-muted-foreground'}>
                        {balance > 0 ? formatCurrency(balance) : '—'}
                      </DataCell>
                      <DataCell>
                        <StatusBadge status={invoice.status} />
                      </DataCell>
                    </DataRow>
                  );
                })}
              </DataList>
            )}
          </TabsContent>

          {/* Offerten */}
          <TabsContent value="offerten">
            {customer.quotes.length === 0 ? (
              <EmptyState
                icon={<FileText aria-hidden />}
                title="Noch keine Offerten"
                description="Erstellen Sie eine Offerte — auf Wunsch mit KI-Entwurf aus der Anfrage."
                action={{ href: `/admin/offerten/neu?kunde=${customer.id}`, label: 'Offerte erstellen' }}
              />
            ) : (
              <DataList label="Offerten dieser Kundschaft">
                <DataListHeader columns={QUOTE_COLUMNS}>
                  <span>Nummer</span>
                  <span>Titel</span>
                  <span className="text-right">Betrag</span>
                  <span>Status</span>
                </DataListHeader>

                {customer.quotes.map((quote) => (
                  <DataRow
                    key={quote.id}
                    href={`/admin/offerten/${quote.id}`}
                    columns={QUOTE_COLUMNS}
                  >
                    <DataCell strong className="tabular-nums text-primary">
                      {quote.number}
                    </DataCell>
                    <DataCell truncate>{quote.title}</DataCell>
                    <DataCell numeric strong label="Betrag">
                      {formatCurrency(toNumber(quote.grossTotal))}
                    </DataCell>
                    <DataCell>
                      <StatusBadge status={quote.status} />
                    </DataCell>
                  </DataRow>
                ))}
              </DataList>
            )}
          </TabsContent>

          {/* Objekte */}
          <TabsContent value="objekte">
            {customer.properties.length === 0 ? (
              <EmptyState
                icon={<Building2 aria-hidden />}
                title="Keine Objekte erfasst"
                description="Objekte speichern Fläche, Zimmerzahl und Zugangsinformationen — das beschleunigt jede weitere Buchung."
              />
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2">
                {customer.properties.map((property) => (
                  <li
                    key={property.id}
                    className="space-y-3 rounded-2xl border border-border bg-card p-5"
                  >
                    <div className="flex items-start gap-3">
                      <span className="flex size-9 items-center justify-center rounded-xl bg-primary/8 text-primary">
                        <Home className="size-4" aria-hidden />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-medium">{property.label}</p>
                        <p className="text-sm text-muted-foreground">
                          {[
                            property.squareMeters ? `${property.squareMeters} m²` : null,
                            property.rooms ? `${toNumber(property.rooms)} Zimmer` : null,
                            property.bathrooms ? `${property.bathrooms} Bad` : null,
                            property.windows ? `${property.windows} Fenster` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </div>
                    </div>
                    {property.accessNote ? (
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        {property.accessNote}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>

        {/* Seitenspalte */}
        <div className="space-y-6">
          <DetailSection title="Kontakt">
            {/* Enge Fassung: Beschriftung und Wert sind hier beide kurz und
                gehören zusammen — 24 px reissen das Paar eher auseinander. */}
            <dl className="protocol-list protocol-list--tight">
              <DetailRow label="E-Mail">
                <a
                  href={`mailto:${customer.email}`}
                  className="inline-flex items-center gap-1.5 text-primary underline-offset-4 hover:underline"
                >
                  <Mail className="size-3.5" aria-hidden />
                  {customer.email}
                </a>
              </DetailRow>
              {customer.phone ? (
                <DetailRow label="Telefon">
                  <a
                    href={`tel:${customer.phone}`}
                    className="inline-flex items-center gap-1.5 text-primary underline-offset-4 hover:underline"
                  >
                    <Phone className="size-3.5" aria-hidden />
                    {formatPhone(customer.phone)}
                  </a>
                </DetailRow>
              ) : null}
              {customer.mobile ? (
                <DetailRow label="Mobil">{formatPhone(customer.mobile)}</DetailRow>
              ) : null}
              {billing ? (
                <DetailRow label="Adresse">
                  <span className="inline-flex items-start gap-1.5">
                    <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span>
                      {billing.street} {billing.streetNo}
                      <br />
                      {billing.postalCode} {billing.city}
                    </span>
                  </span>
                </DetailRow>
              ) : null}
              <DetailRow label="Login">
                {customer.user
                  ? `Aktiv${customer.user.lastLoginAt ? ` · zuletzt ${formatRelative(customer.user.lastLoginAt)}` : ''}`
                  : 'Kein Konto verknüpft'}
              </DetailRow>
            </dl>
          </DetailSection>

          <DetailSection title="Konditionen">
            <dl className="protocol-list">
              <DetailRow label="Zahlungsfrist">{customer.paymentTermDays} Tage</DetailRow>
              <DetailRow label="Rabatt">
                {toNumber(customer.discountPercent) > 0
                  ? `${toNumber(customer.discountPercent)} %`
                  : 'keiner'}
              </DetailRow>
              {customer.vatNumber ? (
                <DetailRow label="MWST-Nummer">{customer.vatNumber}</DetailRow>
              ) : null}
              <DetailRow label="Sprache">{customer.language}</DetailRow>
              {customer.referralCode ? (
                <DetailRow label="Empfehlungscode">{customer.referralCode}</DetailRow>
              ) : null}
            </dl>
          </DetailSection>

          {customer.internalNotes ? (
            <DetailSection title="Interne Notizen">
              <p className="whitespace-pre-line py-4 text-sm leading-relaxed text-muted-foreground">
                {customer.internalNotes}
              </p>
            </DetailSection>
          ) : null}

          {customer.tasks.length > 0 ? (
            <DetailSection title="Offene Aufgaben">
              <ul className="protocol-list">
                {customer.tasks.map((task) => (
                  <li key={task.id} className="py-3">
                    <p className="text-sm font-medium">{task.title}</p>
                    {task.dueAt ? (
                      <p className="text-xs text-muted-foreground">
                        fällig {formatDate(task.dueAt)}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </DetailSection>
          ) : null}
        </div>
      </div>
    </div>
  );
}
