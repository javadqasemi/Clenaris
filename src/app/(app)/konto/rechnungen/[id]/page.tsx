import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Download } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requireCustomerId } from '@/lib/auth/session';
import { formatCurrency, formatDate } from '@/lib/utils';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { DetailRow, DetailSection, PageHeader, TableScroll } from '@/components/app/page-parts';
import { PayInvoice } from '@/features/public/pay-invoice';

export const metadata: Metadata = {
  title: 'Rechnung',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const METHOD_LABELS: Record<string, string> = {
  CARD: 'Karte',
  TWINT: 'TWINT',
  BANK_TRANSFER: 'Banküberweisung',
  CASH: 'Bar',
  SEPA: 'SEPA-Lastschrift',
  GIFT_CARD: 'Geschenkkarte',
  CREDIT_NOTE: 'Gutschrift',
  OTHER: 'Anderes',
};

/**
 * Rechnungsdetail im Kundenkonto.
 *
 * Die Sichtprüfung läuft über `customerId` in der Abfrage selbst, nicht über
 * eine nachgelagerte Prüfung: eine fremde Rechnung wird gar nicht erst
 * geladen, und die Seite antwortet mit 404 statt mit 403 — welche Nummern
 * vergeben sind, geht ein fremdes Konto nichts an.
 *
 * Die Bezahlansicht teilt sich die Komponente mit der öffentlichen
 * Token-Seite. Dieselbe Zahlung darf nicht zwei Implementierungen haben.
 */
export default async function AccountInvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { customerId } = await requireCustomerId();
  const { id } = await params;

  const invoice = await prisma.invoice.findFirst({
    where: { id, customerId, deletedAt: null, status: { not: 'DRAFT' } },
    include: {
      items: { orderBy: { position: 'asc' } },
      payments: {
        where: { status: 'SUCCEEDED' },
        orderBy: { paidAt: 'desc' },
      },
      booking: { select: { id: true, number: true, scheduledStart: true } },
      creditNotes: { select: { id: true, number: true, grossTotal: true, issueDate: true } },
    },
  });

  if (!invoice) notFound();

  const balance = toNumber(invoice.balance);
  const overdue =
    balance > 0 && invoice.status !== 'CANCELLED' && invoice.dueDate < new Date();

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/konto/rechnungen">
          <ArrowLeft aria-hidden />
          Alle Rechnungen
        </Link>
      </Button>

      <PageHeader
        title={`Rechnung ${invoice.number}`}
        description={`Ausgestellt am ${formatDate(invoice.issueDate)} · zahlbar bis ${formatDate(invoice.dueDate)}`}
        actions={
          <>
            <StatusBadge status={invoice.status} />
            <Button asChild variant="outline">
              <a href={`/api/invoices/${invoice.id}/pdf`} download>
                <Download aria-hidden />
                PDF mit QR-Einzahlschein
              </a>
            </Button>
          </>
        }
      />

      {overdue ? (
        <Alert variant="warning">
          Diese Rechnung ist seit dem {formatDate(invoice.dueDate)} fällig. Bitte begleichen Sie
          den offenen Betrag von {formatCurrency(balance)} — oder melden Sie sich, wenn etwas
          nicht stimmt.
        </Alert>
      ) : null}

      {invoice.status === 'CANCELLED' ? (
        <Alert variant="info">
          Diese Rechnung wurde storniert. Massgeblich ist die zugehörige Gutschrift.
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          {/* Positionen */}
          <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
            <header className="border-b border-border px-6 py-4">
              <h2 className="font-display text-base font-semibold tracking-tight">Positionen</h2>
            </header>

            <TableScroll>
              <table className="data-table">
                <caption className="sr-only">Rechnungspositionen</caption>
                <thead>
                  <tr>
                    <th scope="col">Leistung</th>
                    <th scope="col" className="text-right">
                      Menge
                    </th>
                    <th scope="col" className="text-right">
                      Ansatz
                    </th>
                    <th scope="col" className="text-right">
                      Betrag
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <span className="font-medium">{item.name}</span>
                        {item.description ? (
                          <span className="block text-xs text-muted-foreground">
                            {item.description}
                          </span>
                        ) : null}
                      </td>
                      <td className="num text-muted-foreground">
                        {toNumber(item.quantity)} {item.unit}
                      </td>
                      <td className="num text-muted-foreground">
                        {formatCurrency(toNumber(item.unitPrice))}
                      </td>
                      <td className="num font-medium">
                        {formatCurrency(toNumber(item.netAmount))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>

            <dl className="protocol-list border-t border-border px-6 py-4">
              <DetailRow label="Zwischentotal">
                {formatCurrency(toNumber(invoice.subtotal))}
              </DetailRow>
              {toNumber(invoice.discountAmount) > 0 ? (
                <DetailRow label="Rabatt">
                  − {formatCurrency(toNumber(invoice.discountAmount))}
                </DetailRow>
              ) : null}
              <DetailRow label="Netto">{formatCurrency(toNumber(invoice.netTotal))}</DetailRow>
              <DetailRow label="MWST">{formatCurrency(toNumber(invoice.vatAmount))}</DetailRow>
              <DetailRow label="Total">
                <strong className="text-base">
                  {formatCurrency(toNumber(invoice.grossTotal))}
                </strong>
              </DetailRow>
              {toNumber(invoice.paidAmount) > 0 ? (
                <DetailRow label="Bezahlt">
                  − {formatCurrency(toNumber(invoice.paidAmount))}
                </DetailRow>
              ) : null}
              <DetailRow label="Offen">
                <strong className={balance > 0 ? 'text-warning' : 'text-success'}>
                  {formatCurrency(balance)}
                </strong>
              </DetailRow>
            </dl>
          </section>

          {invoice.payments.length > 0 ? (
            <DetailSection title="Zahlungseingänge">
              <dl className="protocol-list">
                {invoice.payments.map((payment) => (
                  <DetailRow
                    key={payment.id}
                    label={payment.paidAt ? formatDate(payment.paidAt) : 'Erfasst'}
                  >
                    {formatCurrency(toNumber(payment.amount))} ·{' '}
                    {METHOD_LABELS[payment.method] ?? payment.method}
                  </DetailRow>
                ))}
              </dl>
            </DetailSection>
          ) : null}

          {invoice.creditNotes.length > 0 ? (
            <DetailSection title="Gutschriften">
              <dl className="protocol-list">
                {invoice.creditNotes.map((note) => (
                  <DetailRow key={note.id} label={note.number}>
                    {formatCurrency(toNumber(note.grossTotal))} vom {formatDate(note.issueDate)}
                  </DetailRow>
                ))}
              </dl>
            </DetailSection>
          ) : null}
        </div>

        <aside className="space-y-6">
          {balance > 0 && invoice.status !== 'CANCELLED' ? (
            <PayInvoice token={invoice.publicToken} amount={balance} />
          ) : null}

          <DetailSection title="Rechnungsempfänger">
            <dl className="protocol-list">
              <DetailRow label="Name">
                {invoice.billToCompany ?? invoice.billToName}
              </DetailRow>
              <DetailRow label="Adresse">
                {invoice.billToStreet}
                <br />
                {invoice.billToZip} {invoice.billToCity}
              </DetailRow>
              {invoice.booking ? (
                <DetailRow label="Termin">
                  <Link
                    href={`/konto/buchungen/${invoice.booking.id}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {invoice.booking.number}
                  </Link>{' '}
                  vom {formatDate(invoice.booking.scheduledStart)}
                </DetailRow>
              ) : null}
              {invoice.qrReference ? (
                <DetailRow label="QR-Referenz">
                  <span className="break-all font-mono text-xs">{invoice.qrReference}</span>
                </DetailRow>
              ) : null}
            </dl>
          </DetailSection>

          <p className="text-sm leading-relaxed text-muted-foreground">
            Stimmt etwas nicht?{' '}
            <Link
              href="/konto/nachrichten"
              className="text-primary underline underline-offset-4"
            >
              Schreiben Sie uns
            </Link>{' '}
            — wir klären das, bevor eine Mahnung läuft.
          </p>
        </aside>
      </div>
    </div>
  );
}
