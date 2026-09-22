'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';

/**
 * Rückmeldung beim Navigieren — ein Fortschrittsbalken am oberen Rand.
 *
 * ---------------------------------------------------------------------------
 *  Warum es das gibt
 * ---------------------------------------------------------------------------
 *
 * Bis Wave 9.1 kam diese Rückmeldung aus den `loading.tsx`-Dateien der drei
 * angemeldeten Bereiche: Next legt für jede davon eine Suspense-Grenze an,
 * und bei einem Seitenwechsel erschien sofort ein Skelett. Diese Grenzen
 * mussten entfallen — die Begründung samt Messreihe steht in
 * `docs/HYDRATION.md`: Reacts gedrosselte Einblendung (`$RC`/`$RV`) kann die
 * eingeblendeten Knoten mitten in die laufende Hydration schieben, und in
 * ein bis sieben Prozent aller Seitenaufrufe verwarf React daraufhin den
 * **gesamten** Baum (`Minified React error #418`) und baute ihn neu.
 *
 * Ohne Ersatz hätte ein Klick auf einen Navigationseintrag gar nichts
 * bewirkt, bis die neue Seite fertig ist — und wer nichts sieht, klickt noch
 * einmal.
 *
 * **Der Ersatz ist an einer Stelle besser als das Bisherige:** Er greift bei
 * *jeder* Navigation. Die Skelette gab es nur für Routen mit eigener
 * `loading.tsx`; `/portal/profil`, `/portal/wissen`, `/admin/sicherheit` und
 * ein gutes Dutzend weitere hatten nie eine Rückmeldung.
 *
 * ---------------------------------------------------------------------------
 *  Drei Entscheidungen
 * ---------------------------------------------------------------------------
 *
 * **Der erste Rendervorgang ergibt `null` — auf dem Server und im Browser.**
 * Das ist keine Formsache, sondern der Grund, warum diese Komponente die
 * Krankheit nicht wiederholt, die sie behandelt: Ein Element, das im Browser
 * beim ersten Durchgang anders aussieht als im ausgelieferten HTML, ist genau
 * der Hydrationsfehler, den Wave 9.1 beseitigt hat. Der Balken entsteht
 * ausschliesslich durch einen Klick, also lange nach der Hydration.
 *
 * **Gehört wird am Dokument, nicht an einzelnen Links.** Next bietet seit
 * 15.3 `useLinkStatus()`, das aber nur *innerhalb* eines `<Link>` gilt — man
 * müsste jeden Link der Anwendung anfassen, und jede Liste, jede Tabellenzeile
 * und jeder Knopf wäre eine Stelle, die man vergessen kann. Ein Zuhörer in der
 * Erfassungsphase des Dokuments sieht jeden Anker, auch die in Listen und in
 * dynamisch nachgeladenen Teilen.
 *
 * **Beendet wird über den Pfadwechsel, mit einem Deckel.** `usePathname()`
 * ändert sich, sobald die neue Seite steht — das ist das richtige Signal.
 * Der Deckel von zwölf Sekunden ist die Antwort auf den Fall, den es sonst
 * gäbe: Eine Navigation, die scheitert (Fehlerseite, abgebrochene Anfrage,
 * gleicher Pfad mit anderem Suchparameter), liesse einen Balken stehen, der
 * für immer lädt. Ein Balken, der lügt, ist schlechter als keiner.
 */

/** Nach dieser Zeit verschwindet der Balken auch ohne Pfadwechsel. */
const DECKEL_MS = 12_000;

/** So lange bleibt der volle Balken stehen, bevor er ausgeblendet wird. */
const AUSKLANG_MS = 220;

export function NavigationProgress() {
  const pathname = usePathname();
  const [laeuft, setLaeuft] = React.useState(false);
  const [fertig, setFertig] = React.useState(false);

  /**
   * Der Pfad, bei dem der Balken gestartet ist.
   *
   * Ohne ihn beendete der Effekt unten den Balken sofort wieder: Er läuft
   * auch beim ersten Durchgang, und `pathname` hat sich dann nicht geändert.
   */
  const startpfad = React.useRef<string | null>(null);

  React.useEffect(() => {
    const beiKlick = (ereignis: MouseEvent) => {
      // Sekundärtasten und Modifikatoren öffnen einen neuen Tab — die aktuelle
      // Seite bleibt stehen, ein Fortschrittsbalken wäre dort eine Lüge.
      if (ereignis.defaultPrevented || ereignis.button !== 0) return;
      if (ereignis.metaKey || ereignis.ctrlKey || ereignis.shiftKey || ereignis.altKey) return;

      const ziel = (ereignis.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!ziel) return;
      if (ziel.target && ziel.target !== '_self') return;
      if (ziel.hasAttribute('download')) return;

      let adresse: URL;
      try {
        adresse = new URL(ziel.href, window.location.href);
      } catch {
        return;
      }
      // Fremder Ursprung: Der Browser verlässt die Anwendung, und der Balken
      // gehört nicht mehr uns.
      if (adresse.origin !== window.location.origin) return;
      // Reiner Anker auf derselben Seite (z. B. „Zum Inhalt springen").
      if (adresse.pathname === window.location.pathname && adresse.search === window.location.search) return;

      startpfad.current = window.location.pathname;
      setFertig(false);
      setLaeuft(true);
    };

    document.addEventListener('click', beiKlick, { capture: true });
    return () => document.removeEventListener('click', beiKlick, { capture: true });
  }, []);

  // Ziel erreicht: Der Pfad ist ein anderer als beim Start.
  React.useEffect(() => {
    if (!laeuft) return;
    if (startpfad.current === null || startpfad.current === pathname) return;
    setFertig(true);
    const zeitgeber = window.setTimeout(() => {
      setLaeuft(false);
      setFertig(false);
      startpfad.current = null;
    }, AUSKLANG_MS);
    return () => window.clearTimeout(zeitgeber);
  }, [pathname, laeuft]);

  // Deckel: nichts bleibt für immer stehen.
  React.useEffect(() => {
    if (!laeuft) return;
    const zeitgeber = window.setTimeout(() => {
      setLaeuft(false);
      setFertig(false);
      startpfad.current = null;
    }, DECKEL_MS);
    return () => window.clearTimeout(zeitgeber);
  }, [laeuft]);

  if (!laeuft) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">Seite wird geladen</span>
      <div
        className={
          fertig
            ? 'h-full w-full bg-primary transition-[width,opacity] duration-200 ease-out'
            : 'h-full w-1/3 animate-nav-progress bg-primary'
        }
      />
    </div>
  );
}
