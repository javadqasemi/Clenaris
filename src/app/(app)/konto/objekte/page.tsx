import type { Metadata } from 'next';
import { Building2, Home, KeyRound, MapPin } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requireCustomerId } from '@/lib/auth/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, PageHeader } from '@/components/app/page-parts';
import { AddressManager } from '@/features/shared/address-manager';
import { PropertyCreateButton, PropertyRowActions } from '@/features/shared/property-dialog';
import { listAddresses } from '@/server/services/address.service';

export const metadata: Metadata = {
  title: 'Meine Objekte',
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

/**
 * Objekte der Kundschaft.
 *
 * Gespeicherte Objekte beschleunigen jede weitere Buchung erheblich: Fläche,
 * Zimmerzahl und Zugangshinweise sind bereits hinterlegt, der Preis steht
 * nach zwei Klicks.
 */
export default async function AccountPropertiesPage() {
  const { customerId } = await requireCustomerId();

  const [properties, addresses] = await Promise.all([
    prisma.property.findMany({
      where: { customerId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: {
        address: true,
        _count: { select: { bookings: true } },
      },
    }),
    listAddresses(customerId),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Meine Objekte"
        description="Gespeicherte Angaben zu Ihren Räumen. Damit ist die nächste Buchung in zwei Klicks erledigt."
        actions={
          <Button asChild>
            <a href="/buchen">Termin buchen</a>
          </Button>
        }
      />

      {/*
        Objekte: die Kundschaft darf eigene anlegen und ändern
        (`property:create`, `property:update`), aber nicht löschen — ein
        Objekt mit Einsatzhistorie gehört zur Akte. Der Endpunkt prüft die
        Zugehörigkeit; das Formular reicht nur die eigene Kundennummer mit.
      */}
      <section className="space-y-4" aria-label="Objekte">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">Objekte</h2>
          {addresses.length > 0 ? (
            <PropertyCreateButton
              customerId={customerId}
              addresses={addresses.map((address) => ({
                id: address.id,
                label: `${address.label} · ${address.street} ${address.streetNo ?? ''}, ${address.postalCode} ${address.city}`,
              }))}
            />
          ) : null}
        </div>

        {properties.length === 0 ? (
          <EmptyState
            icon={<Building2 aria-hidden />}
            title="Noch kein Objekt gespeichert"
            description="Bei Ihrer ersten Buchung legen wir das Objekt automatisch an — oder Sie erfassen es jetzt. Danach genügen zwei Klicks für einen Folgetermin."
            action={{ href: '/buchen', label: 'Termin buchen' }}
          />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {properties.map((property) => (
              <li
                key={property.id}
                className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-soft"
              >
                <div className="flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
                    <Home className="size-5" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="truncate font-medium">{property.label}</p>
                    <Badge variant="neutral" size="sm">
                      {KIND_LABELS[property.kind] ?? property.kind}
                    </Badge>
                  </div>
                  <PropertyRowActions
                    propertyId={property.id}
                    canDelete={false}
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

                <dl className="protocol-list text-sm">
                  {property.squareMeters ? (
                    <div className="flex items-baseline justify-between gap-4 py-2">
                      <dt className="text-muted-foreground">Fläche</dt>
                      <dd className="tabular-nums">{property.squareMeters} m²</dd>
                    </div>
                  ) : null}
                  {property.rooms ? (
                    <div className="flex items-baseline justify-between gap-4 py-2">
                      <dt className="text-muted-foreground">Zimmer</dt>
                      <dd className="tabular-nums">{toNumber(property.rooms)}</dd>
                    </div>
                  ) : null}
                  {property.bathrooms ? (
                    <div className="flex items-baseline justify-between gap-4 py-2">
                      <dt className="text-muted-foreground">Bäder</dt>
                      <dd className="tabular-nums">{property.bathrooms}</dd>
                    </div>
                  ) : null}
                  {property.windows ? (
                    <div className="flex items-baseline justify-between gap-4 py-2">
                      <dt className="text-muted-foreground">Fenster</dt>
                      <dd className="tabular-nums">{property.windows}</dd>
                    </div>
                  ) : null}
                  <div className="flex items-baseline justify-between gap-4 py-2">
                    <dt className="text-muted-foreground">Bisherige Buchungen</dt>
                    <dd className="tabular-nums">{property._count.bookings}</dd>
                  </div>
                </dl>

                {property.address ? (
                  <p className="flex items-start gap-2 border-t border-border pt-3 text-sm text-muted-foreground">
                    <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    {property.address.street} {property.address.streetNo},{' '}
                    {property.address.postalCode} {property.address.city}
                  </p>
                ) : null}

                {property.keyLocation ? (
                  <p className="flex items-start gap-2 text-sm text-muted-foreground">
                    <KeyRound className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
                    Schlüssel hinterlegt
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Adressen */}
      <section className="space-y-4" aria-label="Adressen">
        <h2 className="font-display text-lg font-semibold tracking-tight">Adressen</h2>

        <AddressManager
          customerId={customerId}
          audience="self"
          canEdit
          addresses={addresses.map((address) => ({
            id: address.id,
            label: address.label,
            street: address.street,
            streetNo: address.streetNo,
            addition: address.addition,
            postalCode: address.postalCode,
            city: address.city,
            canton: address.canton,
            country: address.country,
            accessNote: address.accessNote,
            isDefault: address.isDefault,
            isBilling: address.isBilling,
            usage: address._count.properties + address._count.bookings + address._count.jobs,
          }))}
        />

        <p className="prose-measure text-sm leading-relaxed text-muted-foreground">
          Änderungen wirken sofort — auf künftige Termine und auf neue Rechnungen. Bereits
          ausgestellte Rechnungen behalten die Adresse, die zum Zeitpunkt der Ausstellung galt;
          das schreibt die Buchführung so vor.
        </p>
      </section>
    </div>
  );
}
