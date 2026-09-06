'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api/client';
import { formatCurrency, formatDuration, formatNumber } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { Tabs, TabsContent, TabsList, TabsTriggerUnderline } from '@/components/ui/controls';
import { EmptyState, ListCard, TableScroll } from '@/components/app/page-parts';

import { ServiceForm, type ServiceRow } from './service-form';
import { ExtraForm, type ExtraRow } from './extra-form';
import { PriceRuleForm, type PriceRuleRow } from './price-rule-form';
import {
  CategoryForm,
  CouponForm,
  TaxRateForm,
  type CategoryRow,
  type CouponRow,
  type TaxRateRow,
} from './simple-forms';
import {
  ActiveBadge,
  DeleteDialog,
  describeError,
  FREQUENCY_LABELS,
  PRICING_LABELS,
  PROPERTY_KIND_LABELS,
  RowActions,
  SERVICE_KIND_LABELS,
  WEEKDAY_LABELS,
} from './shared';

/**
 * Katalogpflege: Leistungen, Zusätze, Preisregeln, Kategorien, Steuersätze,
 * Gutscheine.
 *
 * Architekturentscheide:
 *
 *  • **Sechs Register statt sechs Seiten.** Die Daten hängen voneinander ab —
 *    eine Zusatzleistung verweist auf Leistungen, eine Preisregel auf eine
 *    Leistung. Wer eine Regel anlegt und merkt, dass die Leistung fehlt, soll
 *    einen Klick entfernt sein und nicht eine Navigation.
 *
 *  • **Der Server liefert die Daten, nicht der Browser.** Die Seite ist eine
 *    Server-Komponente; dieses Bauteil bekommt fertige Zeilen und ruft nach
 *    jeder Änderung `router.refresh()`. Ein eigener Ladezustand im Browser
 *    wäre eine zweite Wahrheit über denselben Datenbestand.
 *
 *  • **Ohne Schreibrecht verschwinden die Schaltflächen, nicht nur ihre
 *    Wirkung.** Eine ausgegraute Schaltfläche, die beim Klick 403 liefert,
 *    ist eine Zumutung. Die Berechtigung kommt vom Server; die API prüft sie
 *    ohnehin ein zweites Mal.
 */

export interface CatalogData {
  services: ServiceRow[];
  extras: ExtraRow[];
  rules: PriceRuleRow[];
  categories: CategoryRow[];
  taxRates: TaxRateRow[];
  coupons: CouponRow[];
  /** Wie oft jede Leistung bereits verwendet wurde — steuert das Löschen. */
  serviceUsage: Record<string, number>;
  extraUsage: Record<string, number>;
  categoryUsage: Record<string, number>;
}

type Editing =
  | { kind: 'service'; row?: ServiceRow }
  | { kind: 'extra'; row?: ExtraRow }
  | { kind: 'rule'; row?: PriceRuleRow }
  | { kind: 'category'; row?: CategoryRow }
  | { kind: 'tax'; row?: TaxRateRow }
  | { kind: 'coupon'; row?: CouponRow }
  | null;

interface Deleting {
  title: string;
  description: string;
  endpoint: string;
}

