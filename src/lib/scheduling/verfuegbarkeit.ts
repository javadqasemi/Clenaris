// Relativ statt über `@/`: Die Prüfungen importieren diesen Kern direkt.
import { zurichParts } from '../bi/periods';

/**
 * Rechenkern der Terminverfügbarkeit — ohne Datenbank (Produktsprint
 * 2026-09-26).
 *
 * ---------------------------------------------------------------------------
 *  Warum ein eigener, reiner Kern
 * ---------------------------------------------------------------------------
 *
 * Bis zu diesem Sprint rechneten zwei Funktionen dieselbe Frage auf zwei
 * Arten: `getAvailableSlots` erzeugte die angebotenen Zeitfenster,
 * `isSlotBookable` prüfte beim Abschluss — und die Prüfung verglich nie mit
 * der Schliesszeit. Ein Termin, den der Kalender gar nicht anbot, ging beim
 * Abschluss durch, solange der Wochentag nicht geschlossen war. Hier gibt es
 * jetzt genau **eine** Prüfung (`pruefeZeitraum`); das Raster ruft sie für
 * jeden Rasterpunkt, der Abschluss für den gewählten Termin. Was angeboten
 * wird und was angenommen wird, kann nicht mehr auseinanderlaufen.
 *
 * Der Kern kennt keine Datenbank. Der Dienst (`availability.service.ts`) lädt
 * die Daten eines Zeitraums und reicht sie herein; die Prüfungen in
 * `tests/api/verfuegbarkeit-rechenkern.test.ts` rechnen mit festen Zahlen,
 * wie die Rechenkerne der Unternehmensführung.
 *
 * ---------------------------------------------------------------------------
 *  Die Pipeline eines Termins
 * ---------------------------------------------------------------------------
 *
 *   Datum → Einsatzfenster des Wochentags (Einsatzzeiten, sonst Öffnungszeiten)
 *         → Feiertag (auch jährlich wiederkehrend)
 *         → Dauer der ganzen Auswahl passt vollständig ins Fenster
 *         → Vorlauf (`bookingMinNoticeHours`) und Buchungshorizont (`bookingLeadDays`)
 *         → verfügbare Personen: aktiv, nicht abwesend, Arbeitszeit deckt den Termin
 *         → abzüglich der Teams, die überlappende Einsätze und noch
 *           unbestätigte Buchungen binden (samt „Puffer zwischen Einsätzen")
 *         → genug für die Teamgrösse der Auswahl?
 *
 * Zeitzone: Alles, was eine Uhrzeit ist (Fenster, Arbeitszeit), ist
 * Wandzeit Europe/Zurich; alles, was ein Zeitpunkt ist, ist UTC. Die
 * Umrechnung geschieht an genau einer Stelle (`zurichZuUtc`) über die
 * Zeitzonendatenbank von `Intl` — kein fester Versatz, kein `getHours()` auf
 * der Zeitzone des Servers.
 */

export const RASTER_MINUTEN = 30;

export interface Zeitfenster {
  /** „HH:MM", Wandzeit Zürich. */
  von: string;
  bis: string;
}

export interface Person {
  id: string;
  /**
   * Hinterlegte Arbeitszeit an diesem Wochentag. `null` heisst: Für diese
   * Person ist überhaupt keine Arbeitszeit gepflegt (siehe
   * `arbeitszeitenGepflegt`).
   */
  fenster: Zeitfenster[] | null;
  /** Bewilligte Abwesenheit an diesem Tag — auch halbe Tage. */
  abwesend: boolean;
}

export interface Belegung {
  start: Date;
  ende: Date;
  crew: number;
  /** „Puffer zwischen Einsätzen" danach — das Team ist so lange nicht frei. */
  pufferMin: number;
}

export interface Tagesdaten {
  /** JJJJ-MM-TT, Kalendertag in Zürich. */
  datum: string;
  /** Wirksames Einsatzfenster; `null` = an diesem Tag keine Einsätze. */
  fenster: Zeitfenster | null;
  /** Warum geschlossen — für die Anzeige. */
  grund?: string;
  personen: Person[];
  /**
   * Pflegt die Organisation überhaupt Arbeitszeiten? Solange für niemanden
   * eine hinterlegt ist, zählt jede aktive, anwesende Person während des
   * ganzen Einsatzfensters. Sobald es Arbeitszeiten gibt, gelten sie — auch
   * für Personen, die keine haben (die sind dann nicht eingeplant).
   *
   * Ohne diese Unterscheidung böte eine Organisation, die das Personalmodul
   * nie ausgefüllt hat, plötzlich gar keine Termine mehr an; mit einer
   * blossen „wer keine hat, zählt immer"-Regel dagegen zählte die
   * Administratorin mit ihrem Personalprofil als Reinigungskraft am Samstag.
   */
  arbeitszeitenGepflegt: boolean;
  belegungen: Belegung[];
}

