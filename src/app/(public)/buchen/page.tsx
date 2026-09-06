import type { Metadata } from 'next';
import { Suspense } from 'react';

import { prisma, toNumber } from '@/lib/db';
import { getSession } from '@/lib/auth/session';
import { pageMetadata } from '@/lib/cms/metadata';
import { getOrganizationId } from '@/server/services/organization.service';
import { BookingWizard } from '@/features/booking/booking-wizard';
import type { BookingService, SavedAddressDto, SavedPropertyDto } from '@/features/booking/types';
import { Skeleton } from '@/components/ui/primitives';

/**
 * Titel, Beschreibung und Vorschaubild kommen aus der Redaktion
 * (`/admin/seo`); fehlt eine Angabe, gilt der Wert aus dem Register.
 */
export const generateMetadata = (): Promise<Metadata> => pageMetadata('/buchen');

// Der Assistent liest Verfügbarkeiten und Kundendaten — nie statisch ausliefern.
export const dynamic = 'force-dynamic';

export default async function BookingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const session = await getSession();

  const services = await prisma.service.findMany({
    where: { organizationId, active: true },
    orderBy: { position: 'asc' },
    include: {
      extras: {
        include: { extra: true },
      },
    },
  });

  // Für angemeldete Kundschaft: Adressen und Objekte vorschlagen.
  let savedAddresses: SavedAddressDto[] = [];
  let savedProperties: SavedPropertyDto[] = [];

  if (session?.role === 'CUSTOMER' && session.profileId) {
    const [addresses, properties] = await Promise.all([
      prisma.address.findMany({
        where: { customerId: session.profileId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          label: true,
          street: true,
          streetNo: true,
          postalCode: true,
          city: true,
          isDefault: true,
        },
      }),
      prisma.property.findMany({
        where: { customerId: session.profileId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          label: true,
          kind: true,
          squareMeters: true,
          rooms: true,
          bathrooms: true,
          windows: true,
          addressId: true,
        },
      }),
    ]);

    savedAddresses = addresses;
    savedProperties = properties.map((property) => ({
      ...property,
      rooms: property.rooms ? toNumber(property.rooms) : null,
    }));
  }

  const bookingServices: BookingService[] = services.map((service) => ({
    id: service.id,
    slug: service.slug,
    name: service.name,
    shortDesc: service.shortDesc,
    kind: service.kind,
    icon: service.icon,
    pricingModel: service.pricingModel,
    hourlyRate: service.hourlyRate ? toNumber(service.hourlyRate) : null,
    pricePerSqm: service.pricePerSqm ? toNumber(service.pricePerSqm) : null,
    basePrice: toNumber(service.basePrice),
    minPrice: toNumber(service.minPrice),
    minHours: toNumber(service.minHours),
    includes: service.includes,
    extras: service.extras
      .filter((link) => link.extra.active)
      .map((link) => ({
        id: link.extra.id,
        slug: link.extra.slug,
        name: link.extra.name,
        description: link.extra.description,
        icon: link.extra.icon,
        price: toNumber(link.extra.price),
        durationMin: link.extra.durationMin,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de-CH')),
  }));

  return (
    <div className="container py-12 sm:py-16">
      <Suspense fallback={<WizardSkeleton />}>
        <BookingWizard
          services={bookingServices}
          isAuthenticated={Boolean(session)}
          savedAddresses={savedAddresses}
          savedProperties={savedProperties}
          prefill={{
            serviceSlug: params.leistung,
            squareMeters: params.flaeche ? Number(params.flaeche) : undefined,
            postalCode: params.plz,
          }}
        />
      </Suspense>
    </div>
  );
}

function WizardSkeleton() {
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-8">
        <Skeleton className="h-8 w-full max-w-lg" />
        <Skeleton className="h-10 w-3/4" />
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-28" />
          ))}
        </div>
      </div>
      <Skeleton className="h-96" />
    </div>
  );
}
