/**
 * Auswahl der sichtbaren Handlungsaufrufe.
 *
 * Diese Datei enthält keine Server-Abhängigkeiten, weil dieselbe Entscheidung
 * an zwei Orten fällt:
 *
 *  • **Auf dem Server**, wenn eine Seite ihre eigenen Aufrufe rendert — sie
 *    kennt ihren Pfad.
 *  • **Im Browser**, für Kopf- und Fusszeile. Die liegen im Layout und kennen
 *    den Pfad nicht: die Middleware läuft aus gutem Grund nicht auf
 *    öffentlichen Seiten (ein Edge-Aufruf je Seitenaufruf), und ein Layout in
 *    Next.js bekommt den Pfad nicht gereicht. Das Layout lädt deshalb die
 *    Aufrufe *aller* Seiten — es sind eine Handvoll Zeilen — und ein kleines
 *    Client-Bauteil wählt daraus aus.
 *
 * Läge die Regel doppelt vor, würde sie irgendwann auseinanderlaufen und
 * Kopfzeile und Seiteninhalt zeigten verschiedene Aufrufe.
 */

export interface CtaLike {
  pages: string[];
  publishFrom: Date | string | null;
  publishUntil: Date | string | null;
}

/**
 * Passt ein Seitenmuster auf den aktuellen Pfad?
 *
 * `/leistungen/*` trifft `/leistungen/umzugsreinigung` **und** `/leistungen`
 * selbst — wer „alle Leistungsseiten" meint, meint die Übersicht mit. Eine
 * leere Musterliste trifft überall.
 */
export function matchesPage(patterns: string[], pathname: string): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((pattern) => {
    if (pattern.endsWith('/*')) {
      const base = pattern.slice(0, -2);
      return pathname === base || pathname.startsWith(`${base}/`);
    }
    return pathname === pattern;
  });
}

/**
 * Liegt der Zeitpunkt im geplanten Fenster?
 *
 * Wird beim *Lesen* ausgewertet, nicht von einem nächtlichen Lauf. Ein Cron,
 * der `active` umschaltet, wäre eine zweite Wahrheit: fällt er aus, bleibt
 * eine abgelaufene Aktion stehen. Ein Vergleich mit der Uhr kostet nichts und
 * kann nicht ausfallen.
 */
export function withinSchedule(
  from: Date | string | null,
  until: Date | string | null,
  now: Date = new Date(),
): boolean {
  if (from && now < new Date(from)) return false;
  if (until && now > new Date(until)) return false;
  return true;
}

/** Beides zusammen — die vollständige Sichtbarkeitsregel. */
export function isVisible(cta: CtaLike, pathname: string, now: Date = new Date()): boolean {
  return matchesPage(cta.pages, pathname) && withinSchedule(cta.publishFrom, cta.publishUntil, now);
}
