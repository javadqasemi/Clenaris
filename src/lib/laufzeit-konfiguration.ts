import { z } from 'zod';

/**
 * Konfiguration, die zur **Laufzeit** gilt — nicht zur Bauzeit (V2-1,
 * 2026-09-26).
 *
 * ---------------------------------------------------------------------------
 *  Das Problem
 * ---------------------------------------------------------------------------
 *
 * Next.js ersetzt jeden Ausdruck `process.env.NEXT_PUBLIC_…` beim Bau durch
 * den Wert, der **in diesem Moment** in der Umgebung steht — in Client- *und*
 * Server-Bündeln. Das CI baut mit `http://localhost:3000`. Ein Artefakt aus
 * diesem Lauf hätte deshalb in der Produktion Links in E-Mails
 * (Passwort, Offerte, Unterzeichnung), Stripe-Rücksprünge, die
 * Twilio-Signaturadresse und die Herkunftsprüfung auf `localhost` gerichtet —
 * ohne Fehlermeldung. Ein Artefakt, das nur für eine Adresse taugt, ist kein
 * Artefakt, sondern ein Bau je Umgebung.
 *
 * ---------------------------------------------------------------------------
 *  Die Regel
 * ---------------------------------------------------------------------------
 *
 *  • Alles, was sich je Umgebung unterscheidet, wird **hier** gelesen, zur
 *    Laufzeit, über `laufzeitUmgebung()` — ein Verweis auf `process.env`, den
 *    der Bau nicht ersetzt, weil er nicht die Form `process.env.NAME` hat.
 *  • Der Browser bekommt davon **nur**, was `PublicRuntimeConfigSchema`
 *    ausdrücklich nennt — über `GET /api/public/runtime-config`. Nie die
 *    ganze Umgebung, nie ein Feld, das hier nicht steht.
 *  • Was vertraut wird (die eigene Herkunft für CSRF, Links, Signaturen),
 *    kommt ausschliesslich aus der **Server**-Umgebung. Keine Anfrage und
 *    keine Browser-Konfiguration kann es setzen.
 *  • Ungültige Werte schlagen geschlossen fehl: Eine ungültige Herkunft wirft;
 *    eine ungültige Analyse-Kennung fällt weg (die Funktion ist dann aus),
 *    statt in ein Skript eingesetzt zu werden.
 *
 * Was bewusst zur Bauzeit bleibt, steht in `src/lib/seiten-url.ts` — mit
 * Begründung.
 *
 * Diese Datei ist ohne `server-only`: `absoluteUrl` in `utils.ts` benutzt sie,
 * und `utils.ts` wird auch in Client-Komponenten eingebunden (für `cn`). Im
 * Browser liefert `laufzeitUmgebung()` ein leeres Objekt — die Funktionen
 * hier sind dort nicht aufzurufen, und keine Client-Komponente tut es.
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

// ---------------------------------------------------------------------------
//  Öffentliche Laufzeitkonfiguration für den Browser
// ---------------------------------------------------------------------------

/**
 * Die Kennungen werden in Skriptzeilen eingesetzt (`gtag('config', '…')`).
 * Deshalb die engen Formate: Ein Wert mit Anführungszeichen oder Klammer wäre
 * Skript, das die Umgebung in jede öffentliche Seite schreibt.
 */
const GA = /^G-[A-Z0-9]{4,20}$/;
const GTM = /^GTM-[A-Z0-9]{4,12}$/;
const PIXEL = /^[0-9]{6,20}$/;

export const PublicRuntimeConfigSchema = z
  .object({
    appUrl: z.string().url(),
    analytics: z
      .object({
        gaMeasurementId: z.string().regex(GA).optional(),
        gtmId: z.string().regex(GTM).optional(),
        facebookPixelId: z.string().regex(PIXEL).optional(),
      })
      .strict(),
  })
  .strict();

export type PublicRuntimeConfig = z.infer<typeof PublicRuntimeConfigSchema>;

function nurWennGueltig(wert: string | undefined, muster: RegExp): string | undefined {
  const w = wert?.trim();
  return w && muster.test(w) ? w : undefined;
}

/**
 * Die Browser-Konfiguration aus einer Umgebung — **Feld für Feld benannt**.
 * Es gibt keinen Weg, der eine Umgebungsvariable weiterreicht, die hier nicht
 * steht; `PublicRuntimeConfigSchema.parse` am Ende lehnt jedes weitere Feld ab.
 */
export function oeffentlicheKonfigurationAus(env: Umgebung): PublicRuntimeConfig {
  return PublicRuntimeConfigSchema.parse({
    appUrl: ursprungAus(env),
    analytics: {
      gaMeasurementId: nurWennGueltig(env.NEXT_PUBLIC_GA_MEASUREMENT_ID, GA),
      gtmId: nurWennGueltig(env.NEXT_PUBLIC_GTM_ID, GTM),
      facebookPixelId: nurWennGueltig(env.NEXT_PUBLIC_FACEBOOK_PIXEL_ID, PIXEL),
    },
  });
}

/** Die Browser-Konfiguration dieser Instanz. */
export function oeffentlicheKonfiguration(): PublicRuntimeConfig {
  return oeffentlicheKonfigurationAus(laufzeitUmgebung());
}
