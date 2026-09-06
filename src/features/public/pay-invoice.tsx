'use client';

import * as React from 'react';
import { CreditCard, Smartphone } from 'lucide-react';
import { toast } from 'sonner';

import { cn, formatCurrency } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';

/**
 * Online-Zahlung einer Rechnung.
 *
 * TWINT steht bewusst an erster Stelle: in der Schweiz ist es bei
 * Privatpersonen das meistgenutzte digitale Zahlungsmittel. Beide Wege laufen
 * über Stripe Checkout — damit bleibt die Kartendateneingabe ausserhalb
 * unserer Applikation und der PCI-Geltungsbereich klein.
 */
const METHODS = [
  {
    value: 'TWINT' as const,
    label: 'TWINT',
    description: 'Mit der TWINT-App bezahlen',
    Icon: Smartphone,
  },
  {
    value: 'CARD' as const,
    label: 'Karte',
    description: 'Visa, Mastercard, American Express',
    Icon: CreditCard,
  },
];

export function PayInvoice({ token, amount }: { token: string; amount: number }) {
  const [method, setMethod] = React.useState<'TWINT' | 'CARD'>('TWINT');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const startPayment = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await api.post<{ url: string }>(`/api/public/invoices/${token}/pay`, {
        method,
      });
      // Weiterleitung zu Stripe Checkout.
      window.location.href = result.url;
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'Die Zahlung konnte nicht gestartet werden. Bitte versuchen Sie es später erneut.';
      setError(message);
      toast.error(message);
      setPending(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-card p-6 shadow-card sm:p-8">
      <h2 className="font-display text-lg font-semibold tracking-tight">Online bezahlen</h2>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Offener Betrag: <strong className="text-foreground">{formatCurrency(amount)}</strong>
      </p>

      {error ? (
        <Alert variant="destructive" className="mt-4">
          {error}
        </Alert>
      ) : null}

      <fieldset className="mt-6">
        <legend className="sr-only">Zahlungsart wählen</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {METHODS.map(({ value, label, description, Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setMethod(value)}
              aria-pressed={method === value}
              className={cn(
                'flex items-start gap-3 rounded-2xl border-2 p-4 text-left transition-all duration-200',
                'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/15',
                method === value
                  ? 'border-primary bg-primary/[0.04]'
                  : 'border-border hover:border-primary/40',
              )}
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
                <Icon className="size-5" aria-hidden />
              </span>
              <span>
                <span className="block font-medium">{label}</span>
                <span className="block text-sm text-muted-foreground">{description}</span>
              </span>
            </button>
          ))}
        </div>
      </fieldset>

      <Button size="lg" width="full" className="mt-6" onClick={startPayment} loading={pending}>
        {formatCurrency(amount)} mit {method === 'TWINT' ? 'TWINT' : 'Karte'} bezahlen
      </Button>

      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        Die Zahlung wird über Stripe abgewickelt. Ihre Kartendaten erreichen unsere Server nie. Nach
        erfolgreicher Zahlung erhalten Sie sofort eine Bestätigung per E-Mail.
      </p>
    </section>
  );
}
