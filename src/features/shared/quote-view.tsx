import type { ReactNode } from 'react';
import type { Prisma } from '@prisma/client';
import { Clock, Download } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { formatCurrency, formatDate, formatDateLong } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';

/**
 * Die Darstellung einer Offerte für die Kundschaft — einmal geschrieben, von
 * zwei Eingängen verwendet.
 *
 * **Warum geteilt und warum nur die Darstellung.** Es gibt zwei Wege zu
 * derselben Offerte: den Link ohne Anmeldung und die Ansicht im
 * Kundenbereich. Was die Kundschaft sieht, ist in beiden Fällen dasselbe
 * Dokument; zwei Abschriften davon liefen bei der nächsten Änderung
 * auseinander, und die Abweichung fiele erst auf, wenn jemand sich über
 * unterschiedliche Zahlen wundert.
 *
 * **Die Berechtigung teilt sich nicht mit.** Diese Komponente prüft nichts
 * und weiss nichts über Tokens oder Sitzungen. Sie bekommt eine Offerte, die
 * der Aufrufer bereits freigegeben hat, und die Bausteine für Antwort und
 * PDF-Abruf als Eigenschaften. Wer die Prüfung vergisst, bekommt von hier
 * keine Hilfe — aber auch keine Deckung.
 */

/** Was `toNumber` entgegennimmt — Prisma liefert `Decimal`, Tests Zahlen. */
type Betrag = Prisma.Decimal | number;

interface QuotePosition {
  id: string;
  name: string;
  description: string | null;
  unit: string;
  optional: boolean;
  quantity: Betrag;
  unitPrice: Betrag;
  lineTotal: Betrag;
}

export interface QuoteViewData {
  number: string;
  title: string;
  status: string;
  validUntil: Date;
  signedAt: Date | null;
  introText: string | null;
  outroText: string | null;
  terms: string | null;
  subtotal: Betrag;
  discountAmount: Betrag;
  netTotal: Betrag;
  vatAmount: Betrag;
  grossTotal: Betrag;
  items: QuotePosition[];
  customer: { firstName: string; lastName: string; companyName: string | null } | null;
  lead: { firstName: string; lastName: string; company: string | null } | null;
  organization: { name: string; email: string | null; phone: string | null };
}

export interface QuoteViewProps {
  quote: QuoteViewData;
  /** Adresse, unter der das PDF abrufbar ist — je Eingang eine andere. */
  pdfUrl: string;
  /**
   * Die Antwortmaske. `null`, wenn nicht mehr geantwortet werden kann; der
   * Aufrufer entscheidet, welche Maske zu seinem Eingang gehört.
   */
  responsePanel?: ReactNode;
}

function daysLeft(validUntil: Date): number {
  return Math.max(0, Math.ceil((validUntil.getTime() - Date.now()) / 86_400_000));
}

export function QuoteView({ quote, pdfUrl, responsePanel }: QuoteViewProps) {
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

  return (
    <div className="container max-w-3xl py-12 sm:py-16">
      <header className="mb-10 space-y-3">
        <p className="text-sm text-muted-foreground">
          {quote.organization.name} · Offerte {quote.number}
        </p>
        <h1 className="text-headline font-bold text-balance">{quote.title}</h1>
        <p className="text-lg text-muted-foreground">
          Für {recipient} · gültig bis {formatDateLong(quote.validUntil)}
        </p>
      </header>

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

      {responsePanel ?? (
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="outline" size="lg">
            <a href={pdfUrl} download>
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

      {quote.terms ? (
        <section className="mt-12 border-t border-border pt-8">
          <h2 className="mb-3 font-display text-base font-semibold">Bedingungen</h2>
          <p className="prose-measure whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
            {quote.terms}
          </p>
        </section>
      ) : null}

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
