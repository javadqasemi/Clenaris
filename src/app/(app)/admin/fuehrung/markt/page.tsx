import type { Metadata } from 'next';
import Link from 'next/link';
import { Compass, ExternalLink, Plus } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { toNumber } from '@/lib/db';
import { formatCurrency, formatDate } from '@/lib/utils';
import { ANALYSIS_KIND_LABELS, INSIGHT_KIND_LABELS } from '@/lib/bi/labels';
import { getOrganizationId } from '@/server/services/organization.service';
import { listAnalysisBoards, listCompetitors, listMarketInsights } from '@/server/services/knowledge.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DetailSection, EmptyState, PageHeader } from '@/components/app/page-parts';
import { ActionButton } from '@/features/fuehrung/action-button';
import { FormDialog } from '@/features/fuehrung/resource-form';
import { competitorFields, insightFields } from '@/features/fuehrung/knowledge-fields';

export const metadata: Metadata = {
  title: 'Markt und Wettbewerb',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Markt und Wettbewerb auf einer Seite: Wettbewerber, Marktbeobachtungen mit
 * Verfallsdatum, SWOT- und PESTEL-Tafeln als Fassungen. Drei Listen, weil sie
 * zusammen gelesen werden — die Analyse entsteht aus den beiden anderen.
 */
export default async function MarketPage() {
  const session = await requirePermission('market:read');
  const organizationId = await getOrganizationId();
  const [competitors, { items: insights }, boards] = await Promise.all([
    listCompetitors(organizationId),
    listMarketInsights(organizationId, { page: 1, pageSize: 20 }),
    listAnalysisBoards(organizationId),
  ]);
  const canManage = can(session.role, 'market:manage');
  const now = new Date();

  return (
    <div className="space-y-8">
      <PageHeader
        title="Markt und Wettbewerb"
        description="Wer sonst noch putzt, was sich im Markt bewegt, und was das für uns heisst. Beobachtungen tragen ein Verfallsdatum — eine Einschätzung von vor drei Jahren ist gefährlicher als keine."
        actions={
          canManage ? (
            <>
              <Button asChild variant="outline">
                <Link href="/admin/fuehrung/markt/analyse/neu?art=SWOT">
                  <Plus aria-hidden />
                  SWOT
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/admin/fuehrung/markt/analyse/neu?art=PESTEL">
                  <Plus aria-hidden />
                  PESTEL
                </Link>
              </Button>
            </>
          ) : null
        }
      />

      <DetailSection
        title="Analysetafeln"
        description="Jede Tafel ist eine Fassung mit Stichtag. Eine neue Fassung löst die alte ab; beide bleiben vergleichbar."
        body="flush"
      >
        {boards.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-muted-foreground">Noch keine Tafel. Der Führungsassistent liefert einen Entwurf aus Kennzahlen und Markt.</p>
        ) : (
          <ul className="divide-y divide-border">
            {boards.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 text-sm">
                <Link href={`/admin/fuehrung/markt/analyse/${b.id}`} className="min-w-0 font-medium hover:text-primary">
                  <Badge size="sm" variant="outline" className="mr-2">{ANALYSIS_KIND_LABELS[b.kind]}</Badge>
                  {b.title}
                </Link>
                <span className="flex items-center gap-2 text-muted-foreground">
                  {formatDate(b.preparedOn)} · {b._count.entries} Punkte
                  {b.supersededBy ? <Badge size="sm" variant="neutral">Abgelöst</Badge> : b.nextReviewAt && b.nextReviewAt < now ? <Badge size="sm" variant="warning">Prüfung fällig</Badge> : <Badge size="sm" variant="success">Aktuell</Badge>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

      <div className="grid gap-6 lg:grid-cols-2">
        <DetailSection
          title="Wettbewerber"
          body="flush"
          action={canManage ? <FormDialog title="Wettbewerber erfassen" triggerLabel="Wettbewerber" triggerVariant="outline" triggerSize="sm" endpoint="/api/bi/competitors" successMessage="Wettbewerber erfasst." fields={competitorFields()} values={{ reviewIntervalDays: 180 }} /> : null}
        >
          {competitors.length === 0 ? (
            <EmptyState className="m-4" icon={<Compass aria-hidden />} title="Keine Wettbewerber" description={'Wer taucht bei „Reinigung Bern" vor Ihnen auf?'} />
          ) : (
            <ul className="divide-y divide-border">
              {competitors.map((c) => {
                const stale = c.nextReviewAt && c.nextReviewAt < now;
                return (
                  <li key={c.id} className="space-y-1.5 px-6 py-4 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium">
                          {c.name}
                          {c.website ? <a href={c.website} target="_blank" rel="noopener" className="ml-2 inline-flex text-muted-foreground hover:text-primary" aria-label="Website öffnen"><ExternalLink className="size-3.5" aria-hidden /></a> : null}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {c.region ?? '—'}
                          {c.services.length ? ` · ${c.services.join(', ')}` : ''}
                          {c.priceFrom || c.priceTo ? ` · ${c.priceFrom ? formatCurrency(toNumber(c.priceFrom)) : '?'} – ${c.priceTo ? formatCurrency(toNumber(c.priceTo)) : '?'}${c.priceNote ? ` ${c.priceNote}` : ''}` : ''}
                          {c.reviewScore ? ` · ${toNumber(c.reviewScore)} ★ (${c.reviewCount ?? 0})` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        {stale ? <Badge size="sm" variant="warning">Veraltet</Badge> : null}
                        {canManage ? (
                          <>
                            <FormDialog title="Wettbewerber bearbeiten" triggerLabel="Bearbeiten" triggerVariant="ghost" triggerSize="sm" plainTrigger endpoint={`/api/bi/competitors/${c.id}`} method="PATCH" successMessage="Gespeichert." fields={competitorFields(true)} values={{ name: c.name, region: c.region, website: c.website, services: c.services, priceFrom: c.priceFrom === null ? null : toNumber(c.priceFrom), priceTo: c.priceTo === null ? null : toNumber(c.priceTo), priceNote: c.priceNote, reviewScore: c.reviewScore === null ? null : toNumber(c.reviewScore), reviewCount: c.reviewCount, marketPosition: c.marketPosition, strengths: c.strengths, weaknesses: c.weaknesses, notes: c.notes, reviewIntervalDays: c.reviewIntervalDays }} />
                            <ActionButton endpoint={`/api/bi/competitors/${c.id}`} method="DELETE" label="Löschen" confirm="Wettbewerber löschen?" variant="ghost" />
                          </>
                        ) : null}
                      </div>
                    </div>
                    {c.marketPosition ? <p className="text-muted-foreground">Position: {c.marketPosition}</p> : null}
                    {c.strengths || c.weaknesses ? (
                      <p className="text-muted-foreground">
                        {c.strengths ? <span><span className="font-medium text-success">+</span> {c.strengths} </span> : null}
                        {c.weaknesses ? <span><span className="font-medium text-destructive">−</span> {c.weaknesses}</span> : null}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </DetailSection>

        <DetailSection
          title="Marktbeobachtungen"
          body="flush"
          action={canManage ? <FormDialog title="Beobachtung erfassen" triggerLabel="Beobachtung" triggerVariant="outline" triggerSize="sm" endpoint="/api/bi/market-insights" successMessage="Beobachtung erfasst." fields={insightFields()} values={{ kind: 'INDUSTRY', observedOn: new Date().toISOString().slice(0, 10), reviewIntervalDays: 365 }} /> : null}
        >
          {insights.length === 0 ? (
            <EmptyState className="m-4" icon={<Compass aria-hidden />} title="Keine Beobachtungen" description="Neue Vorschriften, Lohnentwicklung, Nachfrage nach Umzugsreinigungen — was Sie hören, gehört hierher." />
          ) : (
            <ul className="divide-y divide-border">
              {insights.map((i) => (
                <li key={i.id} className="space-y-1 px-6 py-4 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="font-medium">
                      <Badge size="sm" variant="outline" className="mr-2">{INSIGHT_KIND_LABELS[i.kind]}</Badge>
                      {i.title}
                    </p>
                    <div className="flex items-center gap-1">
                      {i.outdated ? <Badge size="sm" variant="warning">Veraltet</Badge> : null}
                      {canManage ? (
                        <>
                          <FormDialog title="Beobachtung bearbeiten" triggerLabel="Bearbeiten" triggerVariant="ghost" triggerSize="sm" plainTrigger endpoint={`/api/bi/market-insights/${i.id}`} method="PATCH" successMessage="Gespeichert — gilt ab heute wieder." fields={insightFields(true)} values={{ title: i.title, kind: i.kind, observedOn: i.observedOn, sourceName: i.sourceName, sourceUrl: i.sourceUrl, body: i.body, impactNote: i.impactNote, reviewIntervalDays: i.reviewIntervalDays }} />
                          <ActionButton endpoint={`/api/bi/market-insights/${i.id}`} method="DELETE" label="Löschen" confirm="Beobachtung löschen?" variant="ghost" />
                        </>
                      ) : null}
                    </div>
                  </div>
                  <p className="text-muted-foreground">{i.body}</p>
                  {i.impactNote ? <p><span className="font-medium">Für uns:</span> {i.impactNote}</p> : null}
                  <p className="text-xs text-muted-foreground">
                    {formatDate(i.observedOn)}
                    {i.sourceName ? (
                      <>
                        {' · '}
                        {i.sourceUrl ? (
                          <a href={i.sourceUrl} target="_blank" rel="noopener" className="hover:text-primary">
                            {i.sourceName}
                          </a>
                        ) : (
                          i.sourceName
                        )}
                      </>
                    ) : null}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>
      </div>
    </div>
  );
}
