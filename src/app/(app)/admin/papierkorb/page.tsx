import type { Metadata } from 'next';
import Link from 'next/link';
import { Trash2, Undo2 } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatRelative } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { definitionFor, listTrash, type Recyclable } from '@/server/services/trash.service';
import { Badge } from '@/components/ui/badge';
import { ActionButton } from '@/components/app/action-button';
import { EmptyState, ListCard, PageHeader, TableScroll } from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Papierkorb',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Papierkorb.
 *
 * Sieben Datensatzarten lassen sich weich löschen, und jede hatte einen
 * Endpunkt zum Wiederherstellen — aber keine Seite, die ihn anbot. Wer eine
 * Kundschaft versehentlich gelöscht hatte, sah sie nirgends mehr und konnte
 * sie nirgends zurückholen; das ist ein Papierkorb ohne Deckel.
 *
 * Eine gemeinsame Liste über alle Bereiche, sortiert nach Löschzeitpunkt:
 * Wer etwas versehentlich gelöscht hat, weiss oft nicht mehr genau *was* —
 * nur *wann* (siehe `listTrash`).
 *
 * Gezeigt wird nur, was die Rolle auch wiederherstellen darf: Die
 * Betriebsleitung löscht Anfragen und Buchungen, aber keine Kundschaft — sie
 * sieht hier deshalb auch keine gelöschte Kundschaft. Das Recht zum Löschen
 * ist das Recht zum Wiederherstellen; eine eigene Berechtigung dafür wäre
 * eine Zeile in der Matrix, die niemand anders vergeben würde.
 */
const RESTORE_PATH: Record<Recyclable, string> = {
  customer: '/api/customers',
  lead: '/api/leads',
  booking: '/api/bookings',
  quote: '/api/quotes',
  invoice: '/api/invoices',
  job: '/api/jobs',
  property: '/api/properties',
};

const DETAIL_PATH: Record<Recyclable, string | null> = {
  customer: '/admin/kunden',
  lead: '/admin/leads',
  booking: '/admin/buchungen',
  quote: '/admin/offerten',
  invoice: '/admin/rechnungen',
  job: '/admin/einsaetze',
  property: null,
};

export default async function TrashPage() {
  const session = await requirePermission('booking:delete');
  const organizationId = await getOrganizationId();

  const entries = (await listTrash(organizationId)).filter((entry) =>
    can(session.role, definitionFor(entry.model).permission),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Papierkorb"
        description="Weich gelöschte Datensätze aus allen Bereichen. Wiederherstellen bringt sie unverändert zurück — verknüpfte Belege wurden nie mitgelöscht."
      />

      {entries.length === 0 ? (
        <EmptyState
          icon={<Trash2 aria-hidden />}
          title="Der Papierkorb ist leer"
          description="Gelöschte Kundschaft, Anfragen, Buchungen, Offerten, Rechnungsentwürfe, Einsätze und Objekte erscheinen hier."
        />
      ) : (
        <ListCard>
          <TableScroll>
            <table className="data-table">
              <caption className="sr-only">Papierkorb. {entries.length} Einträge.</caption>
              <thead>
                <tr>
                  <th scope="col">Art</th>
                  <th scope="col">Datensatz</th>
                  <th scope="col">Gelöscht</th>
                  <th scope="col" className="text-right">
                    <span className="sr-only">Aktionen</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const detail = DETAIL_PATH[entry.model];
                  return (
                    <tr key={`${entry.model}-${entry.id}`}>
                      <td>
                        <Badge variant="neutral" size="sm">
                          {entry.label}
                        </Badge>
                      </td>
                      <td className="font-medium">
                        {/*
                          Die Detailseiten filtern `deletedAt: null` und
                          antworten mit 404 — der Verweis führt deshalb erst
                          nach dem Wiederherstellen irgendwohin. Er steht als
                          Text, nicht als Link.
                        */}
                        {entry.description}
                        {detail ? (
                          <span className="block text-xs text-muted-foreground">
                            nach dem Wiederherstellen unter {detail}
                          </span>
                        ) : null}
                      </td>
                      <td className="text-muted-foreground">
                        {formatRelative(new Date(entry.deletedAt))}
                      </td>
                      <td>
                        <div className="flex justify-end">
                          <ActionButton
                            endpoint={`${RESTORE_PATH[entry.model]}/${entry.id}/restore`}
                            label="Wiederherstellen"
                            variant="outline"
                            size="sm"
                            successMessage={`${entry.label} wiederhergestellt.`}
                            redirectTo={detail ? `${detail}/${entry.id}` : undefined}
                          >
                            <Undo2 aria-hidden />
                          </ActionButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        </ListCard>
      )}

      <p className="text-sm text-muted-foreground">
        Endgültig gelöscht wird hier nichts. Was aus Datenschutzgründen verschwinden muss, läuft
        über den{' '}
        <Link href="/admin/kunden" className="text-primary underline underline-offset-4">
          Kundendatensatz
        </Link>{' '}
        und die Aufbewahrungsfristen der Buchführung.
      </p>
    </div>
  );
}
