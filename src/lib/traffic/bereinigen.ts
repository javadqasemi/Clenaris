import {
  TRAFFIC_GRENZEN,
  type TrafficBrowserFamilie,
  type TrafficGeraet,
} from './ereignisse';

/**
 * Bereinigung der Besuchsmessung — der reine Rechenkern (2026-09-28).
 *
 * ---------------------------------------------------------------------------
 *  Warum die Bereinigung auf dem Server liegt, obwohl der Browser schon filtert
 * ---------------------------------------------------------------------------
 *
 * Der Erfassungshelfer im Browser schickt bereits nur Pfad und `utm_*` — keine
 * übrige Abfrage, keinen vollen Referrer ausser beim Einstieg. Das ist
 * Datensparsamkeit an der Quelle. Eine *Zusicherung* ist es nicht: Der
 * Endpunkt ist öffentlich, und was an ihm ankommt, kann jeder schicken. Was
 * gespeichert wird, entscheidet deshalb allein diese Datei, und sie geht davon
 * aus, dass die Eingabe feindlich ist.
 *
 * ---------------------------------------------------------------------------
 *  Warum ohne `server-only` und ohne Pfad-Aliasse
 * ---------------------------------------------------------------------------
 *
 * Die Prüfreihe importiert die Funktionen direkt
 * (`tests/api/traffic-rechenkern.test.ts`) — die Bereinigung ist das Herz der
 * Datenschutzaussage und soll ohne laufenden Server Fall für Fall belegt
 * sein. Dieselbe Überlegung wie bei `lib/zuerich.ts`.
 */

// ---------------------------------------------------------------------------
//  Bereiche, die nie gezählt werden
// ---------------------------------------------------------------------------

/**
 * Pfadpräfixe, deren Ereignisse verworfen werden — ganz, nicht maskiert.
 *
 * Die Messung ist eine Messung der **öffentlichen Website**. Die
 * Applikationsbereiche (`/admin`, `/portal`, `/konto`) zeigen Kundschaft,
 * Rechnungen und Personal; wer dort welche Seite öffnet, ist eine Frage der
 * Arbeitsüberwachung, nicht des Marketings, und gehört nicht in diese
 * Tabelle. Die Anmelde- und Signaturwege tragen Einmalcodes und Zugangslinks
 * im Pfad oder im Fragment. `/abnahme` und `/geraet-uebernehmen` sind die
 * Geräteübergabe an Kundschaft vor Ort. `/_next` sind Bündel, keine Seiten.
 *
 * Verglichen wird segmentgenau: `/admin` und `/admin/…` fallen weg,
 * `/administration-reinigung` (eine denkbare Leistungsseite) nicht.
 */
export const AUSGESCHLOSSENE_BEREICHE = [
  '/admin',
  '/portal',
  '/konto',
  '/api',
  '/auth',
  '/signieren',
  '/abnahme',
  '/geraet-uebernehmen',
  '/_next',
] as const;

/**
 * Öffentliche Seiten, deren **nächstes** Segment ein Zugangstoken ist.
 *
 * `/offerte/[token]`, `/rechnung/[token]` und `/buchung/[token]` sind
 * Capability-Links: Wer den Pfad kennt, sieht Offerte, Rechnung oder Buchung
 * samt Adresse. Die allgemeine Tokenerkennung unten würde die heutigen Tokens
 * zwar ebenfalls fangen (sie sind lang und gemischt), aber eine Zusicherung,
 * die an der Form eines Tokens hängt, bricht beim nächsten Tokenformat. Für
 * die bekannten Routen gilt deshalb die Regel unabhängig davon, wie das
 * Segment aussieht.
 */
export const TOKEN_ROUTEN = ['/offerte', '/rechnung', '/buchung'] as const;

const TOKEN_PLATZHALTER = ':token';

function imBereich(pfad: string, praefix: string): boolean {
  return pfad === praefix || pfad.startsWith(`${praefix}/`);
}

