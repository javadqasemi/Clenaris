import type { Metadata } from 'next';
import Link from 'next/link';

import { can } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import { prisma, toNumber } from '@/lib/db';
import { naechsteKontrolle } from '@/lib/quality/bewertung';
import { formatDate } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { StatusBadge } from '@/components/ui/badge';
import { KpiTile } from '@/components/app/kpi-tile';
import { EmptyState, PageHeader, TableScroll } from '@/components/app/page-parts';
import { BegehungDialog } from '@/features/admin/quality-panels';

export const metadata: Metadata = {
  title: 'Qualität',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Qualitätskontrolle — die Begehungen und die fälligen Verträge.
 *
 * Zwei Listen auf einer Seite, weil sie zwei Hälften derselben Frage
 * beantworten: Was wurde gemessen, und wo steht die Messung aus. Getrennt
 * müsste man zwischen ihnen hin- und herklicken, um zu wissen, ob man etwas
 * vergessen hat.
 */
export default async function QualityPage() {
  const session = await requirePermission('quality:read');
  const organizationId = await getOrganizationId();

  const [begehungen, vertraege] = await Promise.all([
    prisma.qualityInspection.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: { inspectedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        number: true,
        status: true,
        inspectedAt: true,
        scorePercent: true,
        targetScore: true,
        outcome: true,
        contract: { select: { id: true, number: true, title: true } },
        property: { select: { label: true } },
        inspector: { select: { firstName: true, lastName: true } },
        _count: { select: { items: true } },
      },
    }),
    /*
      Nur laufende Verträge mit vereinbartem Intervall. Ohne Intervall gibt es
      keine Fälligkeit — und eine Zeile „nie fällig" in einer Fälligkeitsliste
      ist eine Zeile, die man jedes Mal überliest.
    */
    prisma.contract.findMany({
      where: {
        organizationId,
        deletedAt: null,
        status: { in: ['ACTIVE', 'NOTICE_GIVEN'] },
        versions: { some: { status: 'ACTIVE', inspectionIntervalDays: { not: null } } },
      },
      select: {
        id: true,
        number: true,
        title: true,
        startDate: true,
        customer: { select: { companyName: true, firstName: true, lastName: true } },
        versions: {
          where: { status: 'ACTIVE' },
          select: { inspectionIntervalDays: true, targetQualityScore: true },
          take: 1,
        },
        qualityInspections: {
          where: { status: 'COMPLETED', deletedAt: null },
          orderBy: { inspectedAt: 'desc' },
          take: 1,
          select: { id: true, inspectedAt: true, scorePercent: true, outcome: true },
        },
      },
    }),
  ]);

  const faellig = vertraege
    .map((vertrag) => {
      const fassung = vertrag.versions[0];
      const letzte = vertrag.qualityInspections[0];
      return {
        vertrag,
        fassung,
        letzte,
        ...naechsteKontrolle({
          intervallTage: fassung?.inspectionIntervalDays,
          letzteKontrolleAm: letzte?.inspectedAt,
          vertragsbeginn: vertrag.startDate,
        }),
      };
    })
    .sort((a, b) => (a.inTagen ?? 0) - (b.inTagen ?? 0));

  const ueberfaellig = faellig.filter((f) => f.ueberfaellig).length;
  const abgeschlossen = begehungen.filter((b) => b.status === 'COMPLETED');
  const durchgefallen = abgeschlossen.filter((b) => b.outcome === 'NICHT_BESTANDEN').length;
  const schnitt =
    abgeschlossen.length > 0
      ? Math.round(
          (abgeschlossen.reduce((summe, b) => summe + (b.scorePercent ? toNumber(b.scorePercent) : 0), 0) /
            abgeschlossen.length) *
            10,
        ) / 10
      : null;

  const darfBegehen = can(session.role, 'quality:inspect');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Qualität"
        description="Begehungen vor Ort und die Zusagen, gegen die sie gemessen werden."
        actions={darfBegehen ? <BegehungDialog /> : undefined}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile label="Begehungen" value={String(abgeschlossen.length)} hint="abgeschlossen, letzte 50" />
        <KpiTile
          label="Durchschnitt"
          value={schnitt === null ? '—' : `${schnitt} %`}
          hint="über die abgeschlossenen Begehungen"
        />
        <KpiTile
          label="Überfällig"
          value={String(ueberfaellig)}
          hint="Verträge mit vereinbartem Intervall"
          accent={ueberfaellig > 0 ? 'warning' : undefined}
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      <section className="rounded-2xl border border-border bg-card shadow-soft">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
          <div className="min-w-0 space-y-1">
            <h2 className="font-display text-base font-semibold tracking-tight">Fällige Kontrollen</h2>
            <p className="text-meta leading-relaxed text-muted-foreground">
              Gerechnet ab der letzten durchgeführten Begehung — wer früher kontrolliert, verschiebt die nächste
              Frist nach hinten. Ein Entwurf zählt nicht.
            </p>
          </div>
        </header>

        {faellig.length === 0 ? (
          <p className="px-6 py-6 text-sm text-muted-foreground">
            Kein laufender Vertrag hat ein Kontrollintervall vereinbart. Ohne Intervall gibt es keine Fälligkeit —
            das Intervall steht in den Konditionen der Vertragsfassung.
          </p>
        ) : (
          <TableScroll>
            <table className="data-table">
              <caption className="sr-only">Verträge mit vereinbartem Kontrollintervall.</caption>
              <thead>
                <tr>
                  <th scope="col">Vertrag</th>
                  <th scope="col">Kundschaft</th>
                  <th scope="col">Intervall</th>
                  <th scope="col">Letzte Begehung</th>
                  <th scope="col">Fällig</th>
                  {darfBegehen ? (
                    <th scope="col" className="text-right">
                      <span className="sr-only">Handlungen</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {faellig.map((zeile) => (
                  <tr key={zeile.vertrag.id}>
                    <td>
                      <Link
                        href={`/admin/vertraege/${zeile.vertrag.id}`}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {zeile.vertrag.number ?? zeile.vertrag.title}
                      </Link>
                    </td>
                    <td className="text-muted-foreground">
                      {zeile.vertrag.customer.companyName ??
                        `${zeile.vertrag.customer.firstName} ${zeile.vertrag.customer.lastName}`}
                    </td>
                    <td className="num text-muted-foreground">{zeile.fassung?.inspectionIntervalDays} Tage</td>
                    <td className="tabular-nums text-muted-foreground">
                      {zeile.letzte ? (
                        <>
                          {formatDate(zeile.letzte.inspectedAt)}
                          {zeile.letzte.scorePercent ? ` · ${toNumber(zeile.letzte.scorePercent)} %` : ''}
                        </>
                      ) : (
                        'noch keine'
                      )}
                    </td>
                    <td className={zeile.ueberfaellig ? 'font-medium text-warning tabular-nums' : 'tabular-nums'}>
                      {zeile.faelligAm ? formatDate(zeile.faelligAm) : '—'}
                      {zeile.inTagen !== null ? (
                        <span className="ml-2 text-2xs text-muted-foreground">
                          {zeile.ueberfaellig ? `${Math.abs(zeile.inTagen)} Tage überfällig` : `in ${zeile.inTagen} Tagen`}
                        </span>
                      ) : null}
                    </td>
                    {darfBegehen ? (
                      <td className="text-right">
                        <BegehungDialog
                          contractId={zeile.vertrag.id}
                          zielwert={zeile.fassung?.targetQualityScore ?? null}
                          auslöser="Begehen"
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="rounded-2xl border border-border bg-card shadow-soft">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
          <div className="min-w-0 space-y-1">
            <h2 className="font-display text-base font-semibold tracking-tight">Begehungen</h2>
            <p className="text-meta leading-relaxed text-muted-foreground">
              Eine abgeschlossene Begehung ist ein Beleg — korrigiert wird über eine Nachkontrolle.
              {durchgefallen > 0 ? ` ${durchgefallen} davon nicht bestanden.` : ''}
            </p>
          </div>
        </header>

        {begehungen.length === 0 ? (
          <EmptyState
            title="Noch keine Begehung"
            description="Eine Begehung misst, ob die im Vertrag zugesagte Qualität erreicht wurde. Ohne Zusage misst sie trotzdem — sie urteilt dann nur nicht."
          />
        ) : (
          <TableScroll>
            <table className="data-table">
              <caption className="sr-only">Die letzten fünfzig Begehungen.</caption>
              <thead>
                <tr>
                  <th scope="col">Nummer</th>
                  <th scope="col">Begangen</th>
                  <th scope="col">Bezug</th>
                  <th scope="col">Prüfende Person</th>
                  <th scope="col" className="text-right">
                    Ergebnis
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {begehungen.map((begehung) => (
                  <tr key={begehung.id}>
                    <td>
                      <Link
                        href={`/admin/qualitaet/${begehung.id}`}
                        className="font-medium tabular-nums text-primary underline-offset-4 hover:underline"
                      >
                        {begehung.number ?? 'Entwurf'}
                      </Link>
                    </td>
                    <td className="tabular-nums text-muted-foreground">{formatDate(begehung.inspectedAt)}</td>
                    <td className="max-w-[16rem] truncate text-muted-foreground">
                      {begehung.contract?.number ?? begehung.contract?.title ?? begehung.property?.label ?? '—'}
                    </td>
                    <td className="text-muted-foreground">
                      {begehung.inspector
                        ? `${begehung.inspector.firstName} ${begehung.inspector.lastName}`
                        : '—'}
                    </td>
                    <td className="num">
                      {begehung.scorePercent === null ? (
                        <span className="text-muted-foreground">nichts beurteilbar</span>
                      ) : (
                        <>
                          {toNumber(begehung.scorePercent)} %
                          {begehung.targetScore !== null ? (
                            <span className="ml-1 text-2xs text-muted-foreground">von {begehung.targetScore} %</span>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={begehung.status === 'COMPLETED' ? begehung.outcome : begehung.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>
    </div>
  );
}
