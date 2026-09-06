import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckCircle2, Clock } from 'lucide-react';

import { Button } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'Zahlung erhalten',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Rückkehrseite nach der Online-Zahlung.
 *
 * Wichtig: Diese Seite *bucht keine Zahlung*. Sie bestätigt nur den
 * erfolgreichen Abschluss bei Stripe. Die eigentliche Buchung erfolgt über den
 * Webhook — deshalb der Hinweis, dass die Aktualisierung einen Moment dauern
 * kann.
 */
export default async function PaymentThankYouPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <div className="container flex min-h-[70vh] max-w-xl items-center py-20">
      <div className="w-full space-y-8 text-center">
        <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-success/12 text-success">
          <CheckCircle2 className="size-8" aria-hidden />
        </div>

        <div className="space-y-3">
          <h1 className="text-headline font-bold text-balance">Vielen Dank für Ihre Zahlung</h1>
          <p className="text-lg leading-relaxed text-muted-foreground text-pretty">
            Die Zahlung wurde erfolgreich abgeschlossen. Sie erhalten in Kürze eine Bestätigung per
            E-Mail.
          </p>
        </div>

        <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-left">
          <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="text-sm leading-relaxed text-muted-foreground">
            Die Rechnung wird innerhalb weniger Minuten als bezahlt angezeigt. Sollte das länger
            dauern, ist das kein Grund zur Sorge — Ihre Zahlung ist erfasst.
          </p>
        </div>

        <div className="flex flex-col justify-center gap-3 sm:flex-row">
          <Button asChild size="lg">
            <Link href={`/rechnung/${token}`}>Zur Rechnung</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/">Zur Startseite</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
