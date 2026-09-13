import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { toNumber } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { formatCurrency, formatDate } from '@/lib/utils';
import { DEPRECIATION_METHOD_LABELS, EXPENSE_CATEGORY_LABELS, INVESTMENT_STATUS_LABELS } from '@/lib/bi/labels';
import { getOrganizationId } from '@/server/services/organization.service';
import { getDepreciationPlan, getInvestment } from '@/server/services/investment.service';
import { listStaffOptions, listSupplierOptions } from '@/server/services/fuehrung-options.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KpiTile } from '@/components/app/kpi-tile';
import { DetailRow, DetailSection, ListCard, PageHeader, TableScroll } from '@/components/app/page-parts';
import { ActionButton } from '@/features/fuehrung/action-button';
import { FormDialog } from '@/features/fuehrung/resource-form';
import { investmentFields } from '@/features/fuehrung/field-specs';

export const metadata: Metadata = {
  title: 'Investition',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function InvestmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('investment:read');
  const { id } = await params;
  const organizationId = await getOrganizationId();
  const investment = await getInvestment(organizationId, id).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const [suppliers, staff] = await Promise.all([listSupplierOptions(organizationId), listStaffOptions(organizationId)]);
  const schedule = getDepreciationPlan(investment);
  const v = investment.valuation;
  const purchase = toNumber(investment.purchaseAmount);

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/fuehrung/investitionen">
          <ArrowLeft aria-hidden />
          Alle Investitionen
        </Link>
      </Button>

      <PageHeader
        title={investment.name}
        description={`${EXPENSE_CATEGORY_LABELS[investment.category]}${investment.assetTag ? ` · ${investment.assetTag}` : ''}${investment.location ? ` · ${investment.location}` : ''}`}
        actions={
          <>
            <Badge variant={investment.status === 'ACTIVE' ? 'success' : 'neutral'}>{INVESTMENT_STATUS_LABELS[investment.status]}</Badge>
            {can(session.role, 'investment:update') ? (
              <FormDialog
                title="Investition bearbeiten"
                triggerLabel="Bearbeiten"
                triggerVariant="outline"
                plainTrigger
                endpoint={`/api/bi/investments/${id}`}
                method="PATCH"
                successMessage="Investition gespeichert."
                fields={investmentFields({ suppliers, staff, editing: true })}
                values={{
                  name: investment.name,
                  category: investment.category,
                  status: investment.status,
                  purchaseAmount: purchase,
                  expectedAnnualBenefit: investment.expectedAnnualBenefit === null ? null : toNumber(investment.expectedAnnualBenefit),
                  method: investment.method,
                  usefulLifeYears: investment.usefulLifeYears,
                  residualValue: toNumber(investment.residualValue),
                  assetTag: investment.assetTag,
                  plannedOn: investment.plannedOn,
                  purchasedOn: investment.purchasedOn,
                  commissionedOn: investment.commissionedOn,
                  disposedOn: investment.disposedOn,
                  location: investment.location,
                  supplierId: investment.supplierId,
                  ownerId: investment.ownerId,
                  description: investment.description,
                }}
              />
            ) : null}
            {can(session.role, 'investment:delete') ? <ActionButton endpoint={`/api/bi/investments/${id}`} method="DELETE" label="Löschen" confirm="Die Investition wandert in den Papierkorb." variant="ghost" redirectTo="/admin/fuehrung/investitionen" /> : null}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Anschaffungswert" value={formatCurrency(purchase)} />
        <KpiTile label="Restwert heute" value={v ? formatCurrency(v.bookValue) : '—'} hint={v ? `${v.monthsInService} Monate in Betrieb` : 'Noch nicht in Betrieb'} />
        <KpiTile label="Abschreibung je Jahr" value={v ? formatCurrency(v.annualCharge) : '—'} hint={v?.rate ? `Satz ${Math.round(v.rate * 1000) / 10} %` : DEPRECIATION_METHOD_LABELS[investment.method]} />
        <KpiTile label="Amortisation" value={v?.paybackYears ? `${v.paybackYears} Jahre` : '—'} hint={v?.roiPct ? `ROI ${v.roiPct} % je Jahr (Schätzung)` : 'Ohne erwarteten Nutzen'} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <ListCard title="Abschreibungsplan">
          {schedule.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">{`Keine Abschreibung — Methode „${DEPRECIATION_METHOD_LABELS[investment.method]}" oder Nutzungsdauer fehlt.`}</p>
          ) : (
            <TableScroll minWidth="28rem">
              <table className="data-table">
                <caption className="sr-only">Restwert je Nutzungsjahr</caption>
                <thead>
                  <tr>
                    <th scope="col">Jahr</th>
                    <th scope="col" className="text-right">Abschreibung</th>
                    <th scope="col" className="text-right">Restwert</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.map((row) => (
                    <tr key={row.year}>
                      <td>{row.year}</td>
                      <td className="num">{formatCurrency(row.charge)}</td>
                      <td className="num font-medium">{formatCurrency(row.bookValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </ListCard>

        <DetailSection title="Eckdaten" body="list">
          <dl className="protocol-list protocol-list--tight">
            <DetailRow label="Methode">{DEPRECIATION_METHOD_LABELS[investment.method]}{investment.usefulLifeYears ? ` · ${investment.usefulLifeYears} Jahre` : ''}</DetailRow>
            <DetailRow label="Restwert am Ende">{formatCurrency(toNumber(investment.residualValue))}</DetailRow>
            <DetailRow label="Geplant">{investment.plannedOn ? formatDate(investment.plannedOn) : '—'}</DetailRow>
            <DetailRow label="Gekauft">{investment.purchasedOn ? formatDate(investment.purchasedOn) : '—'}</DetailRow>
            <DetailRow label="In Betrieb seit">{investment.commissionedOn ? formatDate(investment.commissionedOn) : '—'}</DetailRow>
            {investment.disposedOn ? <DetailRow label="Ausgebucht">{formatDate(investment.disposedOn)}{investment.disposalProceeds ? ` · Erlös ${formatCurrency(toNumber(investment.disposalProceeds))}` : ''}</DetailRow> : null}
            <DetailRow label="Lieferant">{investment.supplier?.name ?? '—'}</DetailRow>
            <DetailRow label="Verantwortlich">{investment.owner ? `${investment.owner.firstName} ${investment.owner.lastName}` : '—'}</DetailRow>
            {investment.description ? <DetailRow label="Beschreibung">{investment.description}</DetailRow> : null}
          </dl>
        </DetailSection>
      </div>
    </div>
  );
}
