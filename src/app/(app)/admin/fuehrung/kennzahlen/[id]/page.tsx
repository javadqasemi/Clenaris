import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatDate } from '@/lib/utils';
import { formatKpiValue, KPI_DIRECTIONS_LABELS, KPI_PERIOD_LABELS, KPI_SOURCE_LABELS, KPI_UNIT_LABELS, optionsOf } from '@/lib/bi/labels';
import type { PeriodName } from '@/lib/bi/periods';
import { getOrganizationId } from '@/server/services/organization.service';
import { getKpiSeries } from '@/server/services/kpi.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KpiTile } from '@/components/app/kpi-tile';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { KpiSeriesChart } from '@/components/charts/lazy';
import { FormDialog } from '@/features/fuehrung/resource-form';

export const metadata: Metadata = {
  title: 'Kennzahl',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function KpiDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ periode?: string }> }) {
  const session = await requirePermission('kpi:read');
  const { id } = await params;
  const query = await searchParams;
  const organizationId = await getOrganizationId();

  const definition = await prisma.kpiDefinition.findFirst({
    where: { id, organizationId },
    include: { targets: { orderBy: { periodStart: 'desc' }, take: 12 } },
  });
  if (!definition) notFound();

  const period = (['MONTH', 'QUARTER', 'YEAR', 'WEEK', 'DAY'].includes(query.periode ?? '') ? query.periode : definition.periods[0] ?? 'MONTH') as PeriodName;
  const series = await getKpiSeries(organizationId, id, { period, limit: 24 });
  const current = series.at(-1);
  const previous = series.at(-2);
  const canManage = can(session.role, 'kpi:manage');
  const target = definition.targetValue === null ? null : toNumber(definition.targetValue);
  const warn = definition.warnValue === null ? null : toNumber(definition.warnValue);

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/fuehrung/kennzahlen">
          <ArrowLeft aria-hidden />
          Alle Kennzahlen
        </Link>
      </Button>

      <PageHeader
        title={definition.label}
        description={definition.description ?? `${definition.key} · ${KPI_SOURCE_LABELS[definition.source]} · ${definition.group}`}
        actions={
          <>
            <div className="inline-flex items-center gap-0.5 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Periode">
              {definition.periods.map((p) => (
                <Link key={p} href={`/admin/fuehrung/kennzahlen/${id}?periode=${p}`} role="radio" aria-checked={period === p} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${period === p ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground hover:text-foreground'}`}>
                  {KPI_PERIOD_LABELS[p]}
                </Link>
              ))}
            </div>
            {canManage ? (
              <FormDialog
                title="Kennzahl bearbeiten"
                triggerLabel="Bearbeiten"
                triggerVariant="outline"
                plainTrigger
                endpoint={`/api/bi/kpis/${id}`}
                method="PATCH"
                successMessage="Kennzahl gespeichert."
                fields={[
                  { name: 'label', label: 'Bezeichnung', required: true, half: true },
                  { name: 'group', label: 'Gruppe', required: true, half: true },
                  { name: 'unit', label: 'Einheit', type: 'select', required: true, half: true, options: optionsOf(KPI_UNIT_LABELS) },
                  { name: 'direction', label: 'Richtung', type: 'select', required: true, half: true, options: optionsOf(KPI_DIRECTIONS_LABELS) },
                  { name: 'targetValue', label: 'Zielwert', type: 'number', half: true, nullable: true },
                  { name: 'warnValue', label: 'Warnschwelle', type: 'number', half: true, nullable: true, hint: 'Bei „mehr ist besser" unter dem Ziel, sonst darüber.' },
                  { name: 'healthWeight', label: 'Gewicht im Gesundheitswert', type: 'number', half: true, min: 0, max: 100 },
                  { name: 'active', label: 'Aktiv', type: 'checkbox', half: true },
                  { name: 'description', label: 'Beschreibung', type: 'textarea', rows: 2, nullable: true },
                ]}
                values={{ label: definition.label, group: definition.group, unit: definition.unit, direction: definition.direction, targetValue: target, warnValue: warn, healthWeight: definition.healthWeight, active: definition.active, description: definition.description }}
              />
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label={`Aktuell (${current?.label ?? '—'})`} value={formatKpiValue(current?.value ?? null, definition.unit)} hint={current?.provisional ? 'vorläufig' : undefined} changePercent={current && previous && previous.value !== 0 ? Math.round(((current.value - previous.value) / Math.abs(previous.value)) * 1000) / 10 : undefined} invertTrend={definition.direction === 'DOWN_IS_GOOD'} />
        <KpiTile label="Vorjahr" value={formatKpiValue(current?.previousYearValue ?? null, definition.unit)} />
        <KpiTile label="Zielwert" value={formatKpiValue(current?.targetValue ?? target, definition.unit)} hint={warn !== null ? `Warnschwelle ${formatKpiValue(warn, definition.unit)}` : 'Keine Warnschwelle'} />
        <KpiTile label="Fallzahl" value={current?.sampleSize === null || current?.sampleSize === undefined ? '—' : String(current.sampleSize)} hint="Datensätze hinter dem Wert" />
      </div>

      <KpiSeriesChart title={`Verlauf je ${KPI_PERIOD_LABELS[period]}`} unit={definition.unit} data={series} />

      <div className="grid gap-6 lg:grid-cols-2">
        <DetailSection
          title="Zielwerte je Periode"
          description="Ausnahmen vom Dauerwert — etwa ein höheres Ziel im Saisonquartal."
          body="list"
          action={
            canManage ? (
              <FormDialog
                title="Zielwert für eine Periode"
                triggerLabel="Zielwert"
                triggerVariant="outline"
                triggerSize="sm"
                endpoint={`/api/bi/kpis/${id}/targets`}
                successMessage="Zielwert gesetzt."
                fields={[
                  { name: 'period', label: 'Periodenart', type: 'select', required: true, half: true, options: definition.periods.map((p) => ({ value: p, label: KPI_PERIOD_LABELS[p] })) },
                  { name: 'periodStart', label: 'Periodenbeginn', type: 'date', required: true, half: true },
                  { name: 'targetValue', label: 'Zielwert', type: 'number', required: true, half: true },
                  { name: 'note', label: 'Notiz', half: true },
                ]}
                values={{ period: definition.periods[0] }}
              />
            ) : null
          }
        >
          <dl>
            {definition.targets.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">Keine periodenbezogenen Zielwerte.</p> : null}
            {definition.targets.map((t) => (
              <DetailRow key={t.id} label={`${KPI_PERIOD_LABELS[t.period]} ab ${formatDate(t.periodStart)}`}>
                {formatKpiValue(toNumber(t.targetValue), definition.unit)}
                {t.note ? <span className="ml-2 text-muted-foreground">{t.note}</span> : null}
              </DetailRow>
            ))}
          </dl>
        </DetailSection>

        <DetailSection
          title={definition.source === 'MANUAL' ? 'Wert erfassen' : 'Herleitung'}
          description={definition.source === 'MANUAL' ? 'Manuell gepflegte Kennzahl — jeder Wert gilt als endgültig.' : 'Zähler, Nenner und Ausschlüsse des jüngsten Werts.'}
          body="list"
          action={
            canManage && definition.source === 'MANUAL' ? (
              <FormDialog
                title="Wert eintragen"
                triggerLabel="Wert"
                triggerVariant="outline"
                triggerSize="sm"
                endpoint={`/api/bi/kpis/${id}/value`}
                successMessage="Wert gespeichert."
                fields={[
                  { name: 'period', label: 'Periodenart', type: 'select', required: true, half: true, options: definition.periods.map((p) => ({ value: p, label: KPI_PERIOD_LABELS[p] })) },
                  { name: 'periodStart', label: 'Periodenbeginn', type: 'date', required: true, half: true },
                  { name: 'value', label: 'Wert', type: 'number', required: true, half: true, suffix: KPI_UNIT_LABELS[definition.unit] },
                  { name: 'note', label: 'Notiz', half: true },
                ]}
                values={{ period: definition.periods[0] }}
              />
            ) : null
          }
        >
          <dl>
            <DetailRow label="Herkunft">
              <Badge variant={definition.source === 'MANUAL' ? 'neutral' : 'info'} size="sm">{KPI_SOURCE_LABELS[definition.source]}</Badge>
            </DetailRow>
            <DetailRow label="Richtung">{KPI_DIRECTIONS_LABELS[definition.direction]}</DetailRow>
            <DetailRow label="Gewicht im Gesundheitswert">{definition.healthWeight}</DetailRow>
            {current ? <DetailRow label="Letzte Berechnung">{current.label}{current.provisional ? ' (vorläufig, wird beim Periodenwechsel festgeschrieben)' : ' (festgeschrieben)'}</DetailRow> : null}
          </dl>
        </DetailSection>
      </div>
    </div>
  );
}
