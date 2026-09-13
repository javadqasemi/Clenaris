import type { Metadata } from 'next';
import Link from 'next/link';
import { Gift, Mail, Settings2, Ticket, TrendingUp } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatCurrency, formatDate, formatNumber } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { listNewsletterSubscribers } from '@/server/services/operations-admin.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTriggerUnderline } from '@/components/ui/controls';
import { KpiTile } from '@/components/app/kpi-tile';
import {
  DetailSection,
  EmptyState,
  ListCard,
  PageHeader,
  TableScroll,
} from '@/components/app/page-parts';
import { NewsletterList } from '@/features/admin/newsletter-list';

export const metadata: Metadata = {
  title: 'Marketing',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const SOURCE_LABELS: Record<string, string> = {
  WEBSITE: 'Website',
  PHONE: 'Telefon',
  EMAIL: 'E-Mail',
  REFERRAL: 'Empfehlung',
  GOOGLE_ADS: 'Google Ads',
  META_ADS: 'Meta Ads',
  SEO: 'Suchmaschine',
  WALK_IN: 'Laufkundschaft',
  PARTNER: 'Partner',
  OTHER: 'Übriges',
};

export default async function MarketingPage() {
  /**
   * Die Navigation verlangt `newsletter:read`; die Seite verlangte
   * `coupon:read`. Beides hat jede Rolle, die hierher kommt — aber zwei
   * Schwellen für eine Seite sind eine Einladung, eine davon beim nächsten
   * Umbau zu vergessen. Massgeblich ist die der Navigation.
   */
  const session = await requirePermission('newsletter:read');
  const canUnsubscribe = can(session.role, 'newsletter:delete');
  const canManageCoupons = can(session.role, 'coupon:update');

  const organizationId = await getOrganizationId();
  const yearStart = new Date(new Date().getFullYear(), 0, 1);

  const [coupons, giftCards, subscribers, confirmedSubscribers, leadsBySource, wonLeads, totalLeads, subscriberList] =
    await Promise.all([
      prisma.coupon.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.giftCard.findMany({
        where: { organizationId, active: true },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
      prisma.newsletterSubscriber.count({ where: { organizationId } }),
      prisma.newsletterSubscriber.count({
        where: { organizationId, confirmed: true, unsubscribedAt: null },
      }),
      prisma.lead.groupBy({
        by: ['source'],
        where: { organizationId, deletedAt: null, createdAt: { gte: yearStart } },
        _count: true,
      }),
      prisma.lead.count({
        where: { organizationId, deletedAt: null, status: 'WON', createdAt: { gte: yearStart } },
      }),
      prisma.lead.count({
        where: { organizationId, deletedAt: null, createdAt: { gte: yearStart } },
      }),
      listNewsletterSubscribers({ organizationId, page: 1, pageSize: 200 }),
    ]);

  const conversionRate = totalLeads > 0 ? (wonLeads / totalLeads) * 100 : 0;
  const sortedSources = [...leadsBySource].sort((a, b) => b._count - a._count);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Marketing"
        description="Gutscheine, Geschenkkarten, Newsletter und die Frage, woher Ihre Anfragen tatsächlich kommen."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Newsletter-Abonnenten"
          value={String(confirmedSubscribers)}
          hint={`${subscribers} angemeldet, ${confirmedSubscribers} bestätigt`}
        />
        <KpiTile
          label="Abschlussquote"
          value={`${formatNumber(conversionRate, 'de', 0)} %`}
          hint={`${wonLeads} von ${totalLeads} Anfragen`}
        />
        <KpiTile
          label="Aktive Gutscheincodes"
          value={String(coupons.filter((coupon) => coupon.status === 'ACTIVE').length)}
        />
        <KpiTile
          label="Geschenkkarten im Umlauf"
          value={formatCurrency(
            giftCards.reduce((sum, card) => sum + toNumber(card.balance), 0),
          )}
          hint={`${giftCards.length} Karten`}
        />
      </div>

      <Tabs defaultValue="herkunft">
        <TabsList variant="underline" className="w-full justify-start overflow-x-auto">
          <TabsTriggerUnderline value="herkunft">Herkunft der Anfragen</TabsTriggerUnderline>
          <TabsTriggerUnderline value="gutscheine">
            Gutscheine ({coupons.length})
          </TabsTriggerUnderline>
          <TabsTriggerUnderline value="geschenkkarten">
            Geschenkkarten ({giftCards.length})
          </TabsTriggerUnderline>
          <TabsTriggerUnderline value="newsletter">Newsletter</TabsTriggerUnderline>
        </TabsList>

        {/* Herkunft */}
        <TabsContent value="herkunft">
          {sortedSources.length === 0 ? (
            <EmptyState
              icon={<TrendingUp aria-hidden />}
              title="Noch keine Anfragen dieses Jahr"
              description="Sobald Anfragen eingehen, sehen Sie hier, welcher Kanal tatsächlich Aufträge bringt."
            />
          ) : (
            <ListCard title={`Anfragen ${new Date().getFullYear()}`}>
              <TableScroll>
                <table className="data-table">
                  <caption className="sr-only">Leistung je Kanal</caption>
                  <thead>
                    <tr>
                      <th scope="col">Kanal</th>
                      <th scope="col" className="text-right">
                        Anfragen
                      </th>
                      <th scope="col" className="text-right">
                        Anteil
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSources.map((source) => (
                      <tr key={source.source}>
                        <td className="font-medium">
                          {SOURCE_LABELS[source.source] ?? source.source}
                        </td>
                        <td className="num">{source._count}</td>
                        <td className="num text-muted-foreground">
                          {formatNumber((source._count / totalLeads) * 100, 'de', 1)} %
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </ListCard>
          )}
        </TabsContent>

        {/* Gutscheine */}
        <TabsContent value="gutscheine" className="space-y-4">
          {/*
            Angelegt und geändert werden Gutscheine im Katalog — dort stehen
            sie neben Leistungen und Preisregeln, auf die sie wirken. Hier
            steht nur der Weg dorthin; eine zweite Maske hiesse zwei Wahrheiten
            für denselben Datensatz.
          */}
          {canManageCoupons ? (
            <div className="flex justify-end">
              <Button asChild variant="outline">
                <Link href="/admin/einstellungen/leistungen">
                  <Settings2 aria-hidden />
                  Gutscheine im Katalog verwalten
                </Link>
              </Button>
            </div>
          ) : null}
          {coupons.length === 0 ? (
            <EmptyState
              icon={<Ticket aria-hidden />}
              title="Keine Gutscheincodes"
              description="Gutscheine wirken im Buchungsassistenten sofort auf den Preis und lassen sich auf Leistungen und Mindestbeträge einschränken."
            />
          ) : (
            <ListCard>
              <TableScroll>
                <table className="data-table">
                  <caption className="sr-only">Gutscheincodes</caption>
                  <thead>
                    <tr>
                      <th scope="col">Code</th>
                      <th scope="col">Beschreibung</th>
                      <th scope="col" className="text-right">
                        Rabatt
                      </th>
                      <th scope="col" className="text-right">
                        Eingelöst
                      </th>
                      <th scope="col">Gültig bis</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {coupons.map((coupon) => (
                      <tr key={coupon.id}>
                        <td className="font-mono text-sm font-semibold">{coupon.code}</td>
                        <td className="max-w-[18rem] truncate text-muted-foreground">
                          {coupon.description ?? '—'}
                        </td>
                        <td className="num font-medium">
                          {coupon.discountType === 'PERCENT'
                            ? `${toNumber(coupon.discountValue)} %`
                            : formatCurrency(toNumber(coupon.discountValue))}
                        </td>
                        <td className="num text-muted-foreground">
                          {coupon.usageCount}
                          {coupon.usageLimit ? ` / ${coupon.usageLimit}` : ''}
                        </td>
                        <td className="text-muted-foreground">
                          {coupon.validUntil ? formatDate(coupon.validUntil) : 'unbefristet'}
                        </td>
                        <td>
                          <Badge
                            variant={coupon.status === 'ACTIVE' ? 'success' : 'neutral'}
                            size="sm"
                          >
                            {coupon.status === 'ACTIVE' ? 'Aktiv' : 'Inaktiv'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </ListCard>
          )}
        </TabsContent>

        {/* Geschenkkarten */}
        <TabsContent value="geschenkkarten">
          {giftCards.length === 0 ? (
            <EmptyState
              icon={<Gift aria-hidden />}
              title="Keine Geschenkkarten"
              description="Geschenkkarten sind im Reinigungsgewerbe ein beliebtes Präsent — besonders bei Umzügen und Geburten."
            />
          ) : (
            <ListCard>
              <TableScroll>
                <table className="data-table">
                  <caption className="sr-only">Geschenkkarten</caption>
                  <thead>
                    <tr>
                      <th scope="col">Code</th>
                      <th scope="col">Empfänger</th>
                      <th scope="col" className="text-right">
                        Ausgangswert
                      </th>
                      <th scope="col" className="text-right">
                        Guthaben
                      </th>
                      <th scope="col">Gültig bis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {giftCards.map((card) => (
                      <tr key={card.id}>
                        <td className="font-mono text-sm font-semibold">{card.code}</td>
                        <td className="text-muted-foreground">
                          {card.recipientName ?? card.recipientEmail ?? '—'}
                        </td>
                        <td className="num text-muted-foreground">
                          {formatCurrency(toNumber(card.initialValue))}
                        </td>
                        <td className="num font-medium">
                          {formatCurrency(toNumber(card.balance))}
                        </td>
                        <td className="text-muted-foreground">
                          {card.validUntil ? formatDate(card.validUntil) : 'unbefristet'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </ListCard>
          )}
        </TabsContent>

        {/* Newsletter */}
        <TabsContent value="newsletter">
          <div className="space-y-4 rounded-2xl border border-border bg-card p-6">
            <h2 className="flex items-center gap-2 font-display text-base font-semibold">
              <Mail className="size-4 text-primary" aria-hidden />
              Newsletter
            </h2>

            <dl className="protocol-list">
              <div className="protocol-row">
                <dt className="protocol-label">Angemeldet</dt>
                <dd className="protocol-value tabular-nums">{subscribers}</dd>
              </div>
              <div className="protocol-row">
                <dt className="protocol-label">Bestätigt (Double-Opt-in)</dt>
                <dd className="protocol-value tabular-nums">{confirmedSubscribers}</dd>
              </div>
              <div className="protocol-row">
                <dt className="protocol-label">Bestätigungsquote</dt>
                <dd className="protocol-value tabular-nums">
                  {subscribers > 0
                    ? `${formatNumber((confirmedSubscribers / subscribers) * 100, 'de', 0)} %`
                    : '—'}
                </dd>
              </div>
            </dl>

            <p className="prose-measure text-sm leading-relaxed text-muted-foreground">
              Wir versenden ausschliesslich an bestätigte Adressen. Jede E-Mail enthält einen
              Abmeldelink, der mit einem Klick wirkt — beides ist nach DSG und DSGVO Pflicht und
              hält die Zustellrate hoch.
            </p>
          </div>

          <DetailSection
            title={`Abonnenten (${subscriberList.total})`}
            description="Ausgetragene erscheinen nicht — sie haben widersprochen. Bearbeiten gibt es nicht: Die Adresse ist der Identifikator, die Bestätigung ein Nachweis."
            className="mt-4"
          >
            <NewsletterList
              canDelete={canUnsubscribe}
              subscribers={subscriberList.items.map((subscriber) => ({
                id: subscriber.id,
                email: subscriber.email,
                firstName: subscriber.firstName,
                locale: subscriber.locale,
                confirmed: subscriber.confirmed,
                source: subscriber.source,
                createdAt: subscriber.createdAt.toISOString(),
              }))}
            />
          </DetailSection>
        </TabsContent>
      </Tabs>
    </div>
  );
}
