import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { fullName } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-parts';
import { LeadForm } from '@/features/admin/lead-form';

export const metadata: Metadata = {
  title: 'Neue Anfrage',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function NewLeadPage() {
  await requirePermission('lead:create');
  const organizationId = await getOrganizationId();

  const [stages, employees] = await Promise.all([
    prisma.pipelineStage.findMany({
      where: { organizationId },
      orderBy: { position: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.employee.findMany({
      where: { organizationId, active: true },
      orderBy: { employeeNumber: 'asc' },
      select: { id: true, user: { select: { firstName: true, lastName: true } } },
    }),
  ]);

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/leads">
          <ArrowLeft aria-hidden />
          Alle Anfragen
        </Link>
      </Button>

      <PageHeader
        title="Neue Anfrage"
        description="Für Anrufe und Empfehlungen. Anfragen über die Website landen automatisch in der Pipeline."
      />

      <LeadForm
        stages={stages}
        employees={employees.map((employee) => ({
          id: employee.id,
          name: fullName(employee.user.firstName, employee.user.lastName),
        }))}
      />
    </div>
  );
}
