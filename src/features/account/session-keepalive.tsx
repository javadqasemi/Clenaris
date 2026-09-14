'use client';

import * as React from 'react';

/**
 * Aktivitätswächter der Sitzung.
 *
 * Zwei Aufgaben, beide aus derselben Beobachtung: Der Zugangstoken lebt
 * fünfzehn Minuten, und wer länger auf einer Seite arbeitet, stand vorher
 * ohne Vorwarnung vor der Anmeldemaske.
 *
 *  1. **Wer arbeitet, bleibt angemeldet.** Solange innerhalb des
 *     Leerlauffensters Aktivität war (Maus, Tastatur, Berührung, Scrollen),
 *     wird die Sitzung alle zehn Minuten vorbeugend erneuert — deutlich vor
 *     dem Ablauf des Zugangstokens, damit weder ein Seitenaufruf noch ein
 *     API-Aufruf je ins Leere läuft.
 *
 *  2. **Wer nicht arbeitet, wird abgemeldet.** Nach `idleSeconds` ohne
 *     Aktivität beendet der Browser die Sitzung selbst und geht zur
 *     Anmeldung, mit Rücksprungziel und Grund. Das ist keine reine
 *     Bequemlichkeit: Der Server lässt einen Refresh-Token ohnehin nur
 *     innerhalb desselben Fensters erneuern. Der Wächter sorgt nur dafür,
 *     dass die Person es erfährt, statt beim nächsten Klick zu stolpern.
 *
 * Ein versteckter Tab zählt als Leerlauf — wer zurückkommt und länger als
 * das Fenster weg war, wird abgemeldet; wer kürzer weg war, bekommt sofort
 * eine Erneuerung, weil der Token in der Zwischenzeit abgelaufen sein kann.
 *
 * Bewusst kein Countdown-Dialog: Der unterbricht die Arbeit genau der
 * Personen, die gerade arbeiten, und rettet niemanden, der weg ist.
 */

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart', 'wheel'] as const;
const CHECK_EVERY_MS = 30_000;
const REFRESH_EVERY_MS = 10 * 60_000;
const ACTIVITY_THROTTLE_MS = 5_000;

export function SessionKeepalive({ idleSeconds }: { idleSeconds: number }) {
  React.useEffect(() => {
    const idleMs = Math.max(60_000, idleSeconds * 1000);
    let lastActivity = Date.now();
    let lastRefresh = Date.now();
    let lastNoted = 0;
    let stopped = false;

    const noteActivity = () => {
      const now = Date.now();
      // Gedrosselt: `pointermove` feuert hundertfach je Sekunde, und ein
      // Zeitstempel je fünf Sekunden ist für ein Viertelstundenfenster genau genug.
      if (now - lastNoted < ACTIVITY_THROTTLE_MS) return;
      lastNoted = now;
      lastActivity = now;
    };

    const signOut = async () => {
      if (stopped) return;
      stopped = true;
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
      const here = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/auth/anmelden?weiter=${encodeURIComponent(here)}&grund=inaktiv`);
    };

    const refresh = async () => {
      const response = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' }).catch(() => null);
      if (response?.ok) {
        lastRefresh = Date.now();
        return;
      }
      // 429: die Bremse hat gegriffen, der Token gilt noch — beim nächsten
      // Durchgang erneut versuchen. Alles andere heisst: die Sitzung ist weg.
      if (response?.status === 429) return;
      if (!stopped) {
        stopped = true;
        const here = `${window.location.pathname}${window.location.search}`;
        window.location.assign(`/auth/anmelden?weiter=${encodeURIComponent(here)}&grund=abgelaufen`);
      }
    };

    const check = () => {
      if (stopped) return;
      const now = Date.now();
      if (now - lastActivity >= idleMs) {
        void signOut();
        return;
      }
      if (now - lastRefresh >= REFRESH_EVERY_MS) void refresh();
    };

    const onVisibility = () => {
      if (document.visibilityState !== 'visible' || stopped) return;
      const now = Date.now();
      if (now - lastActivity >= idleMs) {
        void signOut();
        return;
      }
      // Sichtbar und noch im Fenster: Der Token kann während der Abwesenheit
      // abgelaufen sein — lieber jetzt erneuern als beim nächsten Klick.
      lastActivity = now;
      void refresh();
    };

    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, noteActivity, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(check, CHECK_EVERY_MS);

    return () => {
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, noteActivity);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(timer);
    };
  }, [idleSeconds]);

  return null;
}
