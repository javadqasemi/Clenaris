import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { formatDate } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-parts';
import { InvoiceForm } from '@/features/admin/invoice-form';

export const metadata: Metadata = {
  title: 'Neue Rechnung',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Rechnung erstellen.
 *
 * Die Liste der noch nicht verrechneten Einsätze wird gleich mitgeladen: der
 * häufigste Fall ist „Einsatz erledigt, jetzt Rechnung", und ein Klick spart
 * das Abtippen von Bezeichnung und Betrag.
 */
export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ kunde?: string }>;
}) {
  await requirePermission('invoice:create');

  const params = await searchParams;
  const organizationId = await getOrganizationId();

  const [customers, jobs] = await Promise.all([
    prisma.customer.findMany({
      where: { organizationId, deletedAt: null, blocked: false },
      orderBy: [{ lastBookingAt: 'desc' }, { lastName: 'asc' }],
      take: 300,
      select: {
        id: true,
        number: true,
        firstName: true,
        lastName: true,
        companyName: true,
        paymentTermDays: true,
      },
    }),
    prisma.job.findMany({
      where: {
        organizationId,
        status: 'COMPLETED',
        deletedAt: null,
        invoiceItems: { none: {} },
      },
      orderBy: { scheduledStart: 'desc' },
      take: 40,
      select: {
        id: true,
        number: true,
        title: true,
        customerId: true,
        scheduledStart: true,
        revenue: true,
      },
    }),
  ]);

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/rechnungen">
          <ArrowLeft aria-hidden />
          Alle Rechnungen
        </Link>
      </Button>

      <PageHeader
        title="Neue Rechnung"
        description="Als Entwurf speichern und später ausstellen — oder direkt ausstellen und versenden."
      />

      <InvoiceForm
        defaultCustomerId={params.kunde}
        customers={customers.map((customer) => ({
          id: customer.id,
          label: `${customer.companyName ?? `${customer.firstName} ${customer.lastName}`} · ${customer.number}`,
          paymentTermDays: customer.paymentTermDays,
        }))}
        jobs={jobs.map((job) => ({
          id: job.id,
          customerId: job.customerId,
          label: `${job.title} (${formatDate(job.scheduledStart)})`,
          amount: toNumber(job.revenue),
        }))}
      />
    </div>
  );
}