export interface Anfrage {
  dauerMin: number;
  crew: number;
  pufferMin: number;
  /** Frühester buchbarer Zeitpunkt (Vorlauf). */
  fruehestens: Date;
  /** Spätester buchbarer Beginn (Buchungshorizont). */
  spaetestens: Date;
}

export interface Slot {
  start: string;
  end: string;
  /** Lokale Anzeige, z. B. „18:00". */
  label: string;
  available: boolean;
  /** Wie viele Personen zu diesem Zeitpunkt noch frei sind. */
  capacity: number;
}

/**
 * Das wirksame Einsatzfenster eines Wochentags aus einer `OpeningHours`-Zeile.
 *
 * Eigene Einsatzzeiten gehen vor; sind keine gesetzt, gelten die
 * Öffnungszeiten. `serviceClosed` sperrt den Tag für Einsätze auch bei
 * offenem Büro. Eigene Einsatzzeiten gelten auch an einem Tag, an dem das
 * Büro geschlossen ist — der Samstag im Büro geschlossen, gereinigt wird
 * trotzdem. Keine Zeile heisst: kein Einsatz. Ein Rückfall auf eine feste
 * Zeit wie 09:00–17:00 gibt es nicht; was nicht konfiguriert ist, wird nicht
 * angeboten.
 */
export function einsatzfenster(
  zeile: {
    opensAt: string | null;
    closesAt: string | null;
    closed: boolean;
    serviceOpensAt: string | null;
    serviceClosesAt: string | null;
    serviceClosed: boolean;
  } | null,
): Zeitfenster | null {
  if (!zeile) return null;
  if (zeile.serviceClosed) return null;
  if (zeile.serviceOpensAt && zeile.serviceClosesAt) {
    return { von: zeile.serviceOpensAt, bis: zeile.serviceClosesAt };
  }
  if (zeile.closed || !zeile.opensAt || !zeile.closesAt) return null;
  return { von: zeile.opensAt, bis: zeile.closesAt };
}

// ---------------------------------------------------------------------------
//  Zeit
// ---------------------------------------------------------------------------

