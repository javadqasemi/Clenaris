import type { Metadata } from 'next';
import Link from 'next/link';
import { Building2, KeyRound } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatDate, toQueryString } from '@/lib/utils';
import { PropertyRowActions } from '@/features/shared/property-dialog';
import { getOrganizationId } from '@/server/services/organization.service';
import { Badge } from '@/components/ui/badge';
import { KpiTile } from '@/components/app/kpi-tile';
import { FilterBar } from '@/components/app/filter-bar';
import {
  EmptyState,
  ListCard,
  PageHeader,
  Pagination,
  TableScroll,
} from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Objekte',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const KIND_LABELS: Record<string, string> = {
  APARTMENT: 'Wohnung',
  HOUSE: 'Haus',
  OFFICE: 'Büro',
  COMMERCIAL: 'Ladenlokal',
  INDUSTRIAL: 'Gewerbe',
  CONSTRUCTION_SITE: 'Baustelle',
  PRACTICE: 'Praxis',
  RESTAURANT: 'Gastronomie',
  SCHOOL: 'Schule',
  OTHER: 'Anderes',
};

export default async function PropertiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePermission('property:read');
  // Objekte entstehen an der Kundenakte (dort ist die Adresse bekannt); hier
  // werden sie korrigiert und aufgeräumt.
  const canEdit = can(session.role, 'property:update');
  const canDelete = can(session.role, 'property:delete');

  const params = await searchParams;
  const organizationId = await getOrganizationId();

  const page = Math.max(1, Number(params.seite) || 1);
  const pageSize = 25;

  const where = {
    deletedAt: null,
    customer: { organizationId, deletedAt: null },
    ...(params.art ? { kind: params.art as never } : {}),
    ...(params.q
      ? {
          OR: [
            { label: { contains: params.q, mode: 'insensitive' as const } },
            { customer: { lastName: { contains: params.q, mode: 'insensitive' as const } } },
            { customer: { companyName: { contains: params.q, mode: 'insensitive' as const } } },
            { address: { city: { contains: params.q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };

  const [properties, total, withKeys, totalArea] = await Promise.all([
    prisma.property.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, companyName: true } },
        address: { select: { street: true, streetNo: true, postalCode: true, city: true } },
        _count: { select: { bookings: true, jobs: true } },
      },
    }),
    prisma.property.count({ where }),
    prisma.property.count({
      where: { ...where, keyLocation: { not: null } },
    }),
    prisma.property.aggregate({
      where: { deletedAt: null, customer: { organizationId, deletedAt: null } },
      _sum: { squareMeters: true },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const baseHref = `/admin/objekte${toQueryString({ q: params.q, art: params.art })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Objekte"
        description="Wohnungen, Büros und Liegenschaften mit gespeicherten Kennzahlen und Zugangsinformationen. Sie beschleunigen jede weitere Buchung."
      >
        <FilterBar
          searchPlaceholder="Objekt, Kundschaft oder Ort …"
          filters={[
            {
              param: 'art',
              label: 'Objektart',
              options: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })),
            },
          ]}
        />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile label="Erfasste Objekte" value={String(total)} />
        <KpiTile
          label="Betreute Fläche"
          value={`${(totalArea._sum.squareMeters ?? 0).toLocaleString('de-CH')} m²`}
        />
        <KpiTile
          label="Mit Schlüsseldepot"
          value={String(withKeys)}
          hint="Zugang ohne Anwesenheit möglich"
        />
      </div>

      {properties.length === 0 ? (
        <EmptyState
          icon={<Building2 aria-hidden />}
          title="Keine Objekte gefunden"
          description="Objekte entstehen bei der Buchung oder werden am Kundendatensatz erfasst. Sie speichern Fläche, Zimmerzahl und Zugangshinweise."
          action={{ href: '/admin/kunden', label: 'Zu den Kunden' }}
        />
      ) : (
        <ListCard
          footer={
            <Pagination page={page} totalPages={totalPages} total={total} baseHref={baseHref} />
          }
        >
          <TableScroll>
            <table className="data-table">
              <caption className="sr-only">Objektliste. {total} Einträge.</caption>
              <thead>
                <tr>
                  <th scope="col">Objekt</th>
                  <th scope="col">Kundschaft</th>
                  <th scope="col">Adresse</th>
                  <th scope="col">Kennzahlen</th>
                  <th scope="col" className="text-right">
                    Einsätze
                  </th>
                  <th scope="col">Erfasst</th>
                  {canEdit ? (
                    <th scope="col" className="text-right">
                      <span className="sr-only">Aktionen</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {properties.map((property) => (
                  <tr key={property.id}>
                    <td>
                      <span className="block font-medium">{property.label}</span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="neutral" size="sm">
                          {KIND_LABELS[property.kind] ?? property.kind}
                        </Badge>
                        {property.keyLocation ? (
                          <span
                            className="inline-flex items-center gap-1 text-xs text-primary"
                            title="Schlüssel hinterlegt"
                          >
                            <KeyRound className="size-3" aria-hidden />
                            Schlüssel
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td>
                      <Link
                        href={`/admin/kunden/${property.customer.id}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {property.customer.companyName ??
                          `${property.customer.firstName} ${property.customer.lastName}`}
                      </Link>
                    </td>
                    <td className="text-muted-foreground">
                      {property.address
                        ? `${property.address.street} ${property.address.streetNo ?? ''}, ${property.address.postalCode} ${property.address.city}`
                        : '—'}
                    </td>
                    <td className="text-muted-foreground">
                      {[
                        property.squareMeters ? `${property.squareMeters} m²` : null,
                        property.rooms ? `${toNumber(property.rooms)} Zi.` : null,
                        property.bathrooms ? `${property.bathrooms} Bad` : null,
                        property.windows ? `${property.windows} Fenster` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                    <td className="num">{property._count.jobs}</td>
                    <td className="text-muted-foreground">{formatDate(property.createdAt)}</td>
                    {canEdit ? (
                      <td>
                        <div className="flex justify-end">
                          <PropertyRowActions
                            propertyId={property.id}
                            canDelete={canDelete}
                            values={{
                              label: property.label,
                              kind: property.kind,
                              addressId: property.addressId,
                              squareMeters: property.squareMeters,
                              rooms: property.rooms ? toNumber(property.rooms) : null,
                              bathrooms: property.bathrooms,
                              windows: property.windows,
                              floor: property.floor,
                              hasBalcony: property.hasBalcony,
                              hasGarden: property.hasGarden,
                              hasPets: property.hasPets,
                              hasElevator: property.hasElevator,
                              parkingInfo: property.parkingInfo,
                              keyLocation: property.keyLocation,
                              accessNote: property.accessNote,
                              notes: property.notes,
                            }}
                          />
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </ListCard>
      )}
    </div>
  );
}