/**
 * Sieht ein Pfadsegment nach einem Geheimnis oder einer Kennung aus?
 *
 * Absichtlich misstrauisch — ein fälschlich maskiertes Segment kostet eine
 * Zeile in der Liste „meistbesuchte Seiten", ein durchgelassenes Token einen
 * Zugang zu fremden Daten in einer Tabelle, die das Marketing liest:
 *
 *  • länger als 32 Zeichen — jeder Base64url-Token (43 Zeichen) ist es;
 *    ausgenommen ein sprechender Slug aus Wörtern (siehe unten);
 *  • eine UUID;
 *  • nur Buchstaben und Ziffern, mindestens 20 Zeichen, mit einer Ziffer —
 *    cuid, Hex, Nanoid ohne Bindestrich;
 *  • Gross- und Kleinbuchstaben **und** Ziffern ab 16 Zeichen — Base64-artig;
 *    die Slugs der Website sind klein geschrieben;
 *  • sechs und mehr Ziffern am Stück — Buchungs-, Rechnungs- oder
 *    Telefonnummern haben in einem Seitenpfad nichts verloren;
 *  • ein `@` — eine E-Mail-Adresse im Pfad;
 *  • ein Segment, das sich nicht dekodieren lässt.
 */
export function siehtNachTokenAus(segment: string): boolean {
  let klar: string;
  try {
    klar = decodeURIComponent(segment);
  } catch {
    return true;
  }
  if (klar.length > 32) {
    // Eine Ausnahme von „länger als 32": ein sprechender Slug aus
    // kleingeschriebenen Wörtern mit Bindestrich. Der Blogbeitrag
    // `reinigungsmittel-richtig-dosieren` aus dem Demobestand hat 33 Zeichen
    // und wäre sonst in der Rangliste als `:token` erschienen. Ein Token
    // besteht nie aus Wörtern: Base64url mischt Gross- und Kleinbuchstaben,
    // Hex beginnt nicht mit einem Wort und einem Bindestrich. Die Obergrenze
    // (80 Zeichen, kein Wort über 24) hält auch diese Ausnahme eng.
    const slug =
      klar.length <= 80 &&
      /^[a-z]+(?:-[a-z0-9]+)+$/.test(klar) &&
      klar.split('-').every((teil) => teil.length <= 24);
    if (!slug) return true;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(klar)) return true;
  if (/^(?=.*\d)[a-z0-9]{20,}$/i.test(klar)) return true;
  if (/^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])[A-Za-z0-9_-]{16,}$/.test(klar)) return true;
  if (/\d{6,}/.test(klar)) return true;
  if (klar.includes('@')) return true;
  return false;
}

export interface BereinigterPfad {
  /** Pfad ohne Abfrage, Token-Segmente als `:token`. */
  pfad: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
}

/**
 * Einen UTM-Wert zuschneiden: getrimmt, klein, höchstens 100 Zeichen, nur
 * unverfängliche Zeichen. Ein Wert mit `@` wird verworfen — Kampagnenlinks,
 * in die ein Werkzeug die E-Mail-Adresse der Empfängerin einsetzt, gibt es,
 * und genau die sollen hier nicht landen.
 */
export function utmWert(roh: string | null | undefined): string | null {
  if (roh == null) return null;
  const wert = roh.trim().toLowerCase();
  if (wert === '' || wert.includes('@')) return null;
  const sauber = wert.replace(/[^a-z0-9._\- +]/g, '').replace(/\s+/g, ' ').trim();
  if (sauber === '') return null;
  return sauber.slice(0, TRAFFIC_GRENZEN.utm);
}

