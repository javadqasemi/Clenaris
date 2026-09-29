/**
 * Herkunft und Umgebung zur **Laufzeit** — der Teil von
 * `laufzeit-konfiguration.ts`, der ohne Zod auskommt (seit 2026-09-28).
 *
 * **Warum eine eigene Datei.** `utils.ts` braucht `laufzeitUrsprung` für
 * `absoluteUrl`, und `utils.ts` steht in fast jeder Client-Komponente (für
 * `cn`). Stand die Funktion in `laufzeit-konfiguration.ts`, kam deren
 * Zod-Schema mit: Ein `z.object(…)` auf oberster Ebene ist für den Bündler
 * eine Nebenwirkung, das Modul lässt sich nicht weglassen — und mit ihm nicht
 * Zod. Gemessen mit `scripts/leistungsbudget.ts`: rund 20 kB gzip im
 * Wurzellayout, also auf **jeder** Seite, auch der öffentlichen Startseite,
 * die gar nichts validiert.
 *
 * Hier steht deshalb nur, was ohne Schema auskommt. Die öffentliche
 * Browserkonfiguration samt Schema bleibt in `laufzeit-konfiguration.ts`, das
 * diese Funktionen unverändert weiterreicht — kein Aufrufer musste sich
 * ändern. Begründung der Regeln selbst (Laufzeit statt Bauzeit, geschlossen
 * fehlschlagen) steht dort.
 *
 * Ohne `server-only`: siehe oben. Im Browser liefert `laufzeitUmgebung()` ein
 * leeres Objekt; keine Client-Komponente ruft diese Funktionen auf.
 */

export type Umgebung = Record<string, string | undefined>;

/**
 * Die Laufzeitumgebung. Absichtlich über eine Variable und nicht als
 * `process.env.X`: Nur diese Form ersetzt der Bau.
 */
export function laufzeitUmgebung(): Umgebung {
  return (typeof process !== 'undefined' ? process.env : {}) as Umgebung;
}

const ENTWICKLUNG_URSPRUNG = 'http://localhost:3000';

export class KonfigurationsFehler extends Error {
  constructor(meldung: string) {
    super(meldung);
    this.name = 'KonfigurationsFehler';
  }
}

/**
 * Die Herkunft, unter der **diese Instanz** erreichbar ist — `APP_URL`, sonst
 * das ältere `NEXT_PUBLIC_APP_URL` (zur Laufzeit gelesen, nicht eingesetzt).
 *
 * Nur Schema, Host und Port: Ein Pfad, eine Abfrage, Zugangsdaten oder ein
 * anderes Schema als http/https sind ein Konfigurationsfehler und werfen.
 * Fehlt der Wert in der Produktion, wirft die Funktion ebenfalls — ein
 * stilles `localhost` in Kundenmails ist schlimmer als ein lauter Fehler.
 */
export function ursprungAus(env: Umgebung): string {
  const roh = (env.APP_URL ?? env.NEXT_PUBLIC_APP_URL)?.trim();
  if (!roh) {
    if (env.NODE_ENV === 'production') {
      throw new KonfigurationsFehler('APP_URL fehlt — die Anwendung weiss nicht, unter welcher Adresse sie erreichbar ist.');
    }
    return ENTWICKLUNG_URSPRUNG;
  }
  let url: URL;
  try {
    url = new URL(roh);
  } catch {
    throw new KonfigurationsFehler('APP_URL ist keine gültige Adresse.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new KonfigurationsFehler('APP_URL muss http oder https sein.');
  if (url.username || url.password) throw new KonfigurationsFehler('APP_URL darf keine Zugangsdaten enthalten.');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new KonfigurationsFehler('APP_URL ist nur Schema, Host und Port — ohne Pfad, Abfrage oder Anker.');
  }
  return url.origin;
}

/** Die Herkunft dieser Instanz, aus der Server-Umgebung, zur Laufzeit. */
export function laufzeitUrsprung(): string {
  return ursprungAus(laufzeitUmgebung());
}

/** Browser-Schlüssel für Google Maps (auf die Domain beschränkt) — serverseitig, zur Laufzeit. */
export function mapsBrowserSchluessel(): string | undefined {
  return laufzeitUmgebung().NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() || undefined;
}

/** Adresse des Supabase-Projekts — serverseitig, zur Laufzeit. */
export function supabaseAdresse(): string | undefined {
  return laufzeitUmgebung().NEXT_PUBLIC_SUPABASE_URL?.trim() || undefined;
}
