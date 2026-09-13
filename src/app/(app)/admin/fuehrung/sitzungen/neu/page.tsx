import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { getOrganizationId } from '@/server/services/organization.service';
import { listObjectiveOptions, listStaffOptions } from '@/server/services/fuehrung-options.service';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-parts';
import { MeetingForm } from '@/features/fuehrung/meeting-form';

export const metadata: Metadata = {
  title: 'Sitzung anlegen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function NewMeetingPage() {
  await requirePermission('meeting:create');
  const organizationId = await getOrganizationId();
  const [staff, objectives] = await Promise.all([listStaffOptions(organizationId), listObjectiveOptions(organizationId)]);

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/fuehrung/sitzungen">
          <ArrowLeft aria-hidden />
          Alle Sitzungen
        </Link>
      </Button>
      <PageHeader title="Sitzung anlegen" description="Traktanden vorab, Protokoll und Beschlüsse danach. Pendenzen werden beim Speichern zu Aufgaben." />
      <div className="max-w-4xl">
        <MeetingForm mode="create" staff={staff} objectives={objectives} />
      </div>
    </div>
  );
}
