/**
 * Der Wertevorrat der eigenen Besuchsmessung — eine Liste für Browser,
 * Validierung, Dienst und Anzeige.
 *
 * Ohne `server-only` und ohne Abhängigkeiten: Der Erfassungshelfer im Browser
 * braucht die Namen ebenso wie das Zod-Schema und die Auswertungsseite. Stünde
 * die Liste an drei Orten, liefe früher oder später einer davon auseinander —
 * und ein Name, den der Browser schickt, das Schema aber nicht kennt, wäre ein
 * stiller 422 bei jeder einzelnen Meldung.
 *
 * Die Werte entsprechen der Prisma-Aufzählung `TrafficEventName` Buchstabe für
 * Buchstabe; `tests/api/traffic-rechenkern.test.ts` prüft das gegen das
 * Schema.
 */

export const TRAFFIC_EREIGNISSE = [
  'PAGE_VIEW',
  'CONTACT_PHONE',
  'CONTACT_EMAIL',
  'CONTACT_FORM',
  'BOOKING_START',
  'BOOKING_COMPLETE',
  'QUOTE_REQUEST',
  'NEWSLETTER_SIGNUP',
] as const;

export type TrafficEreignisName = (typeof TRAFFIC_EREIGNISSE)[number];

/** Alle Ereignisse ausser der Seitenansicht — das, was als Konversion zählt. */
export const KONVERSIONEN = TRAFFIC_EREIGNISSE.filter(
  (name): name is Exclude<TrafficEreignisName, 'PAGE_VIEW'> => name !== 'PAGE_VIEW',
);

/** Beschriftung in der Auswertung. */
export const EREIGNIS_BESCHRIFTUNG: Record<TrafficEreignisName, string> = {
  PAGE_VIEW: 'Seitenansicht',
  CONTACT_PHONE: 'Klick auf Telefonnummer',
  CONTACT_EMAIL: 'Klick auf E-Mail-Adresse',
  CONTACT_FORM: 'Kontaktformular gesendet',
  BOOKING_START: 'Buchung begonnen',
  BOOKING_COMPLETE: 'Buchung abgeschlossen',
  QUOTE_REQUEST: 'Offertanfrage gesendet',
  NEWSLETTER_SIGNUP: 'Newsletter-Anmeldung',
};

export const TRAFFIC_GERAETE = ['MOBILE', 'TABLET', 'DESKTOP'] as const;
export type TrafficGeraet = (typeof TRAFFIC_GERAETE)[number];

export const TRAFFIC_BROWSER = ['CHROME', 'FIREFOX', 'SAFARI', 'EDGE', 'OTHER'] as const;
export type TrafficBrowserFamilie = (typeof TRAFFIC_BROWSER)[number];

export const GERAET_BESCHRIFTUNG: Record<TrafficGeraet, string> = {
  MOBILE: 'Telefon',
  TABLET: 'Tablet',
  DESKTOP: 'Computer',
};

export const BROWSER_BESCHRIFTUNG: Record<TrafficBrowserFamilie, string> = {
  CHROME: 'Chrome',
  FIREFOX: 'Firefox',
  SAFARI: 'Safari',
  EDGE: 'Edge',
  OTHER: 'Andere',
};

/** Grenzen, die Browser, Schema und Bereinigung teilen. */
export const TRAFFIC_GRENZEN = {
  /** Ereignisse je Anfrage. */
  proAnfrage: 20,
  /** Länge des Pfads samt Abfrage, wie der Browser ihn schickt. */
  pfad: 300,
  /** Länge der Herkunftsadresse, wie der Browser sie schickt. */
  referrer: 500,
  /** Gespeicherte Länge eines UTM-Werts. */
  utm: 100,
  /** Gespeicherte Länge eines Herkunfts-Hosts. */
  host: 120,
  /** Aufbewahrung in Monaten. */
  aufbewahrungMonate: 13,
} as const;