export function CatalogWorkspace({
  data,
  canWrite,
  canWriteTaxRates,
  canWriteCoupons,
}: {
  data: CatalogData;
  canWrite: boolean;
  canWriteTaxRates: boolean;
  canWriteCoupons: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<Editing>(null);
  const [deleting, setDeleting] = React.useState<Deleting | null>(null);
  const [reordering, setReordering] = React.useState(false);

  const serviceNames = React.useMemo(
    () => data.services.map((service) => ({ id: service.id, name: service.name })),
    [data.services],
  );
  const categoryNames = React.useMemo(
    () => data.categories.map((category) => ({ id: category.id, name: category.name })),
    [data.categories],
  );

  /**
   * Einen Eintrag um eine Stelle verschieben.
   *
   * Gesendet wird die vollständige neue Reihenfolge, nicht die neue Position
   * des einen Eintrags: nur so kann kein Zustand entstehen, in dem zwei
   * Zeilen dieselbe Position tragen.
   */
  const move = async (
    entity: 'service' | 'extra' | 'category',
    ids: string[],
    index: number,
    delta: number,
  ) => {
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    const next = [...ids];
    [next[index], next[target]] = [next[target], next[index]];

    setReordering(true);
    try {
      await api.post('/api/catalog/reorder', { entity, ids: next });
      router.refresh();
    } catch (error) {
      toast.error(describeError(error, 'Die Reihenfolge konnte nicht gespeichert werden.'));
    } finally {
      setReordering(false);
    }
  };

  const serviceIds = data.services.map((service) => service.id);
  const extraIds = data.extras.map((extra) => extra.id);
  const categoryIds = data.categories.map((category) => category.id);

  return (
    <>
      <Tabs defaultValue="services">
        <div className="overflow-x-auto">
          <TabsList variant="underline">
            <TabsTriggerUnderline value="services">
              Leistungen
              <Count value={data.services.length} />
            </TabsTriggerUnderline>
            <TabsTriggerUnderline value="extras">
              Zusätze
              <Count value={data.extras.length} />
            </TabsTriggerUnderline>
            <TabsTriggerUnderline value="rules">
              Preisregeln
              <Count value={data.rules.length} />
            </TabsTriggerUnderline>
            <TabsTriggerUnderline value="categories">
              Kategorien
              <Count value={data.categories.length} />
            </TabsTriggerUnderline>
            <TabsTriggerUnderline value="tax">
              Steuersätze
              <Count value={data.taxRates.length} />
            </TabsTriggerUnderline>
            <TabsTriggerUnderline value="coupons">
              Gutscheine
              <Count value={data.coupons.length} />
            </TabsTriggerUnderline>
          </TabsList>
        </div>

        {/* --- Leistungen ------------------------------------------------- */}
        <TabsContent value="services" className="space-y-4">
          <ListCard
            title={`Leistungen (${data.services.length})`}
            action={
              canWrite ? (
                <Button size="sm" onClick={() => setEditing({ kind: 'service' })}>
                  <Plus aria-hidden />
                  Leistung
                </Button>
              ) : null
            }
          >
            {data.services.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title="Noch keine Leistungen"
                  description="Ohne Leistung zeigt die Website keine Angebote und der Buchungsassistent bleibt leer."
                />
              </div>
            ) : (
              <TableScroll minWidth="52rem">
                <table className="data-table data-table--sticky">
                  <caption className="sr-only">Leistungskatalog mit Preislogik</caption>
                  <thead>
                    <tr>
                      <th scope="col">Leistung</th>
                      <th scope="col">Modell</th>
                      <th scope="col" className="text-right">
                        Grundpreis
                      </th>
                      <th scope="col" className="text-right">
                        Ansatz
                      </th>
                      <th scope="col" className="text-right">
                        Minimum
                      </th>
                      <th scope="col" className="text-right">
                        Dauer
                      </th>
                      <th scope="col">Status</th>
                      {canWrite ? (
                        <th scope="col" className="text-right">
                          <span className="sr-only">Aktionen</span>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {data.services.map((service, index) => (
                      <tr key={service.id}>
                        <td className="cell-wide">
                          <span className="font-medium">{service.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {SERVICE_KIND_LABELS[service.kind] ?? service.kind}
                            {' · '}
                            {categoryNames.find((c) => c.id === service.categoryId)?.name ??
                              'ohne Kategorie'}
                            {service.featured ? ' · hervorgehoben' : ''}
                          </span>
                        </td>
                        <td className="text-muted-foreground">
                          {PRICING_LABELS[service.pricingModel] ?? service.pricingModel}
                        </td>
                        <td className="num">{formatCurrency(service.basePrice)}</td>
                        <td className="num text-muted-foreground">
                          {service.pricingModel === 'PER_SQM' && service.pricePerSqm
                            ? `${formatCurrency(service.pricePerSqm)}/m²`
                            : service.hourlyRate
                              ? `${formatCurrency(service.hourlyRate)}/Std.`
                              : '—'}
                        </td>
                        <td className="num text-muted-foreground">
                          {service.minPrice > 0 ? formatCurrency(service.minPrice) : '—'}
                        </td>
                        <td className="num text-muted-foreground">
                          {formatDuration(service.defaultDurationMin)}
                          <span className="block text-xs">
                            {formatNumber(service.minutesPerSqm, 'de', 1)} Min./m²
                          </span>
                        </td>
                        <td>
                          <ActiveBadge active={service.active} />
                        </td>
                        {canWrite ? (
                          <td>
                            <RowActions
                              label={service.name}
                              onEdit={() => setEditing({ kind: 'service', row: service })}
                              onMoveUp={
                                index > 0 && !reordering
                                  ? () => move('service', serviceIds, index, -1)
                                  : undefined
                              }
                              onMoveDown={
                                index < serviceIds.length - 1 && !reordering
                                  ? () => move('service', serviceIds, index, 1)
                                  : undefined
                              }
                              onDelete={() =>
                                setDeleting({
                                  title: service.name,
                                  description:
                                    (data.serviceUsage[service.id] ?? 0) > 0
                                      ? `Diese Leistung ist in ${data.serviceUsage[service.id]} Vorgängen verwendet. Der Server wird das Löschen ablehnen — setzen Sie sie stattdessen auf inaktiv.`
                                      : 'Die Leistung verschwindet von der Website. Sie ist in keinem Vorgang verwendet, es geht also nichts verloren.',
                                  endpoint: `/api/services/${service.id}`,
                                })
                              }
                            />
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </ListCard>
        </TabsContent>

        {/* --- Zusatzleistungen -------------------------------------------- */}
        <TabsContent value="extras" className="space-y-4">
          <ListCard
            title={`Zusatzleistungen (${data.extras.length})`}
            action={
              canWrite ? (
                <Button size="sm" onClick={() => setEditing({ kind: 'extra' })}>
                  <Plus aria-hidden />
                  Zusatz
                </Button>
              ) : null
            }
          >
            {data.extras.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title="Noch keine Zusatzleistungen"
                  description="Zusätze wie Backofen- oder Kühlschrankreinigung erhöhen den Auftragswert, ohne den Grundpreis zu belasten."
                />
              </div>
            ) : (
              <TableScroll minWidth="46rem">
                <table className="data-table data-table--sticky">
                  <caption className="sr-only">Buchbare Zusatzleistungen</caption>
                  <thead>
                    <tr>
                      <th scope="col">Zusatz</th>
                      <th scope="col">Angeboten bei</th>
                      <th scope="col" className="text-right">
                        Preis
                      </th>
                      <th scope="col" className="text-right">
                        Zusatzdauer
                      </th>
                      <th scope="col">Status</th>
                      {canWrite ? (
                        <th scope="col" className="text-right">
                          <span className="sr-only">Aktionen</span>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {data.extras.map((extra, index) => (
                      <tr key={extra.id}>
                        <td className="cell-wide">
                          <span className="font-medium">{extra.name}</span>
                          {extra.description ? (
                            <span className="block text-xs text-muted-foreground">
                              {extra.description}
                            </span>
                          ) : null}
                        </td>
                        <td className="text-muted-foreground">
                          {extra.serviceIds.length === 0
                            ? 'allen Leistungen'
                            : extra.serviceIds
                                .map((id) => serviceNames.find((s) => s.id === id)?.name)
                                .filter(Boolean)
                                .join(', ')}
                        </td>
                        <td className="num">{formatCurrency(extra.price)}</td>
                        <td className="num text-muted-foreground">
                          {extra.durationMin > 0 ? formatDuration(extra.durationMin) : '—'}
                        </td>
                        <td>
                          <ActiveBadge active={extra.active} />
                        </td>
                        {canWrite ? (
                          <td>
                            <RowActions
                              label={extra.name}
                              onEdit={() => setEditing({ kind: 'extra', row: extra })}
                              onMoveUp={
                                index > 0 && !reordering
                                  ? () => move('extra', extraIds, index, -1)
                                  : undefined
                              }
                              onMoveDown={
                                index < extraIds.length - 1 && !reordering
                                  ? () => move('extra', extraIds, index, 1)
                                  : undefined
                              }
                              onDelete={() =>
                                setDeleting({
                                  title: extra.name,
                                  description:
                                    (data.extraUsage[extra.id] ?? 0) > 0
                                      ? `Dieser Zusatz ist in ${data.extraUsage[extra.id]} Buchungen enthalten. Der Server wird das Löschen ablehnen — setzen Sie ihn stattdessen auf inaktiv.`
                                      : 'Der Zusatz verschwindet aus dem Buchungsassistenten.',
                                  endpoint: `/api/service-extras/${extra.id}`,
                                })
                              }
                            />
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </ListCard>
        </TabsContent>

        {/* --- Preisregeln -------------------------------------------------- */}
        <TabsContent value="rules" className="space-y-4">
          <Alert variant="info">
            Reihenfolge der Berechnung: Grundpreis → Zusatzleistungen → Anfahrt →{' '}
            <strong>Preisregeln</strong> → Abo-Rabatt → Gutschein → Mindestbetrag → MWST. Regeln
            wirken auf die Summe aus Grundpreis und Zusätzen.
          </Alert>

          <ListCard
            title={`Preisregeln (${data.rules.length})`}
            action={
              canWrite ? (
                <Button size="sm" onClick={() => setEditing({ kind: 'rule' })}>
                  <Plus aria-hidden />
                  Regel
                </Button>
              ) : null
            }
          >
            {data.rules.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title="Keine Preisregeln"
                  description="Ohne Regeln gilt überall derselbe Ansatz — auch am Sonntagabend und bei Express-Terminen."
                />
              </div>
            ) : (
              <TableScroll minWidth="46rem">
                <table className="data-table data-table--sticky">
                  <caption className="sr-only">Zuschläge und Abschläge</caption>
                  <thead>
                    <tr>
                      <th scope="col">Regel</th>
                      <th scope="col">Gilt für</th>
                      <th scope="col">Bedingung</th>
                      <th scope="col" className="text-right">
                        Wirkung
                      </th>
                      <th scope="col">Status</th>
                      {canWrite ? (
                        <th scope="col" className="text-right">
                          <span className="sr-only">Aktionen</span>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rules.map((rule) => (
                      <tr key={rule.id}>
                        <td>
                          <span className="font-medium">{rule.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            Reihenfolge {rule.priority}
                          </span>
                        </td>
                        <td className="text-muted-foreground">
                          {serviceNames.find((s) => s.id === rule.serviceId)?.name ??
                            'alle Leistungen'}
                        </td>
                        <td className="cell-wide text-muted-foreground">
                          {describeCondition(rule.condition)}
                        </td>
                        <td className="num">{describeEffect(rule.multiplier, rule.surcharge)}</td>
                        <td>
                          <ActiveBadge active={rule.active} />
                        </td>
                        {canWrite ? (
                          <td>
                            <RowActions
                              label={rule.name}
                              onEdit={() => setEditing({ kind: 'rule', row: rule })}
                              onDelete={() =>
                                setDeleting({
                                  title: rule.name,
                                  description:
                                    'Die Regel wirkt ab sofort nicht mehr. Bestehende Belege behalten den bereits verrechneten Zuschlag als eigene Position.',
                                  endpoint: `/api/price-rules/${rule.id}`,
                                })
                              }
                            />
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </ListCard>
        </TabsContent>

        {/* --- Kategorien --------------------------------------------------- */}
        <TabsContent value="categories" className="space-y-4">
          <ListCard
            title={`Kategorien (${data.categories.length})`}
            action={
              canWrite ? (
                <Button size="sm" onClick={() => setEditing({ kind: 'category' })}>
                  <Plus aria-hidden />
                  Kategorie
                </Button>
              ) : null
            }
          >
            {data.categories.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title="Keine Kategorien"
                  description="Ohne Kategorien stehen alle Leistungen in einer einzigen Liste."
                />
              </div>
            ) : (
              <TableScroll minWidth="36rem">
                <table className="data-table">
                  <caption className="sr-only">Kategorien des Leistungskatalogs</caption>
                  <thead>
                    <tr>
                      <th scope="col">Kategorie</th>
                      <th scope="col">Beschreibung</th>
                      <th scope="col" className="text-right">
                        Leistungen
                      </th>
                      <th scope="col">Status</th>
                      {canWrite ? (
                        <th scope="col" className="text-right">
                          <span className="sr-only">Aktionen</span>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {data.categories.map((category, index) => (
                      <tr key={category.id}>
                        <td>
                          <span className="font-medium">{category.name}</span>
                          <span className="block font-mono text-xs text-muted-foreground">
                            {category.slug}
                          </span>
                        </td>
                        <td className="cell-wide text-muted-foreground">
                          {category.description ?? '—'}
                        </td>
                        <td className="num text-muted-foreground">
                          {data.categoryUsage[category.id] ?? 0}
                        </td>
                        <td>
                          <ActiveBadge active={category.active} />
                        </td>
                        {canWrite ? (
                          <td>
                            <RowActions
                              label={category.name}
                              onEdit={() => setEditing({ kind: 'category', row: category })}
                              onMoveUp={
                                index > 0 && !reordering
                                  ? () => move('category', categoryIds, index, -1)
                                  : undefined
                              }
                              onMoveDown={
                                index < categoryIds.length - 1 && !reordering
                                  ? () => move('category', categoryIds, index, 1)
                                  : undefined
                              }
                              onDelete={() =>
                                setDeleting({
                                  title: category.name,
                                  description:
                                    (data.categoryUsage[category.id] ?? 0) > 0
                                      ? `${data.categoryUsage[category.id]} Leistungen stehen danach ohne Kategorie da. Sie bleiben bestehen und sichtbar.`
                                      : 'Die Kategorie ist leer und kann folgenlos entfernt werden.',
                                  endpoint: `/api/service-categories/${category.id}`,
                                })
                              }
                            />
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </ListCard>
        </TabsContent>

        {/* --- Steuersätze -------------------------------------------------- */}
        <TabsContent value="tax" className="space-y-4">
          <ListCard
            title={`Mehrwertsteuersätze (${data.taxRates.length})`}
            action={
              canWriteTaxRates ? (
                <Button size="sm" onClick={() => setEditing({ kind: 'tax' })}>
                  <Plus aria-hidden />
                  Satz
                </Button>
              ) : null
            }
            footer={
              <p className="text-meta leading-relaxed text-muted-foreground">
                Der Satz einer Leistung wird auf ihr selbst gepflegt; diese Liste ist die Auswahl,
                aus der Rechnungspositionen schöpfen. Seit dem 1. Januar 2024 gilt der Normalsatz
                von 8.1 %.
              </p>
            }
          >
            <TableScroll minWidth="30rem">
              <table className="data-table">
                <caption className="sr-only">Mehrwertsteuersätze</caption>
                <thead>
                  <tr>
                    <th scope="col">Bezeichnung</th>
                    <th scope="col" className="text-right">
                      Satz
                    </th>
                    <th scope="col">Status</th>
                    {canWriteTaxRates ? (
                      <th scope="col" className="text-right">
                        <span className="sr-only">Aktionen</span>
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {data.taxRates.map((rate) => (
                    <tr key={rate.id}>
                      <td>
                        <span className="font-medium">{rate.name}</span>
                        {rate.isDefault ? (
                          <Badge variant="info" size="sm" className="ml-2">
                            Standard
                          </Badge>
                        ) : null}
                      </td>
                      <td className="num">{formatNumber(rate.rate, 'de', 1)} %</td>
                      <td>
                        <ActiveBadge active={rate.active} />
                      </td>
                      {canWriteTaxRates ? (
                        <td>
                          <RowActions
                            label={rate.name}
                            onEdit={() => setEditing({ kind: 'tax', row: rate })}
                            onDelete={
                              rate.isDefault
                                ? undefined
                                : () =>
                                    setDeleting({
                                      title: rate.name,
                                      description:
                                        'Bestehende Rechnungen behalten ihren Satz — er steht als eigene Spalte auf jeder Position.',
                                      endpoint: `/api/tax-rates/${rate.id}`,
                                    })
                            }
                          />
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </ListCard>
        </TabsContent>

        {/* --- Gutscheine --------------------------------------------------- */}
        <TabsContent value="coupons" className="space-y-4">
          <ListCard
            title={`Gutscheine (${data.coupons.length})`}
            action={
              canWriteCoupons ? (
                <Button size="sm" onClick={() => setEditing({ kind: 'coupon' })}>
                  <Plus aria-hidden />
                  Gutschein
                </Button>
              ) : null
            }
          >
            {data.coupons.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title="Keine Gutscheine"
                  description="Ein Code für Erstaufträge ist die günstigste Art, eine Flyer-Aktion messbar zu machen."
                />
              </div>
            ) : (
              <TableScroll minWidth="46rem">
                <table className="data-table data-table--sticky">
                  <caption className="sr-only">Gutscheincodes</caption>
                  <thead>
                    <tr>
                      <th scope="col">Code</th>
                      <th scope="col" className="text-right">
                        Rabatt
                      </th>
                      <th scope="col">Gültigkeit</th>
                      <th scope="col" className="text-right">
                        Eingelöst
                      </th>
                      <th scope="col">Status</th>
                      {canWriteCoupons ? (
                        <th scope="col" className="text-right">
                          <span className="sr-only">Aktionen</span>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {data.coupons.map((coupon) => (
                      <tr key={coupon.id}>
                        <td>
                          <span className="font-mono font-medium">{coupon.code}</span>
                          {coupon.description ? (
                            <span className="block text-xs text-muted-foreground">
                              {coupon.description}
                            </span>
                          ) : null}
                        </td>
                        <td className="num">
                          {coupon.discountType === 'PERCENT'
                            ? `${formatNumber(coupon.discountValue, 'de', 1)} %`
                            : formatCurrency(coupon.discountValue)}
                          {coupon.minOrderValue > 0 ? (
                            <span className="block text-xs text-muted-foreground">
                              ab {formatCurrency(coupon.minOrderValue)}
                            </span>
                          ) : null}
                        </td>
                        <td className="whitespace-nowrap text-muted-foreground">
                          {formatDate(coupon.validFrom)}
                          {coupon.validUntil ? ` – ${formatDate(coupon.validUntil)}` : ' – offen'}
                        </td>
                        <td className="num text-muted-foreground">
                          {coupon.usageCount}
                          {coupon.usageLimit ? ` / ${coupon.usageLimit}` : ''}
                        </td>
                        <td>
                          <CouponStatusBadge status={coupon.status} />
                        </td>
                        {canWriteCoupons ? (
                          <td>
                            <RowActions
                              label={`Gutschein ${coupon.code}`}
                              onEdit={() => setEditing({ kind: 'coupon', row: coupon })}
                              onDelete={() =>
                                setDeleting({
                                  title: `Gutschein ${coupon.code}`,
                                  description:
                                    coupon.usageCount > 0
                                      ? `Der Code wurde ${coupon.usageCount}× eingelöst und bleibt als Beleg erhalten. Der Server wird das Löschen ablehnen — setzen Sie ihn auf „pausiert".`
                                      : 'Der Code wurde nie eingelöst und kann folgenlos entfernt werden.',
                                  endpoint: `/api/coupons/${coupon.id}`,
                                })
                              }
                            />
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </ListCard>
        </TabsContent>
      </Tabs>

      {/* --- Formulare ------------------------------------------------------ */}
      <ServiceForm
        open={editing?.kind === 'service'}
        onOpenChange={(open) => !open && setEditing(null)}
        service={editing?.kind === 'service' ? editing.row : undefined}
        categories={categoryNames}
      />
      <ExtraForm
        open={editing?.kind === 'extra'}
        onOpenChange={(open) => !open && setEditing(null)}
        extra={editing?.kind === 'extra' ? editing.row : undefined}
        services={serviceNames}
      />
      <PriceRuleForm
        open={editing?.kind === 'rule'}
        onOpenChange={(open) => !open && setEditing(null)}
        rule={editing?.kind === 'rule' ? editing.row : undefined}
        services={serviceNames}
      />
      <CategoryForm
        open={editing?.kind === 'category'}
        onOpenChange={(open) => !open && setEditing(null)}
        category={editing?.kind === 'category' ? editing.row : undefined}
      />
      <TaxRateForm
        open={editing?.kind === 'tax'}
        onOpenChange={(open) => !open && setEditing(null)}
        taxRate={editing?.kind === 'tax' ? editing.row : undefined}
      />
      <CouponForm
        open={editing?.kind === 'coupon'}
        onOpenChange={(open) => !open && setEditing(null)}
        coupon={editing?.kind === 'coupon' ? editing.row : undefined}
      />

      <DeleteDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={deleting?.title ?? ''}
        description={deleting?.description ?? ''}
        endpoint={deleting?.endpoint ?? ''}
      />
    </>
  );
}

function Count({ value }: { value: number }) {
  return <span className="text-xs tabular-nums text-muted-foreground">{value}</span>;
}

function CouponStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: 'success' | 'neutral' | 'warning' }> = {
    ACTIVE: { label: 'Aktiv', variant: 'success' },
    PAUSED: { label: 'Pausiert', variant: 'warning' },
    EXPIRED: { label: 'Abgelaufen', variant: 'neutral' },
    DEPLETED: { label: 'Aufgebraucht', variant: 'neutral' },
  };
  const entry = map[status] ?? { label: status, variant: 'neutral' as const };
  return (
    <Badge variant={entry.variant} size="sm">
      {entry.label}
    </Badge>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('de-CH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Zurich',
  });
}

/**
 * Die Bedingung einer Regel in Worten.
 *
 * Die gespeicherte Form ist JSON, weil die Engine damit rechnet. In der
 * Tabelle wäre sie unlesbar — und unlesbar heisst hier: niemand bemerkt, dass
 * eine Regel bei jedem Auftrag greift, weil ihre Bedingung leer ist.
 */
function describeCondition(condition: Record<string, unknown>): string {
  const parts: string[] = [];
  const c = condition as {
    weekday?: number[];
    hourFrom?: number;
    hourTo?: number;
    minSqm?: number;
    maxSqm?: number;
    frequency?: string[];
    propertyKind?: string[];
    hasPets?: boolean;
    urgent?: boolean;
    postalCode?: string[];
  };

  if (c.weekday?.length) parts.push(c.weekday.map((d) => WEEKDAY_LABELS[d]).join(', '));
  if (c.hourFrom !== undefined || c.hourTo !== undefined) {
    parts.push(`${c.hourFrom ?? 0}–${c.hourTo ?? 23} Uhr`);
  }
  if (c.minSqm !== undefined || c.maxSqm !== undefined) {
    parts.push(`${c.minSqm ?? 0}–${c.maxSqm ?? '∞'} m²`);
  }
  if (c.frequency?.length) {
    parts.push(c.frequency.map((f) => FREQUENCY_LABELS[f] ?? f).join('/'));
  }
  if (c.propertyKind?.length) {
    parts.push(c.propertyKind.map((p) => PROPERTY_KIND_LABELS[p] ?? p).join('/'));
  }
  if (c.hasPets !== undefined) parts.push(c.hasPets ? 'mit Haustieren' : 'ohne Haustiere');
  if (c.urgent !== undefined) parts.push(c.urgent ? 'Express' : 'kein Express');
  if (c.postalCode?.length) parts.push(`PLZ ${c.postalCode.join(', ')}`);

  return parts.length ? parts.join(' · ') : 'jeder Auftrag';
}

function describeEffect(multiplier: number, surcharge: number): string {
  const parts: string[] = [];
  if (multiplier > 1) parts.push(`+${formatNumber((multiplier - 1) * 100, 'de', 1)} %`);
  if (multiplier < 1) parts.push(`−${formatNumber((1 - multiplier) * 100, 'de', 1)} %`);
  if (surcharge > 0) parts.push(`+${formatCurrency(surcharge)}`);
  if (surcharge < 0) parts.push(`−${formatCurrency(Math.abs(surcharge))}`);
  return parts.length ? parts.join(' ') : '—';
}
