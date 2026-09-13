'use client';

import dynamic from 'next/dynamic';

import { Skeleton } from '@/components/ui/primitives';

/**
 * Diagramme, nachgeladen statt mitgeliefert.
 *
 * Recharts wiegt gepackt rund 100 kB. Auf der Übersicht und in den
 * Auswertungen ist das gerechtfertigt — aber erst, wenn die Seite steht.
 * Bis dahin steht ein Platzhalter in exakt der Höhe des Diagramms: so
 * springt beim Nachladen nichts.
 *
 * `ssr: false` ist Absicht. Ein serverseitig gerendertes SVG müsste im HTML
 * mitreisen und würde beim Hydrieren ohnehin verworfen; die Diagramme sind
 * ausserdem nie das, was jemand zuerst liest.
 */
function ChartSkeleton({ height = 300 }: { height?: number }) {
  return (
    <Skeleton
      className="w-full rounded-2xl"
      style={{ height }}
      aria-label="Diagramm wird geladen"
    />
  );
}

export const RevenueTrendChart = dynamic(
  () => import('./dashboard-charts').then((m) => m.RevenueTrendChart),
  { ssr: false, loading: () => <ChartSkeleton height={320} /> },
);

export const ServiceRevenueChart = dynamic(
  () => import('./dashboard-charts').then((m) => m.ServiceRevenueChart),
  { ssr: false, loading: () => <ChartSkeleton height={280} /> },
);

export const UtilizationChart = dynamic(
  () => import('./dashboard-charts').then((m) => m.UtilizationChart),
  { ssr: false, loading: () => <ChartSkeleton height={280} /> },
);

export const CashflowChart = dynamic(
  () => import('./dashboard-charts').then((m) => m.CashflowChart),
  { ssr: false, loading: () => <ChartSkeleton height={300} /> },
);

// Unternehmensführung
export const KpiSeriesChart = dynamic(
  () => import('./fuehrung-charts').then((m) => m.KpiSeriesChart),
  { ssr: false, loading: () => <ChartSkeleton height={300} /> },
);

export const HealthHistoryChart = dynamic(
  () => import('./fuehrung-charts').then((m) => m.HealthHistoryChart),
  { ssr: false, loading: () => <ChartSkeleton height={220} /> },
);

export const ScenarioChart = dynamic(
  () => import('./fuehrung-charts').then((m) => m.ScenarioChart),
  { ssr: false, loading: () => <ChartSkeleton height={300} /> },
);

export const BudgetVarianceChart = dynamic(
  () => import('./fuehrung-charts').then((m) => m.BudgetVarianceChart),
  { ssr: false, loading: () => <ChartSkeleton height={260} /> },
);
