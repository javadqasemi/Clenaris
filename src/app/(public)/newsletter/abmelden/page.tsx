import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertCircle, MailX } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { NewsletterAktion } from '@/features/public/newsletter-aktion';
import { newsletterLinkStand } from '@/server/services/newsletter.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const metadata: Metadata = {
  title: 'Newsletter abbestellen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Abmeldung mit einem Klick.
 *
 * Kein Bestätigungsschritt, keine Rückfrage, kein Login — die DSGVO verlangt,
 * dass der Widerruf so einfach ist wie die Anmeldung. Aber der Klick auf die
 * Schaltfläche meldet ab, nicht schon der Seitenaufruf (2026-09-27): Mailfilter
 * rufen Links vorab auf und trugen so Abonnenten aus, die nie abbestellen
 * wollten. Die Seite liest nur; geschrieben wird über
 * `POST /api/public/newsletter/abmelden`.
 */
export default async function NewsletterUnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const stand = await newsletterLinkStand(await getOrganizationId(), 'abmelden', token);

  return (
    <div className="container flex min-h-[70vh] max-w-xl items-center py-20">
      <div className="w-full space-y-8 text-center">
        <div
          className={`mx-auto flex size-16 items-center justify-center rounded-2xl ${
            stand === 'unbekannt' ? 'bg-destructive/12 text-destructive' : 'bg-muted text-muted-foreground'
          }`}
        >
          {stand === 'unbekannt' ? <AlertCircle className="size-8" aria-hidden /> : <MailX className="size-8" aria-hidden />}
        </div>

        <div className="space-y-3">
          <h1 className="text-headline font-bold text-balance">
            {stand === 'offen' ? 'Newsletter abbestellen' : stand === 'erledigt' ? 'Sie sind abgemeldet' : 'Abmeldung nicht möglich'}
          </h1>
          <p className="text-lg leading-relaxed text-muted-foreground text-pretty">
            {stand === 'offen'
              ? 'Ein Klick genügt — danach senden wir Ihnen keine Newsletter mehr. Terminbestätigungen und Rechnungen erhalten Sie weiterhin; das sind keine Werbe-E-Mails.'
              : stand === 'erledigt'
                ? 'Wir senden Ihnen keine Newsletter mehr. Terminbestätigungen und Rechnungen erhalten Sie weiterhin — das sind keine Werbe-E-Mails.'
                : 'Dieser Abmeldelink ist ungültig. Schreiben Sie uns kurz, wir erledigen die Abmeldung von Hand.'}
          </p>
        </div>

        {stand === 'offen' && token ? (
          <NewsletterAktion art="abmelden" token={token} beschriftung="Newsletter abbestellen" />
        ) : (
          <div className="flex flex-col justify-center gap-3 sm:flex-row">
            <Button asChild size="lg" variant="outline">
              <Link href="/">Zur Startseite</Link>
            </Button>
            {stand === 'unbekannt' ? (
              <Button asChild size="lg">
                <Link href="/kontakt">Kontakt aufnehmen</Link>
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
