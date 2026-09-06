import type { Metadata } from 'next';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { getOrganizationId } from '@/server/services/organization.service';
import { listEmployees } from '@/server/services/employee.service';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-parts';
import { DispatchCalendar } from '@/features/admin/dispatch-calendar.lazy';

export const metadata: Metadata = {
  title: 'Einsatzkalender',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AdminCalendarPage() {
  await requirePermission('job:read');

  const organizationId = await getOrganizationId();
  const employees = await listEmployees({ organizationId });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Einsatzkalender"
        description="Einsätze per Drag & Drop verschieben, Dauer am Rand ziehen, per Klick Team zuteilen. Jede Änderung prüft der Server auf Kapazität und Doppelbelegung."
        actions={
          <Button asChild variant="outline">
            <Link href="/admin/ki?werkzeug=disposition">
              <Sparkles aria-hidden />
              KI-Tagesplanung
            </Link>
          </Button>
        }
      />

      <DispatchCalendar
        employees={employees.map((employee) => ({
          id: employee.id,
          name: `${employee.user.firstName} ${employee.user.lastName}`,
          firstName: employee.user.firstName,
          lastName: employee.user.lastName,
          color: employee.color,
          avatarUrl: employee.user.avatarUrl,
        }))}
      />
    </div>
  );
}
