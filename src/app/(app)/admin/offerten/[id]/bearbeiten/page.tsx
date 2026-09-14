import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { NotFoundError } from '@/lib/errors';
import { getOrganizationId } from '@/server/services/organization.service';
import { getQuoteDetail } from '@/server/services/quote.service';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { PageHeader } from '@/components/app/page-parts';
import { QuoteEditor } from '@/features/admin/quote-editor';

export const metadata: Metadata = {
  title: 'Offerte bearbeiten',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Offerte bearbeiten.
 *
 * Bearbeitbar sind nur Entwürfe und versendete Offerten. Eine angenommene
 * Offerte ist die Grundlage eines Vertrags — sie wird nicht nachträglich
 * verändert, sondern dupliziert. Dieselbe Regel setzt `updateQuote` auf dem
 * Server durch; hier steht sie nur, damit man es sieht, bevor man tippt.
 */
export default async function EditQuotePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission('quote:update');

  const { id } = await params;
  const organizationId = await getOrganizationId();

  const quote = await getQuoteDetail({ organizationId, quoteId: id }).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  const locked = ['ACCEPTED', 'REJECTED', 'EXPIRED', 'CONVERTED'].includes(quote.status);

  const [customers, services] = await Promise.all([
    prisma.customer.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: [{ lastBookingAt: 'desc' }, { lastName: 'asc' }],
      take: 300,
      select: { id: true, number: true, firstName: true, lastName: true, companyName: true },
    }),
    prisma.service.findMany({
      where: { organizationId, active: true },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        name: true,
        kind: true,
        pricingModel: true,
        hourlyRate: true,
        pricePerSqm: true,
        basePrice: true,
        vatRate: true,
      },
    }),
  ]);

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href={`/admin/offerten/${quote.id}`}>
          <ArrowLeft aria-hidden />
          Zurück zur Offerte
        </Link>
      </Button>

      <PageHeader
        title={`Offerte ${quote.number} bearbeiten`}
        description={quote.title}
      />

      {locked ? (
        <Alert variant="warning" title="Diese Offerte ist abgeschlossen">
          Angenommene, abgelehnte und abgelaufene Offerten werden nicht mehr verändert. Erstellen
          Sie stattdessen eine Kopie — so bleibt nachvollziehbar, worüber die Kundschaft
          entschieden hat.
        </Alert>
      ) : (
        <QuoteEditor
          quoteId={quote.id}
          customers={customers.map((customer) => ({
            id: customer.id,
            label: `${customer.companyName ?? `${customer.firstName} ${customer.lastName}`} · ${customer.number}`,
          }))}
          services={services.map((service) => ({
            id: service.id,
            name: service.name,
            kind: service.kind,
            pricingModel: service.pricingModel,
            hourlyRate: service.hourlyRate ? toNumber(service.hourlyRate) : null,
            pricePerSqm: service.pricePerSqm ? toNumber(service.pricePerSqm) : null,
            basePrice: toNumber(service.basePrice),
            vatRate: toNumber(service.vatRate),
          }))}
          initial={{
            customerId: quote.customerId ?? undefined,
            title: quote.title,
            validUntil: quote.validUntil,
            introText: quote.introText ?? '',
            outroText: quote.outroText ?? '',
            discountType: quote.discountType ?? undefined,
            discountValue: toNumber(quote.discountValue),
            items: quote.items.map((item) => ({
              serviceId: item.serviceId ?? undefined,
              name: item.name,
              description: item.description ?? undefined,
              quantity: toNumber(item.quantity),
              unit: item.unit,
              unitPrice: toNumber(item.unitPrice),
              discount: toNumber(item.discount),
              vatRate: toNumber(item.vatRate),
              optional: item.optional,
            })),
          }}
        />
      )}
    </div>
  );
}
