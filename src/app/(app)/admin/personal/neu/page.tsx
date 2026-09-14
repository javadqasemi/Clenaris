import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { requirePagePermission } from '@/lib/auth/session';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-parts';
import { EmployeeForm } from '@/features/admin/employee-form';

export const metadata: Metadata = {
  title: 'Neue/r Mitarbeitende/r',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Personal anlegen — für Administration und Systemverantwortung.
 *
 * Mit dem Datensatz entstehen Lohnfelder, AHV-Nummer und IBAN; die
 * Betriebsleitung disponiert, stellt aber nicht ein. Geprüft wird die
 * Berechtigung `employee:create`, nicht die Rolle: `requireRole('ADMIN')`
 * schloss die Systemverantwortung aus, obwohl der Endpunkt sie zulässt.
 * Die Seite ist eine reine Eingabemaske und antwortet Unberechtigten mit
 * 404 statt mit einer Fehlerseite — sie soll für sie nicht existieren.
 */
export default async function NewEmployeePage() {
  await requirePagePermission('employee:create');

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
