'use client';

import * as React from 'react';
import { Clock } from 'lucide-react';

import { abmeldungBeenden, abmeldungBeginnen, abmeldungLaeuftBereits } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';

/**
 * Aktivitätswächter der Sitzung.
 *
 * Drei Aufgaben, alle aus derselben Beobachtung: Der Zugangstoken lebt
 * fünfzehn Minuten, der Server erneuert eine Sitzung nur innerhalb ihres
 * Leerlauffensters (`refreshSession`), und wer davon nichts merkt, steht beim
 * nächsten Klick vor der Anmeldemaske.
 *
 *  1. **Wer arbeitet, bleibt angemeldet.** Solange innerhalb des
 *     Leerlauffensters Aktivität war (Maus, Tastatur, Berührung, Scrollen),
 *     wird die Sitzung alle zehn Minuten vorbeugend erneuert.
 *
 *  2. **Wer nicht arbeitet, wird gewarnt und dann abgemeldet.** Zwei Minuten
 *     vor Ablauf erscheint ein Dialog („Sitzung läuft in 2 Minuten ab") mit
 *     „Weiterarbeiten" und „Abmelden". Ohne Antwort meldet der Browser die
 *     Sitzung nach `idleSeconds` selbst ab.
 *
 *     Früher stand hier bewusst *kein* Countdown — mit dem Argument, er
 *     unterbreche die, die arbeiten. Das trifft auf diesen Dialog nicht zu: Er
 *     erscheint erst nach dreizehn Minuten ohne jede Eingabe **in allen Tabs**,
 *     also nie mitten in der Arbeit — aber genau dann, wenn jemand ein langes
 *     Formular liest oder vom Telefon zurückkommt und sonst den Inhalt
 *     verlöre (2026-09-28).
 *
 *  3. **Mehrere Tabs sind eine Sitzung.** Bis 2026-09-28 führte jeder Tab
 *     seine eigene Uhr. Ein Tab im Hintergrund zählte als untätig und meldete
 *     nach fünfzehn Minuten **die ganze Sitzung** ab — während im Tab daneben
 *     gearbeitet wurde. Jetzt teilen die Tabs den Zeitpunkt der letzten
 *     Aktivität (`localStorage` + `BroadcastChannel`), und eine Abmeldung in
 *     einem Tab schickt alle anderen zur Anmeldemaske, statt sie mit einer
 *     toten Sitzung stehen zu lassen.
 *
 * **Was im Speicher des Browsers liegt:** nur ein Zeitstempel. Kein Token,
 * keine Kennung — die Sitzung selbst steht in `HttpOnly`-Cookies, die kein
 * Skript liest. Fehlt der Speicher (privates Fenster, gesperrt), arbeitet der
 * Wächter je Tab weiter wie zuvor.
 *
 * **Was er nicht kann:** das Schliessen des Browsers erkennen. Dafür gibt es
 * kein verlässliches Ereignis (`beforeunload` feuert auch beim Neuladen und
 * beim Wechsel der Seite, und nie beim Absturz). Das Ende mit dem Browser
 * besorgen die Sitzungscookies (`createSession`), das Ende nach Leerlauf der
 * Server — siehe `docs/SITZUNG.md`.
 */

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart', 'wheel'] as const;
const CHECK_EVERY_MS = 5_000;
const REFRESH_EVERY_MS = 10 * 60_000;
const ACTIVITY_THROTTLE_MS = 5_000;
const WARN_BEFORE_MS = 2 * 60_000;

const SPEICHER_SCHLUESSEL = 'clenaris.sitzung.letzteAktivitaet';
const KANAL = 'clenaris-sitzung';

type Nachricht = { art: 'aktiv'; zeit: number } | { art: 'abgemeldet' };

function gemeinsameAktivitaetLesen(): number {
  try {
    return Number(window.localStorage.getItem(SPEICHER_SCHLUESSEL)) || 0;
  } catch {
    return 0;
  }
}

function gemeinsameAktivitaetSchreiben(zeit: number): void {
  try {
    window.localStorage.setItem(SPEICHER_SCHLUESSEL, String(zeit));
  } catch {
    // Ohne Speicher (privates Fenster, gesperrt) bleibt es bei der Uhr je Tab.
  }
}

function kanalOeffnen(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(KANAL);
  } catch {
    return null;
  }
}

/**
 * Den anderen Tabs sagen, dass diese Sitzung beendet ist.
 *
 * Für die Abmeldung über das Profilmenü (`app-shell.tsx`): Sie läuft nicht
 * durch diesen Wächter, soll die anderen Tabs aber genauso erreichen.
 */