/**
 * Den gemeldeten Pfad bereinigen — oder `null`, wenn das Ereignis wegfällt.
 *
 * Schritte:
 *  1. Nur ein absoluter Pfad derselben Website: beginnt mit genau einem `/`.
 *     `//fremd.example/…` wäre für `new URL` ein anderer Host.
 *  2. Abfrage und Fragment ab. Aus der Abfrage bleiben nur `utm_source`,
 *     `utm_medium`, `utm_campaign` — und die nicht im Pfad, sondern in
 *     eigenen Spalten. Alles andere (`?t=…` der Buchungsbestätigung,
 *     `?token=…` der Newsletterbestätigung, `?session_id=…` der Zahlung)
 *     wird nie gespeichert.
 *  3. App-Bereiche verwerfen (siehe oben).
 *  4. Segmente normalisieren: leere Segmente (doppelte Schrägstriche) weg,
 *     Schrägstrich am Ende weg, kleingeschrieben.
 *  5. Token-Segmente maskieren: nach einer Token-Route immer, sonst nach
 *     `siehtNachTokenAus`.
 */
export function pfadBereinigen(roh: string): BereinigterPfad | null {
  if (typeof roh !== 'string') return null;
  const eingabe = roh.trim();
  if (!eingabe.startsWith('/') || eingabe.startsWith('//') || eingabe.includes('\\')) return null;
  if (eingabe.length > TRAFFIC_GRENZEN.pfad) return null;

  let url: URL;
  try {
    url = new URL(eingabe, 'https://messung.invalid');
  } catch {
    return null;
  }
  // Ein Pfad, der den Host wechselt, ist kein Pfad dieser Website.
  if (url.host !== 'messung.invalid') return null;

  // Die Segmente in ihrer Originalschreibweise: Die Tokenerkennung braucht
  // Gross- und Kleinbuchstaben (Base64), kleingeschrieben wird erst danach.
  const segmente = url.pathname.split('/').filter((s) => s !== '');
  const grundpfad = `/${segmente.join('/')}`.toLowerCase();

  if (AUSGESCHLOSSENE_BEREICHE.some((bereich) => imBereich(grundpfad, bereich))) return null;

  const tokenRoute = TOKEN_ROUTEN.find((route) => imBereich(grundpfad, route));
  const maskiert = segmente.map((segment, index) => {
    // Das Segment direkt nach einer Token-Route ist der Token — immer.
    if (tokenRoute && index === 1) return TOKEN_PLATZHALTER;
    return siehtNachTokenAus(segment) ? TOKEN_PLATZHALTER : segment.toLowerCase();
  });

  const pfad = `/${maskiert.join('/')}`.slice(0, TRAFFIC_GRENZEN.pfad);

  return {
    pfad,
    utmSource: utmWert(url.searchParams.get('utm_source')),
    utmMedium: utmWert(url.searchParams.get('utm_medium')),
    utmCampaign: utmWert(url.searchParams.get('utm_campaign')),
  };
}

// ---------------------------------------------------------------------------
//  Herkunft
// ---------------------------------------------------------------------------

/**
 * Den Referrer auf den Host kürzen — oder `null`.
 *
 * Gespeichert wird nur, *von welcher Website* jemand kam, nie die Adresse
 * dort: Ein voller Referrer trägt Suchbegriffe, Kennungen fremder Dienste und
 * gelegentlich die E-Mail-Adresse aus einem Webmail-Link. Ohne `www.`, damit
 * `www.google.ch` und `google.ch` eine Zeile sind. Die eigene Website fällt
 * weg (`eigeneHosts`) — ein Klick innerhalb der Website ist keine Herkunft.
 * Nur `http`/`https`; `android-app://…` und Ähnliches ist zu selten, um die
 * Regel zu verkomplizieren.
 */
export function referrerHost(roh: string | null | undefined, eigeneHosts: readonly string[]): string | null {
  if (!roh) return null;
  let url: URL;
  try {
    url = new URL(roh);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === '' || host.length > TRAFFIC_GRENZEN.host) return null;
  const eigene = eigeneHosts.map((h) => h.toLowerCase().replace(/:\d+$/, '').replace(/^www\./, ''));
  if (eigene.includes(host)) return null;
  return host;
}

