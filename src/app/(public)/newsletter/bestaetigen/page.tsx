import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, MailCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { NewsletterAktion } from '@/features/public/newsletter-aktion';
import { newsletterLinkStand } from '@/server/services/newsletter.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const metadata: Metadata = {
  title: 'Newsletter bestätigen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Double-Opt-in-Bestätigung.
 *
 * Die Seite **liest nur** (2026-09-27). Früher bestätigte sie schon beim
 * Laden — und der Vorabaufruf eines Mailfilters genügte, um eine Anmeldung zu
 * bestätigen, die die Person nie bestätigt hatte. Jetzt bestätigt erst die
 * Schaltfläche (`POST /api/public/newsletter/bestaetigen`); der Token wird
 * dabei entwertet, ein zweiter Aufruf desselben Links zeigt die Fehlermeldung.
 */
export default async function NewsletterConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const stand = await newsletterLinkStand(await getOrganizationId(), 'bestaetigen', token);

  const Symbol = stand === 'offen' ? MailCheck : stand === 'erledigt' ? CheckCircle2 : AlertCircle;
  const farbe =
    stand === 'unbekannt' ? 'bg-destructive/12 text-destructive' : stand === 'erledigt' ? 'bg-success/12 text-success' : 'bg-primary/12 text-primary';

  return (
    <div className="container flex min-h-[70vh] max-w-xl items-center py-20">
      <div className="w-full space-y-8 text-center">
        <div className={`mx-auto flex size-16 items-center justify-center rounded-2xl ${farbe}`}>
          <Symbol className="size-8" aria-hidden />
        </div>

        <div className="space-y-3">
          <h1 className="text-headline font-bold text-balance">
            {stand === 'offen' ? 'Anmeldung bestätigen' : stand === 'erledigt' ? 'Sie sind dabei' : 'Bestätigung fehlgeschlagen'}
          </h1>
          <p className="text-lg leading-relaxed text-muted-foreground text-pretty">
            {stand === 'offen'
              ? 'Ein Klick noch: Bestätigen Sie, dass Sie unseren Newsletter erhalten möchten. Wir schreiben rund einmal im Monat — mit praktischen Tipps und gelegentlich einem Aktionscode.'
              : stand === 'erledigt'
                ? 'Ihre Anmeldung ist bestätigt. Abmelden können Sie sich in jeder E-Mail mit einem Klick.'
                : 'Dieser Bestätigungslink ist ungültig oder wurde bereits verwendet. Melden Sie sich einfach erneut an.'}
          </p>
        </div>

        {stand === 'offen' && token ? (
          <NewsletterAktion art="bestaetigen" token={token} beschriftung="Anmeldung bestätigen" />
        ) : (
          <div className="flex flex-col justify-center gap-3 sm:flex-row">
            <Button asChild size="lg">
              <Link href="/">Zur Startseite</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/blog">Ratgeber lesen</Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
