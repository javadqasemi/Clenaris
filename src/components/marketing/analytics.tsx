'use client';

import Script from 'next/script';
import * as React from 'react';

import { clientEnv } from '@/lib/env';
import { hasConsent, onConsentChange, type ConsentState } from '@/lib/consent';

/**
 * Analyse- und Marketing-Skripte.
 *
 * Architekturentscheid: Skripte werden erst geladen, wenn die Einwilligung
 * vorliegt — nicht mit `denied`-Default vorgeladen. Das Schweizer DSG und die
 * DSGVO verlangen eine vorgängige Einwilligung für nicht notwendige Cookies;
 * die einzige technisch saubere Umsetzung ist, den Code gar nicht erst
 * auszuführen.
 */
export function AnalyticsScripts() {
  const [consent, setConsent] = React.useState<ConsentState | null>(null);

  React.useEffect(() => {
    setConsent(hasConsent());
    return onConsentChange(setConsent);
  }, []);

  if (!consent?.analytics && !consent?.marketing) return null;

  return (
    <>
      {consent.analytics && clientEnv.NEXT_PUBLIC_GA_MEASUREMENT_ID ? (
        <>
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${clientEnv.NEXT_PUBLIC_GA_MEASUREMENT_ID}`}
            strategy="afterInteractive"
          />
          <Script id="ga-init" strategy="afterInteractive">
            {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              gtag('config', '${clientEnv.NEXT_PUBLIC_GA_MEASUREMENT_ID}', {
                anonymize_ip: true,
                cookie_flags: 'SameSite=Lax;Secure'
              });
            `}
          </Script>
        </>
      ) : null}

      {consent.analytics && clientEnv.NEXT_PUBLIC_GTM_ID ? (
        <Script id="gtm" strategy="afterInteractive">
          {`
            (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
            new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
            j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
            'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
            })(window,document,'script','dataLayer','${clientEnv.NEXT_PUBLIC_GTM_ID}');
          `}
        </Script>
      ) : null}

      {consent.marketing && clientEnv.NEXT_PUBLIC_FACEBOOK_PIXEL_ID ? (
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
            fbq('init', '${clientEnv.NEXT_PUBLIC_FACEBOOK_PIXEL_ID}');
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
