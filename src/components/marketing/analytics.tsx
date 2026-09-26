'use client';

import Script from 'next/script';
import * as React from 'react';

import { hasConsent, onConsentChange, type ConsentState } from '@/lib/consent';
import { PublicRuntimeConfigSchema, type PublicRuntimeConfig } from '@/lib/laufzeit-konfiguration';

type Kennungen = PublicRuntimeConfig['analytics'];

/**
 * Analyse- und Marketing-Skripte.
 *
 * Architekturentscheid: Skripte werden erst geladen, wenn die Einwilligung
 * vorliegt — nicht mit `denied`-Default vorgeladen. Das Schweizer DSG und die
 * DSGVO verlangen eine vorgängige Einwilligung für nicht notwendige Cookies;
 * die einzige technisch saubere Umsetzung ist, den Code gar nicht erst
 * auszuführen.
 *
 * **Kennungen zur Laufzeit (V2-1, 2026-09-26).** Bis dahin standen sie als
 * `process.env.NEXT_PUBLIC_…` im Bündel — beim Bau eingesetzt. Eine
 * Probeumgebung mit demselben Artefakt hätte an die Analyse der Produktion
 * gemeldet, und ohne neuen Bau liess sich keine Kennung ändern. Jetzt holt
 * die Komponente sie erst nach der Einwilligung von
 * `/api/public/runtime-config` und prüft sie **auch hier** gegen das Schema:
 * Sie werden in Skriptzeilen eingesetzt, und was nicht dem engen Format
 * entspricht, wird nicht eingesetzt. Ohne Einwilligung keine Anfrage.
 */
export function AnalyticsScripts() {
  const [consent, setConsent] = React.useState<ConsentState | null>(null);
  const [kennungen, setKennungen] = React.useState<Kennungen | null>(null);

  React.useEffect(() => {
    setConsent(hasConsent());
    return onConsentChange(setConsent);
  }, []);

  const benoetigt = Boolean(consent?.analytics || consent?.marketing);
  React.useEffect(() => {
    if (!benoetigt || kennungen) return;
    const abbruch = new AbortController();
    fetch('/api/public/runtime-config', { signal: abbruch.signal, credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : null))
      .then((antwort: { data?: unknown } | null) => {
        const geprueft = PublicRuntimeConfigSchema.safeParse(antwort?.data);
        // Ungültig oder nicht erreichbar: keine Skripte — geschlossen, nicht offen.
        setKennungen(geprueft.success ? geprueft.data.analytics : {});
      })
      .catch(() => {
        if (!abbruch.signal.aborted) setKennungen({});
      });
    return () => abbruch.abort();
  }, [benoetigt, kennungen]);

  if (!consent || !benoetigt || !kennungen) return null;

  return (
    <>
      {consent.analytics && kennungen.gaMeasurementId ? (
        <>
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${kennungen.gaMeasurementId}`}
            strategy="afterInteractive"
          />
          <Script id="ga-init" strategy="afterInteractive">
            {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              gtag('config', '${kennungen.gaMeasurementId}', {
                anonymize_ip: true,
                cookie_flags: 'SameSite=Lax;Secure'
              });
            `}
          </Script>
        </>
      ) : null}

      {consent.analytics && kennungen.gtmId ? (
        <Script id="gtm" strategy="afterInteractive">
          {`
            (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
            new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
            j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
            'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
            })(window,document,'script','dataLayer','${kennungen.gtmId}');
          `}
        </Script>
      ) : null}

      {consent.marketing && kennungen.facebookPixelId ? (
        <Script id="meta-pixel" strategy="afterInteractive">
          {`
            !function(f,b,e,v,n,t,s)
            {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
            n.callMethod.apply(n,arguments):n.queue.push(arguments)};
            if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
            n.queue=[];t=b.createElement(e);t.async=!0;
            t.src=v;s=b.getElementsByTagName(e)[0];
            s.parentNode.insertBefore(t,s)}(window,document,'script',
            'https://connect.facebook.net/en_US/fbevents.js');
            fbq('init', '${kennungen.facebookPixelId}');
            fbq('track', 'PageView');
          `}
        </Script>
      ) : null}
    </>
  );
}

/**
 * Konversionsereignis melden (Buchung abgeschlossen, Offerte angefragt).
 * Fehlt die Einwilligung, passiert nichts — der Aufrufer muss das nicht prüfen.
 */
export function trackEvent(
  name: string,
  params: Record<string, string | number | boolean> = {},
): void {
  if (typeof window === 'undefined') return;
  const consent = hasConsent();
  if (!consent.analytics) return;

  const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
  gtag?.('event', name, params);

  if (consent.marketing) {
    const fbq = (window as unknown as { fbq?: (...args: unknown[]) => void }).fbq;
    if (name === 'purchase' || name === 'booking_completed') {
      fbq?.('track', 'Purchase', { value: params.value, currency: 'CHF' });
    } else if (name === 'quote_requested') {
      fbq?.('track', 'Lead');
    }
  }
}
