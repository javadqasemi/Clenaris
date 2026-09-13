import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getOrganizationId } from '@/server/services/organization.service';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-parts';
import { QuoteEditor } from '@/features/admin/quote-editor';

export const metadata: Metadata = {
  title: 'Neue Offerte',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ kunde?: string }>;
}) {
  await requirePermission('quote:create');

  const params = await searchParams;
  const organizationId = await getOrganizationId();

  const [customers, services] = await Promise.all([
    prisma.customer.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: [{ lastBookingAt: 'desc' }, { lastName: 'asc' }],
      take: 300,
      select: {
        id: true,
        number: true,
        firstName: true,
        lastName: true,
        companyName: true,
      },
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
        <Link href="/admin/offerten">
          <ArrowLeft aria-hidden />
          Alle Offerten
        </Link>
      </Button>

      <PageHeader
        title="Neue Offerte"
        description="Positionen erfassen, Preis prüfen, versenden. Die Kundschaft kann online annehmen — mit rechtsgültiger digitaler Unterschrift."
      />

      <QuoteEditor
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
        defaultCustomerId={params.kunde}
      />
    </div>
  );
}
