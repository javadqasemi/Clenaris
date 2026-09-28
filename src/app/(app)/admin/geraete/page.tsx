import type { Metadata } from 'next';
import Link from 'next/link';
import { Wrench } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { formatDate } from '@/lib/utils';
import { zuercherTagText } from '@/lib/zuerich';
import { getOrganizationId } from '@/server/services/organization.service';
import { listEquipment } from '@/server/services/equipment.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DetailSection, EmptyState, ListCard, PageHeader, TableScroll } from '@/components/app/page-parts';
import { ActionButton } from '@/components/app/action-button';
import { FormDialog } from '@/components/app/resource-form';
import { assignFields, equipmentFields, maintenanceFields } from '@/features/admin/betrieb-fields';

export const metadata: Metadata = {
  title: 'Geräte',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const STATUS: Record<string, { text: string; variant: 'success' | 'info' | 'warning' | 'neutral' }> = {
  AVAILABLE: { text: 'Verfügbar', variant: 'success' },
  IN_USE: { text: 'Zugeteilt', variant: 'info' },
  MAINTENANCE: { text: 'In Wartung', variant: 'warning' },
  RETIRED: { text: 'Ausgemustert', variant: 'neutral' },
};

/**
 * Geräte mit Zuteilung und Wartung (Wave 11). Die nächste Wartung rechnet
 * sich aus der letzten und dem Intervall; ein Wartungsbeleg ist
 * unveränderlich.
 */
export default async function EquipmentPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requirePermission('equipment:read');
  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const nurFaellig = params.faellig === '1';
  const [geraete, personal] = await Promise.all([
    listEquipment({ organizationId, wartungFaellig: nurFaellig }),
    prisma.employee.findMany({
      where: { organizationId, active: true },
      select: { id: true, employeeNumber: true, user: { select: { firstName: true, lastName: true } } },
      orderBy: { employeeNumber: 'asc' },
    }),
  ]);
  const darf = can(session.role, 'equipment:manage');
  const personen = personal.map((p) => ({ value: p.id, label: `${p.user.firstName} ${p.user.lastName} (${p.employeeNumber})` }));
  const heute = zuercherTagText();

  return (
    <div className="space-y-8">
      <PageHeader
        title="Geräte"
        description="Inventar mit Zuteilung und Wartungsfälligkeit. Ausgemusterte Geräte bleiben als Beleg bestehen."
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={nurFaellig ? '/admin/geraete' : '/admin/geraete?faellig=1'}>{nurFaellig ? 'Alle Geräte' : 'Wartung fällig'}</Link>
            </Button>
            {darf ? (
              <FormDialog title="Gerät erfassen" triggerLabel="Gerät" endpoint="/api/equipment" successMessage="Gerät erfasst." fields={equipmentFields()} />
            ) : null}
          </>
        }
      />

      <DetailSection title="Inventar" body="flush">
        {geraete.length === 0 ? (
          <EmptyState className="m-4" icon={<Wrench aria-hidden />} title="Keine Geräte" description="Staubsauger, Scheuersaugmaschinen, Hochdruckreiniger." />
        ) : (
          <ListCard>
            <TableScroll>
              <table className="data-table">
                <caption className="sr-only">Geräte</caption>
                <thead>
                  <tr>
                    <th scope="col">Gerät</th>
                    <th scope="col">Zugeteilt</th>
                    <th scope="col">Nächste Wartung</th>
                    <th scope="col">Stand</th>
                    <th scope="col"><span className="sr-only">Aktionen</span></th>
                  </tr>
                </thead>
                <tbody>
                  {geraete.map((g) => (
                    // Ziel eines Scans (`scan.service.ts`) — Geräte haben keine eigene Detailseite.
                    <tr key={g.id} id={`geraet-${g.id}`} className="scroll-mt-24 target:bg-primary/10">
                      <td className="font-medium">
                        {g.name}
                        <span className="block text-xs text-muted-foreground">
                          {g.inventoryNumber}
                          {g.category ? ` · ${g.category}` : ''}
                        </span>
                      </td>
                      <td className="text-muted-foreground">
                        {g.assignedEmployee ? `${g.assignedEmployee.user.firstName} ${g.assignedEmployee.user.lastName}` : '—'}
                      </td>
                      <td className={g.wartungUeberfaellig ? 'font-medium text-destructive' : 'text-muted-foreground'}>
                        {g.nextMaintenanceOn ? formatDate(g.nextMaintenanceOn) : '—'}
                      </td>
                      <td>
                        <Badge size="sm" variant={STATUS[g.status]!.variant}>{STATUS[g.status]!.text}</Badge>
                      </td>
                      <td className="space-x-1 text-right">
                        {darf && g.status !== 'RETIRED' ? (
                          <>
                            {g.assignedEmployeeId ? (
                              <ActionButton endpoint={`/api/equipment/${g.id}/assign`} body={{ employeeId: null }} label="Zurücknehmen" variant="ghost" size="sm" />
                            ) : g.status === 'AVAILABLE' ? (
                              <FormDialog title={`${g.name} zuteilen`} triggerLabel="Zuteilen" triggerVariant="ghost" triggerSize="sm" plainTrigger endpoint={`/api/equipment/${g.id}/assign`} successMessage="Zugeteilt." fields={assignFields(personen)} />
                            ) : null}
                            <FormDialog
                              title={`Wartung — ${g.name}`}
                              triggerLabel="Wartung"
                              triggerVariant="ghost"
                              triggerSize="sm"
                              plainTrigger
                              endpoint={`/api/equipment/${g.id}/maintenance`}
                              successMessage="Wartung festgehalten."
                              fields={maintenanceFields()}
                              values={{ performedOn: heute, kind: 'Wartung' }}
                            />
                            <ActionButton
                              endpoint={`/api/equipment/${g.id}/status`}
                              body={{ status: 'RETIRED' }}
                              label="Ausmustern"
                              confirm="Ausmustern ist endgültig."
                              withNote
                              noteField="reason"
                              noteLabel="Grund"
                              variant="ghost"
                              size="sm"
                            />
                            <Button asChild variant="ghost" size="sm">
                              <Link href={`/admin/etikett/EQUIPMENT/${g.id}`}>Etikett</Link>
                            </Button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </ListCard>
        )}
      </DetailSection>
    </div>
  );
}
