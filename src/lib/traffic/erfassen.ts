'use client';

import { hasConsent } from '@/lib/consent';
import { oeffentlicheKonfigurationHolen } from '@/lib/laufzeit-konfiguration';

import { TRAFFIC_GRENZEN, type TrafficEreignisName } from './ereignisse';

/**
 * Erfassung der eigenen Besuchsmessung im Browser (2026-09-28).
 *
 * ---------------------------------------------------------------------------
 *  Die vier Regeln dieser Datei
 * ---------------------------------------------------------------------------
 *
 *  1. **Ohne Einwilligung geschieht nichts.** Jede Funktion prüft
 *     `hasConsent().analytics` selbst; kein Aufrufer muss daran denken. Ohne
 *     Einwilligung entsteht auch keine Sitzungskennung im `sessionStorage`.
 *  2. **Nie ein Fehler nach aussen.** Die Messung ist das Unwichtigste auf der
 *     Seite. Ein Werbeblocker, der die Anfrage abfängt, ein privater Modus
 *     ohne `sessionStorage`, ein Browser ohne `sendBeacon`: alles wird
 *     geschluckt. Jede öffentliche Funktion ist in `try/catch` gehüllt und
 *     gibt nichts zurück, auf das jemand warten könnte.
 *  3. **Nichts, was der Server nicht braucht.** Gesendet wird der Pfad samt
 *     `utm_*` — nicht die übrige Abfrage (dort steht etwa der Token der
 *     Buchungsbestätigung) —, beim Einstieg der Referrer, sonst nichts. Keine
 *     Bildschirmgrösse, keine Sprache, keine Zeitzone: Das wären die Zutaten
 *     eines Fingerabdrucks. Der Server bereinigt trotzdem noch einmal, denn
 *     was hier steht, ist Sparsamkeit, keine Zusicherung.
 *  4. **Ohne Freigabe der Instanz geschieht ebenfalls nichts** (seit
 *     2026-09-30). Die Betreiberin schaltet die Messung mit
 *     `CLENARIS_BESUCHSMESSUNG=an` ein; die Browser-Konfiguration meldet das
 *     als `besuchsmessung`. Erst nach der Einwilligung wird sie einmal je
 *     Seite geholt (`trafficFreigabe`), und solange sie nicht ausdrücklich
 *     `true` sagt, entsteht weder eine Sitzungskennung noch eine Meldung.
 *     Der Server speichert ausgeschaltet zwar ohnehin nichts — aber eine
 *     Kennung im Speicher des Tabs und Meldungen ins Leere wären Messung ohne
 *     Zweck, und die Einwilligung allein ist nicht die Entscheidung der
 *     Betreiberin.
 *
 * `Sec-GPC`/`DNT` wertet der Server aus; der Browser prüft
 * `navigator.globalPrivacyControl` und `doNotTrack` zusätzlich und schickt
 * dann gar nicht erst.
 *
 * Gesammelt wird kurz (eine halbe Sekunde) und dann in einem Stapel gesendet;
 * beim Verlassen der Seite (`pagehide`, `visibilitychange`) sofort — dafür ist
 * `sendBeacon` da: Er überlebt das Schliessen des Tabs und das Folgen eines
 * `tel:`-Links.
 */

const SITZUNG_SCHLUESSEL = 'clenaris-besuch';
const ENDPUNKT = '/api/public/traffic';
const SAMMELZEIT_MS = 500;

interface Ereignis {
  name: TrafficEreignisName;
  pfad: string;
  referrer?: string;
  einstieg?: boolean;
}

let warteschlange: Ereignis[] = [];
let zeitgeber: ReturnType<typeof setTimeout> | null = null;
/** Ersatz, wenn `sessionStorage` nicht verfügbar ist: gilt bis zum Neuladen. */
let fluechtigeSitzung: string | null = null;
/** Ist die nächste Seitenansicht der Einstieg dieser Sitzung? */
let einstiegOffen = false;
/**
 * Hat die Instanz die Messung freigegeben? `null`: noch nicht gefragt oder
 * die Antwort steht aus. Einmal bekannt, gilt sie bis zum Neuladen — sie ist
 * eine Eigenschaft des Servers, nicht der Einwilligung, und ändert sich nicht,
 * während die Seite offen ist.
 */
