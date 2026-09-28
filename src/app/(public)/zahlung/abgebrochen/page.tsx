import type { Metadata } from 'next';
import Link from 'next/link';
import { XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'Zahlung abgebrochen',
  robots: { index: false, follow: false },
};

/**
 * Rückkehr von Stripe nach einem Abbruch.
 *
 * **Warum diese Seite nichts weiss.** Sie bekommt keine Sitzungskennung und
 * keine Rechnungsreferenz. Für `cancel_url` ist die Ersetzung von
 * `{CHECKOUT_SESSION_ID}` nicht in derselben Weise zugesichert wie für
 * `success_url`, und einen Capability-Token an Stripe zu geben, nur damit
 * eine Abbruchseite den Namen einer Rechnung anzeigen kann, wäre ein
 * schlechter Tausch. Vorher stand genau das in der Adresse.
 *
 * **Und warum sie nichts entscheidet.** Ein Abbruch heisst nicht, dass die
 * Zahlung endgültig gescheitert ist — Stripe kann dieselbe Sitzung noch
 * abschliessen, und ein Kartenbeleg kann verzögert eintreffen. Ein
 * Statuswechsel allein aufgrund dieses Seitenaufrufs wäre eine Behauptung
 * ohne Grundlage. Gebucht wird im Webhook, hier gar nichts.
 *
 * Statisch: Es gibt nichts nachzuschlagen.
 */
export default function ZahlungAbgebrochenSeite() {
  return (
    <div className="container flex min-h-[70vh] max-w-xl items-center py-20">
      <div className="w-full space-y-8 text-center">
        <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <XCircle className="size-8" aria-hidden />
        </div>

        <div className="space-y-3">
          <h1 className="text-headline font-bold text-balance">Zahlung abgebrochen</h1>
          <p className="text-lg leading-relaxed text-muted-foreground text-pretty">
            Über diesen Vorgang wurde keine Zahlung bestätigt. Es wurde Ihnen nichts belastet.
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 text-left">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Sie können es jederzeit erneut versuchen — über den Rechnungslink aus Ihrer E-Mail
            oder, wenn Sie ein Konto haben, in Ihrem Kundenbereich unter &bdquo;Rechnungen&ldquo;. Die
            Rechnung bleibt auf jedem Weg offen, auch per Einzahlungsschein.
          </p>
        </div>

        <div className="flex flex-col justify-center gap-3 sm:flex-row">
          <Button asChild size="lg" variant="outline">
            <Link href="/konto/rechnungen">Zu meinen Rechnungen</Link>
          </Button>
          <Button asChild size="lg" variant="ghost">
            <Link href="/">Zur Startseite</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
