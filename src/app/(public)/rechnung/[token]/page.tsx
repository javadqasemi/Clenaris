import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Download } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { formatCurrency, formatDateLong, formatIban } from '@/lib/utils';
import { formatQrReference } from '@/lib/pdf/swiss-qr';
import { getInvoiceByToken } from '@/server/services/invoice.service';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { StatusBadge } from '@/components/ui/badge';
import { PayInvoice } from '@/features/public/pay-invoice';

export const metadata: Metadata = {
  title: 'Ihre Rechnung',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Öffentliche Rechnungsansicht mit Zahlungsmöglichkeit.
 *
 * Zwei Wege stehen gleichwertig nebeneinander: online mit Karte oder TWINT,
 * oder klassisch per QR-Rechnung. In der Schweiz zahlen viele Privatpersonen
 * weiterhin per E-Banking — die Zahlungsangaben gehören deshalb sichtbar auf
 * die Seite, nicht nur ins PDF.
 */
export default async function PublicInvoicePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const invoice = await getInvoiceByToken(token).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  const balance = toNumber(invoice.balance);
  const overdue = balance > 0 && invoice.dueDate < new Date();
  const iban = invoice.organization.qrIban ?? invoice.organization.iban;

  return (
    <div className="container max-w-3xl py-12 sm:py-16">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{invoice.organization.name}</p>
          <h1 className="text-headline font-bold">Rechnung {invoice.number}</h1>
          <p className="text-muted-foreground">
            Ausgestellt am {formatDateLong(invoice.issueDate)} · zahlbar bis{' '}
            {formatDateLong(invoice.dueDate)}
          </p>
        </div>
        <StatusBadge status={invoice.status} />
      </header>

      {balance <= 0 ? (
        <Alert variant="success" title="Bezahlt" className="mb-8">
          Diese Rechnung ist vollständig beglichen. Vielen Dank.
        </Alert>
      ) : overdue ? (
        <Alert variant="warning" title="Zahlungsfrist überschritten" className="mb-8">
          Die Rechnung war am {formatDateLong(invoice.dueDate)} fällig. Haben Sie bereits bezahlt?
          Dann betrachten Sie diesen Hinweis als gegenstandslos — Zahlungen brauchen bis zu drei
          Bankarbeitstage.
        </Alert>
      ) : null}

      {/* Positionen */}
      <section className="mb-8" aria-label="Rechnungspositionen">
        <dl className="protocol-list rounded-2xl border border-border bg-card px-6">
          {invoice.items.map((item) => (
            <div key={item.id} className="flex flex-wrap items-baseline justify-between gap-4 py-4">
              <dt className="min-w-0 flex-1">
                <span className="block font-medium">{item.name}</span>
                {item.description ? (
                  <span className="block text-sm text-muted-foreground">{item.description}</span>
                ) : null}
                <span className="block text-sm text-muted-foreground">
                  {toNumber(item.quantity)} {item.unit} × {formatCurrency(toNumber(item.unitPrice))}
                </span>
              </dt>
              <dd className="font-medium tabular-nums">
                {formatCurrency(toNumber(item.netAmount))}
              </dd>
            </div>
          ))}
        </dl>

        <dl className="ml-auto mt-6 max-w-sm space-y-2">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-sm text-muted-foreground">Total netto</dt>
            <dd className="text-sm tabular-nums">{formatCurrency(toNumber(invoice.netTotal))}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-sm text-muted-foreground">MWST</dt>
            <dd className="text-sm tabular-nums">{formatCurrency(toNumber(invoice.vatAmount))}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 border-t border-border pt-3">
            <dt className="font-semibold">Gesamtbetrag</dt>
            <dd className="font-display text-2xl font-bold tabular-nums">
              {formatCurrency(toNumber(invoice.grossTotal))}
            </dd>
          </div>
          {toNumber(invoice.paidAmount) > 0 ? (
            <>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-sm text-success">Bereits bezahlt</dt>
                <dd className="text-sm tabular-nums text-success">
                  − {formatCurrency(toNumber(invoice.paidAmount))}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="font-semibold">Offener Betrag</dt>
                <dd className="font-semibold tabular-nums">{formatCurrency(balance)}</dd>
              </div>
            </>
          ) : null}
        </dl>
      </section>

      {/* Bezahlen */}
      {balance > 0 ? (
        <div className="space-y-6">
          <PayInvoice token={token} amount={balance} />

          {iban ? (
            <section className="rounded-2xl border border-border bg-surface p-6">
              <h2 className="mb-4 font-display text-base font-semibold">
                Oder per Banküberweisung
              </h2>
              <dl className="protocol-list">
                <div className="protocol-row">
                  <dt className="protocol-label">Empfänger</dt>
                  <dd className="protocol-value">{invoice.organization.name}</dd>
                </div>
                <div className="protocol-row">
                  <dt className="protocol-label">IBAN</dt>
                  <dd className="protocol-value tabular-nums">{formatIban(iban)}</dd>
                </div>
                {invoice.qrReference ? (
                  <div className="protocol-row">
                    <dt className="protocol-label">Referenznummer</dt>
                    <dd className="protocol-value tabular-nums">
                      {formatQrReference(invoice.qrReference)}
                    </dd>
                  </div>
                ) : (
                  <div className="protocol-row">
                    <dt className="protocol-label">Mitteilung</dt>
                    <dd className="protocol-value">Rechnung {invoice.number}</dd>
                  </div>
                )}
                <div className="protocol-row">
                  <dt className="protocol-label">Betrag</dt>
                  <dd className="protocol-value tabular-nums">{formatCurrency(balance)}</dd>
                </div>
              </dl>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                Im PDF finden Sie den Einzahlungsschein mit QR-Code — damit können Sie den Betrag in
                Ihrer Banking-App einfach abscannen.
              </p>
            </section>
          ) : null}
        </div>
      ) : null}

      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild variant="outline">
          <a href={`/api/public/invoices/${token}/pdf`} download>
            <Download aria-hidden />
            Rechnung als PDF
          </a>
        </Button>
      </div>

      <footer className="mt-12 border-t border-border pt-8 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{invoice.organization.name}</p>
        <p>
          {invoice.organization.phone ? `${invoice.organization.phone} · ` : ''}
          {invoice.organization.email}
        </p>
      </footer>
    </div>
  );
}