let freigegeben: boolean | null = null;
let freigabeAnfrage: Promise<boolean> | null = null;

/** Einwilligung und Ablehnungssignale des Browsers — ohne die Freigabe. */
function erlaubt(): boolean {
  if (typeof window === 'undefined') return false;
  if (!hasConsent().analytics) return false;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.globalPrivacyControl === true || nav.doNotTrack === '1') return false;
  return true;
}

/**
 * Die Freigabe der Instanz — einmal je Seite gefragt, nie vor der
 * Einwilligung (die Aufrufer prüfen `erlaubt()` bzw. die Einwilligung
 * zuerst). Wirft nie; jeder Fehler heisst „nicht freigegeben".
 *
 * Exportiert für `TrafficMessung`: Die Komponente hängt ihre Zuhörer erst an,
 * wenn die Freigabe feststeht, statt bei ausgeschalteter Messung auf jeden
 * Klick zu horchen.
 */
export function trafficFreigabe(): Promise<boolean> {
  if (freigegeben !== null) return Promise.resolve(freigegeben);
  if (!freigabeAnfrage) {
    freigabeAnfrage = oeffentlicheKonfigurationHolen()
      .then((konfiguration) => konfiguration?.besuchsmessung === true)
      .catch(() => false)
      .then((an) => {
        freigegeben = an;
        return an;
      });
  }
  return freigabeAnfrage;
}

/**
 * `aktion` ausführen, sobald feststeht, dass gemessen werden darf.
 *
 * Ist die Freigabe schon bekannt, läuft `aktion` **sofort und synchron** —
 * das ist der Normalfall, denn `TrafficMessung` fragt beim Erteilen der
 * Einwilligung. Synchron muss es bleiben: Beim Klick auf einen `tel:`-Link
 * folgt dem Einreihen unmittelbar `trafficJetztSenden()`, und eine erst im
 * nächsten Mikrotask eingereihte Meldung käme zu spät, um mitzureisen.
 *
 * Steht die Antwort noch aus (ein Formular, das vor ihr abgeschickt wird),
 * wartet die Aktion darauf und prüft danach die Einwilligung **erneut** —
 * in der Zwischenzeit kann sie widerrufen worden sein.
 */
function wennFreigegeben(aktion: () => void): void {
  if (freigegeben === true) {
    aktion();
    return;
  }
  if (freigegeben === false) return;
  void trafficFreigabe().then((an) => {
    try {
      if (an && erlaubt()) aktion();
    } catch {
      /* Nie nach aussen. */
    }
  });
}

function zufallsKennung(): string | null {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) return null;
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  // Base64url ohne Auffüllung — passt zum Schema (16–64 Zeichen, A–Z a–z 0–9 _ -).
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Die Tab-Sitzungskennung — erzeugt beim ersten Bedarf, und nur mit
 * Einwilligung (der Aufrufer hat `erlaubt()` geprüft). Stirbt mit dem Tab.
 */
function sitzung(): string | null {
  try {
    const vorhanden = window.sessionStorage.getItem(SITZUNG_SCHLUESSEL);
    if (vorhanden && /^[A-Za-z0-9_-]{16,64}$/.test(vorhanden)) return vorhanden;
    const neu = zufallsKennung();
    if (!neu) return null;
    window.sessionStorage.setItem(SITZUNG_SCHLUESSEL, neu);
    einstiegOffen = true;
    return neu;
  } catch {
    if (!fluechtigeSitzung) {
      fluechtigeSitzung = zufallsKennung();
      einstiegOffen = true;
    }
    return fluechtigeSitzung;
  }
}

/** Die Sitzungskennung verwerfen — beim Widerruf der Einwilligung. */
export function trafficSitzungVergessen(): void {
  try {
    warteschlange = [];
    fluechtigeSitzung = null;
    window.sessionStorage.removeItem(SITZUNG_SCHLUESSEL);
  } catch {
    /* Ohne Speicher gibt es nichts zu vergessen. */
  }
}

