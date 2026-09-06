import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Download, Mail } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { NotFoundError } from '@/lib/errors';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/utils';
import { formatQrReference } from '@/lib/pdf/swiss-qr';
import { getOrganizationId } from '@/server/services/organization.service';
import { getInvoiceDetail } from '@/server/services/invoice.service';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { InvoiceActions } from '@/features/admin/invoice-actions';

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
  GIFT_CARD: 'Geschenkgutschein',
  CREDIT_NOTE: 'Gutschrift',
  OTHER: 'Andere',
};

export default async function AdminInvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission('invoice:read');

  const { id } = await params;
  const organizationId = await getOrganizationId();

  const invoice = await getInvoiceDetail({ organizationId, invoiceId: id }).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  const balance = toNumber(invoice.balance);
  const isDraft = invoice.status === 'DRAFT';
  const daysOverdue =
    balance > 0 && invoice.dueDate < new Date()
      ? Math.floor((Date.now() - invoice.dueDate.getTime()) / 86_400_000)
      : 0;

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/rechnungen">
          <ArrowLeft aria-hidden />
          Alle Rechnungen
        </Link>
      </Button>

      <PageHeader
        title={isDraft ? 'Rechnungsentwurf' : `Rechnung ${invoice.number}`}
        description={
          isDraft
            ? 'Noch keine Nummer vergeben. Beim Ausstellen wird die Rechnung unveränderlich.'
            : `Ausgestellt am ${formatDate(invoice.issueDate)} · zahlbar bis ${formatDate(invoice.dueDate)}`
        }
        actions={
          <>
            <StatusBadge status={invoice.status} className="self-center" />
            {!isDraft ? (
              <Button asChild variant="outline">
                <a href={`/api/invoices/${invoice.id}/pdf`} download>
                  <Download aria-hidden />
                  PDF
                </a>
              </Button>
            ) : null}
            <InvoiceActions
              invoiceId={invoice.id}
              status={invoice.status}
              balance={balance}
              email={invoice.billToEmail ?? invoice.customer.email}
            />
          </>
        }
      />

      {daysOverdue > 0 ? (
        <Alert variant="warning" title={`Seit ${daysOverdue} Tagen überfällig`}>
          Offener Betrag: {formatCurrency(balance)}.{' '}
          {invoice.reminderLevel > 0
            ? `Bereits ${invoice.reminderLevel} Mahnung(en) versendet, zuletzt am ${
                invoice.lastReminderAt ? formatDate(invoice.lastReminderAt) : '—'
              }.`
            : 'Noch keine Mahnung versendet — der nächtliche Lauf übernimmt das automatisch.'}
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="space-y-6">
          <DetailSection title="Positionen">
            <div className="overflow-x-auto py-2">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Bezeichnung</th>
                    <th scope="col" className="text-right">
                      Menge
                    </th>
                    <th scope="col" className="text-right">
                      Preis
                    </th>
                    <th scope="col" className="text-right">
                      MWST
                    </th>
                    <th scope="col" className="text-right">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <span className="block font-medium">{item.name}</span>
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
                      <td className="num text-muted-foreground">
                        {toNumber(item.vatRate).toFixed(1)} %
                      </td>
                      <td className="num font-medium">{formatCurrency(toNumber(item.netAmount))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <dl className="protocol-list ml-auto max-w-sm">
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-sm text-muted-foreground">Zwischentotal</dt>
                <dd className="text-sm tabular-nums">{formatCurrency(toNumber(invoice.subtotal))}</dd>
              </div>
              {toNumber(invoice.discountAmount) > 0 ? (
                <div className="flex items-baseline justify-between gap-4 py-2">
                  <dt className="text-sm text-success">Rabatt</dt>
                  <dd className="text-sm tabular-nums text-success">
                    − {formatCurrency(toNumber(invoice.discountAmount))}
                  </dd>
                </div>
              ) : null}
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-sm text-muted-foreground">Total netto</dt>
                <dd className="text-sm tabular-nums">{formatCurrency(toNumber(invoice.netTotal))}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-sm text-muted-foreground">MWST</dt>
                <dd className="text-sm tabular-nums">
                  {formatCurrency(toNumber(invoice.vatAmount))}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-3">
                <dt className="font-semibold">Gesamtbetrag</dt>
                <dd className="font-display text-lg font-bold tabular-nums">
                  {formatCurrency(toNumber(invoice.grossTotal))}
                </dd>
              </div>
              {toNumber(invoice.paidAmount) > 0 ? (
                <>
                  <div className="flex items-baseline justify-between gap-4 py-2">
                    <dt className="text-sm text-muted-foreground">Bezahlt</dt>
                    <dd className="text-sm tabular-nums text-success">
                      − {formatCurrency(toNumber(invoice.paidAmount))}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4 py-2">
                    <dt className="text-sm font-semibold">Offen</dt>
                    <dd className="text-sm font-semibold tabular-nums">
                      {formatCurrency(balance)}
                    </dd>
                  </div>
                </>
              ) : null}
            </dl>
          </DetailSection>

          <DetailSection title="Zahlungen">
            {invoice.payments.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">
                Noch kein Zahlungseingang erfasst.
              </p>
            ) : (
              <ul className="protocol-list">
                {invoice.payments.map((payment) => (
                  <li key={payment.id} className="flex flex-wrap items-center gap-4 py-3.5">
                    <span className="font-medium tabular-nums">
                      {formatCurrency(toNumber(payment.amount))}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {METHOD_LABELS[payment.method] ?? payment.method}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {payment.paidAt ? formatDate(payment.paidAt) : formatDate(payment.createdAt)}
                    </span>
                    {payment.reference ? (
                      <span className="text-xs text-muted-foreground">{payment.reference}</span>
                    ) : null}
                    <StatusBadge status={payment.status} className="ml-auto" />
                  </li>
                ))}
              </ul>
            )}
          </DetailSection>

          {invoice.reminders.length > 0 ? (
            <DetailSection title="Mahnhistorie">
              <ul className="protocol-list">
                {invoice.reminders.map((reminder) => (
                  <li key={reminder.id} className="flex items-center justify-between gap-4 py-3">
                    <span className="text-sm">
                      {reminder.level === 1 ? 'Zahlungserinnerung' : `${reminder.level - 1}. Mahnung`}
                      {toNumber(reminder.fee) > 0
                        ? ` · Gebühr ${formatCurrency(toNumber(reminder.fee))}`
                        : ''}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {formatDateTime(reminder.sentAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </DetailSection>
          ) : null}
        </div>

        {/* Seitenspalte */}
        <div className="space-y-6">
          <DetailSection title="Empfänger">
            <dl className="protocol-list">
              <DetailRow label="Name">
                <Link
                  href={`/admin/kunden/${invoice.customer.id}`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {invoice.billToCompany ?? invoice.billToName}
                </Link>
              </DetailRow>
              <DetailRow label="Adresse">
                {invoice.billToStreet}
                <br />
                {invoice.billToZip} {invoice.billToCity}
              </DetailRow>
              {invoice.billToEmail ? (
                <DetailRow label="E-Mail">
                  <a
                    href={`mailto:${invoice.billToEmail}`}
                    className="inline-flex items-center gap-1.5 text-primary underline-offset-4 hover:underline"
                  >
                    <Mail className="size-3.5" aria-hidden />
                    {invoice.billToEmail}
                  </a>
                </DetailRow>
              ) : null}
              {invoice.billToVat ? (
                <DetailRow label="MWST-Nummer">{invoice.billToVat}</DetailRow>
              ) : null}
            </dl>
          </DetailSection>

          <DetailSection title="Zahlungsinformationen">
            <dl className="protocol-list">
              {invoice.qrReference ? (
                <DetailRow label="QR-Referenz">
                  <span className="tabular-nums">{formatQrReference(invoice.qrReference)}</span>
                </DetailRow>
              ) : null}
              <DetailRow label="Zahlungsfrist">{formatDate(invoice.dueDate)}</DetailRow>
              {invoice.sentAt ? (
                <DetailRow label="Versendet">{formatDateTime(invoice.sentAt)}</DetailRow>
              ) : null}
              {invoice.viewedAt ? (
                <DetailRow label="Angesehen">{formatDateTime(invoice.viewedAt)}</DetailRow>
              ) : null}
              {invoice.paidAt ? (
                <DetailRow label="Bezahlt am">{formatDate(invoice.paidAt)}</DetailRow>
              ) : null}
              <DetailRow label="Zahlungslink">
                <a
                  href={`/rechnung/${invoice.publicToken}`}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all text-primary underline-offset-4 hover:underline"
                >
                  /rechnung/{invoice.publicToken.slice(0, 12)}…
                </a>
              </DetailRow>
            </dl>
          </DetailSection>

          {invoice.booking || invoice.quote ? (
            <DetailSection title="Verknüpfungen">
              <dl className="protocol-list">
                {invoice.booking ? (
                  <DetailRow label="Buchung">
                    <Link
                      href={`/admin/buchungen/${invoice.booking.id}`}
                      className="tabular-nums text-primary underline-offset-4 hover:underline"
                    >
                      {invoice.booking.number}
                    </Link>
                  </DetailRow>
                ) : null}
                {invoice.quote ? (
                  <DetailRow label="Offerte">
                    <Link
                      href={`/admin/offerten/${invoice.quote.id}`}
                      className="tabular-nums text-primary underline-offset-4 hover:underline"
                    >
                      {invoice.quote.number}
                    </Link>
                  </DetailRow>
                ) : null}
              </dl>
            </DetailSection>
          ) : null}

          {invoice.creditNotes.length > 0 ? (
            <DetailSection title="Gutschriften">
              <ul className="protocol-list">
                {invoice.creditNotes.map((note) => (
                  <li key={note.id} className="flex items-center justify-between gap-3 py-3">
                    <span className="text-sm tabular-nums">{note.number}</span>
                    <span className="text-sm tabular-nums text-muted-foreground">
                      {formatCurrency(toNumber(note.grossTotal))}
                    </span>
                  </li>
                ))}
              </ul>
            </DetailSection>
          ) : null}
        </div>
      </div>
    </div>
  );
}
