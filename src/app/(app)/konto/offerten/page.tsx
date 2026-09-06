import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Download, FileText } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requireCustomerId } from '@/lib/auth/session';
import { formatCurrency, formatDate } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { listQuotes } from '@/server/services/quote.service';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, ListCard, PageHeader } from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Offerten',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AccountQuotesPage() {
  const { customerId } = await requireCustomerId();
  const organizationId = await getOrganizationId();

  const { items } = await listQuotes({
    organizationId,
    customerId,
    page: 1,
    pageSize: 50,
  });

  // Entwürfe sind interne Vorstufen und gehören nicht in die Kundenansicht.
  const visible = items.filter((quote) => quote.status !== 'DRAFT');
  const open = visible.filter((quote) => ['SENT', 'VIEWED'].includes(quote.status));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Offerten"
        description={
          open.length > 0
            ? `${open.length} ${open.length === 1 ? 'Offerte wartet' : 'Offerten warten'} auf Ihre Antwort. Sie können online annehmen — mit digitaler Unterschrift.`
            : 'Alle Ihre Angebote auf einen Blick.'
        }
      />

      {visible.length === 0 ? (
        <EmptyState
          icon={<FileText aria-hidden />}
          title="Noch keine Offerten"
          description="Für Hauswartung, grosse Objekte oder Sonderfälle erstellen wir Ihnen gerne eine individuelle Offerte."
          action={{ href: '/offerte', label: 'Offerte anfordern' }}
        />
      ) : (
        <ListCard>
          <ul className="divide-y divide-border">
            {visible.map((quote) => {
              const isOpen = ['SENT', 'VIEWED'].includes(quote.status);
              const expiringSoon =
                isOpen && quote.validUntil.getTime() - Date.now() < 3 * 86_400_000;

              return (
                <li
                  key={quote.id}
                  className="grid gap-3 p-5 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_auto] sm:items-center sm:gap-4"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{quote.title}</p>
                    <p className="text-meta text-muted-foreground">
                      {quote.number} ·{' '}
                      <span className={expiringSoon ? 'font-medium text-warning' : undefined}>
                        gültig bis {formatDate(quote.validUntil)}
                      </span>
                    </p>
                  </div>

                  <span className="font-semibold tabular-nums sm:text-right">
                    {formatCurrency(toNumber(quote.grossTotal))}
                  </span>

                  <div className="min-w-0">
                    <StatusBadge status={quote.status} />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button asChild variant="outline" size="sm">
                      <a href={`/api/quotes/${quote.id}/pdf`} download>
                        <Download aria-hidden />
                        PDF
                      </a>
                    </Button>
                    {isOpen ? (
                      <Button asChild size="sm">
                        <Link href={`/offerte/${quote.publicToken}`}>
                          Ansehen und antworten
                          <ArrowRight aria-hidden />
                        </Link>
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </ListCard>
      )}
    </div>
  );
}