export function minutenVon(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/** Versatz Zürich gegenüber UTC zu einem Zeitpunkt, in Minuten. */
function versatzMinuten(instant: Date): number {
  const p = zurichParts(instant);
  const alsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((alsUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/**
 * Wandzeit Zürich → Zeitpunkt (UTC).
 *
 * Zweimal gerechnet: erst mit dem Versatz des vermuteten Zeitpunkts, dann
 * mit dem des Ergebnisses. Das trifft an beiden Umstellungstagen. Eine
 * Wandzeit, die es nicht gibt (02:30 am letzten Sonntag im März), landet auf
 * dem Zeitpunkt eine Stunde später; eine doppelte (02:30 im Oktober) auf dem
 * ersten der beiden. Beides liegt ausserhalb jeder Einsatzzeit.
 */
export function zurichZuUtc(datum: string, hhmm: string): Date {
  const [y, mo, d] = datum.split('-').map(Number) as [number, number, number];
  const minuten = minutenVon(hhmm) ?? 0;
  const wand = Date.UTC(y, mo - 1, d, Math.floor(minuten / 60), minuten % 60);
  const erster = versatzMinuten(new Date(wand));
  let t = wand - erster * 60_000;
  const zweiter = versatzMinuten(new Date(t));
  if (zweiter !== erster) t = wand - zweiter * 60_000;
  return new Date(t);
}

/** Kalendertag in Zürich als JJJJ-MM-TT. */
export function zurichDatum(instant: Date): string {
  const p = zurichParts(instant);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Minuten seit Mitternacht (Wandzeit Zürich). */
export function zurichMinuten(instant: Date): number {
  const p = zurichParts(instant);
  return p.hour * 60 + p.minute;
}

/** Wochentag eines Kalendertags, 0 = Sonntag. Zeitzonenunabhängig. */
export function wochentag(datum: string): number {
  return new Date(`${datum}T12:00:00Z`).getUTCDay();
}

export function naechsterTag(datum: string, schritt = 1): string {
  const t = new Date(`${datum}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + schritt);
  return t.toISOString().slice(0, 10);
}

const uhrzeit = new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' });

// ---------------------------------------------------------------------------
//  Die eine Prüfung
// ---------------------------------------------------------------------------

export type Ablehnung =
  | 'GESCHLOSSEN'
  | 'AUSSERHALB_FENSTER'
  | 'ZU_KURZFRISTIG'
  | 'ZU_WEIT_VORAUS'
  | 'KEINE_KAPAZITAET';

export const ABLEHNUNGSTEXT: Record<Ablehnung, string> = {
  GESCHLOSSEN: 'An diesem Tag finden keine Einsätze statt.',
  AUSSERHALB_FENSTER: 'Die gewählten Leistungen passen zu dieser Uhrzeit nicht mehr vollständig in unsere Einsatzzeit.',
  ZU_KURZFRISTIG: 'Der gewünschte Termin liegt zu kurzfristig oder in der Vergangenheit.',
  ZU_WEIT_VORAUS: 'So weit im Voraus nehmen wir noch keine Buchungen an.',
  KEINE_KAPAZITAET: 'Für diesen Zeitpunkt sind leider keine Kapazitäten mehr frei. Bitte wählen Sie einen anderen Termin.',
};

/** Wie viele Personen im Zeitraum `[start, ende]` frei wären. */
export function freiePersonen(tag: Tagesdaten, start: Date, ende: Date, pufferMin: number): number {
  const vonMin = zurichMinuten(start);
  // Endet der Einsatz genau um Mitternacht, liefert die Wandzeit 0 — gemeint
  // ist das Ende des Tages.
  const bisMin = zurichDatum(ende) !== tag.datum ? 24 * 60 : zurichMinuten(ende);

  const verfuegbar = tag.personen.filter((p) => {
    if (p.abwesend) return false;
    if (!tag.arbeitszeitenGepflegt) return true;
    return (p.fenster ?? []).some((f) => {
      const a = minutenVon(f.von);
      const b = minutenVon(f.bis);
      return a !== null && b !== null && vonMin >= a && bisMin <= b;
    });
  }).length;

  // Überlappung mit Puffer auf beiden Seiten: Ein bestehender Einsatz bindet
  // sein Team bis Ende + eigener Puffer, der neue bindet es bis Ende + seinem.
  const endeMitPuffer = ende.getTime() + pufferMin * 60_000;
  const gebunden = tag.belegungen
    .filter((b) => b.start.getTime() < endeMitPuffer && b.ende.getTime() + b.pufferMin * 60_000 > start.getTime())
    .reduce((summe, b) => summe + b.crew, 0);

  return verfuegbar - gebunden;
}

/**
 * Ist dieser Termin buchbar? `null` = ja, sonst der Grund.
 *
 * Die Reihenfolge ist die der Aussagekraft für die Kundschaft: Ein
 * geschlossener Tag ist die bessere Begründung als „keine Kapazität".
 */
export function pruefeZeitraum(
  tag: Tagesdaten,
  start: Date,
  anfrage: Anfrage,
): { ablehnung: Ablehnung | null; frei: number } {
  if (!tag.fenster) return { ablehnung: 'GESCHLOSSEN', frei: 0 };

  const ende = new Date(start.getTime() + anfrage.dauerMin * 60_000);
  const oeffnet = zurichZuUtc(tag.datum, tag.fenster.von);
  const schliesst = zurichZuUtc(tag.datum, tag.fenster.bis);
  // Der ganze Einsatz — alle Leistungen nacheinander — muss ins Fenster.
  if (start < oeffnet || ende > schliesst) return { ablehnung: 'AUSSERHALB_FENSTER', frei: 0 };

  const frei = freiePersonen(tag, start, ende, anfrage.pufferMin);
  if (start < anfrage.fruehestens) return { ablehnung: 'ZU_KURZFRISTIG', frei };
  if (start > anfrage.spaetestens) return { ablehnung: 'ZU_WEIT_VORAUS', frei };
  if (frei < anfrage.crew) return { ablehnung: 'KEINE_KAPAZITAET', frei };
  return { ablehnung: null, frei };
}

/**
 * Die Zeitfenster eines Tages im Raster.
 *
 * Es erscheinen nur Anfangszeiten, zu denen der ganze Einsatz ins
 * Einsatzfenster passt — ein dreistündiger Einsatz in einem Fenster von
 * 18:00 bis 22:00 beginnt frühestens um 18:00 und spätestens um 19:00. Ob
 * eine Anfangszeit *buchbar* ist (Kapazität, Vorlauf), sagt `available`.
 */
export function berechneSlots(
  tag: Tagesdaten,
  anfrage: Anfrage,
  rasterMin = RASTER_MINUTEN,
): { date: string; closed: boolean; reason?: string; available: boolean; slots: Slot[] } {
  if (!tag.fenster) {
    return { date: tag.datum, closed: true, reason: tag.grund ?? ABLEHNUNGSTEXT.GESCHLOSSEN, available: false, slots: [] };
  }

  const oeffnet = zurichZuUtc(tag.datum, tag.fenster.von).getTime();
  const schliesst = zurichZuUtc(tag.datum, tag.fenster.bis).getTime();
  const slots: Slot[] = [];

  for (let t = oeffnet; t + anfrage.dauerMin * 60_000 <= schliesst; t += rasterMin * 60_000) {
    const start = new Date(t);
    const { ablehnung, frei } = pruefeZeitraum(tag, start, anfrage);
    slots.push({
      start: start.toISOString(),
      end: new Date(t + anfrage.dauerMin * 60_000).toISOString(),
      label: uhrzeit.format(start),
      available: ablehnung === null,
      capacity: Math.max(0, frei),
    });
  }

  return {
    date: tag.datum,
    closed: false,
    ...(slots.length === 0 ? { reason: 'Die gewählten Leistungen dauern länger als unsere Einsatzzeit an diesem Tag.' } : {}),
    available: slots.some((s) => s.available),
    slots,
  };
}
