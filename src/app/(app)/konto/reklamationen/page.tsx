import type { Metadata } from 'next';
import { MessageSquareWarning } from 'lucide-react';

import { requireCustomerId } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { formatDateTime } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { STATUS_BESCHRIFTUNG, listOwnComplaints } from '@/server/services/complaint.service';
import { Badge } from '@/components/ui/badge';
import { DetailSection, EmptyState, PageHeader } from '@/components/app/page-parts';
import { FormDialog } from '@/components/app/resource-form';
import { ownComplaintFields } from '@/features/admin/betrieb-fields';

export const metadata: Metadata = {
  title: 'Reklamationen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Reklamationen im Kundenbereich (Wave 11): melden und den Stand verfolgen —
 * samt der vertraglich zugesagten Reaktionszeit. Sichtbar ist, was die
 * Kundschaft betrifft; die interne Notiz steht nicht in der Abfrage.
 */
export default async function OwnComplaintsPage() {
  const { customerId } = await requireCustomerId();
  const organizationId = await getOrganizationId();
  const [meldungen, objekte] = await Promise.all([
    listOwnComplaints({ organizationId, customerId }),
    prisma.property.findMany({
      where: { customerId, deletedAt: null },
      select: { id: true, label: true },
      orderBy: { label: 'asc' },
    }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reklamationen"
        description="Etwas war nicht in Ordnung? Melden Sie es hier — Sie sehen, wann wir reagiert haben und was getan wurde."
        actions={
          <FormDialog
            title="Reklamation melden"
            triggerLabel="Melden"
            endpoint="/api/account/complaints"
            successMessage="Danke — Ihre Meldung ist eingegangen."
            fields={ownComplaintFields(objekte.map((o) => ({ value: o.id, label: o.label })))}
            values={{ kind: 'COMPLAINT' }}
          />
        }
      />
      <DetailSection title="Ihre Meldungen" body="flush">
        {meldungen.length === 0 ? (
          <EmptyState className="m-4" icon={<MessageSquareWarning aria-hidden />} title="Keine Meldungen" description="Hoffentlich bleibt das so." />
        ) : (
          <ul className="divide-y divide-border">
            {meldungen.map((m) => (
              <li key={m.id} className="space-y-1 px-6 py-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {m.number} — {m.title}
                  </span>
                  <Badge size="sm" variant="outline">{STATUS_BESCHRIFTUNG[m.status]}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Gemeldet {formatDateTime(m.reportedAt)}
                  {m.responseDueAt ? ` · Reaktion zugesagt bis ${formatDateTime(m.responseDueAt)}` : ''}
                  {m.acknowledgedAt ? ` · bestätigt ${formatDateTime(m.acknowledgedAt)}` : ''}
                </p>
                {m.resolution ? <p className="text-muted-foreground">{m.resolution}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
    </div>
  );
}
