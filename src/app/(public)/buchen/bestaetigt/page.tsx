import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarCheck, Mail, Phone } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { getPublicCompanyInfo } from '@/server/services/organization.service';

export const metadata: Metadata = {
  title: 'Buchung eingegangen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function BookingConfirmedPage({
  searchParams,
}: {
  searchParams: Promise<{ nr?: string }>;
}) {
  const { nr } = await searchParams;
  const company = await getPublicCompanyInfo();

  return (
    <div className="container flex min-h-[70vh] items-center justify-center py-20">
      <div className="w-full max-w-xl space-y-8 text-center">
        <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-success/12 text-success">
          <CalendarCheck className="size-8" aria-hidden />
        </div>

        <div className="space-y-3">
          <h1 className="text-headline font-bold text-balance">Wir haben Ihre Buchung erhalten</h1>
          <p className="text-lg leading-relaxed text-muted-foreground text-pretty">
            {nr ? (
              <>
                Ihre Buchungsnummer lautet{' '}
                <span className="font-semibold tabular-nums text-foreground">{nr}</span>.{' '}
              </>
            ) : null}
            Wir prüfen den Termin und bestätigen ihn in der Regel innerhalb von zwei Stunden. Die
            Bestätigung kommt per E-Mail.
          </p>
        </div>

        <dl className="protocol-list rounded-2xl border border-border bg-card px-6 text-left">
          <div className="protocol-row">
            <dt className="protocol-label">Als Nächstes</dt>
            <dd className="protocol-value">
              Sie erhalten eine E-Mail mit allen Angaben und einem Link zum Verwalten des Termins.
            </dd>
          </div>
          <div className="protocol-row">
            <dt className="protocol-label">Bezahlung</dt>
            <dd className="protocol-value">
              Erst nach dem Einsatz, per QR-Rechnung mit 30 Tagen Frist oder online mit Karte und
              TWINT.
            </dd>
          </div>
          <div className="protocol-row">
            <dt className="protocol-label">Änderungen</dt>
            <dd className="protocol-value">
              Bis 24 Stunden vor dem Termin kostenlos — über den Link in der E-Mail oder telefonisch.
            </dd>
          </div>
        </dl>

        <div className="flex flex-col justify-center gap-3 sm:flex-row">
          <Button asChild size="lg">
            <Link href="/konto/buchungen">Zu meinen Buchungen</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/">Zur Startseite</Link>
          </Button>
        </div>

        <div className="flex flex-col items-center justify-center gap-4 border-t border-border pt-8 text-sm text-muted-foreground sm:flex-row sm:gap-8">
          {company.phone ? (
            <a
              href={`tel:${company.phone.replace(/\s/g, '')}`}
              className="inline-flex items-center gap-2 transition-colors hover:text-foreground"
            >
              <Phone className="size-4 text-primary" aria-hidden />
              {company.phone}
            </a>
          ) : null}
          <a
            href={`mailto:${company.email}`}
            className="inline-flex items-center gap-2 transition-colors hover:text-foreground"
          >
            <Mail className="size-4 text-primary" aria-hidden />
            {company.email}
          </a>
        </div>
      </div>
    </div>
  );
}
