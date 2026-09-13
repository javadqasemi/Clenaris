import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { getOrganizationId } from '@/server/services/organization.service';
import { listObjectiveOptions, listStaffOptions } from '@/server/services/fuehrung-options.service';
import { Button } from '@/components/ui/button';
import { DetailSection, PageHeader } from '@/components/app/page-parts';
import { ResourceForm } from '@/features/fuehrung/resource-form';
import { objectiveFields } from '@/features/fuehrung/objective-fields';

export const metadata: Metadata = {
  title: 'Ziel anlegen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function NewObjectivePage({ searchParams }: { searchParams: Promise<{ flughoehe?: string; eltern?: string }> }) {
  await requirePermission('objective:create');
  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const [staff, parents] = await Promise.all([listStaffOptions(organizationId), listObjectiveOptions(organizationId)]);
  const year = new Date().getFullYear();
  const quarter = Math.floor(new Date().getMonth() / 3) + 1;

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/fuehrung/ziele">
          <ArrowLeft aria-hidden />
          Alle Ziele
        </Link>
      </Button>
      <PageHeader title="Ziel anlegen" description="Ein Ziel braucht Titel, Flughöhe und Zeitraum. Schlüsselergebnisse und Massnahmen kommen auf der Detailseite dazu." />
      <DetailSection title="Angaben" body="form" className="max-w-3xl">
        <ResourceForm
          fields={objectiveFields({ staff, parents })}
          values={{ horizon: params.flughoehe ?? 'OBJECTIVE', level: 'COMPANY', status: 'DRAFT', priority: 'NORMAL', fiscalYear: year, quarter: params.flughoehe === 'STRATEGY' ? '' : String(quarter), parentId: params.eltern ?? '', reviewIntervalDays: 30 }}
          endpoint="/api/bi/objectives"
          submitLabel="Ziel anlegen"
          successMessage="Ziel angelegt."
          redirectTo="/admin/fuehrung/ziele/{id}"
        />
      </DetailSection>
    </div>
  );
}
