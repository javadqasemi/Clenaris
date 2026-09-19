import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CheckCircle2, Clock } from 'lucide-react';

import { prisma } from '@/lib/db';
import { resolveCheckoutSession } from '@/lib/payments/stripe';
import { issuePublicToken } from '@/server/services/access-token.service';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'Zahlung abgeschlossen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Rückkehr von Stripe nach einer Zahlung.
 *
 * **Warum es diese Seite gibt.** Die Rückkehradressen lauteten früher
 * `/rechnung/<roher Token>/danke` und `/rechnung/<roher Token>`. Damit ging
 * der Capability-Token, der eine Rechnung öffnet und eine Zahlung auslöst,
 * als Teil der Adresse an Stripe — und lag dort in der Checkout-Sitzung, im
 * Dashboard, in API-Antworten und in der Webhook-Nutzlast. Ein Geheimnis in
 * fremder Datenhaltung, für nichts als eine Weiterleitung.
 *
 * Zurück kommt jetzt allein Stripes eigene Sitzungskennung. Diese Seite löst
 * sie serverseitig auf, prüft, dass die Sitzung von dieser Anwendung stammt,
 * liest die Rechnungsreferenz und stellt **danach** einen frischen,
 * kurzlebigen Ansichtstoken aus. Fehlt eines davon, gibt es keinen Token und
 * keine Weiterleitung.
 *
 * **Diese Seite bucht nichts.** Der Zahlungsstand kommt aus dem Webhook; wer
 * den Tab nach der Zahlung schliesst, sieht diese Seite nie, und eine
 * Buchung, die daran hinge, fiele in genau diesem Fall aus. Umgekehrt
 * beweist das Aufrufen dieser Adresse nichts — sie stellt fest, sie
 * entscheidet nicht.
 */

/** Wie lange der Ansichtslink nach der Rückkehr gilt. */
const RUECKKEHR_TTL_MS = 2 * 60 * 60 * 1000;

export default async function ZahlungAbschlussSeite({
  searchParams,
}: {
  searchParams: Promise<{ sitzung?: string }>;
}) {
  const { sitzung } = await searchParams;

  /**
   * Das Ziel bestimmt ausschliesslich der Server. Es gibt hier bewusst kein
   * `weiter`, `returnUrl` oder `next` aus der Adresse — eine offene
   * Weiterleitung wäre ein Geschenk an jeden, der eine Phishing-Seite hinter
   * einer Clenaris-Adresse verstecken will.
   */
  const rueckkehr = sitzung ? await resolveCheckoutSession(sitzung) : null;

  if (rueckkehr) {
    const rechnung = await prisma.invoice.findFirst({
      where: {
        id: rueckkehr.invoiceId,
        organizationId: rueckkehr.organizationId,
        deletedAt: null,
      },
      select: { id: true, organizationId: true },
    });

    if (rechnung) {
      const link = await issuePublicToken({
        organizationId: rechnung.organizationId,
        purpose: 'INVOICE_VIEW',
        resourceId: rechnung.id,
        expiresAt: new Date(Date.now() + RUECKKEHR_TTL_MS),
      });
      redirect(`/rechnung/${link.raw}/danke`);
    }
  }

  /**
   * Ohne auflösbare Sitzung wird nichts ausgestellt und nichts verraten. Die
   * Zahlung kann trotzdem erfolgreich gewesen sein — deshalb keine
   * Fehlermeldung, sondern der ehrliche Stand: Der Webhook entscheidet.
   */
  return (
    <div className="container flex min-h-[70vh] max-w-xl items-center py-20">
      <div className="w-full space-y-8 text-center">
        <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-success/12 text-success">
          <CheckCircle2 className="size-8" aria-hidden />
        </div>

        <div className="space-y-3">
          <h1 className="text-headline font-bold text-balance">Vielen Dank für Ihre Zahlung</h1>
          <p className="text-lg leading-relaxed text-muted-foreground text-pretty">
            Die Zahlung wurde bei unserem Zahlungsdienstleister abgeschlossen. Sie erhalten in
            Kürze eine Bestätigung per E-Mail.
          </p>
        </div>

        <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-left">
          <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="text-sm leading-relaxed text-muted-foreground">
            Die Rechnung wird innerhalb weniger Minuten als bezahlt angezeigt. Sollte das länger
            dauern, ist das kein Grund zur Sorge — Ihre Zahlung ist erfasst. Den aktuellen Stand
            sehen Sie jederzeit über den Rechnungslink aus Ihrer E-Mail oder in Ihrem Konto.
          </p>
        </div>

        <div className="flex flex-col justify-center gap-3 sm:flex-row">
          <Button asChild size="lg" variant="outline">
            <Link href="/">Zur Startseite</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
