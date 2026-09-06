import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-parts';
import { CustomerForm } from '@/features/admin/customer-form';

export const metadata: Metadata = {
  title: 'Neuer Kunde',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function NewCustomerPage() {
  await requirePermission('customer:create');

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/kunden">
          <ArrowLeft aria-hidden />
          Alle Kunden
        </Link>
      </Button>

      <PageHeader
        title="Neuer Kunde"
        description="Für Anfragen, die am Telefon kommen. Web-Anfragen legen wir automatisch als Lead an."
      />

      <CustomerForm />
    </div>
  );
}
