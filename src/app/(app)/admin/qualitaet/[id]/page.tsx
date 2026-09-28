import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { can } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import { prisma, toNumber } from '@/lib/db';
import { formatDate } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { StatusBadge } from '@/components/ui/badge';
import { ActionButton } from '@/components/app/action-button';
import { DetailRow, DetailSection, PageHeader, TableScroll } from '@/components/app/page-parts';
import { BegehungDialog } from '@/features/admin/quality-panels';

export const metadata: Metadata = {
  title: 'Begehung',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function QualityInspectionPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('quality:read');
  const { id } = await params;
  const organizationId = await getOrganizationId();

  const begehung = await prisma.qualityInspection.findFirst({
    where: { id, organizationId, deletedAt: null },
    include: {
      items: { orderBy: { position: 'asc' } },
      contract: { select: { id: true, number: true, title: true } },
      version: { select: { versionNumber: true, targetQualityScore: true } },
      property: { select: { id: true, label: true } },
      job: { select: { id: true, number: true } },
      inspector: { select: { firstName: true, lastName: true } },
      followUpOf: { select: { id: true, number: true, inspectedAt: true, scorePercent: true } },
      followUp: { select: { id: true, number: true, inspectedAt: true, scorePercent: true } },
    },
  });
  if (!begehung) notFound();

  const istEntwurf = begehung.status === 'DRAFT';
  const darfBegehen = can(session.role, 'quality:inspect');
  const darfAbschliessen = can(session.role, 'quality:complete');

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${begehung.number ?? 'Begehungsentwurf'}`}
        description={`Begangen am ${formatDate(begehung.inspectedAt)}${
          begehung.inspector ? ` von ${begehung.inspector.firstName} ${begehung.inspector.lastName}` : ''
        }`}
        actions={
          <div className="flex flex-wrap gap-2">
            {darfAbschliessen && istEntwurf ? (
              <ActionButton
                endpoint={`/api/quality-inspections/${begehung.id}/complete`}
                body={{}}
                label="Abschliessen"
                variant="default"
                confirmTitle="Begehung abschliessen"
                confirm="Die Begehung erhält eine Nummer und ist danach ein Beleg — unveränderlich. Korrigiert wird ab dann nur noch über eine Nachkontrolle."
                successMessage="Die Begehung ist abgeschlossen."
              />
            ) : null}

            {darfBegehen && istEntwurf ? (
              <ActionButton
                endpoint={`/api/quality-inspections/${begehung.id}`}
                method="DELETE"
                label="Entwurf verwerfen"
                variant="destructive"
                confirmTitle="Entwurf verwerfen"
                confirm="Der Entwurf wird verworfen. Eine abgeschlossene Begehung liesse sich nicht verwerfen — sie ist ein Beleg."
                successMessage="Der Entwurf ist verworfen."
                redirectTo="/admin/qualitaet"
              />
            ) : null}

            {/*
              Die Nachkontrolle ist der einzige Weg, eine abgeschlossene
              Begehung zu korrigieren. Sie steht deshalb genau dort, wo das
              Ändern nicht mehr geht — und nur einmal je Begehung.
            */}
            {darfBegehen && begehung.status === 'COMPLETED' && !begehung.followUp ? (
              <BegehungDialog
                contractId={begehung.contractId ?? undefined}
                propertyId={begehung.propertyId ?? undefined}
                zielwert={begehung.targetScore}
                followUpOfId={begehung.id}
              />
            ) : null}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <DetailSection title="Bewertung" body="flush">
            {begehung.items.length === 0 ? (
              <p className="px-6 py-6 text-sm text-muted-foreground">
                Noch keine Position. Eine Begehung ohne Positionen lässt sich nicht abschliessen.
              </p>
            ) : (
              <TableScroll>
                <table className="data-table">
                  <caption className="sr-only">Die bewerteten Kriterien dieser Begehung.</caption>
                  <thead>
                    <tr>
                      <th scope="col">Kriterium</th>
                      <th scope="col">Ort</th>
                      <th scope="col" className="text-right">
                        Punkte
                      </th>
                      <th scope="col" className="text-right">
                        Gewicht
                      </th>
                      <th scope="col">Bemerkung</th>
                    </tr>
                  </thead>
                  <tbody>
                    {begehung.items.map((item) => {
                      const gewicht = toNumber(item.weight);
                      return (
                        <tr key={item.id}>
                          <td className="font-medium">{item.label}</td>
                          <td className="text-muted-foreground">{item.room ?? '—'}</td>
                          <td className="num">
                            {gewicht === 0 ? (
                              <span className="text-muted-foreground">nicht beurteilbar</span>
                            ) : (
                              `${toNumber(item.points)} / ${toNumber(item.maxPoints)}`
                            )}
                          </td>
                          <td className="num text-muted-foreground">{gewicht === 0 ? '—' : `${gewicht}×`}</td>
                          <td className="max-w-[20rem] truncate text-muted-foreground">{item.note ?? '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </DetailSection>

          {begehung.note ? (
            <DetailSection title="Befund" description="Was der Kundschaft mitgeteilt wird.">
              <p className="py-4 text-sm leading-relaxed">{begehung.note}</p>
            </DetailSection>
          ) : null}

          {/*
            Die interne Notiz steht in einem eigenen Abschnitt mit ausdrücklichem
            Hinweis. Der Endpunkt gibt sie der Kundschaft nicht heraus — dass sie
            hier steht, heisst nicht, dass sie dort ankommt.
          */}
          {begehung.internalNote ? (
            <DetailSection title="Interne Notiz" description="Nur für den Betrieb — nicht Teil des Befunds.">
              <p className="py-4 text-sm leading-relaxed text-muted-foreground">{begehung.internalNote}</p>
            </DetailSection>
          ) : null}
        </div>

        <div className="space-y-6">
          <DetailSection title="Ergebnis">
            <DetailRow label="Punktzahl">
              {begehung.scorePercent === null ? (
                <span className="text-muted-foreground">Keine Position war beurteilbar</span>
              ) : (
                <span className="font-medium tabular-nums">
                  {toNumber(begehung.scorePercent)} %
                  <span className="ml-2 font-normal text-muted-foreground">
                    {toNumber(begehung.scoreAchieved)} von {toNumber(begehung.scorePossible)} Punkten
                  </span>
                </span>
              )}
            </DetailRow>
            <DetailRow label="Zugesagt">
              {begehung.targetScore === null ? (
                <span className="text-muted-foreground">
                  Kein Zielwert vereinbart — die Begehung misst, urteilt aber nicht.
                </span>
              ) : (
                <span className="tabular-nums">
                  {begehung.targetScore} %
                  {begehung.version ? (
                    <span className="ml-2 text-muted-foreground">aus Fassung {begehung.version.versionNumber}</span>
                  ) : null}
                </span>
              )}
            </DetailRow>
            <DetailRow label="Urteil">
              <StatusBadge status={begehung.status === 'COMPLETED' ? begehung.outcome : begehung.status} />
            </DetailRow>
            {begehung.completedAt ? (
              <DetailRow label="Abgeschlossen">{formatDate(begehung.completedAt)}</DetailRow>
            ) : null}
          </DetailSection>

          <DetailSection title="Bezug">
            <DetailRow label="Vertrag">
              {begehung.contract ? (
                <Link
                  href={`/admin/vertraege/${begehung.contract.id}`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {begehung.contract.number ?? begehung.contract.title}
                </Link>
              ) : (
                <span className="text-muted-foreground">ohne Vertrag</span>
              )}
            </DetailRow>
            <DetailRow label="Objekt">{begehung.property?.label ?? '—'}</DetailRow>
            <DetailRow label="Einsatz">
              {begehung.job ? (
                <Link
                  href={`/admin/einsaetze/${begehung.job.id}`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {begehung.job.number}
                </Link>
              ) : (
                '—'
              )}
            </DetailRow>
          </DetailSection>

          {begehung.followUpOf || begehung.followUp ? (
            <DetailSection
              title="Nachkontrolle"
              description="Der einzige Weg, eine abgeschlossene Begehung zu korrigieren."
            >
              {begehung.followUpOf ? (
                <DetailRow label="Korrigiert">
                  <Link
                    href={`/admin/qualitaet/${begehung.followUpOf.id}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {begehung.followUpOf.number ?? 'Entwurf'}
                  </Link>
                  <span className="ml-2 text-muted-foreground tabular-nums">
                    {formatDate(begehung.followUpOf.inspectedAt)}
                    {begehung.followUpOf.scorePercent
                      ? ` · ${toNumber(begehung.followUpOf.scorePercent)} %`
                      : ''}
                  </span>
                </DetailRow>
              ) : null}
              {begehung.followUp ? (
                <DetailRow label="Nachkontrolliert durch">
                  <Link
                    href={`/admin/qualitaet/${begehung.followUp.id}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {begehung.followUp.number ?? 'Entwurf'}
                  </Link>
                  <span className="ml-2 text-muted-foreground tabular-nums">
                    {formatDate(begehung.followUp.inspectedAt)}
                    {begehung.followUp.scorePercent ? ` · ${toNumber(begehung.followUp.scorePercent)} %` : ''}
                  </span>
                </DetailRow>
              ) : null}
            </DetailSection>
          ) : null}
        </div>
      </div>
    </div>
  );
}
