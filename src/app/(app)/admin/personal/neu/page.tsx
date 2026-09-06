import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { requireRole } from '@/lib/auth/session';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-parts';
import { EmployeeForm } from '@/features/admin/employee-form';

export const metadata: Metadata = {
  title: 'Neue/r Mitarbeitende/r',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Personal anlegen — ausschliesslich für die Administration.
 *
 * Mit dem Datensatz entstehen Lohnfelder, AHV-Nummer und IBAN; die
 * Betriebsleitung disponiert, stellt aber nicht ein. Dieselbe Schranke gilt
 * auf dem Endpunkt.
 */
export default async function NewEmployeePage() {
  await requireRole('ADMIN');

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/personal">
          <ArrowLeft aria-hidden />
          Alle Mitarbeitenden
        </Link>
      </Button>

      <PageHeader
        title="Neue/r Mitarbeitende/r"
        description="Legt gleichzeitig das Portalkonto an und versendet die Einladung zur Passwortvergabe."
      />

      <EmployeeForm />
    </div>
  );
}
