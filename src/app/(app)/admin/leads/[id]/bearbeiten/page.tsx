import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { fullName } from '@/lib/utils';
import type { CreateLeadInput } from '@/lib/validation/crm';
import { getOrganizationId } from '@/server/services/organization.service';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-parts';
import { LeadForm } from '@/features/admin/lead-form';

export const metadata: Metadata = {
  title: 'Anfrage bearbeiten',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Anfrage bearbeiten.
 *
 * Dieselbe Maske wie beim Erfassen, vorbefüllt. Anders als Aufträge werden
 * Anfragen nie gesperrt: An ihnen hängt keine Rechnung und keine Abrechnung —
 * eine gewonnene Anfrage mit falscher Telefonnummer ist schlicht eine falsche
 * Telefonnummer, und die soll sich korrigieren lassen.
 *
 * Die Statuswechsel bleiben in der Akte (`LeadActions`): Dort steht die
 * Begründung für „verloren" gleich daneben, hier ginge sie unter.
 */
export default async function EditLeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission('lead:update');

  const { id } = await params;
  const organizationId = await getOrganizationId();

  const [lead, stages, employees] = await Promise.all([
    prisma.lead.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: { tags: { select: { tagId: true } } },
    }),
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

  if (!lead) notFound();

  /*
    `null` aus der Datenbank wird zu `undefined`: Das Schema kennt für
    freiwillige Felder nur „fehlt", und ein `null` im Textfeld zeigte der
    Browser als das Wort „null".
  */
  const values: Partial<CreateLeadInput> = {
    firstName: lead.firstName,
    lastName: lead.lastName,
    email: lead.email,
    phone: lead.phone ?? undefined,
    company: lead.company ?? undefined,
    street: lead.street ?? undefined,
    postalCode: lead.postalCode ?? undefined,
    city: lead.city ?? undefined,
    serviceKind: (lead.serviceKind ?? undefined) as CreateLeadInput['serviceKind'],
    message: lead.message ?? undefined,
    estimatedValue: lead.estimatedValue ? toNumber(lead.estimatedValue) : undefined,
    source: lead.source as CreateLeadInput['source'],
    stageId: lead.stageId ?? undefined,
    ownerId: lead.ownerId ?? undefined,
    nextFollowUpAt: lead.nextFollowUpAt ?? undefined,
    tagIds: lead.tags.map((tag) => tag.tagId),
  };

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href={`/admin/leads/${lead.id}`}>
          <ArrowLeft aria-hidden />
          Zurück zur Anfrage
        </Link>
      </Button>

      <PageHeader
        title={`Anfrage ${lead.number} bearbeiten`}
        description={lead.company ?? fullName(lead.firstName, lead.lastName)}
      />

      <LeadForm
        lead={{ id: lead.id, number: lead.number, values }}
        stages={stages}
        employees={employees.map((employee) => ({
          id: employee.id,
          name: fullName(employee.user.firstName, employee.user.lastName),
        }))}
      />
    </div>
  );
}