/** Aktueller Pfad samt den drei UTM-Parametern — nichts sonst aus der Abfrage. */
function aktuellerPfad(): string {
  const { pathname, search } = window.location;
  const utm = new URLSearchParams();
  const alle = new URLSearchParams(search);
  for (const name of ['utm_source', 'utm_medium', 'utm_campaign']) {
    const wert = alle.get(name);
    if (wert) utm.set(name, wert.slice(0, TRAFFIC_GRENZEN.utm));
  }
  const abfrage = utm.toString();
  return `${pathname}${abfrage ? `?${abfrage}` : ''}`.slice(0, TRAFFIC_GRENZEN.pfad);
}

function senden(): void {
  if (zeitgeber) {
    clearTimeout(zeitgeber);
    zeitgeber = null;
  }
  if (warteschlange.length === 0) return;
  const kennung = sitzung();
  const stapel = warteschlange.splice(0, TRAFFIC_GRENZEN.proAnfrage);
  if (!kennung) return;
  const koerper = JSON.stringify({ sitzung: kennung, ereignisse: stapel });

  try {
    const blob = new Blob([koerper], { type: 'application/json' });
    if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(ENDPUNKT, blob)) {
      if (warteschlange.length > 0) senden();
      return;
    }
  } catch {
    /* Weiter mit fetch. */
  }
  try {
    void fetch(ENDPUNKT, {
      method: 'POST',
      body: koerper,
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      credentials: 'same-origin',
    }).catch(() => undefined);
  } catch {
    /* Werbeblocker oder kein Netz — die Messung fällt still aus. */
  }
  if (warteschlange.length > 0) senden();
}

function einreihen(ereignis: Ereignis): void {
  warteschlange.push(ereignis);
  if (warteschlange.length >= TRAFFIC_GRENZEN.proAnfrage) {
    senden();
    return;
  }
  if (!zeitgeber) zeitgeber = setTimeout(senden, SAMMELZEIT_MS);
}

/** Wartende Ereignisse sofort senden — beim Verlassen der Seite. */
export function trafficJetztSenden(): void {
  try {
    senden();
  } catch {
    /* Nie nach aussen. */
  }
}

/**
 * Eine Seitenansicht melden. Die erste der Tab-Sitzung trägt den Referrer
 * und gilt als Einstieg.
 */
export function trafficSeitenansicht(): void {
  try {
    if (!erlaubt()) return;
    // Der Pfad wird **jetzt** gelesen, nicht erst nach der Freigabe: Bis
    // deren Antwort da ist, kann die App-Navigation schon weiter sein, und
    // gemeldet würde die falsche Seite.
    const pfad = aktuellerPfad();
    wennFreigegeben(() => {
      // Zuerst die Sitzung holen: Sie setzt `einstiegOffen`, wenn sie neu ist.
      if (!sitzung()) return;
      const einstieg = einstiegOffen;
      einstiegOffen = false;
      einreihen({
        name: 'PAGE_VIEW',
        pfad,
        ...(einstieg
          ? { einstieg: true, referrer: document.referrer ? document.referrer.slice(0, TRAFFIC_GRENZEN.referrer) : undefined }
          : {}),
      });
    });
  } catch {
    /* Nie nach aussen. */
  }
}

/**
 * Ein Konversionsereignis melden — ohne Einwilligung oder ohne Freigabe der
 * Instanz ein stilles Nichts.
 *
 * Der Aufrufer muss nichts prüfen und auf nichts warten; die Funktion kehrt
 * sofort zurück und wirft nie.
 */
export function trafficEreignis(name: Exclude<TrafficEreignisName, 'PAGE_VIEW'>): void {
  try {
    if (!erlaubt()) return;
    const pfad = aktuellerPfad();
    wennFreigegeben(() => {
      if (!sitzung()) return;
      einreihen({ name, pfad });
    });
  } catch {
    /* Nie nach aussen. */
  }
}
