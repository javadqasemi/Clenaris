'use client';

import * as React from 'react';
import Link from 'next/link';
import { Cookie } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/controls';
import { needsDecision, setConsent } from '@/lib/consent';

/**
 * Cookie-Hinweis.
 *
 * „Nur notwendige" steht gleichwertig neben „Alle akzeptieren" — beides ist ein
 * Klick, beides gleich prominent. Alles andere wäre ein Dark Pattern und nach
 * DSGVO/DSG unzulässig.
 */
export function CookieBanner() {
  const [open, setOpen] = React.useState(false);
  const [showDetails, setShowDetails] = React.useState(false);
  const [analytics, setAnalytics] = React.useState(true);
  const [marketing, setMarketing] = React.useState(false);

  React.useEffect(() => {
    // Kurz warten, damit das Banner nicht mit dem ersten Rendern konkurriert.
    const timer = window.setTimeout(() => setOpen(needsDecision()), 800);
    return () => window.clearTimeout(timer);
  }, []);

  if (!open) return null;

  const decide = (choice: { analytics: boolean; marketing: boolean }) => {
    setConsent(choice);
    setOpen(false);
  };

  return (
    <div
      role="dialog"
      aria-labelledby="cookie-title"
      aria-describedby="cookie-description"
      className="fixed inset-x-0 bottom-0 z-[60] p-3 sm:p-5"
    >
      <div className="glass-panel mx-auto max-w-3xl animate-fade-up rounded-2xl p-5 shadow-elevated sm:p-6">
        <div className="flex gap-4">
          <span className="hidden size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary sm:flex">
            <Cookie className="size-5" aria-hidden />
          </span>

          <div className="min-w-0 flex-1 space-y-4">
            <div className="space-y-1.5">
              <h2 id="cookie-title" className="font-display text-base font-semibold">
                Wir möchten die Website verbessern
              </h2>
              <p id="cookie-description" className="text-sm leading-relaxed text-muted-foreground">
                Für den Betrieb notwendige Cookies sind immer aktiv. Zusätzlich möchten wir
                anonymisiert messen, welche Seiten genutzt werden. Sie entscheiden.{' '}
                <Link href="/legal/cookies" className="underline underline-offset-2">
                  Details
                </Link>
              </p>
            </div>

            {showDetails ? (
              <div className="protocol-list rounded-xl border border-border bg-background/60 px-4">
                <div className="flex items-center justify-between gap-4 py-3.5">
                  <div>
                    <p className="text-sm font-medium">Notwendig</p>
                    <p className="text-xs text-muted-foreground">
                      Anmeldung, Warenkorb, Sicherheit. Ohne diese funktioniert die Website nicht.
                    </p>
                  </div>
                  <Switch checked disabled aria-label="Notwendige Cookies (immer aktiv)" />
                </div>

                <div className="flex items-center justify-between gap-4 py-3.5">
                  <div>
                    <p className="text-sm font-medium">Statistik</p>
                    <p className="text-xs text-muted-foreground">
                      Anonymisierte Nutzungszahlen (Google Analytics, IP gekürzt).
                    </p>
                  </div>
                  <Switch
                    checked={analytics}
                    onCheckedChange={setAnalytics}
                    aria-label="Statistik-Cookies"
                  />
                </div>

                <div className="flex items-center justify-between gap-4 py-3.5">
                  <div>
                    <p className="text-sm font-medium">Marketing</p>
                    <p className="text-xs text-muted-foreground">
                      Messung von Werbekampagnen (Meta, Google Ads).
                    </p>
                  </div>
                  <Switch
                    checked={marketing}
                    onCheckedChange={setMarketing}
                    aria-label="Marketing-Cookies"
                  />
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                onClick={() => decide({ analytics: true, marketing: true })}
                className="sm:flex-1"
              >
                Alle akzeptieren
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  decide(showDetails ? { analytics, marketing } : { analytics: false, marketing: false })
                }
                className="sm:flex-1"
              >
                {showDetails ? 'Auswahl speichern' : 'Nur notwendige'}
              </Button>
              {!showDetails ? (
                <Button variant="ghost" onClick={() => setShowDetails(true)}>
                  Einstellungen
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
