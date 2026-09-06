import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Download, ExternalLink, PenLine } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { NotFoundError } from '@/lib/errors';
import { absoluteUrl, formatCurrency, formatDate, formatDateTime } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { getQuoteDetail } from '@/server/services/quote.service';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { QuoteActions } from '@/features/admin/quote-actions';

export const metadata: Metadata = {
  title: 'Offerte',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AdminQuoteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission('quote:read');

  const { id } = await params;
  const organizationId = await getOrganizationId();

  const quote = await getQuoteDetail({ organizationId, quoteId: id }).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  const recipient =
    quote.customer?.companyName ??
    (quote.customer
      ? `${quote.customer.firstName} ${quote.customer.lastName}`
      : quote.lead
        ? `${quote.lead.firstName} ${quote.lead.lastName}`
        : '—');

  const publicUrl = absoluteUrl(`/offerte/${quote.publicToken}`);
  const billable = quote.items.filter((item) => !item.optional);
  const optional = quote.items.filter((item) => item.optional);

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/offerten">
          <ArrowLeft aria-hidden />
          Alle Offerten
        </Link>
      </Button>

      <PageHeader
        title={`Offerte ${quote.number}`}
        description={quote.title}
        actions={
          <>
            <StatusBadge status={quote.status} className="self-center" />
            <Button asChild variant="outline">
              <a href={`/api/quotes/${quote.id}/pdf`} download>
                <Download aria-hidden />
                PDF
              </a>
            </Button>
            <QuoteActions
              quoteId={quote.id}
              status={quote.status}
              hasCustomer={Boolean(quote.customerId)}
              email={quote.customer?.email ?? quote.lead?.email ?? ''}
            />
          </>
        }
      />

      {quote.status === 'ACCEPTED' && quote.signedAt ? (
        <Alert variant="success" title="Digital angenommen">
          {quote.signatureName} hat die Offerte am {formatDateTime(quote.signedAt)} unterschrieben.
          Die Unterschrift ist im PDF hinterlegt.
        </Alert>
      ) : null}

      {quote.status === 'REJECTED' ? (
        <Alert variant="warning" title="Abgelehnt">
          {quote.rejectReason ?? 'Es wurde kein Grund angegeben.'}
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="space-y-6">
          {quote.introText ? (
            <DetailSection title="Einleitung">
              <p className="whitespace-pre-line py-4 text-sm leading-relaxed">{quote.introText}</p>
            </DetailSection>
          ) : null}

          <DetailSection
            title="Positionen"
            action={
              ['DRAFT', 'SENT', 'VIEWED'].includes(quote.status) ? (
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/admin/offerten/${quote.id}/bearbeiten`}>
                    <PenLine aria-hidden />
                    Bearbeiten
                  </Link>
                </Button>
              ) : null
            }
          >
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
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {billable.map((item) => (
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
                      <td className="num font-medium">{formatCurrency(toNumber(item.lineTotal))}</td>
                    </tr>
                  ))}

                  {optional.map((item) => (
                    <tr key={item.id} className="opacity-70">
                      <td>
                        <span className="block font-medium">{item.name}</span>
                        <span className="block text-xs text-primary">
                          Option — nicht im Total enthalten
                        </span>
                      </td>
                      <td className="num text-muted-foreground">
                        {toNumber(item.quantity)} {item.unit}
                      </td>
                      <td className="num text-muted-foreground">
                        {formatCurrency(toNumber(item.unitPrice))}
                      </td>
                      <td className="num text-muted-foreground">
                        ({formatCurrency(toNumber(item.lineTotal))})
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <dl className="protocol-list ml-auto max-w-sm">
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-sm text-muted-foreground">Zwischentotal</dt>
                <dd className="text-sm tabular-nums">{formatCurrency(toNumber(quote.subtotal))}</dd>
              </div>
              {toNumber(quote.discountAmount) > 0 ? (
                <div className="flex items-baseline justify-between gap-4 py-2">
                  <dt className="text-sm text-success">Rabatt</dt>
                  <dd className="text-sm tabular-nums text-success">
                    − {formatCurrency(toNumber(quote.discountAmount))}
                  </dd>
                </div>
              ) : null}
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-sm text-muted-foreground">Total netto</dt>
                <dd className="text-sm tabular-nums">{formatCurrency(toNumber(quote.netTotal))}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-sm text-muted-foreground">MWST</dt>
                <dd className="text-sm tabular-nums">{formatCurrency(toNumber(quote.vatAmount))}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-3">
                <dt className="font-semibold">Gesamtbetrag</dt>
                <dd className="font-display text-lg font-bold tabular-nums">
                  {formatCurrency(toNumber(quote.grossTotal))}
                </dd>
              </div>
            </dl>
          </DetailSection>

          {quote.outroText || quote.terms ? (
            <DetailSection title="Abschluss und Bedingungen">
              <div className="space-y-4 py-4 text-sm leading-relaxed">
                {quote.outroText ? <p className="whitespace-pre-line">{quote.outroText}</p> : null}
                {quote.terms ? (
                  <p className="whitespace-pre-line text-muted-foreground">{quote.terms}</p>
                ) : null}
              </div>
            </DetailSection>
          ) : null}
        </div>

        {/* Seitenspalte */}
        <div className="space-y-6">
          <DetailSection title="Empfänger">
            <dl className="protocol-list">
              <DetailRow label="Name">
                {quote.customerId ? (
                  <Link
                    href={`/admin/kunden/${quote.customerId}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {recipient}
                  </Link>
                ) : quote.leadId ? (
                  <Link
                    href={`/admin/leads/${quote.leadId}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {recipient} (Lead)
                  </Link>
                ) : (
                  recipient
                )}
              </DetailRow>
              <DetailRow label="E-Mail">
                {quote.customer?.email ?? quote.lead?.email ?? '—'}
              </DetailRow>
              <DetailRow label="Gültig bis">{formatDate(quote.validUntil)}</DetailRow>
            </dl>
          </DetailSection>

          <DetailSection title="Verlauf">
            <dl className="protocol-list">
              <DetailRow label="Erstellt">{formatDateTime(quote.createdAt)}</DetailRow>
              {quote.sentAt ? (
                <DetailRow label="Versendet">{formatDateTime(quote.sentAt)}</DetailRow>
              ) : null}
              {quote.viewedAt ? (
                <DetailRow label="Angesehen">{formatDateTime(quote.viewedAt)}</DetailRow>
              ) : null}
              {quote.acceptedAt ? (
                <DetailRow label="Angenommen">{formatDateTime(quote.acceptedAt)}</DetailRow>
              ) : null}
              {quote.rejectedAt ? (
                <DetailRow label="Abgelehnt">{formatDateTime(quote.rejectedAt)}</DetailRow>
              ) : null}
              <DetailRow label="Öffentlicher Link">
                <a
                  href={publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 break-all text-primary underline-offset-4 hover:underline"
                >
                  <ExternalLink className="size-3.5 shrink-0" aria-hidden />
                  Ansicht der Kundschaft
                </a>
              </DetailRow>
            </dl>
          </DetailSection>

          {quote.internalNote ? (
            <DetailSection title="Interne Notiz">
              <p className="whitespace-pre-line py-4 text-sm leading-relaxed text-muted-foreground">
                {quote.internalNote}
              </p>
            </DetailSection>
          ) : null}
        </div>
      </div>
    </div>
  );
}
