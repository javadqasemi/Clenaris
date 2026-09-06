import Link from 'next/link';
import { ArrowRight, Home, Phone, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Logo } from '@/components/marketing/logo';

export const metadata = {
  title: 'Seite nicht gefunden',
  robots: { index: false, follow: false },
};

/**
 * 404-Seite.
 *
 * Kein Wortspiel, keine Illustration — sondern die drei Wege, die jemand
 * tatsächlich sucht, wenn eine Seite fehlt.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="container flex h-20 items-center">
        <Logo />
      </header>

      <main id="inhalt" className="container flex flex-1 items-center py-20">
        <div className="mx-auto max-w-xl space-y-8">
          <div className="space-y-3">
            <p className="font-display text-6xl font-bold tabular-nums text-primary/25">404</p>
            <h1 className="text-headline font-bold text-balance">Diese Seite gibt es nicht</h1>
            <p className="text-lg leading-relaxed text-muted-foreground">
              Vielleicht wurde sie verschoben oder der Link enthält einen Tippfehler. Hier kommen
              Sie weiter:
            </p>
          </div>

          <ul className="divide-y divide-border border-y border-border">
            {[
              {
                href: '/',
                label: 'Zur Startseite',
                description: 'Übersicht über alle Leistungen und Preise',
                Icon: Home,
              },
              {
                href: '/buchen',
                label: 'Termin buchen',
                description: 'Preis berechnen und Zeitfenster wählen',
                Icon: Search,
              },
              {
                href: '/kontakt',
                label: 'Kontakt aufnehmen',
                description: 'Wir helfen Ihnen persönlich weiter',
                Icon: Phone,
              },
            ].map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="group flex items-center gap-4 py-4 transition-colors hover:text-primary"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
                    <item.Icon className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{item.label}</span>
                    <span className="block text-sm text-muted-foreground">{item.description}</span>
                  </span>
                  <ArrowRight
                    className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-spring group-hover:translate-x-0.5"
                    aria-hidden
                  />
                </Link>
              </li>
            ))}
          </ul>

          <Button asChild size="lg">
            <Link href="/">Zur Startseite</Link>
          </Button>
        </div>
      </main>
    </div>
  );
}
