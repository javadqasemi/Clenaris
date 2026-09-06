import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertCircle, MailX } from 'lucide-react';

import { prisma } from '@/lib/db';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'Newsletter abbestellen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Abmeldung mit einem Klick.
 *
 * Kein Bestätigungsschritt, keine Rückfrage, kein Login. Die DSGVO verlangt,
 * dass der Widerruf so einfach ist wie die Anmeldung — und alles andere
 * erzeugt nur Spam-Beschwerden.
 */
export default async function NewsletterUnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  let unsubscribed = false;
  let email: string | null = null;

  if (token) {
    const subscriber = await prisma.newsletterSubscriber.findUnique({
      where: { unsubscribeToken: token },
    });

    if (subscriber) {
      await prisma.newsletterSubscriber.update({
        where: { id: subscriber.id },
        data: { unsubscribedAt: new Date(), confirmed: false },
      });
      unsubscribed = true;
      email = subscriber.email;
    }
  }

  return (
    <div className="container flex min-h-[70vh] max-w-xl items-center py-20">
      <div className="w-full space-y-8 text-center">
        <div
          className={`mx-auto flex size-16 items-center justify-center rounded-2xl ${
            unsubscribed ? 'bg-muted text-muted-foreground' : 'bg-destructive/12 text-destructive'
          }`}
        >
          {unsubscribed ? (
            <MailX className="size-8" aria-hidden />
          ) : (
            <AlertCircle className="size-8" aria-hidden />
          )}
        </div>

        <div className="space-y-3">
          <h1 className="text-headline font-bold text-balance">
            {unsubscribed ? 'Sie sind abgemeldet' : 'Abmeldung nicht möglich'}
          </h1>
          <p className="text-lg leading-relaxed text-muted-foreground text-pretty">
            {unsubscribed
              ? `Wir senden keine Newsletter mehr an ${email}. Terminbestätigungen und Rechnungen erhalten Sie weiterhin — das sind keine Werbe-E-Mails.`
              : 'Dieser Abmeldelink ist ungültig. Schreiben Sie uns kurz, wir erledigen die Abmeldung von Hand.'}
          </p>
        </div>

        <div className="flex flex-col justify-center gap-3 sm:flex-row">
          <Button asChild size="lg" variant="outline">
            <Link href="/">Zur Startseite</Link>
          </Button>
          {!unsubscribed ? (
            <Button asChild size="lg">
              <Link href="/kontakt">Kontakt aufnehmen</Link>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