export function abmeldungVerbreiten(): void {
  const kanal = kanalOeffnen();
  kanal?.postMessage({ art: 'abgemeldet' } satisfies Nachricht);
  kanal?.close();
}

function restzeitText(ms: number): string {
  const sekunden = Math.max(0, Math.ceil(ms / 1000));
  const minuten = Math.floor(sekunden / 60);
  const rest = sekunden % 60;
  return minuten > 0 ? `${minuten}:${String(rest).padStart(2, '0')} Minuten` : `${rest} Sekunden`;
}

export function SessionKeepalive({ idleSeconds }: { idleSeconds: number }) {
  /** Restzeit bis zur Abmeldung, solange die Warnung steht — sonst `null`. */
  const [restzeit, setRestzeit] = React.useState<number | null>(null);
  const aktionen = React.useRef<{ weiter: () => void; abmelden: () => void }>({ weiter: () => {}, abmelden: () => {} });

  /*
    Der Wächter hängt sich ein, sobald ein angemeldeter Bereich gerendert
    wird — das ist der Beginn einer Sitzung in diesem Tab. Eine Abmeldemarke
    aus einer früheren Sitzung desselben Tabs (Abmelden über das Profilmenü,
    dann clientseitig neu angemeldet) gilt hier nicht mehr; ohne das Zurück-
    setzen sperrte `lib/api/client.ts` jede geschützte Abfrage der neuen
    Sitzung (2026-10-01). Ein eigener Effekt ohne Abhängigkeiten: Der
    Zeitgeber-Effekt unten läuft bei jedem neuen `idleSeconds` erneut, das
    Zurücksetzen gehört nur zum Einhängen.
  */
  React.useEffect(() => {
    abmeldungBeenden();
  }, []);

  React.useEffect(() => {
    const idleMs = Math.max(60_000, idleSeconds * 1000);
    const warnMs = Math.min(WARN_BEFORE_MS, Math.floor(idleMs / 4));
    const kanal = kanalOeffnen();

    let lastActivity = Math.max(Date.now(), gemeinsameAktivitaetLesen());
    let lastRefresh = Date.now();
    let lastNoted = 0;
    let stopped = false;
    let warnungOffen = false;

    const zurAnmeldung = (grund: 'inaktiv' | 'abgelaufen' | 'abgemeldet') => {
      // Dieses Ziel gilt — keine laufende Abfrage soll mit „abgelaufen" dazwischenspringen.
      abmeldungBeginnen();
      const here = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/auth/anmelden?weiter=${encodeURIComponent(here)}&grund=${grund}`);
    };

    const aktivitaetMerken = (zeit: number, verbreiten: boolean) => {
      if (zeit <= lastActivity) return;
      lastActivity = zeit;
      if (verbreiten) {
        gemeinsameAktivitaetSchreiben(zeit);
        kanal?.postMessage({ art: 'aktiv', zeit } satisfies Nachricht);
      }
      if (warnungOffen) {
        warnungOffen = false;
        setRestzeit(null);
      }
    };

    const noteActivity = () => {
      // Steht die Warnung, zählt nur die ausdrückliche Antwort: Die Bewegung,
      // mit der jemand zum Knopf fährt, soll den Dialog nicht wegziehen.
      if (warnungOffen) return;
      const now = Date.now();
      // Gedrosselt: `pointermove` feuert hundertfach je Sekunde, und ein
      // Zeitstempel je fünf Sekunden ist für ein Viertelstundenfenster genau genug.
      if (now - lastNoted < ACTIVITY_THROTTLE_MS) return;
      lastNoted = now;
      aktivitaetMerken(now, true);
    };

    const signOut = async (grund: 'inaktiv' | 'abgemeldet') => {
      if (stopped) return;
      stopped = true;
      // Schon vor dem Abmeldeaufruf: Sonst schickt eine laufende Abfrage mit
      // ihrem 401 zur Anmeldung „abgelaufen", im Wettlauf mit dem Ziel hier.
      abmeldungBeginnen();
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
      kanal?.postMessage({ art: 'abgemeldet' } satisfies Nachricht);
      zurAnmeldung(grund);
    };

    const refresh = async () => {
      lastRefresh = Date.now();
      const response = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' }).catch(() => null);
      if (response?.ok) return;
      // 429: die Bremse hat gegriffen, der Token gilt noch — beim nächsten
      // Durchgang erneut versuchen. Alles andere heisst: die Sitzung ist weg.
      if (response?.status === 429) {
        lastRefresh = 0;
        return;
      }
      // Ausser: Ein anderer Tab hat sie soeben erneuert (`SESSION_ROTATED`).
      // Dann lebt sie mit dessen Cookies weiter — nichts tun, nicht abmelden.
      if (response?.status === 401) {
        const antwort = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
        if (antwort?.error?.code === 'SESSION_ROTATED') return;
      }
      if (!stopped) {
        stopped = true;
        zurAnmeldung('abgelaufen');
      }
    };

    aktionen.current = {
      weiter: () => {
        warnungOffen = false;
        setRestzeit(null);
        lastNoted = Date.now();
        aktivitaetMerken(Date.now(), true);
        void refresh();
      },
      abmelden: () => void signOut('abgemeldet'),
    };

    const check = () => {
      if (stopped) return;
      // Die jüngste Aktivität irgendeines Tabs zählt — nicht nur dieses.
      aktivitaetMerken(gemeinsameAktivitaetLesen(), false);
      const now = Date.now();
      const untaetig = now - lastActivity;
      if (untaetig >= idleMs) {
        void signOut('inaktiv');
        return;
      }
      if (untaetig >= idleMs - warnMs) {
        warnungOffen = true;
        setRestzeit(idleMs - untaetig);
        return;
      }
      if (now - lastRefresh >= REFRESH_EVERY_MS) void refresh();
    };

    const onVisibility = () => {
      if (document.visibilityState !== 'visible' || stopped) return;
      check();
      // Sichtbar und noch im Fenster: Der Token kann während der Abwesenheit
      // abgelaufen sein — lieber jetzt erneuern als beim nächsten Klick.
      if (!stopped && !warnungOffen) void refresh();
    };

    const onNachricht = (event: MessageEvent<Nachricht>) => {
      if (event.data?.art === 'aktiv') aktivitaetMerken(event.data.zeit, false);
      if (event.data?.art === 'abgemeldet' && !stopped) {
        stopped = true;
        // `abmeldungVerbreiten()` öffnet einen eigenen Kanal, und ein
        // `BroadcastChannel` stellt auch an die anderen Kanäle **desselben**
        // Tabs zu. Ohne diese Weiche schickte die eigene Nachricht den Tab, der
        // gerade über das Kontomenü abmeldet, hart zur Anmeldung „abgemeldet" —
        // im Wettlauf mit seinem Sprung auf die Startseite (2026-09-29,
        // `tests/e2e/abmelden.spec.ts`). Dieser Tab hat sein Ziel schon.
        if (abmeldungLaeuftBereits()) return;
        zurAnmeldung('abgemeldet');
      }
    };

    // `storage` als Rückfall für Browser ohne `BroadcastChannel`.
    const onSpeicher = (event: StorageEvent) => {
      if (event.key === SPEICHER_SCHLUESSEL && event.newValue) aktivitaetMerken(Number(event.newValue) || 0, false);
    };

    gemeinsameAktivitaetSchreiben(lastActivity);
    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, noteActivity, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('storage', onSpeicher);
    kanal?.addEventListener('message', onNachricht);
    const timer = window.setInterval(check, CHECK_EVERY_MS);

    return () => {
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, noteActivity);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('storage', onSpeicher);
      kanal?.removeEventListener('message', onNachricht);
      kanal?.close();
      window.clearInterval(timer);
    };
  }, [idleSeconds]);

  /*
    Vor der ersten Warnung rendert die Komponente nichts — auf dem Server wie
    im Browser. Ein Dialog im ersten Render brächte den Hydrationsfehler
    zurück, den `NavigationProgress` aus demselben Grund vermeidet.
  */
  if (restzeit === null) return null;

  return (
    <Dialog open onOpenChange={(offen) => { if (!offen) aktionen.current.weiter(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="size-5 text-primary" aria-hidden />
            Sitzung läuft bald ab
          </DialogTitle>
          <DialogDescription>
            Seit einer Weile gab es keine Eingabe. Ohne Antwort werden Sie in{' '}
            <span className="font-medium tabular-nums text-foreground" aria-live="polite">
              {restzeitText(restzeit)}
            </span>{' '}
            abgemeldet — nicht gespeicherte Eingaben gehen dann verloren.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => aktionen.current.abmelden()}>
            Abmelden
          </Button>
          <Button autoFocus onClick={() => aktionen.current.weiter()}>
            Weiterarbeiten
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
