'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';

import { hasConsent, onConsentChange } from '@/lib/consent';
import {
  trafficEreignis,
  trafficFreigabe,
  trafficJetztSenden,
  trafficSeitenansicht,
  trafficSitzungVergessen,
} from '@/lib/traffic/erfassen';

/**
 * Eigene Besuchsmessung der Website — der unsichtbare Teil im Rahmen.
 *
 * Rendert nichts. Meldet eine Seitenansicht beim ersten Laden und bei jedem
 * Wechsel des Pfads (App-Router-Navigation), einen Klick auf `tel:`- und
 * `mailto:`-Links und sendet Wartendes beim Verlassen der Seite. Alles nur
 * mit Einwilligung „Statistik"; wird sie erteilt, während die Seite offen
 * ist, zählt die aktuelle Seite ab diesem Moment (`onConsentChange`).
 *
 * **Warum `usePathname` und nicht auch `useSearchParams`.** Der öffentliche
 * Rahmen wird statisch vorgerendert; `useSearchParams` verlangte dort eine
 * Suspense-Grenze um den ganzen Rahmen und wäre genau die Art
 * Hydrationswettlauf, die `docs/HYDRATION.md` beschreibt. Eine Navigation, die
 * nur die Abfrage ändert (`?seite=2` im Blog), zählt deshalb nicht als neue
 * Seitenansicht — das ist für eine Besuchsauswertung die richtige Zählung.
 * Die UTM-Parameter liest der Erfassungshelfer beim Melden aus
 * `window.location`.
 *
 * **Warum ein Klick-Zuhörer am Dokument statt eines Aufrufs an jedem Link.**
 * Telefonnummer und E-Mail-Adresse stehen in Kopf- und Fusszeile, auf der
 * Kontaktseite, in den FAQ, auf der Buchungsbestätigung und in den
 * gepflegten Handlungsaufrufen (`CtaButton`) — die meisten davon Server
 * Components ohne eigenen Klickweg. Ein einziger Zuhörer in der
 * Einfangphase erfasst sie alle, auch künftige, ohne dass jemand beim
 * nächsten Link daran denken muss.
 *
 * **Zwei Schranken, in dieser Reihenfolge** (seit 2026-09-30): zuerst die
 * Einwilligung „Statistik", dann die Freigabe der Instanz
 * (`CLENARIS_BESUCHSMESSUNG`, über die Laufzeitkonfiguration). Ohne
 * Einwilligung wird nicht einmal nach der Freigabe gefragt — keine Anfrage
 * ohne Einwilligung. Mit Einwilligung, aber ausgeschalteter Messung bleibt
 * die Komponente vollständig still: keine Zuhörer, keine Sitzungskennung,
 * keine Meldung. Erwogen wurde, die Freigabe allein dem Erfassungshelfer zu
 * überlassen (er prüft sie ohnehin, für die Formulare); dann hingen hier bei
 * ausgeschalteter Messung trotzdem Klick- und Sichtbarkeitszuhörer, die bei
 * jedem Klick einen Weg ins Leere gingen.
 */
export function TrafficMessung() {
  const pfad = usePathname();
  const [einwilligung, setEinwilligung] = React.useState(false);
  const [freigegeben, setFreigegeben] = React.useState(false);
  const aktiv = einwilligung && freigegeben;

  React.useEffect(() => {
    try {
      setEinwilligung(hasConsent().analytics);
      return onConsentChange((zustand) => {
        setEinwilligung(zustand.analytics);
        if (!zustand.analytics) trafficSitzungVergessen();
      });
    } catch {
      return undefined;
    }
  }, []);

  React.useEffect(() => {
    if (!einwilligung || freigegeben) return;
    // Die Antwort kann eintreffen, nachdem die Komponente schon weg ist (oder
    // die Einwilligung widerrufen wurde) — dann wird sie verworfen.
    let gueltig = true;
    void trafficFreigabe().then((an) => {
      if (gueltig) setFreigegeben(an);
    });
    return () => {
      gueltig = false;
    };
  }, [einwilligung, freigegeben]);

  React.useEffect(() => {
    if (!aktiv) return;
    trafficSeitenansicht();
  }, [aktiv, pfad]);

  React.useEffect(() => {
    if (!aktiv) return;

    const klick = (event: MouseEvent) => {
      try {
        const ziel = event.target instanceof Element ? event.target.closest('a[href]') : null;
        const href = ziel?.getAttribute('href')?.trim().toLowerCase() ?? '';
        if (href.startsWith('tel:')) trafficEreignis('CONTACT_PHONE');
        else if (href.startsWith('mailto:')) trafficEreignis('CONTACT_EMAIL');
        else return;
        // Der Link verlässt die Seite (Telefon-App, Mailprogramm) — jetzt senden.
        trafficJetztSenden();
      } catch {
        /* Nie nach aussen. */
      }
    };
    const verlassen = () => trafficJetztSenden();
    const sichtbarkeit = () => {
      if (document.visibilityState === 'hidden') trafficJetztSenden();
    };

    document.addEventListener('click', klick, true);
    window.addEventListener('pagehide', verlassen);
    document.addEventListener('visibilitychange', sichtbarkeit);
    return () => {
      document.removeEventListener('click', klick, true);
      window.removeEventListener('pagehide', verlassen);
      document.removeEventListener('visibilitychange', sichtbarkeit);
    };
  }, [aktiv]);

  return null;
}
