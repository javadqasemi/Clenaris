import type { Metadata } from 'next';
import Link from 'next/link';
import { ClipboardList } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { formatDateTime } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { listSiteVisits } from '@/server/services/site-visit.service';
import { Badge } from '@/components/ui/badge';
import { DetailSection, EmptyState, ListCard, PageHeader, TableScroll } from '@/components/app/page-parts';
import { FormDialog } from '@/components/app/resource-form';
import { siteVisitFields } from '@/features/admin/verkauf-fields';

export const metadata: Metadata = {
  title: 'Besichtigungen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const STAND: Record<string, { text: string; variant: 'info' | 'success' | 'neutral' }> = {
  PLANNED: { text: 'Geplant', variant: 'info' },
  DONE: { text: 'Durchgeführt', variant: 'success' },
  CANCELLED: { text: 'Abgesagt', variant: 'neutral' },
};

/**
 * Besichtigungen / Objektaufnahmen (Wave 12): planen, Flächen aufnehmen,
 * berechnen, offerieren. Der Preis kommt aus derselben Berechnung wie die
 * Online-Buchung.
 */
export default async function SiteVisitsPage() {
  const session = await requirePermission('quote:read');
  const organizationId = await getOrganizationId();
  const darf = can(session.role, 'quote:create');
  const [besichtigungen, anfragen, kunden, personen] = await Promise.all([
    listSiteVisits({ organizationId }),
    darf
      ? prisma.lead.findMany({
          where: { organizationId, deletedAt: null, status: { notIn: ['WON', 'LOST'] } },
          select: { id: true, firstName: true, lastName: true, company: true },
          orderBy: { createdAt: 'desc' },
          take: 200,
        })
      : Promise.resolve([]),
    darf
      ? prisma.customer.findMany({
          where: { organizationId, deletedAt: null },
          select: { id: true, number: true, companyName: true, firstName: true, lastName: true },
          orderBy: { number: 'asc' },
          take: 500,
        })
      : Promise.resolve([]),
    darf
      ? prisma.user.findMany({
          where: { organizationId, role: { in: ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EMPLOYEE'] }, status: 'ACTIVE' },
          select: { id: true, firstName: true, lastName: true },
          orderBy: { lastName: 'asc' },
        })
      : Promise.resolve([]),
  ]);
  const name = (p: { companyName?: string | null; company?: string | null; firstName?: string | null; lastName?: string | null }) =>
    p.companyName ?? p.company ?? `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim();

  return (
    <div className="space-y-8">
      <PageHeader
        title="Besichtigungen"
        description="Vor Ort aufnehmen, was offeriert wird. Gerechnet wird mit dem Katalog — kein Preis aus dem Kopf."
        actions={
          darf ? (
            <FormDialog
              title="Besichtigung planen"
              triggerLabel="Planen"
              endpoint="/api/site-visits"
              successMessage="Besichtigung geplant."
              fields={siteVisitFields(
                anfragen.map((a) => ({ value: a.id, label: name(a) })),
                kunden.map((k) => ({ value: k.id, label: `${name(k)} (${k.number})` })),
                personen.map((p) => ({ value: p.id, label: `${p.firstName} ${p.lastName}` })),
              )}
              values={{ propertyKind: 'OFFICE' }}
            />
          ) : null
        }
      />
      <DetailSection title="Termine" body="flush">
        {besichtigungen.length === 0 ? (
          <EmptyState className="m-4" icon={<ClipboardList aria-hidden />} title="Keine Besichtigungen" description="Für Objekte, die man gesehen haben muss, bevor man offeriert." />
        ) : (
          <ListCard>
            <TableScroll>
              <table className="data-table">
                <caption className="sr-only">Besichtigungen</caption>
                <thead>
                  <tr>
                    <th scope="col">Nummer</th>
                    <th scope="col">Für</th>
                    <th scope="col">Termin</th>
                    <th scope="col">Flächen</th>
                    <th scope="col">Stand</th>
                    <th scope="col">Offerte</th>
                  </tr>
                </thead>
                <tbody>
                  {besichtigungen.map((b) => (
                    <tr key={b.id}>
                      <td className="font-medium">
                        <Link href={`/admin/besichtigungen/${b.id}`} className="hover:text-primary">
                          {b.number}
                        </Link>
                      </td>
                      <td>{b.customer ? name(b.customer) : b.lead ? `${name(b.lead)} (Anfrage)` : '—'}</td>
                      <td className="text-muted-foreground">{formatDateTime(b.scheduledAt)}</td>
                      <td className="num">{b._count.areas}</td>
                      <td>
                        <Badge size="sm" variant={STAND[b.status]!.variant}>{STAND[b.status]!.text}</Badge>
                      </td>
                      <td>
                        {b.quote ? (
                          <Link href={`/admin/offerten/${b.quote.id}`} className="hover:text-primary">
                            {b.quote.number}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </ListCard>
        )}
      </DetailSection>
    </div>
  );
}
