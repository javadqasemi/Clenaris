import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, CalendarClock, FileWarning, Info, ShieldAlert, Target } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { hasIntegration } from '@/lib/env';
import { formatDate, formatDateTime } from '@/lib/utils';
import { formatKpiValue, RISK_BAND_LABELS } from '@/lib/bi/labels';
import type { PeriodName } from '@/lib/bi/periods';
import { getOrganizationId } from '@/server/services/organization.service';
import { getCockpit } from '@/server/services/cockpit.service';
import { listBudgetOptions } from '@/server/services/fuehrung-options.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, Progress } from '@/components/ui/primitives';
import { KpiTile } from '@/components/app/kpi-tile';
import { DetailSection, PageHeader } from '@/components/app/page-parts';
import { HealthHistoryChart } from '@/components/charts/lazy';
import { HealthGauge } from '@/features/fuehrung/health-gauge';
import { RiskMatrix } from '@/features/fuehrung/risk-matrix';
import { AssistantPanel } from '@/features/fuehrung/assistant-panel';
import { statusBadge } from '@/features/fuehrung/roadmap';

export const metadata: Metadata = {
  title: 'Führungscockpit',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const PERIODS: { value: PeriodName; label: string }[] = [
  { value: 'MONTH', label: 'Monat' },
  { value: 'QUARTER', label: 'Quartal' },
  { value: 'YEAR', label: 'Jahr' },
];

const SEVERITY_ICON = { critical: AlertTriangle, warning: AlertTriangle, info: Info } as const;

/**
 * Das Führungscockpit.
 *
 * Eine Seite, sechs Blicke: Gesundheitswert, Kennzahlen je Gruppe,
 * Auffälligkeiten, Ziele des Quartals, Risikomatrix, Fälliges. Die
 * Finanzgruppen erscheinen nur mit `cockpit:financials` — die Grenze zieht der
 * Dienst, die Seite zeigt, was sie bekommt.
 */
export default async function CockpitPage({ searchParams }: { searchParams: Promise<{ periode?: string }> }) {
  const session = await requirePermission('cockpit:view');
  const params = await searchParams;
  const period = (PERIODS.some((p) => p.value === params.periode) ? params.periode : 'MONTH') as PeriodName;
  const organizationId = await getOrganizationId();
  const [cockpit, budgets] = await Promise.all([getCockpit(session, organizationId, period), listBudgetOptions(organizationId)]);
  const lastHealth = cockpit.health.history.at(-1);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Führungscockpit"
        description="Gesundheit der Firma auf einen Blick — Zahlen aus dem Nachtlauf, Auffälligkeiten aus Regeln, Ziele und Risiken aus den Registern."
        actions={
          <div className="inline-flex items-center gap-0.5 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Periode">
            {PERIODS.map((p) => (
              <Link
                key={p.value}
                href={`/admin/fuehrung?periode=${p.value}`}
                role="radio"
                aria-checked={period === p.value}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${period === p.value ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {p.label}
              </Link>
            ))}
          </div>
        }
      />

      {cockpit.missingTargets.length > 0 && can(session.role, 'kpi:manage') ? (
        <Alert variant="info" title="Zielwerte fehlen">
          {cockpit.missingTargets.slice(0, 4).join(', ')}
          {cockpit.missingTargets.length > 4 ? ` und ${cockpit.missingTargets.length - 4} weitere` : ''} haben noch keinen Zielwert oder keine Warnschwelle und fliessen nicht in den Gesundheitswert ein.{' '}
          <Link href="/admin/fuehrung/kennzahlen" className="font-medium underline underline-offset-2">
            Kennzahlen einrichten
          </Link>
        </Alert>
      ) : null}

      <DetailSection title="Gesundheitswert" description="Gewichtete Teilnoten aus sechs Bereichen. Die Herleitung steht daneben, damit die Zahl prüfbar bleibt." body="form">
        <HealthGauge score={cockpit.health.score} status={cockpit.health.status} delta={lastHealth?.scoreDelta} topRisk={cockpit.health.topRisk} components={cockpit.health.components} />
      </DetailSection>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <HealthHistoryChart data={cockpit.health.history} />
        <DetailSection title="Auffälligkeiten" description="Regelbasiert, mit Sprung zur Stelle, wo man etwas tun kann." body="flush">
          {cockpit.insights.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">Keine Auffälligkeiten. Das ist eine gute Nachricht.</p>
          ) : (
            <ul className="divide-y divide-border">
              {cockpit.insights.map((insight) => {
                const Icon = SEVERITY_ICON[insight.severity];
                return (
                  <li key={insight.key}>
                    <Link href={insight.href} className="group flex gap-3 px-6 py-3.5 transition-colors hover:bg-muted/50">
                      <Icon className={`mt-0.5 size-4 shrink-0 ${insight.severity === 'critical' ? 'text-destructive' : insight.severity === 'warning' ? 'text-warning' : 'text-muted-foreground'}`} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{insight.title}</span>
                        <span className="block text-sm text-muted-foreground">{insight.detail}</span>
                        <span className="block text-2xs text-muted-foreground">Quelle: {insight.source}</span>
                      </span>
                      <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </DetailSection>
      </div>

      {cockpit.groups.map((group) => (
        <section key={group.name} className="space-y-3" aria-label={group.name}>
          <div className="flex items-baseline justify-between">
            <h2 className="font-display text-base font-semibold">{group.name}</h2>
            <Link href="/admin/fuehrung/kennzahlen" className="text-sm text-muted-foreground hover:text-foreground">
              Alle Kennzahlen
            </Link>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {group.rows.map((row) => (
              <KpiTile
                key={row.id}
                label={row.label}
                value={formatKpiValue(row.current?.value ?? null, row.unit)}
                changePercent={row.changePct ?? undefined}
                invertTrend={row.direction === 'DOWN_IS_GOOD'}
                hint={row.current ? `${row.current.label}${row.current.provisional ? ' · vorläufig' : ''}${row.targetValue !== null ? ` · Ziel ${formatKpiValue(row.targetValue, row.unit)}` : ''}` : 'Noch kein Wert'}
                href={`/admin/fuehrung/kennzahlen/${row.id}`}
              />
            ))}
          </div>
        </section>
      ))}

      <div className="grid gap-6 lg:grid-cols-2">
        <DetailSection
          title={`Ziele ${cockpit.objectives.quarterLabel}`}
          description="Aktive Quartalsziele, die am wenigsten fortgeschrittenen zuerst."
          body="flush"
          action={
            <Button asChild variant="ghost" size="sm">
              <Link href="/admin/fuehrung/ziele">
                <Target aria-hidden />
                Alle Ziele
              </Link>
            </Button>
          }
        >
          {cockpit.objectives.quarterObjectives.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">Keine aktiven Ziele im Quartal.</p>
          ) : (
            <ul className="divide-y divide-border">
              {cockpit.objectives.quarterObjectives.map((o) => (
                <li key={o.id} className="space-y-2 px-6 py-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <Link href={`/admin/fuehrung/ziele/${o.id}`} className="min-w-0 truncate text-sm font-medium hover:text-primary">
                      {o.title}
                    </Link>
                    <span className="flex items-center gap-2">
                      {statusBadge(o.status)}
                      <span className="text-sm tabular-nums">{o.progressPct} %</span>
                    </span>
                  </div>
                  <Progress value={o.progressPct} />
                </li>
              ))}
            </ul>
          )}
        </DetailSection>

        <DetailSection
          title="Risikomatrix"
          description={`${cockpit.risks.total} offene Risiken · ${cockpit.risks.bands.CRITICAL} kritisch, ${cockpit.risks.bands.HIGH} hoch`}
          body="form"
          action={
            <Button asChild variant="ghost" size="sm">
              <Link href="/admin/fuehrung/risiken">
                <ShieldAlert aria-hidden />
                Register
              </Link>
            </Button>
          }
        >
          <div className="grid gap-5 sm:grid-cols-[auto_1fr]">
            <RiskMatrix cells={cockpit.risks.cells} compact />
            <ul className="space-y-2 text-sm">
              {cockpit.risks.top.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <Link href={`/admin/fuehrung/risiken/${r.id}`} className="min-w-0 truncate hover:text-primary">
                    {r.title}
                  </Link>
                  <Badge size="sm" variant={r.band === 'CRITICAL' ? 'destructive' : r.band === 'HIGH' ? 'warning' : 'neutral'}>
                    {RISK_BAND_LABELS[r.band]} · {r.severity}
                  </Badge>
                </li>
              ))}
              {cockpit.risks.top.length === 0 ? <li className="text-muted-foreground">Das Register ist leer.</li> : null}
            </ul>
          </div>
        </DetailSection>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <DetailSection title="Fällige Prüfungen" body="list">
          <dl className="protocol-list">
            {[
              ['Ziele', cockpit.due.objectives, '/admin/fuehrung/ziele'],
              ['Risiken', cockpit.due.risks, '/admin/fuehrung/risiken?faellig=1'],
              ['Kontrollen', cockpit.due.controls, '/admin/fuehrung/qualitaet?faellig=1'],
              ['Markt', cockpit.due.market, '/admin/fuehrung/markt'],
            ].map(([label, count, href]) => (
              <div key={String(label)} className="flex items-center justify-between py-2.5 text-sm">
                <dt className="text-muted-foreground">{label}</dt>
                <dd>
                  <Link href={String(href)} className={`font-semibold tabular-nums ${Number(count) > 0 ? 'text-warning' : ''}`}>
                    {count}
                  </Link>
                </dd>
              </div>
            ))}
          </dl>
        </DetailSection>
        <DetailSection title="Qualität" body="list">
          <dl className="protocol-list">
            {[
              ['Offene Massnahmen', cockpit.quality.openActions],
              ['Überfällige Massnahmen', cockpit.quality.overdueActions],
              ['Abweichungen', cockpit.quality.nonCompliant],
              ['Reklamationen (90 Tage)', cockpit.quality.complaints],
            ].map(([label, count]) => (
              <div key={String(label)} className="flex items-center justify-between py-2.5 text-sm">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className={`font-semibold tabular-nums ${Number(count) > 0 && String(label).startsWith('Über') ? 'text-destructive' : ''}`}>{count}</dd>
              </div>
            ))}
          </dl>
        </DetailSection>
        <DetailSection title="Demnächst" body="list">
          <ul className="protocol-list text-sm">
            {cockpit.upcomingMeetings.map((m) => (
              <li key={m.id} className="flex items-center gap-2 py-2.5">
                <CalendarClock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <Link href={`/admin/fuehrung/sitzungen/${m.id}`} className="min-w-0 flex-1 truncate hover:text-primary">
                  {m.title}
                </Link>
                <span className="text-muted-foreground">{formatDateTime(m.heldAt)}</span>
              </li>
            ))}
            {cockpit.expiringDocuments.map((d) => (
              <li key={d.id} className="flex items-center gap-2 py-2.5">
                <FileWarning className="size-4 shrink-0 text-warning" aria-hidden />
                <Link href={`/admin/fuehrung/dokumente/${d.id}`} className="min-w-0 flex-1 truncate hover:text-primary">
                  {d.title}
                </Link>
                <span className="text-muted-foreground">{d.expiresOn ? formatDate(d.expiresOn) : ''}</span>
              </li>
            ))}
            {cockpit.upcomingMeetings.length === 0 && cockpit.expiringDocuments.length === 0 ? <li className="py-2.5 text-muted-foreground">Keine Sitzungen, keine ablaufenden Dokumente.</li> : null}
          </ul>
        </DetailSection>
      </div>

      {can(session.role, 'ai:use') ? <AssistantPanel configured={hasIntegration('ai')} budgets={budgets} /> : null}
    </div>
  );
}
