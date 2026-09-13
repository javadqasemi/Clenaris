import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { prisma, toNumber, type Prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { NotFoundError } from '@/lib/errors';
import { getOrganizationId } from '@/server/services/organization.service';
import { getBookingDetail } from '@/server/services/booking.service';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { PageHeader } from '@/components/app/page-parts';
import { BookingEditor } from '@/features/admin/booking-editor';

export const metadata: Metadata = {
  title: 'Auftrag bearbeiten',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Auftrag bearbeiten.
 *
 * Ein abgeschlossener oder stornierter Auftrag bleibt lesbar, aber
 * unveränderlich: Er ist die Grundlage einer Rechnung und einer
 * Lohnabrechnung. Was daran nicht stimmt, wird korrigiert, indem ein neuer
 * Auftrag entsteht — nicht, indem der alte still anders aussieht.
 */
const LOCKED_STATUS = ['COMPLETED', 'CANCELLED'];

export default async function EditBookingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePermission('booking:update');

  const { id } = await params;
  const organizationId = await getOrganizationId();

  const booking = await getBookingDetail({ organizationId, bookingId: id }).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  const locked = LOCKED_STATUS.includes(booking.status);

  const [customers, addresses, properties, services, extras] = await Promise.all([
    prisma.customer.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: [{ lastBookingAt: 'desc' }, { lastName: 'asc' }],
      take: 300,
      select: { id: true, number: true, firstName: true, lastName: true, companyName: true },
    }),
    // Nur die Adressen der Kundschaft dieses Auftrags — eine fremde Adresse
    // anzubieten wäre ein Datenleck in einer Auswahlliste.
    prisma.address.findMany({
      where: { customerId: booking.customerId },
      orderBy: { isDefault: 'desc' },
      select: { id: true, label: true, street: true, streetNo: true, postalCode: true, city: true },
    }),
    prisma.property.findMany({
      where: { customerId: booking.customerId, deletedAt: null },
      select: { id: true, label: true },
    }),
    prisma.service.findMany({
      where: { organizationId, active: true },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        name: true,
        pricingModel: true,
        hourlyRate: true,
        pricePerSqm: true,
        basePrice: true,
        defaultDurationMin: true,
      },
    }),
    prisma.serviceExtra.findMany({
      where: { organizationId, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, price: true },
    }),
  ]);

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href={`/admin/buchungen/${booking.id}`}>
          <ArrowLeft aria-hidden />
          Zurück zum Auftrag
        </Link>
      </Button>

      <PageHeader
        title={`Auftrag ${booking.number} bearbeiten`}
        description={
          booking.customer.companyName ??
          `${booking.customer.firstName} ${booking.customer.lastName}`
        }
      />

      {locked ? (
        <Alert variant="warning" title="Dieser Auftrag ist abgeschlossen">
          Abgeschlossene und stornierte Aufträge werden nicht mehr verändert — an ihnen hängen
          Rechnung und Lohnabrechnung. Erfassen Sie stattdessen einen neuen Auftrag; die Historie
          bleibt so nachvollziehbar.
        </Alert>
      ) : (
        <BookingEditor
          bookingId={booking.id}
          bookingNumber={booking.number}
          canEditPricing={can(session.role, 'pricing:update')}
          canChangeCustomer={can(session.role, 'customer:update')}
          customers={customers.map((customer) => ({
            id: customer.id,
            label: `${customer.companyName ?? `${customer.firstName} ${customer.lastName}`} · ${customer.number}`,
          }))}
          addresses={addresses.map((address) => ({
            id: address.id,
            label: `${address.label ? `${address.label}: ` : ''}${address.street} ${address.streetNo ?? ''}, ${address.postalCode} ${address.city}`.replace(
              /\s+/g,
              ' ',
            ),
          }))}
          properties={properties.map((property) => ({ id: property.id, label: property.label }))}
          services={services.map((service) => ({
            id: service.id,
            name: service.name,
            // Einheit und Ansatz folgen dem Preismodell der Leistung — dieselbe
            // Zuordnung wie in der Offerte, damit Auftrag und Offerte dieselbe
            // Sprache sprechen.
            unit: unitFor(service.pricingModel),
            unitPrice: defaultRateFor(service),
            defaultDurationMin: service.defaultDurationMin,
          }))}
          extras={extras.map((extra) => ({
            id: extra.id,
            name: extra.name,
            price: toNumber(extra.price),
          }))}
          initial={{
            status: booking.status,
            scheduledStart: booking.scheduledStart,
            durationMin: booking.durationMin,
            crewSize: booking.crewSize,
            customerId: booking.customerId,
            addressId: booking.addressId ?? undefined,
            propertyId: booking.propertyId,
            propertyKind: booking.propertyKind,
            squareMeters: booking.squareMeters,
            rooms: booking.rooms ? toNumber(booking.rooms) : null,
            windows: booking.windows,
            frequency: booking.frequency,
            travelFee: toNumber(booking.travelFee),
            discountAmount: toNumber(booking.discountAmount),
            vatRate: toNumber(booking.vatRate),
            items: booking.items.map((item) => ({
              serviceId: item.serviceId,
              name: item.name,
              description: item.description,
              quantity: toNumber(item.quantity),
              unit: item.unit,
              unitPrice: toNumber(item.unitPrice),
              durationMin: item.durationMin,
            })),
            extras: booking.extras.map((extra) => ({
              extraId: extra.extraId,
              name: extra.name,
              quantity: extra.quantity,
              unitPrice: toNumber(extra.unitPrice),
            })),
            accessNote: booking.accessNote,
            customerNote: booking.customerNote,
            internalNote: booking.internalNote,
          }}
        />
      )}
    </div>
  );
}

/** Die Mengeneinheit, die zum Preismodell einer Leistung passt. */
function unitFor(pricingModel: string): string {
  switch (pricingModel) {
    case 'PER_SQM':
      return 'm²';
    case 'PER_UNIT':
      return 'Stk.';
    case 'FLAT':
      return 'Pauschal';
    default:
      return 'Std.';
  }
}

/** Der Ansatz, der zum Preismodell gehört — nicht pauschal der Stundensatz. */
function defaultRateFor(service: {
  pricingModel: string;
  hourlyRate: Prisma.Decimal | null;
  pricePerSqm: Prisma.Decimal | null;
  basePrice: Prisma.Decimal;
}): number {
  switch (service.pricingModel) {
    case 'PER_SQM':
      return toNumber(service.pricePerSqm);
    case 'FLAT':
      return toNumber(service.basePrice);
    default:
      return toNumber(service.hourlyRate);
  }
}
