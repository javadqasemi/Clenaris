import { tagPlus, zuercherTag } from '../zuerich';
import { TRAFFIC_GRENZEN } from './ereignisse';

/**
 * Zeiträume der Besuchsauswertung — Zürcher Kalendertage, einschliesslich.
 *
 * **Warum ein eigener kleiner Kern und nicht `resolveRange` aus
 * `analytics.service.ts`.** Jene Funktion liefert Zeitpunkte für
 * `timestamptz`-Spalten und kennt „7 Tage" als „jetzt minus 168 Stunden". Die
 * Besuchstabelle hat eine Spalte `day` (`@db.Date`, Zürcher Tag), und jede
 * Auswertung filtert darauf. „7 Tage" heisst hier „heute und die sechs Tage
 * davor", ganz, nicht „seit gestern 14:32". Zwei Deutungen desselben Worts in
 * einer Funktion wären schlechter als zwei Funktionen mit je einer.
 *
 * Die Kalenderrechnung selbst kommt aus `lib/zuerich.ts` — der einen Stelle
 * für Zürcher Tage. Ohne `server-only`: Die Prüfreihe importiert die Datei
 * direkt.
 */

export const TRAFFIC_ZEITRAEUME = ['heute', '7tage', '30tage', 'monat', 'quartal', 'jahr', 'eigen'] as const;
export type TrafficZeitraum = (typeof TRAFFIC_ZEITRAEUME)[number];

export const ZEITRAUM_BESCHRIFTUNG: Record<TrafficZeitraum, string> = {
  heute: 'Heute',
  '7tage': '7 Tage',
  '30tage': '30 Tage',
  monat: 'Monat',
  quartal: 'Quartal',
  jahr: 'Jahr',
  eigen: 'Benutzerdefiniert',
};

/**
 * Längster wählbarer Zeitraum in Tagen.
 *
 * Nicht länger als die Aufbewahrung: Ein Zeitraum über zwei Jahre zeigte eine
 * Zahl, die zur Hälfte aus bereits gelöschten Tagen bestünde, und läse sich
 * wie ein Einbruch. 400 Tage decken das laufende Jahr samt Vorjahresmonat und
 * begrenzen zugleich die Grösse jeder Auswertungsabfrage.
 */
export const LAENGSTER_ZEITRAUM_TAGE = 400;

export interface AufgeloesterZeitraum {
  art: TrafficZeitraum;
  /** Erster Tag, UTC-Mitternacht (Form von `@db.Date`). */
  vonTag: Date;
  /** Letzter Tag, einschliesslich. */
  bisTag: Date;
  /** Gleich langer Zeitraum unmittelbar davor — für den Vergleich. */
  vorher: { vonTag: Date; bisTag: Date };
  tage: number;
}

const TAG_MUSTER = /^\d{4}-\d{2}-\d{2}$/;

function tagAusText(text: string | undefined): Date | null {
  if (!text || !TAG_MUSTER.test(text)) return null;
  const tag = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(tag.getTime())) return null;
  // `2026-02-31` rollt in JavaScript still in den März — das wäre ein anderer Tag als verlangt.
  if (tag.toISOString().slice(0, 10) !== text) return null;
  return tag;
}

function tageZwischen(von: Date, bis: Date): number {
  return Math.round((bis.getTime() - von.getTime()) / 86_400_000) + 1;
}

/**
 * Einen Zeitraum auflösen.
 *
 * Ein unbrauchbarer benutzerdefinierter Zeitraum (fehlend, ungültig) fällt auf
 * „30 Tage" zurück, statt einen Fehler zu zeigen — die Seite ist eine
 * Auswertung, kein Formular, und ein Tippfehler in der Adresse soll keine
 * leere Fehlerseite ergeben. Vertauschte Grenzen werden getauscht, ein
 * Zeitraum in die Zukunft endet heute, ein zu langer wird von hinten her auf
 * `LAENGSTER_ZEITRAUM_TAGE` gekürzt.
 */
export function trafficZeitraumAufloesen(
  art: TrafficZeitraum,
  von?: string,
  bis?: string,
  jetzt: Date = new Date(),
): AufgeloesterZeitraum {
  const heute = zuercherTag(jetzt);
  let vonTag: Date;
  let bisTag: Date = heute;
  let gewaehlt: TrafficZeitraum = art;

  switch (art) {
    case 'heute':
      vonTag = heute;
      break;
    case '7tage':
      vonTag = tagPlus(heute, -6);
      break;
    case 'monat':
      vonTag = new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth(), 1));
      break;
    case 'quartal':
      vonTag = new Date(Date.UTC(heute.getUTCFullYear(), Math.floor(heute.getUTCMonth() / 3) * 3, 1));
      break;
    case 'jahr':
      vonTag = new Date(Date.UTC(heute.getUTCFullYear(), 0, 1));
      break;
    case 'eigen': {
      let a = tagAusText(von);
      let b = tagAusText(bis);
      if (!a || !b) {
        gewaehlt = '30tage';
        vonTag = tagPlus(heute, -29);
        break;
      }
      if (a.getTime() > b.getTime()) [a, b] = [b, a];
      if (b.getTime() > heute.getTime()) b = heute;
      if (a.getTime() > b.getTime()) a = b;
      if (tageZwischen(a, b) > LAENGSTER_ZEITRAUM_TAGE) a = tagPlus(b, -(LAENGSTER_ZEITRAUM_TAGE - 1));
      vonTag = a;
      bisTag = b;
      break;
    }
    case '30tage':
    default:
      gewaehlt = '30tage';
      vonTag = tagPlus(heute, -29);
  }

  const tage = tageZwischen(vonTag, bisTag);
  return {
    art: gewaehlt,
    vonTag,
    bisTag,
    vorher: { vonTag: tagPlus(vonTag, -tage), bisTag: tagPlus(vonTag, -1) },
    tage,
  };
}

/**
 * Der erste Tag, der beim Aufräumen **bleibt**: heute vor 13 Monaten.
 *
 * Kalendermonate, nicht 395 Tage — „13 Monate" in der Datenschutzerklärung
 * soll genau das heissen. Fällt der Tag in einen kürzeren Monat (29. bis 31.),
 * gilt dessen letzter Tag.
 */
export function aufbewahrungsgrenze(jetzt: Date = new Date()): Date {
  const heute = zuercherTag(jetzt);
  const monate = TRAFFIC_GRENZEN.aufbewahrungMonate;
  const jahr = heute.getUTCFullYear();
  const monat = heute.getUTCMonth() - monate;
  const letzterTag = new Date(Date.UTC(jahr, monat + 1, 0)).getUTCDate();
  return new Date(Date.UTC(jahr, monat, Math.min(heute.getUTCDate(), letzterTag)));
}
