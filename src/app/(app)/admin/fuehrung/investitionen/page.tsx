import type { Metadata } from 'next';
import { Landmark } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { toNumber } from '@/lib/db';
import { formatCurrency, formatDate } from '@/lib/utils';
import { EXPENSE_CATEGORY_LABELS, INVESTMENT_STATUS_LABELS, optionsOf } from '@/lib/bi/labels';
import { getOrganizationId } from '@/server/services/organization.service';
import { getAssetRegister, listInvestments } from '@/server/services/investment.service';
import { listStaffOptions, listSupplierOptions } from '@/server/services/fuehrung-options.service';
import { Badge } from '@/components/ui/badge';
import { KpiTile } from '@/components/app/kpi-tile';
import { FilterBar } from '@/components/app/filter-bar';
import { EmptyState, PageHeader } from '@/components/app/page-parts';
import { DataCell, DataList, DataListHeader, DataRow } from '@/components/app/data-list';
import { FormDialog } from '@/features/fuehrung/resource-form';
import { investmentFields } from '@/features/fuehrung/field-specs';

export const metadata: Metadata = {
  title: 'Investitionen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const COLUMNS = 'minmax(0,1fr) 8rem 8rem 8rem 8rem';
const STATUS_VARIANT: Record<string, 'neutral' | 'default' | 'info' | 'success' | 'outline' | 'destructive'> = { PLANNED: 'neutral', APPROVED: 'default', ORDERED: 'info', ACTIVE: 'success', DISPOSED: 'outline', CANCELLED: 'destructive' };

export default async function InvestmentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requirePermission('investment:read');
  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const [items, register, suppliers, staff] = await Promise.all([
    listInvestments(organizationId, { status: params.status, category: params.kategorie, q: params.q }),
    getAssetRegister(organizationId),
    listSupplierOptions(organizationId),
    listStaffOptions(organizationId),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Investitionen"
        description="Geplante und getätigte Anschaffungen — zugleich das Anlagenverzeichnis mit Restwert. Die Abschreibung wird gerechnet, nicht gebucht."
        actions={
          can(session.role, 'investment:create') ? (
            <FormDialog title="Investition erfassen" triggerLabel="Investition" endpoint="/api/bi/investments" successMessage="Investition erfasst." redirectTo="/admin/fuehrung/investitionen/{id}" fields={investmentFields({ suppliers, staff })} values={{ category: 'EQUIPMENT', status: 'PLANNED', method: 'STRAIGHT_LINE', residualValue: 0, usefulLifeYears: 5 }} />
          ) : null
        }
      >
        <FilterBar
          searchPlaceholder="Bezeichnung, Inventarnummer, Standort …"
          filters={[
            { param: 'status', label: 'Status', options: optionsOf(INVESTMENT_STATUS_LABELS) },
            { param: 'kategorie', label: 'Kategorie', options: optionsOf(EXPENSE_CATEGORY_LABELS) },
          ]}
        />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Anschaffungswert in Betrieb" value={formatCurrency(register.totals.purchase)} />
        <KpiTile label="Restwert heute" value={formatCurrency(register.totals.bookValue)} />
        <KpiTile label="Kumulierte Abschreibung" value={formatCurrency(register.totals.accumulated)} />
        <KpiTile label="Abschreibung je Jahr" value={formatCurrency(register.totals.annualCharge)} hint="aktueller Jahresbetrag" />
      </div>

      {items.length === 0 ? (
        <EmptyState icon={<Landmark aria-hidden />} title="Keine Investitionen" description="Fahrzeuge, Maschinen, IT und Mobiliar — erfassen Sie sie mit Anschaffungswert und Nutzungsdauer, und das Anlagenverzeichnis entsteht von selbst." />
      ) : (
        <DataList label="Investitionen">
          <DataListHeader columns={COLUMNS}>
            <span>Anlage</span>
            <span>Status</span>
            <span className="text-right">Anschaffung</span>
            <span className="text-right">Restwert</span>
            <span className="text-right">ROI</span>
          </DataListHeader>
          {items.map((i) => (
            <DataRow key={i.id} columns={COLUMNS} href={`/admin/fuehrung/investitionen/${i.id}`}>
              <DataCell strong truncate>
                {i.name}
                <span className="block text-xs font-normal text-muted-foreground">
                  {EXPENSE_CATEGORY_LABELS[i.category]}
                  {i.assetTag ? ` · ${i.assetTag}` : ''}
                  {i.location ? ` · ${i.location}` : ''}
                  {i.commissionedOn ? ` · seit ${formatDate(i.commissionedOn)}` : ''}
                </span>
              </DataCell>
              <DataCell>
                <Badge size="sm" variant={STATUS_VARIANT[i.status]}>{INVESTMENT_STATUS_LABELS[i.status]}</Badge>
              </DataCell>
              <DataCell numeric>{formatCurrency(toNumber(i.purchaseAmount))}</DataCell>
              <DataCell numeric muted>{i.status === 'ACTIVE' && i.valuation ? formatCurrency(i.valuation.bookValue) : '—'}</DataCell>
              <DataCell numeric muted>{i.valuation?.roiPct !== null && i.valuation?.roiPct !== undefined ? `${i.valuation.roiPct} % / Jahr` : '—'}</DataCell>
            </DataRow>
          ))}
        </DataList>
      )}
    </div>
  );
}
