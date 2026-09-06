import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertCircle, CheckCircle2 } from 'lucide-react';

import { prisma } from '@/lib/db';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'Newsletter bestätigen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Double-Opt-in-Bestätigung.
 *
 * Der Token wird beim Bestätigen entwertet — ein zweiter Aufruf desselben
 * Links führt daher zur Fehlermeldung. Das ist gewollt: der Link soll nicht
 * dauerhaft gültig bleiben.
 */
export default async function NewsletterConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  let confirmed = false;

  if (token) {
    const subscriber = await prisma.newsletterSubscriber.findUnique({
      where: { confirmToken: token },
    });

    if (subscriber && !subscriber.confirmed) {
      await prisma.newsletterSubscriber.update({
        where: { id: subscriber.id },
        data: { confirmed: true, confirmToken: null, unsubscribedAt: null },
      });
      confirmed = true;
    } else if (subscriber?.confirmed) {
      confirmed = true;
    }
  }

  return (
    <div className="container flex min-h-[70vh] max-w-xl items-center py-20">
      <div className="w-full space-y-8 text-center">
        <div
          className={`mx-auto flex size-16 items-center justify-center rounded-2xl ${
            confirmed ? 'bg-success/12 text-success' : 'bg-destructive/12 text-destructive'
          }`}
        >
          {confirmed ? (
            <CheckCircle2 className="size-8" aria-hidden />
          ) : (
            <AlertCircle className="size-8" aria-hidden />
          )}
        </div>

        <div className="space-y-3">
          <h1 className="text-headline font-bold text-balance">
            {confirmed ? 'Sie sind dabei' : 'Bestätigung fehlgeschlagen'}
          </h1>
          <p className="text-lg leading-relaxed text-muted-foreground text-pretty">
            {confirmed
              ? 'Ihre Anmeldung ist bestätigt. Wir schreiben rund einmal im Monat — mit praktischen Tipps und gelegentlich einem Aktionscode. Abmelden können Sie sich in jeder E-Mail mit einem Klick.'
              : 'Dieser Bestätigungslink ist ungültig oder wurde bereits verwendet. Melden Sie sich einfach erneut an.'}
          </p>
        </div>

        <div className="flex flex-col justify-center gap-3 sm:flex-row">
          <Button asChild size="lg">
            <Link href="/">Zur Startseite</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/blog">Ratgeber lesen</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
