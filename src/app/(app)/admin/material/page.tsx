import type { Metadata } from 'next';
import Link from 'next/link';
import { Package } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { toNumber } from '@/lib/db';
import { formatCurrency } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { listMaterials } from '@/server/services/inventory.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DetailSection, EmptyState, ListCard, PageHeader, TableScroll } from '@/components/app/page-parts';
import { FormDialog } from '@/components/app/resource-form';
import { materialFields, movementFields } from '@/features/admin/betrieb-fields';

export const metadata: Metadata = {
  title: 'Material',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Material und Lager (Wave 11). Der Bestand ist die Summe der Bewegungen —
 * es gibt kein Feld, ihn zu setzen; berichtigt wird mit einer Gegenbuchung.
 */
export default async function MaterialPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requirePermission('inventory:read');
  const params = await searchParams;
  const nurNachbestellen = params.nachbestellen === '1';
  const materialien = await listMaterials({ organizationId: await getOrganizationId(), nachbestellen: nurNachbestellen });
  const darf = can(session.role, 'inventory:manage');
  const lagerwert = materialien.reduce((s, m) => s + m.lagerwert, 0);
  const nachbestellen = materialien.filter((m) => m.nachbestellen).length;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Material und Lager"
        description={`Lagerwert ${formatCurrency(lagerwert)} · ${nachbestellen} Artikel am oder unter dem Meldebestand.`}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={nurNachbestellen ? '/admin/material' : '/admin/material?nachbestellen=1'}>
                {nurNachbestellen ? 'Alle Artikel' : 'Nur nachbestellen'}
              </Link>
            </Button>
            {darf ? (
              <FormDialog
                title="Material anlegen"
                triggerLabel="Material"
                endpoint="/api/materials"
                successMessage="Material angelegt."
                fields={materialFields()}
                values={{ unit: 'Stk.', unitCost: 0, minStock: 0 }}
              />
            ) : null}
          </>
        }
      />

      <DetailSection title="Artikel" body="flush">
        {materialien.length === 0 ? (
          <EmptyState className="m-4" icon={<Package aria-hidden />} title="Kein Material" description="Reinigungsmittel, Säcke, Tücher — alles, was aus dem Lager kommt." />
        ) : (
          <ListCard>
            <TableScroll>
              <table className="data-table">
                <caption className="sr-only">Material</caption>
                <thead>
                  <tr>
                    <th scope="col">Artikel</th>
                    <th scope="col" className="text-right">Bestand</th>
                    <th scope="col" className="text-right">Meldebestand</th>
                    <th scope="col" className="text-right">Preis</th>
                    <th scope="col" className="text-right">Lagerwert</th>
                    <th scope="col"><span className="sr-only">Buchen</span></th>
                  </tr>
                </thead>
                <tbody>
                  {materialien.map((m) => (
                    // Der Anker ist das Ziel eines Scans (`scan.service.ts`) —
                    // Material hat keine eigene Detailseite.
                    <tr key={m.id} id={`material-${m.id}`} className="scroll-mt-24 target:bg-primary/10">
                      <td className="font-medium">
                        {m.name}
                        <span className="block text-xs text-muted-foreground">
                          {m.sku}
                          {m.barcode ? ` · ${m.barcode}` : ''}
                        </span>
                      </td>
                      <td className="num">
                        {m.bestand.toLocaleString('de-CH')} {m.unit}{' '}
                        {m.nachbestellen ? <Badge size="sm" variant="warning">nachbestellen</Badge> : null}
                      </td>
                      <td className="num text-muted-foreground">{toNumber(m.minStock).toLocaleString('de-CH')}</td>
                      <td className="num">{formatCurrency(toNumber(m.unitCost))}</td>
                      <td className="num">{formatCurrency(m.lagerwert)}</td>
                      <td className="text-right">
                        {darf ? (
                          <FormDialog
                            title={`Bewegung buchen — ${m.name}`}
                            description="Bewegungen sind unveränderlich; eine falsche Buchung wird mit einer Gegenbuchung berichtigt."
                            triggerLabel="Buchen"
                            triggerVariant="ghost"
                            triggerSize="sm"
                            plainTrigger
                            endpoint={`/api/materials/${m.id}/movements`}
                            successMessage="Gebucht."
                            fields={movementFields()}
                            values={{ kind: 'RECEIPT' }}
                          />
                        ) : null}
                        {darf ? (
                          <Button asChild variant="ghost" size="sm">
                            <Link href={`/admin/etikett/MATERIAL/${m.id}`}>Etikett</Link>
                          </Button>
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
