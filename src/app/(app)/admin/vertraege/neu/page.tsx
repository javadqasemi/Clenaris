import type { Metadata } from 'next';

import { requirePagePermission } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { getOrganizationId } from '@/server/services/organization.service';
import { PageHeader } from '@/components/app/page-parts';
import { ContractForm } from '@/features/admin/contract-form';

export const metadata: Metadata = {
  title: 'Vertrag anlegen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function NewContractPage() {
  // Reine Eingabemaske: ohne Schreibrecht 404 statt Fehlergrenze (Audit 2026-09-28).
  await requirePagePermission('contract:create');
  const organizationId = await getOrganizationId();

  const [kunden, objekte, leistungen, personal, offerten] = await Promise.all([
    prisma.customer.findMany({
      where: { organizationId, deletedAt: null, blocked: false },
      orderBy: [{ companyName: 'asc' }, { lastName: 'asc' }],
      take: 500,
      select: { id: true, companyName: true, firstName: true, lastName: true, number: true },
    }),
    prisma.property.findMany({
      where: { customer: { organizationId, deletedAt: null }, deletedAt: null },
      orderBy: { label: 'asc' },
      take: 1000,
      select: { id: true, label: true, customerId: true },
    }),
    prisma.service.findMany({
      where: { organizationId, active: true },
      orderBy: { position: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.employee.findMany({
      where: { organizationId, active: true },
      orderBy: { employeeNumber: 'asc' },
      select: { id: true, user: { select: { firstName: true, lastName: true } } },
    }),
    /**
     * Nur **angenommene** Offerten.
     *
     * Der Dienst weist alles andere ab (422); die Auswahl hier zeigt gar nicht
     * erst, was nicht geht. Beides zusammen ist der Punkt: Die Oberfläche
     * führt, die Schnittstelle entscheidet.
     */
    prisma.quote.findMany({
      where: { organizationId, deletedAt: null, status: 'ACCEPTED' },
      orderBy: { acceptedAt: 'desc' },
      take: 200,
      select: { id: true, number: true, title: true },
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Vertrag anlegen"
        description="Der Entwurf entsteht mit seiner ersten Fassung und einer Leistung. In Kraft tritt er erst, wenn jemand ihn aktiviert — dann erhält er auch seine Nummer."
      />

      <ContractForm
        kunden={kunden.map((k) => ({
          value: k.id,
          label: `${k.companyName ?? `${k.firstName} ${k.lastName}`} (${k.number})`,
        }))}
        objekte={objekte.map((o) => ({ value: o.id, label: o.label, customerId: o.customerId }))}
        leistungen={leistungen.map((l) => ({ value: l.id, label: l.name }))}
        personal={personal.map((p) => ({
          value: p.id,
          label: `${p.user.firstName} ${p.user.lastName}`,
        }))}
        offerten={offerten.map((o) => ({ value: o.id, label: `${o.number} — ${o.title}` }))}
      />
    </div>
  );
}
