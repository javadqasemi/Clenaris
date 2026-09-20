import { createHash } from 'node:crypto';

/**
 * Der Wortlaut der Zustimmung — versioniert, je Sprache, im Code.
 *
 * **Warum im Code und nicht in der Datenbank.** Der Text, dem jemand
 * zugestimmt hat, muss Jahre später noch exakt so vorliegen. Eine editierbare
 * Tabelle hiesse: Jemand verbessert ein Komma, und alle bisherigen
 * Zustimmungen zeigen auf einen Text, den niemand gelesen hat. Hier ist jede
 * Fassung ein fester Wert; eine Änderung ist eine neue Fassung.
 *
 * **Der Client sendet den Text nie.** Er sendet `accepted: true`; der Server
 * nimmt Fassung und Sprache aus dem Vorgang, friert den Wortlaut am Teilnehmer
 * ein und speichert dazu den SHA-256 über genau diese UTF-8-Bytes — nicht
 * über eine Übersetzungskennung, die morgen etwas anderes bedeuten könnte.
 *
 * Produkttext, keine rechtliche Zusage: kein „qualifiziert", kein „QES",
 * kein „handschriftlich gleichgestellt".
 */

/**
 * `v1` gilt für Dokumentfassungen, `quote-v1` für die Annahme einer Offerte
 * (Gate 4C): fachlich präziser — es geht um Bedingungen und eine Annahme,
 * nicht um „ein Dokument" —, aber dieselbe Regel: versioniert, eingefroren,
 * gehasht, ohne rechtliche Zusage.
 */
export const CONSENT_VERSIONS = ['v1', 'quote-v1', 'rapport-v1'] as const;
export type ConsentVersion = (typeof CONSENT_VERSIONS)[number];
export const CURRENT_CONSENT_VERSION: ConsentVersion = 'v1';
export const QUOTE_CONSENT_VERSION: ConsentVersion = 'quote-v1';
export const RAPPORT_CONSENT_VERSION: ConsentVersion = 'rapport-v1';

export const CONSENT_LOCALES = ['de-CH'] as const;
export type ConsentLocale = (typeof CONSENT_LOCALES)[number];
export const DEFAULT_CONSENT_LOCALE: ConsentLocale = 'de-CH';

const TEXTE: Record<ConsentVersion, Record<ConsentLocale, string>> = {
  v1: {
    'de-CH':
      'Ich bestätige, dass ich das angezeigte Dokument vollständig gelesen habe und es hiermit ' +
      'elektronisch unterzeichne. Mir ist bekannt, dass Clenaris den Ablauf dieser Unterzeichnung ' +
      '(Zeitpunkt, verwendeter Link, bestätigter Code, technische Angaben meines Geräts) in einem ' +
      'Signaturprotokoll festhält.',
  },
  'quote-v1': {
    'de-CH':
      'Ich habe die angezeigte Offerte einschliesslich der darin enthaltenen Positionen, Preise und ' +
      'Bedingungen gelesen und nehme sie hiermit elektronisch an. Massgebend ist das angezeigte ' +
      'Dokument in genau dieser Fassung. Mir ist bekannt, dass Clenaris den Ablauf dieser Annahme ' +
      '(Zeitpunkt, verwendeter Zugang, technische Angaben meines Geräts) in einem Signaturprotokoll ' +
      'festhält.',
  },
  /**
   * Vor Ort, auf dem Gerät des Betriebs. Der Text sagt ausdrücklich, was
   * bestätigt wird — die *dokumentierten* Arbeiten in genau dieser Fassung —
   * und behauptet nichts über die Identität der unterzeichnenden Person:
   * Wer vor Ort unterschreibt, hat sich niemandem ausgewiesen, und der
   * Beweis soll nicht so tun, als wäre es anders.
   */
  'rapport-v1': {
    'de-CH':
      'Ich habe den angezeigten Rapport geprüft und bestätige die darin dokumentierten ' +
      'ausgeführten Arbeiten elektronisch. Massgebend ist das angezeigte Dokument in genau ' +
      'dieser Fassung. Mir ist bekannt, dass Clenaris den Ablauf dieser Abnahme (Zeitpunkt, ' +
      'verwendetes Gerät, technische Angaben) in einem Signaturprotokoll festhält.',
  },
};

export function consentText(version: ConsentVersion, locale: ConsentLocale): string {
  const text = TEXTE[version]?.[locale];
  if (!text) throw new Error(`Kein Zustimmungstext für ${version}/${locale}.`);
  return text;
}

/** SHA-256 über die UTF-8-Bytes des exakten Wortlauts, hexadezimal. */
export function consentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function isConsentVersion(v: string): v is ConsentVersion {
  return (CONSENT_VERSIONS as readonly string[]).includes(v);
}

export function isConsentLocale(v: string): v is ConsentLocale {
  return (CONSENT_LOCALES as readonly string[]).includes(v);
}