// ---------------------------------------------------------------------------
//  Gerät und Browser
// ---------------------------------------------------------------------------

/**
 * Automatische Abrufe — Suchmaschinen, Vorschaudienste, kopflose Browser.
 *
 * Sie senden ohnehin keine Einwilligung und damit keine Ereignisse; wer den
 * Endpunkt trotzdem mit einem solchen User-Agent anspricht, zählt nicht.
 */
const AUTOMAT = /bot|crawl|spider|slurp|headless|lighthouse|pingdom|preview|monitor|curl|wget|python|java\//i;

export interface Umgebung {
  geraet: TrafficGeraet;
  browser: TrafficBrowserFamilie;
}

/**
 * Gerätefamilie und Browserfamilie aus dem User-Agent — oder `null` für einen
 * Automaten.
 *
 * Bewusst grob, und der User-Agent selbst wird nie gespeichert: Eine
 * Browserversion, ein Betriebssystem und eine Bildschirmgrösse wären zusammen
 * mit Tag und Einstiegsseite schon ein halber Fingerabdruck. Drei
 * Gerätefamilien und fünf Browser beantworten die Fragen, die das Marketing
 * hat („lohnt sich die Telefonansicht?"), und nicht mehr.
 *
 * Bekannte Grenze: iPadOS meldet sich seit Version 13 als Mac und zählt
 * deshalb als Computer. Das lässt sich ohne Skriptabfrage im Browser
 * (Berührungspunkte) nicht unterscheiden, und eine solche Abfrage wäre genau
 * die Art Merkmal, die hier nicht erhoben wird.
 *
 * Reihenfolge der Browserprüfung: Edge und Opera melden sich zusätzlich als
 * Chrome, Chrome zusätzlich als Safari — deshalb von spezifisch nach
 * allgemein.
 */
export function umgebungAusUserAgent(ua: string | null | undefined): Umgebung | null {
  const text = (ua ?? '').slice(0, 512);
  if (AUTOMAT.test(text)) return null;

  let geraet: TrafficGeraet = 'DESKTOP';
  if (/ipad|tablet|playbook|silk|kindle/i.test(text) || (/android/i.test(text) && !/mobile/i.test(text))) {
    geraet = 'TABLET';
  } else if (/mobi|iphone|ipod|windows phone|android/i.test(text)) {
    geraet = 'MOBILE';
  }

  let browser: TrafficBrowserFamilie = 'OTHER';
  if (/edg(e|a|ios)?\//i.test(text)) browser = 'EDGE';
  else if (/opr\/|opera|samsungbrowser|yabrowser|vivaldi/i.test(text)) browser = 'OTHER';
  else if (/firefox\/|fxios\//i.test(text)) browser = 'FIREFOX';
  else if (/chrome\/|crios\/|chromium\//i.test(text)) browser = 'CHROME';
  else if (/safari\//i.test(text) && /version\//i.test(text)) browser = 'SAFARI';

  return { geraet, browser };
}

// ---------------------------------------------------------------------------
//  Ablehnungssignale
// ---------------------------------------------------------------------------

/**
 * Hat der Browser „nicht verfolgen" signalisiert?
 *
 * `Sec-GPC: 1` (Global Privacy Control) und `DNT: 1` (Do Not Track) werden
 * als Widerspruch gelesen, auch wenn die Person im Hinweis „Alle akzeptieren"
 * geklickt hat: Das Signal ist die dauerhafte, browserweite Einstellung, der
 * Klick eine einzelne Antwort auf eine Frage, die sie vielleicht nur loswerden
 * wollte. Im Zweifel zählt die sparsamere Aussage. Die Kosten — weniger
 * gezählte Besuche — stehen offen in `docs/TRAFFIC_ANALYTICS.md`.
 */
export function verfolgungAbgelehnt(kopf: (name: string) => string | null): boolean {
  return kopf('sec-gpc')?.trim() === '1' || kopf('dnt')?.trim() === '1';
}
