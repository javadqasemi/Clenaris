import type { Metadata } from 'next';
import Link from 'next/link';
import { MessageSquareWarning } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { formatDateTime } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { STATUS_BESCHRIFTUNG, complaintSlaSummary, listComplaints, type FristStand } from '@/server/services/complaint.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DetailSection, EmptyState, ListCard, PageHeader, TableScroll } from '@/components/app/page-parts';
import { FormDialog } from '@/components/app/resource-form';
import { ART_OPTIONEN, LABEL, SCHWERE_OPTIONEN, complaintFields } from '@/features/admin/betrieb-fields';

export const metadata: Metadata = {
  title: 'Reklamationen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const FRIST: Record<FristStand, { text: string; variant: 'neutral' | 'info' | 'success' | 'destructive' }> = {
  KEINE_ZUSAGE: { text: 'Keine Zusage', variant: 'neutral' },
  LAEUFT: { text: 'Frist läuft', variant: 'info' },
  EINGEHALTEN: { text: 'Eingehalten', variant: 'success' },
  VERPASST: { text: 'Verpasst', variant: 'destructive' },
};

/**
 * Reklamationen und Vorfälle mit Reaktionsfrist (Wave 11).
 *
 * Die Frist steht neben jeder Meldung — gerechnet aus der Vertragsfassung am
 * Meldetag, nicht gepflegt. Oben die Quote der letzten 90 Tage: Eine
 * Zusage, deren Einhaltung niemand misst, ist keine.
 */
export default async function ComplaintsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requirePermission('complaint:read');
  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const nurOffene = params.alle !== '1';

  const [faelle, quote, kunden, zustaendige] = await Promise.all([
    listComplaints({ organizationId, offen: nurOffene }),
    complaintSlaSummary(organizationId, new Date(Date.now() - 90 * 86_400_000)),
    can(session.role, 'complaint:create')
      ? prisma.customer.findMany({
          where: { organizationId, deletedAt: null },
          select: { id: true, number: true, companyName: true, firstName: true, lastName: true },
          orderBy: { number: 'asc' },
          take: 500,
        })
      : Promise.resolve([]),
    prisma.user.findMany({
      where: { organizationId, role: { in: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] }, status: 'ACTIVE' },
      select: { id: true, firstName: true, lastName: true },
      orderBy: { lastName: 'asc' },
    }),
  ]);
  const kundenOptionen = kunden.map((k) => ({
    value: k.id,
    label: `${k.companyName ?? `${k.firstName ?? ''} ${k.lastName ?? ''}`.trim()} (${k.number})`,
  }));
  const zustaendigOptionen = zustaendige.map((z) => ({ value: z.id, label: `${z.firstName} ${z.lastName}` }));
  const artLabel = LABEL(ART_OPTIONEN);
  const schwereLabel = LABEL(SCHWERE_OPTIONEN);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Reklamationen und Vorfälle"
        description="Mit der vertraglich zugesagten Reaktionszeit. Die Frist rechnet der Server aus der Vertragsfassung am Meldetag; ohne Zusage steht keine."
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={nurOffene ? '/admin/reklamationen?alle=1' : '/admin/reklamationen'}>{nurOffene ? 'Alle anzeigen' : 'Nur offene'}</Link>
            </Button>
            {can(session.role, 'complaint:create') ? (
              <FormDialog
                title="Reklamation erfassen"
                triggerLabel="Erfassen"
                endpoint="/api/complaints"
                successMessage="Reklamation erfasst."
                fields={complaintFields(kundenOptionen, zustaendigOptionen)}
                values={{ kind: 'COMPLAINT', severity: 'MEDIUM', channel: 'PHONE' }}
              />
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Mit Zusage (90 Tage)', String(quote.mitZusage)],
          ['Eingehalten', String(quote.eingehalten)],
          ['Verpasst', String(quote.verpasst)],
          ['Quote', quote.quotePct === null ? '—' : `${quote.quotePct.toLocaleString('de-CH')} %`],
        ].map(([label, wert]) => (
          <div key={label} className="rounded-lg border border-border bg-card p-4 shadow-soft">
            <p className="text-meta text-muted-foreground">{label}</p>
            <p className="font-display text-title tabular-nums">{wert}</p>
          </div>
        ))}
      </div>

      <DetailSection title={nurOffene ? 'Offene Meldungen' : 'Alle Meldungen'} body="flush">
        {faelle.length === 0 ? (
          <EmptyState className="m-4" icon={<MessageSquareWarning aria-hidden />} title="Keine Meldungen" description="Hier erscheinen Reklamationen, Vorfälle und Schäden." />
        ) : (
          <ListCard>
            <TableScroll>
              <table className="data-table">
                <caption className="sr-only">Reklamationen</caption>
                <thead>
                  <tr>
                    <th scope="col">Nummer</th>
                    <th scope="col">Betreff</th>
                    <th scope="col">Kundschaft</th>
                    <th scope="col">Gemeldet</th>
                    <th scope="col">Reaktion bis</th>
                    <th scope="col">Stand</th>
                  </tr>
                </thead>
                <tbody>
                  {faelle.map((c) => {
                    const f = FRIST[c.frist];
                    return (
                      <tr key={c.id}>
                        <td className="font-medium">
                          <Link href={`/admin/reklamationen/${c.id}`} className="hover:text-primary">
                            {c.number}
                          </Link>
                        </td>
                        <td>
                          {c.title}
                          <span className="block text-xs text-muted-foreground">
                            {artLabel[c.kind]} · {schwereLabel[c.severity]}
                          </span>
                        </td>
                        <td className="text-muted-foreground">
                          {c.customer.companyName ?? `${c.customer.firstName ?? ''} ${c.customer.lastName ?? ''}`}
                        </td>
                        <td className="text-muted-foreground">{formatDateTime(c.reportedAt)}</td>
                        <td className="text-muted-foreground">{c.responseDueAt ? formatDateTime(c.responseDueAt) : '—'}</td>
                        <td>
                          <Badge size="sm" variant="outline">{STATUS_BESCHRIFTUNG[c.status]}</Badge>{' '}
                          <Badge size="sm" variant={f.variant}>{f.text}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          </ListCard>
        )}
      </DetailSection>
    </div>
  );
}
