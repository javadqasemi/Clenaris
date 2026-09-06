import type { Metadata } from 'next';
import Link from 'next/link';
import { CreditCard } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { formatCurrency, formatDate, toQueryString } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { StatusBadge } from '@/components/ui/badge';
import { KpiTile } from '@/components/app/kpi-tile';
import { FilterBar } from '@/components/app/filter-bar';
import {
  EmptyState,
  ListCard,
  PageHeader,
  Pagination,
  TableScroll,
} from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Zahlungen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const METHOD_LABELS: Record<string, string> = {
  CARD: 'Karte',
  TWINT: 'TWINT',
  BANK_TRANSFER: 'Banküberweisung',
  CASH: 'Bar',
  SEPA: 'SEPA',
  GIFT_CARD: 'Geschenkgutschein',
  CREDIT_NOTE: 'Gutschrift',
  OTHER: 'Andere',
};

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePermission('invoice:read');

  const params = await searchParams;
  const organizationId = await getOrganizationId();

  const page = Math.max(1, Number(params.seite) || 1);
  const pageSize = 30;
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  const where = {
    invoice: { organizationId },
    ...(params.methode ? { method: params.methode as never } : {}),
    ...(params.q
      ? {
          OR: [
            { reference: { contains: params.q, mode: 'insensitive' as const } },
            { invoice: { number: { contains: params.q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };

  const [payments, total, monthTotal, byMethod] = await Promise.all([
    prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        invoice: { select: { id: true, number: true } },
        customer: { select: { id: true, firstName: true, lastName: true, companyName: true } },
      },
    }),
    prisma.payment.count({ where }),
    prisma.payment.aggregate({
      where: { status: 'SUCCEEDED', paidAt: { gte: monthStart }, invoice: { organizationId } },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.payment.groupBy({
      by: ['method'],
      where: { status: 'SUCCEEDED', paidAt: { gte: monthStart }, invoice: { organizationId } },
      _sum: { amount: true },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const baseHref = `/admin/zahlungen${toQueryString({ q: params.q, methode: params.methode })}`;

  const topMethod = [...byMethod].sort(
    (a, b) => toNumber(b._sum.amount) - toNumber(a._sum.amount),
  )[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Zahlungen"
        description="Alle Zahlungseingänge. Karten- und TWINT-Zahlungen werden über den Stripe-Webhook automatisch gebucht, Banküberweisungen erfassen Sie an der Rechnung."
      >
        <FilterBar
          searchPlaceholder="Rechnungsnummer oder Referenz …"
          filters={[
            {
              param: 'methode',
              label: 'Zahlungsart',
              options: Object.entries(METHOD_LABELS).map(([value, label]) => ({ value, label })),
            },
          ]}
        />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile
          label="Eingang diesen Monat"
          value={formatCurrency(toNumber(monthTotal._sum.amount))}
          hint={`${monthTotal._count} Zahlungen`}
        />
        <KpiTile
          label="Häufigste Zahlungsart"
          value={topMethod ? (METHOD_LABELS[topMethod.method] ?? topMethod.method) : '—'}
          hint={topMethod ? formatCurrency(toNumber(topMethod._sum.amount)) : undefined}
        />
        <KpiTile label="Erfasste Zahlungen total" value={String(total)} />
      </div>

      {payments.length === 0 ? (
        <EmptyState
          icon={<CreditCard aria-hidden />}
          title="Noch keine Zahlungen"
          description="Sobald Rechnungen beglichen werden, erscheinen die Eingänge hier — automatisch bei Online-Zahlungen, manuell erfasst bei Überweisungen."
          action={{ href: '/admin/rechnungen', label: 'Zu den Rechnungen' }}
        />
      ) : (
        <ListCard
          footer={
            <Pagination page={page} totalPages={totalPages} total={total} baseHref={baseHref} />
          }
        >
          <TableScroll>
            <table className="data-table">
              <caption className="sr-only">Zahlungsliste. {total} Einträge.</caption>
              <thead>
                <tr>
                  <th scope="col">Datum</th>
                  <th scope="col">Rechnung</th>
                  <th scope="col">Kundschaft</th>
                  <th scope="col">Zahlungsart</th>
                  <th scope="col">Referenz</th>
                  <th scope="col" className="text-right">
                    Betrag
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id}>
                    <td className="tabular-nums text-muted-foreground">
                      {formatDate(payment.paidAt ?? payment.createdAt)}
                    </td>
                    <td>
                      {payment.invoice ? (
                        <Link
                          href={`/admin/rechnungen/${payment.invoice.id}`}
                          className="font-medium tabular-nums text-primary underline-offset-4 hover:underline"
                        >
                          {payment.invoice.number}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="truncate">
                      {payment.customer
                        ? (payment.customer.companyName ??
                          `${payment.customer.firstName} ${payment.customer.lastName}`)
                        : '—'}
                    </td>
                    <td className="text-muted-foreground">
                      {METHOD_LABELS[payment.method] ?? payment.method}
                    </td>
                    <td className="max-w-[12rem] truncate text-xs text-muted-foreground">
                      {payment.reference ?? '—'}
                    </td>
                    <td className="num font-medium">{formatCurrency(toNumber(payment.amount))}</td>
                    <td>
                      <StatusBadge status={payment.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </ListCard>
      )}
    </div>
  );
}
