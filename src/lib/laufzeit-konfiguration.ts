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
 * Herkunft und Umgebung selbst stehen seit 2026-09-28 in
 * `laufzeit-ursprung.ts` (ohne Zod — Begründung dort: sonst reiste Zod über
 * `utils.ts` in jedes Client-Bündel) und werden hier unverändert
 * weitergereicht.
 */

import { laufzeitUmgebung, ursprungAus, type Umgebung } from './laufzeit-ursprung';

export {
  KonfigurationsFehler,
  laufzeitUmgebung,
  laufzeitUrsprung,
  mapsBrowserSchluessel,
  supabaseAdresse,
  ursprungAus,
  type Umgebung,
} from './laufzeit-ursprung';

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

/**
 * Ist die eigene Besuchsmessung eingeschaltet (`CLENARIS_BESUCHSMESSUNG`,
 * 2026-09-30)? **Nur der Wert „an"** schaltet sie ein — nach dem Entfernen
 * der Leerzeichen am Rand, sonst buchstabengenau.
 *
 * Warum so eng und nicht „alles, was nach ja aussieht" (`true`, `1`, `on`,
 * `AN`): Die Messung darf in der Produktion erst laufen, wenn die
 * Datenschutzerklärung rechtlich geprüft ist (TA-02). Ein Schalter, der sich
 * aus Versehen einschalten lässt — ein `1` aus einer Vorlage, ein `true` aus
 * Gewohnheit —, wäre genau die stille Entscheidung, die er verhindern soll.
 * Ein einziges deutsches Wort ist eine bewusste Handlung; alles andere, auch
 * das Fehlen, heisst aus.
 *
 * Eine Regel für alle Leser: `serverEnv()` (Route), diese Datei (Browser)
 * und `scripts/production-preflight.ts` (Warnung) urteilen gleich. Die
 * Vorprüfung vergleicht dieselbe Zeichenkette selbst, weil sie ohne die
 * Anwendung laufen muss — `traffic-rechenkern.test.ts` hält beide Stellen an
 * denselben Fällen fest, damit sie nicht auseinanderlaufen.
 */
export function besuchsmessungEingeschaltet(wert: string | undefined): boolean {
  return wert?.trim() === 'an';
}

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
    /**
     * Darf der Browser die eigene Besuchsmessung überhaupt melden
     * (2026-09-30)? Pflichtfeld, nicht optional: Fehlte es, müsste der
     * Browser raten, und ein Raten, das „an" ergäbe, wäre eine Messung ohne
     * Entscheidung der Betreiberin. Der Wert sagt nur, *ob* gemessen werden
     * darf — die Einwilligung „Statistik" bleibt im Browser die zweite,
     * unabhängige Schranke.
     */
    besuchsmessung: z.boolean(),
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
    besuchsmessung: besuchsmessungEingeschaltet(env.CLENARIS_BESUCHSMESSUNG),
  });
}

/** Die Browser-Konfiguration dieser Instanz. */
export function oeffentlicheKonfiguration(): PublicRuntimeConfig {
  return oeffentlicheKonfigurationAus(laufzeitUmgebung());
}

// ---------------------------------------------------------------------------
//  Im Browser: die Konfiguration einmal je Seite holen
// ---------------------------------------------------------------------------

/** Die eine Anfrage dieser Seite — `null`, solange niemand gefragt hat. */
let imBrowserGeholt: Promise<PublicRuntimeConfig | null> | null = null;

/**
 * Die Browser-Konfiguration vom Server holen — **einmal je geladener Seite**,
 * geteilt von allen, die sie brauchen (2026-09-30).
 *
 * Zwei Verbraucher fragen danach: die Analyse-Skripte (`analytics.tsx`,
 * Kennungen) und die eigene Besuchsmessung (`lib/traffic/erfassen.ts`,
 * Schalter). Jeder mit eigenem `fetch` hiesse zwei gleiche Anfragen nach
 * derselben Einwilligung — und zwei Antworten, die sich im ungünstigen Fall
 * widersprächen (eine vor, eine nach einem Neustart mit anderer Umgebung).
 * Eine geteilte Anfrage gibt beiden dieselbe Wahrheit.
 *
 * Geprüft wird die Antwort **auch hier** gegen das Schema: Die Kennungen
 * werden in Skriptzeilen eingesetzt. Ungültig, nicht erreichbar oder ein
 * Fehler: `null` — geschlossen, nicht offen. Die Funktion wirft nie, und ein
 * Fehlschlag wird für diese Seite nicht wiederholt: Wer neu lädt, fragt neu.
 *
 * Auf dem Server gibt es nichts zu holen (`null`, ohne Zwischenspeicher) —
 * sonst hinge eine einmal geholte Antwort an einem Modul, das alle Anfragen
 * des Prozesses teilen. Aufgerufen wird sie ohnehin nur aus Effekten im
 * Browser, und nur nach einer Einwilligung: Ohne Einwilligung keine Anfrage.
 */
export function oeffentlicheKonfigurationHolen(): Promise<PublicRuntimeConfig | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (!imBrowserGeholt) {
    imBrowserGeholt = fetch('/api/public/runtime-config', { credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : null))
      .then((antwort: { data?: unknown } | null) => {
        const geprueft = PublicRuntimeConfigSchema.safeParse(antwort?.data);
        return geprueft.success ? geprueft.data : null;
      })
      .catch(() => null);
  }
  return imBrowserGeholt;
}
