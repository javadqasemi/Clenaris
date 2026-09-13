import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, MapPin } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatCurrency, formatDuration } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { KpiTile } from '@/components/app/kpi-tile';
import { EmptyState, ListCard, PageHeader, TableScroll } from '@/components/app/page-parts';
import {
  ServiceAreaCreateButton,
  ServiceAreaExportButton,
  ServiceAreaImportDialog,
  ServiceAreaRowActions,
  type ServiceAreaRow,
} from '@/features/admin/settings/service-area-manager';

export const metadata: Metadata = {
  title: 'Einsatzgebiet',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Einsatzgebiet.
 *
 * Das Gebiet ist über Postleitzahlen definiert, nicht über einen Radius:
 * eine Luftlinie von 20 km bedeutet im Emmental etwas völlig anderes als im
 * Raum Bern-Köniz. Jede PLZ trägt ihre eigene Anfahrtspauschale und die
 * geschätzte Fahrzeit, die in die Kapazitätsplanung einfliesst.
 *
 * Wird eine PLZ deaktiviert, verweigert das Buchungsformular sie sofort — die
 * Prüfung läuft über `/api/public/service-areas/check` gegen dieselbe
 * Tabelle.
 *
 * Bearbeiten darf, wer `serviceArea:update` hat — die Administration. Die
 * Betriebsleitung liest das Gebiet mit, weil sie Termine plant; sie sieht
 * die Liste ohne Schaltflächen.
 */
export default async function ServiceAreaSettingsPage() {
  const session = await requirePermission('settings:read');
  const canEdit = can(session.role, 'serviceArea:update');
  const organizationId = await getOrganizationId();

  const areas = await prisma.serviceArea.findMany({
    where: { organizationId },
    orderBy: [{ active: 'desc' }, { postalCode: 'asc' }],
  });

  const rows: ServiceAreaRow[] = areas.map((area) => ({
    id: area.id,
    postalCode: area.postalCode,
    city: area.city,
    canton: area.canton,
    travelFee: toNumber(area.travelFee),
    travelMinutes: area.travelMinutes,
    active: area.active,
  }));

  const active = rows.filter((area) => area.active);
  const withFee = active.filter((area) => area.travelFee > 0);
  const averageFee =
    withFee.length > 0
      ? withFee.reduce((sum, area) => sum + area.travelFee, 0) / withFee.length
      : 0;

  // Gruppierung nach PLZ-Tausenderblock — so liest sich die Liste als Region.
  const groups = new Map<string, ServiceAreaRow[]>();
  for (const area of rows) {
    const key = `${area.postalCode.slice(0, 2)}00`;
    const bucket = groups.get(key) ?? [];
    bucket.push(area);
    groups.set(key, bucket);
  }

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/einstellungen">
          <ArrowLeft aria-hidden />
          Einstellungen
        </Link>
      </Button>

      <PageHeader
        title="Einsatzgebiet"
        description="Postleitzahlen, in denen wir arbeiten — mit Anfahrtspauschale und Fahrzeit für die Planung."
        actions={
          <>
            <ServiceAreaExportButton areas={rows} />
            {canEdit ? (
              <>
                <ServiceAreaImportDialog />
                <ServiceAreaCreateButton />
              </>
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile label="Aktive Postleitzahlen" value={String(active.length)} />
        <KpiTile
          label="Mit Anfahrtspauschale"
          value={String(withFee.length)}
          hint={withFee.length > 0 ? `im Schnitt ${formatCurrency(averageFee)}` : undefined}
        />
        <KpiTile
          label="Deaktiviert"
          value={String(rows.length - active.length)}
          accent={rows.length - active.length > 0 ? 'warning' : 'neutral'}
        />
      </div>

      <Alert variant="info">
        Eine Anfrage aus einer nicht erfassten Postleitzahl wird im Buchungsformular abgewiesen,
        aber weiterhin als Lead festgehalten — so sieht man, wohin sich eine Erweiterung lohnen
        würde.
      </Alert>

      {rows.length === 0 ? (
        <EmptyState
          icon={<MapPin aria-hidden />}
          title="Noch kein Gebiet erfasst"
          description="Ohne erfasste Postleitzahlen nimmt das Buchungsformular keine Termine an. Nehmen Sie die erste Postleitzahl auf oder importieren Sie eine Liste."
        />
      ) : (
        <div className="space-y-6">
          {Array.from(groups.entries()).map(([prefix, entries]) => (
            <ListCard key={prefix} title={`Region ${prefix.slice(0, 2)}xx`}>
              <TableScroll>
                <table className="data-table data-table--sticky">
                  <caption className="sr-only">Postleitzahlen der Region {prefix}</caption>
                  <thead>
                    <tr>
                      <th scope="col">PLZ</th>
                      <th scope="col">Ort</th>
                      <th scope="col">Kanton</th>
                      <th scope="col" className="text-right">
                        Anfahrt
                      </th>
                      <th scope="col" className="text-right">
                        Fahrzeit
                      </th>
                      <th scope="col">Status</th>
                      {canEdit ? (
                        <th scope="col" className="text-right">
                          <span className="sr-only">Aktionen</span>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((area) => (
                      <tr key={area.id}>
                        <td className="num font-medium">{area.postalCode}</td>
                        <td>{area.city}</td>
                        <td className="text-muted-foreground">{area.canton}</td>
                        <td className="num">
                          {area.travelFee > 0 ? formatCurrency(area.travelFee) : 'inbegriffen'}
                        </td>
                        <td className="num text-muted-foreground">
                          {area.travelMinutes > 0 ? formatDuration(area.travelMinutes) : '—'}
                        </td>
                        <td>
                          {area.active ? (
                            <Badge variant="success" size="sm">
                              Aktiv
                            </Badge>
                          ) : (
                            <Badge variant="neutral" size="sm">
                              Inaktiv
                            </Badge>
                          )}
                        </td>
                        {canEdit ? (
                          <td>
                            <ServiceAreaRowActions area={area} />
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </ListCard>
          ))}
        </div>
      )}
    </div>
  );
}
