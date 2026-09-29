import { z } from 'zod';

import { TRAFFIC_EREIGNISSE, TRAFFIC_GRENZEN } from '@/lib/traffic/ereignisse';
import { TRAFFIC_ZEITRAEUME } from '@/lib/traffic/zeitraum';

/**
 * Schemas der eigenen Besuchsmessung (2026-09-28).
 *
 * Das Eingangsschema ist **eng und streng** (`.strict()`): Der Endpunkt ist
 * öffentlich und ohne Anmeldung erreichbar. Ein unbekanntes Feld ist kein
 * Versehen eines alten Browsers — den gibt es nicht, der Erfassungshelfer
 * wurde mit diesem Schema zusammen ausgeliefert —, sondern ein Versuch, etwas
 * mitzuschicken, das hier nichts verloren hat. Abgelehnt wird mit 422.
 *
 * Die Grenzen hier sind die der **Anfrage**. Was davon gespeichert wird,
 * entscheidet danach die Bereinigung (`lib/traffic/bereinigen.ts`): Ein Pfad
 * von 300 Zeichen ist gültig, landet aber ohne Abfrage und mit maskierten
 * Token-Segmenten in der Tabelle — oder gar nicht, wenn er in einen
 * App-Bereich zeigt.
 */

export const trafficEreignisSchema = z
  .object({
    name: z.enum(TRAFFIC_EREIGNISSE),
    /** Pfad samt `utm_*`-Abfrage, wie der Browser ihn sieht. */
    pfad: z.string().min(1).max(TRAFFIC_GRENZEN.pfad),
    /** Nur beim Einstieg: `document.referrer`. Der Server kürzt auf den Host. */
    referrer: z.string().max(TRAFFIC_GRENZEN.referrer).optional(),
    /** Erste Seitenansicht dieser Tab-Sitzung. */
    einstieg: z.boolean().optional(),
  })
  .strict();

export const trafficBatchSchema = z
  .object({
    /**
     * Zufällige Tab-Sitzungskennung aus dem Browser.
     *
     * Nur Base64url-Zeichen und eine feste Länge: Die Kennung wird nie
     * gespeichert, sondern nur gehasht — aber was hier ankommt, landet in
     * einem HMAC, und ein Feld, das beliebigen Text annimmt, ist ein Feld,
     * über das jemand eine E-Mail-Adresse „als Sitzung" schicken könnte.
     */
    sitzung: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Ungültige Sitzungskennung.'),
    ereignisse: z.array(trafficEreignisSchema).min(1).max(TRAFFIC_GRENZEN.proAnfrage),
  })
  .strict();

export type TrafficBatchInput = z.infer<typeof trafficBatchSchema>;
export type TrafficEreignisInput = z.infer<typeof trafficEreignisSchema>;

/**
 * Zeitraum der Auswertung — für Seite und Lese-Endpunkt dasselbe Schema.
 *
 * `von`/`bis` als `JJJJ-MM-TT` (Zürcher Tage). Ein unbrauchbarer eigener
 * Zeitraum fällt in `trafficZeitraumAufloesen` auf „30 Tage" zurück; hier
 * wird nur die Form geprüft, damit der Endpunkt bei Unsinn 422 sagt statt
 * stillschweigend etwas anderes zu liefern.
 */
export const trafficAuswertungQuerySchema = z.object({
  zeitraum: z.enum(TRAFFIC_ZEITRAEUME).default('30tage'),
  von: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT.')
    .optional(),
  bis: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT.')
    .optional(),
});

export type TrafficAuswertungQuery = z.infer<typeof trafficAuswertungQuerySchema>;
