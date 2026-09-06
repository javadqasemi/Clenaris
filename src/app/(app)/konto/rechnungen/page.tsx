import type { Metadata } from 'next';
import Link from 'next/link';
import { Download, Receipt } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requireCustomerId } from '@/lib/auth/session';
import { formatCurrency, formatDate } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { listInvoices } from '@/server/services/invoice.service';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, ListCard, PageHeader, Pagination } from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Rechnungen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AccountInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ seite?: string }>;
}) {
  const { customerId } = await requireCustomerId();

  const params = await searchParams;
  const organizationId = await getOrganizationId();

  const page = Math.max(1, Number(params.seite) || 1);
  const pageSize = 20;

  const { items, total, totals } = await listInvoices({
    organizationId,
    customerId,
    page,
    pageSize,
  });

  // Entwürfe sind interne Vorstufen und gehören nicht in die Kundenansicht.
  const visible = items.filter((invoice) => invoice.status !== 'DRAFT');
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rechnungen"
        description={
          totals.outstanding > 0
            ? `Offen: ${formatCurrency(totals.outstanding)}. Sie können online mit Karte oder TWINT bezahlen.`
            : 'Alle Rechnungen sind beglichen. Vielen Dank.'
        }
      />

      {visible.length === 0 ? (
        <EmptyState
          icon={<Receipt aria-hidden />}
          title="Noch keine Rechnungen"
          description="Nach dem ersten Einsatz erhalten Sie hier Ihre Rechnung — als PDF und mit QR-Code zum Bezahlen."
          action={{ href: '/buchen', label: 'Termin buchen' }}
        />
      ) : (
        <ListCard
          footer={
            <Pagination
              page={page}
              totalPages={totalPages}
              total={total}
              baseHref="/konto/rechnungen"
            />
          }
        >
          {/*
            Festes Raster statt `flex-wrap`: Beträge, Status und Schaltflächen
            fluchten dadurch von Zeile zu Zeile. Unter `sm` wird gestapelt —
            vier Spalten sind auf einem Telefon nicht lesbar.
          */}
          <ul className="divide-y divide-border">
            {visible.map((invoice) => {
              const balance = toNumber(invoice.balance);
              return (
                <li
                  key={invoice.id}
                  className="grid gap-3 p-5 sm:grid-cols-[minmax(0,1fr)_8rem_7rem_auto] sm:items-center sm:gap-4"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/konto/rechnungen/${invoice.id}`}
                      className="font-medium tabular-nums text-primary underline-offset-4 hover:underline"
                    >
                      {invoice.number}
                    </Link>
                    <p className="text-meta text-muted-foreground">
                      Ausgestellt {formatDate(invoice.issueDate)} · zahlbar bis{' '}
                      {formatDate(invoice.dueDate)}
                    </p>
                  </div>

                  <div className="sm:text-right">
                    <p className="font-semibold tabular-nums">
                      {formatCurrency(toNumber(invoice.grossTotal))}
                    </p>
                    {balance > 0 ? (
                      <p className="text-meta tabular-nums text-warning">
                        offen {formatCurrency(balance)}
                      </p>
                    ) : null}
                  </div>

                  <div className="min-w-0">
                    <StatusBadge status={invoice.status} />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button asChild variant="outline" size="sm">
                      <a href={`/api/invoices/${invoice.id}/pdf`} download>
                        <Download aria-hidden />
                        PDF
                      </a>
                    </Button>
                    {balance > 0 ? (
                      <Button asChild size="sm">
                        <Link href={`/konto/rechnungen/${invoice.id}`}>Bezahlen</Link>
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
