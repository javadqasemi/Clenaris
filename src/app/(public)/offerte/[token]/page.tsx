import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Clock, Download } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { formatCurrency, formatDate, formatDateLong } from '@/lib/utils';
import { getQuoteByToken } from '@/server/services/quote.service';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { QuoteResponse } from '@/features/public/quote-response';

export const metadata: Metadata = {
  title: 'Ihre Offerte',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Öffentliche Offertansicht.
 *
 * Erreichbar ohne Anmeldung über einen unerratbaren Token. Die Kundschaft
 * sieht dieselben Zahlen wie im PDF und kann direkt hier annehmen — mit
 * Namenseingabe und gezeichneter Unterschrift. Diese eine Seite ersetzt
 * Ausdrucken, Unterschreiben, Einscannen und Zurückschicken.
 */
export default async function PublicQuotePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const quote = await getQuoteByToken(token).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  const recipient =
    quote.customer?.companyName ??
    (quote.customer
      ? `${quote.customer.firstName} ${quote.customer.lastName}`
      : quote.lead
        ? `${quote.lead.company ?? `${quote.lead.firstName} ${quote.lead.lastName}`}`
        : 'Kundin/Kunde');

  const billable = quote.items.filter((item) => !item.optional);
  const optional = quote.items.filter((item) => item.optional);

  const expired = quote.validUntil < new Date();
  const answered = ['ACCEPTED', 'REJECTED', 'CONVERTED'].includes(quote.status);
  const canRespond = !answered && !expired;

  return (
    <div className="container max-w-3xl py-12 sm:py-16">
      {/* Kopf */}
      <header className="mb-10 space-y-3">
        <p className="text-sm text-muted-foreground">
          {quote.organization.name} · Offerte {quote.number}
        </p>
        <h1 className="text-headline font-bold text-balance">{quote.title}</h1>
        <p className="text-lg text-muted-foreground">
          Für {recipient} · gültig bis {formatDateLong(quote.validUntil)}
        </p>
      </header>

      {/* Status */}
      {quote.status === 'ACCEPTED' || quote.status === 'CONVERTED' ? (
        <Alert variant="success" title="Offerte angenommen" className="mb-8">
          Vielen Dank. Wir haben Ihre Zusage erhalten
          {quote.signedAt ? ` (${formatDate(quote.signedAt)})` : ''} und melden uns zur
          Terminvereinbarung.
        </Alert>
      ) : quote.status === 'REJECTED' ? (
        <Alert variant="warning" title="Offerte abgelehnt" className="mb-8">
          Sie haben diese Offerte abgelehnt. Falls sich etwas geändert hat, melden Sie sich gerne —
          wir erstellen Ihnen ein neues Angebot.
        </Alert>
      ) : expired ? (
        <Alert variant="warning" title="Offerte abgelaufen" className="mb-8">
          Diese Offerte war bis {formatDateLong(quote.validUntil)} gültig. Kontaktieren Sie uns für
          ein aktualisiertes Angebot — in der Regel gelten dieselben Konditionen.
        </Alert>
      ) : (
        <Alert variant="info" className="mb-8">
          <span className="flex items-center gap-2">
            <Clock className="size-4 shrink-0" aria-hidden />
            Diese Offerte ist noch {daysLeft(quote.validUntil)} Tage gültig.
          </span>
        </Alert>
      )}

      {quote.introText ? (
        <p className="prose-measure mb-10 whitespace-pre-line leading-relaxed text-muted-foreground">
          {quote.introText}
        </p>
      ) : null}

      {/* Positionen */}
      <section className="mb-10" aria-label="Leistungen">
        <h2 className="mb-4 font-display text-lg font-semibold tracking-tight">Leistungen</h2>

        <dl className="protocol-list rounded-2xl border border-border bg-card px-6">
          {billable.map((item) => (
            <div key={item.id} className="flex flex-wrap items-baseline justify-between gap-4 py-4">
              <dt className="min-w-0 flex-1">
                <span className="block font-medium">{item.name}</span>
                {item.description ? (
                  <span className="block text-sm leading-relaxed text-muted-foreground">
                    {item.description}
                  </span>
                ) : null}
                <span className="block text-sm text-muted-foreground">
                  {toNumber(item.quantity)} {item.unit} ×{' '}
                  {formatCurrency(toNumber(item.unitPrice))}
                </span>
              </dt>
              <dd className="font-medium tabular-nums">
                {formatCurrency(toNumber(item.lineTotal))}
              </dd>
            </div>
          ))}
        </dl>

        {/* Summen */}
        <dl className="ml-auto mt-6 max-w-sm space-y-2">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-sm text-muted-foreground">Zwischentotal</dt>
            <dd className="text-sm tabular-nums">{formatCurrency(toNumber(quote.subtotal))}</dd>
          </div>
          {toNumber(quote.discountAmount) > 0 ? (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-sm text-success">Rabatt</dt>
              <dd className="text-sm tabular-nums text-success">
                − {formatCurrency(toNumber(quote.discountAmount))}
              </dd>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-sm text-muted-foreground">Total netto</dt>
            <dd className="text-sm tabular-nums">{formatCurrency(toNumber(quote.netTotal))}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-sm text-muted-foreground">MWST 8.1 %</dt>
            <dd className="text-sm tabular-nums">{formatCurrency(toNumber(quote.vatAmount))}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 border-t border-border pt-3">
            <dt className="font-semibold">Gesamtbetrag</dt>
            <dd className="font-display text-2xl font-bold tabular-nums">
              {formatCurrency(toNumber(quote.grossTotal))}
            </dd>
          </div>
        </dl>

        {/* Optionen */}
        {optional.length > 0 ? (
          <div className="mt-8 rounded-2xl border border-dashed border-border p-6">
            <h3 className="mb-3 font-display text-base font-semibold">
              Optionale Zusatzleistungen
            </h3>
            <p className="mb-4 text-sm text-muted-foreground">
              Diese Positionen sind im Gesamtbetrag <strong>nicht</strong> enthalten. Sagen Sie
              einfach Bescheid, wenn Sie eine davon wünschen.
            </p>
            <dl className="protocol-list">
              {optional.map((item) => (
                <div key={item.id} className="flex items-baseline justify-between gap-4 py-3">
                  <dt className="text-sm">{item.name}</dt>
                  <dd className="text-sm tabular-nums text-muted-foreground">
                    {formatCurrency(toNumber(item.lineTotal))}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
      </section>

      {quote.outroText ? (
        <p className="prose-measure mb-8 whitespace-pre-line leading-relaxed">{quote.outroText}</p>
      ) : null}

      {/* Antwort */}
      {canRespond ? (
        <QuoteResponse token={token} grossTotal={toNumber(quote.grossTotal)} />
      ) : (
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="outline" size="lg">
            <a href={`/api/public/quotes/${token}/pdf`} download>
              <Download aria-hidden />
              Offerte als PDF
            </a>
          </Button>
          {quote.organization.phone ? (
            <Button asChild size="lg">
              <a href={`tel:${quote.organization.phone.replace(/\s/g, '')}`}>
                Wir sind erreichbar: {quote.organization.phone}
              </a>
            </Button>
          ) : null}
        </div>
      )}

      {/* Bedingungen */}
      {quote.terms ? (
        <section className="mt-12 border-t border-border pt-8">
          <h2 className="mb-3 font-display text-base font-semibold">Bedingungen</h2>
          <p className="prose-measure whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
            {quote.terms}
          </p>
        </section>
      ) : null}

      {/* Kontakt */}
      <footer className="mt-12 border-t border-border pt-8 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{quote.organization.name}</p>
        <p>
          {quote.organization.phone ? `${quote.organization.phone} · ` : ''}
          {quote.organization.email}
        </p>
      </footer>
    </div>
  );
}

function daysLeft(validUntil: Date): number {
  return Math.max(0, Math.ceil((validUntil.getTime() - Date.now()) / 86_400_000));
}
