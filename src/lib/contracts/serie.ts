/**
 * Der Rechenkern der Serienplanung.
 *
 * Bewusst **rein** und ohne `server-only`, ohne Prisma, ohne Pfad-Aliasse:
 * Dieses Modul entscheidet, an welchen Kalendertagen ein Vertrag zu leisten
 * ist, und genau das ist die Stelle, an der ein Fehler zu doppelten oder
 * fehlenden Einsätzen führt. Es wird deshalb direkt geprüft
 * (`tests/api/vertraege-rechenkern.test.ts`) — dieselbe Bauart wie
 * `src/lib/bi/math.ts`.
 *
 * ---------------------------------------------------------------------------
 *  Warum Kalendertage und keine Zeitpunkte
 * ---------------------------------------------------------------------------
 *
 * Ein Reinigungsvertrag sagt „jeden Montag und Donnerstag von 06:00 bis
 * 10:00". Das ist ein Tag plus ein Zeitfenster in **Ortszeit**, kein
 * UTC-Zeitpunkt. Rechnete man in Zeitpunkten, verschöbe sich beim Wechsel auf
 * die Sommerzeit jede Serie um eine Stunde — und zwar still, weil niemand
 * einen Einsatz kontrolliert, der eine Stunde zu früh beginnt.
 *
 * Alle Daten hier sind deshalb `Date`-Objekte auf **UTC-Mitternacht** des
 * gemeinten Kalendertags, genau wie `@db.Date` sie speichert. Die Umrechnung
 * in einen Zeitpunkt mit Zeitzone passiert erst im Dienst, beim Anlegen des
 * Einsatzes.
 */

export type SerienFrequenz = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';
export type Feiertagsbehandlung = 'IGNORE' | 'SKIP' | 'MOVE_BEFORE' | 'MOVE_AFTER';
export type Ausnahmeart = 'SKIP' | 'MOVE' | 'EXTRA';

export interface Serienregel {
  frequency: SerienFrequenz;
  /** Alle n Perioden. */
  interval: number;
  /** 0 = Sonntag … 6 = Samstag. */
  weekdays: number[];
  /** Tag im Monat; `null` heisst „derselbe Tag wie `effectiveFrom`". */
  monthDay: number | null;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  holidayHandling: Feiertagsbehandlung;
}

export interface Ausnahme {
  kind: Ausnahmeart;
  originalDate: Date;
  newDate: Date | null;
}

export interface Termin {
  /** Der Tag, an dem tatsächlich geleistet wird. */
  datum: Date;
  /** Der Serientag, aus dem er entstanden ist — die Kennung der Idempotenz. */
  serientag: Date;
  /** Warum er vom Serientag abweicht, falls er das tut. */
  grund?: 'FEIERTAG_VOR' | 'FEIERTAG_NACH' | 'AUSNAHME_VERSCHOBEN' | 'AUSNAHME_ZUSATZ';
}

const TAG_MS = 86_400_000;

/** Kalendertag als `YYYY-MM-DD` — der Vergleichsschlüssel dieses Moduls. */
export function tagSchluessel(datum: Date): string {
  return datum.toISOString().slice(0, 10);
}

/** UTC-Mitternacht des Kalendertags, auf den ein Zeitpunkt fällt. */
export function alsTag(datum: Date): Date {
  return new Date(Date.UTC(datum.getUTCFullYear(), datum.getUTCMonth(), datum.getUTCDate()));
}

export function plusTage(datum: Date, tage: number): Date {
  return new Date(datum.getTime() + tage * TAG_MS);
}

/**
 * Monate addieren, ohne in den Folgemonat zu rutschen.
 *
 * `new Date(2026, 0, 31)` plus einen Monat ergibt in JavaScript den 3. März —
 * der Februar hat den 31. nicht, und das Datum läuft über. Für eine
 * Reinigungsserie wäre das ein Termin, der jeden Monat weiter wandert. Hier
 * wird stattdessen auf den letzten Tag des Zielmonats begrenzt.
 */
export function plusMonate(datum: Date, monate: number): Date {
  const jahr = datum.getUTCFullYear();
  const monat = datum.getUTCMonth() + monate;
  const tag = datum.getUTCDate();
  const letzterImZielmonat = new Date(Date.UTC(jahr, monat + 1, 0)).getUTCDate();
  return new Date(Date.UTC(jahr, monat, Math.min(tag, letzterImZielmonat)));
}

/** Wie viele Monate eine Periode dieser Frequenz umfasst. */
function monateJePeriode(frequenz: SerienFrequenz): number {
  switch (frequenz) {
    case 'MONTHLY':
      return 1;
    case 'QUARTERLY':
      return 3;
    case 'SEMIANNUAL':
      return 6;
    case 'ANNUAL':
      return 12;
    default:
      return 0;
  }
}

/**
 * Die Serientage einer Regel in einem Zeitraum — **ohne** Feiertage und
 * Ausnahmen.
 *
 * Getrennt, weil die Serientage die Kennung der Idempotenz sind: Verschiebt
 * ein Feiertag einen Termin, bleibt der Serientag derselbe, und ein zweiter
 * Lauf erkennt den Einsatz wieder. Wäre der verschobene Tag die Kennung,
 * entstünde beim Nachtragen eines Feiertags ein Doppeleinsatz.
 */
export function serientage(regel: Serienregel, von: Date, bis: Date): Date[] {
  const start = alsTag(regel.effectiveFrom);
  const ende = regel.effectiveUntil ? alsTag(regel.effectiveUntil) : null;
  const fensterVon = alsTag(von) > start ? alsTag(von) : start;
  const fensterBis = ende && ende < alsTag(bis) ? ende : alsTag(bis);
  if (fensterBis < fensterVon) return [];

  const intervall = Math.max(1, Math.trunc(regel.interval));
  const tage: Date[] = [];

  if (regel.frequency === 'WEEKLY' || regel.frequency === 'BIWEEKLY') {
    const wochentage = [...new Set(regel.weekdays)].filter((t) => t >= 0 && t <= 6).sort((a, b) => a - b);
    if (wochentage.length === 0) return [];

    /**
     * Der Wochenrhythmus zählt ab der Woche des **ersten Serientermins**.
     *
     * Zwei falsche Bezugspunkte liegen nahe:
     *
     *  • *Die Woche des Fensterbeginns.* Dann verschöbe sich „alle zwei
     *    Wochen" bei jedem Nachplanen um eine Woche, je nachdem, wo das
     *    Fenster gerade anfängt — der Plan hinge davon ab, wann man ihn
     *    abfragt.
     *  • *Die Woche von `effectiveFrom`.* Beginnt der Vertrag an einem
     *    Donnerstag und wird montags gereinigt, läge der erste Montag in der
     *    **Folgewoche** — und bei zweiwöchentlichem Rhythmus fiele er aus.
     *    Der erste Termin eines Vertrags entfällt: genau der Fehler, den
     *    niemand beim Testen sieht und jeder beim ersten Kunden.
     *
     * Deshalb der erste Wochentag der Serie, der auf oder nach dem
     * Vertragsbeginn liegt. Er hängt nur an der Regel, nicht am Fenster.
     */
    const basis = wochenbeginn(ersterSerientag(start, wochentage));
    const schrittWochen = regel.frequency === 'BIWEEKLY' ? 2 * intervall : intervall;

    for (let tag = fensterVon; tag <= fensterBis; tag = plusTage(tag, 1)) {
      if (!wochentage.includes(tag.getUTCDay())) continue;
      const wochenAbstand = Math.round((wochenbeginn(tag).getTime() - basis.getTime()) / (7 * TAG_MS));
      if (wochenAbstand % schrittWochen !== 0) continue;
      tage.push(tag);
    }
    return tage;
  }

  const schrittMonate = monateJePeriode(regel.frequency) * intervall;
  if (schrittMonate <= 0) return [];

  const zielTag = regel.monthDay ?? start.getUTCDate();
  let kandidat = imMonat(start, zielTag);
  // Fällt der erste Termin vor den Serienbeginn, eine Periode weiter.
  while (kandidat < start) kandidat = imMonat(plusMonate(kandidat, schrittMonate), zielTag);

  // Obergrenze gegen eine Endlosschleife bei absurden Eingaben.
  for (let schutz = 0; schutz < 5000 && kandidat <= fensterBis; schutz++) {
    if (kandidat >= fensterVon) tage.push(kandidat);
    kandidat = imMonat(plusMonate(kandidat, schrittMonate), zielTag);
  }
  return tage;
}

/** Der erste Tag ab `start`, dessen Wochentag in der Serie vorkommt. */
function ersterSerientag(start: Date, wochentage: number[]): Date {
  for (let versatz = 0; versatz < 7; versatz++) {
    const kandidat = plusTage(start, versatz);
    if (wochentage.includes(kandidat.getUTCDay())) return kandidat;
  }
  return start;
}

/** Montag der Woche, in der ein Tag liegt. */
function wochenbeginn(tag: Date): Date {
  const wochentag = tag.getUTCDay();
  const zurueck = (wochentag + 6) % 7;
  return plusTage(tag, -zurueck);
}

/** Denselben Monat, aber auf den gewünschten Tag — begrenzt auf den Monatsletzten. */
function imMonat(datum: Date, zielTag: number): Date {
  const letzter = new Date(Date.UTC(datum.getUTCFullYear(), datum.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(datum.getUTCFullYear(), datum.getUTCMonth(), Math.min(zielTag, letzter)));
}

/**
 * Die tatsächlichen Termine — Serientage, auf Feiertage und Ausnahmen
 * angewandt.
 *
 * Reihenfolge der Anwendung, und sie ist nicht beliebig:
 *
 *  1. **Ausnahme vor Feiertag.** Wer einen Termin von Hand verschiebt, hat
 *     die Feiertagsregel bereits berücksichtigt; sie danach noch einmal
 *     anzuwenden verschöbe ihn ein zweites Mal.
 *  2. **Feiertagsregel nur auf unveränderte Serientage.**
 *  3. **Zusatztermine zuletzt**, damit sie von keiner Regel mehr wandern.
 *
 * `feiertage` ist eine Menge von `YYYY-MM-DD`. Welche Tage das sind, weiss
 * dieses Modul nicht — das steht je Organisation und Kanton in `Holiday`.
 * Ein eingebauter Feiertagskalender wäre für genau einen Kanton richtig.
 */
export function termine(
  regel: Serienregel,
  von: Date,
  bis: Date,
  feiertage: ReadonlySet<string>,
  ausnahmen: readonly Ausnahme[] = [],
): Termin[] {
  const nachTag = new Map<string, Ausnahme>();
  for (const ausnahme of ausnahmen) nachTag.set(tagSchluessel(alsTag(ausnahme.originalDate)), ausnahme);

  const ergebnis: Termin[] = [];

  for (const serientag of serientage(regel, von, bis)) {
    const schluessel = tagSchluessel(serientag);
    const ausnahme = nachTag.get(schluessel);

    if (ausnahme?.kind === 'SKIP') continue;
    if (ausnahme?.kind === 'MOVE' && ausnahme.newDate) {
      ergebnis.push({ datum: alsTag(ausnahme.newDate), serientag, grund: 'AUSNAHME_VERSCHOBEN' });
      continue;
    }

    if (regel.holidayHandling === 'IGNORE' || !feiertage.has(schluessel)) {
      ergebnis.push({ datum: serientag, serientag });
      continue;
    }

    if (regel.holidayHandling === 'SKIP') continue;

    const richtung = regel.holidayHandling === 'MOVE_BEFORE' ? -1 : 1;
    const ersatz = naechsterWerktag(serientag, richtung, feiertage);
    if (ersatz) {
      ergebnis.push({
        datum: ersatz,
        serientag,
        grund: richtung < 0 ? 'FEIERTAG_VOR' : 'FEIERTAG_NACH',
      });
    }
  }

  // Zusatztermine: eigene Serientage, damit sie eine eigene Kennung haben und
  // nicht mit einem regulären Termin desselben Tages kollidieren können.
  for (const ausnahme of ausnahmen) {
    if (ausnahme.kind !== 'EXTRA') continue;
    const tag = alsTag(ausnahme.newDate ?? ausnahme.originalDate);
    if (tag < alsTag(von) || tag > alsTag(bis)) continue;
    ergebnis.push({ datum: tag, serientag: alsTag(ausnahme.originalDate), grund: 'AUSNAHME_ZUSATZ' });
  }

  ergebnis.sort((a, b) => a.datum.getTime() - b.datum.getTime());
  return ergebnis;
}

/**
 * Der nächste Tag in einer Richtung, der weder Feiertag noch Wochenende ist.
 *
 * Wochenende gilt als arbeitsfrei, weil eine Feiertagsverschiebung sonst
 * regelmässig auf einen Samstag fiele — und ein Büro, das montags bis freitags
 * gereinigt wird, ist am Samstag zu. Wer samstags reinigt, hat den Samstag in
 * `weekdays` und ist von dieser Regel gar nicht betroffen: Sie greift nur für
 * den *Ersatz* eines Feiertags.
 *
 * Gibt `null` zurück, wenn in zwei Wochen kein Werktag zu finden ist — das
 * kann nicht vorkommen und ist trotzdem abgefangen, weil eine Endlosschleife
 * in einem nächtlichen Lauf niemandem auffällt.
 */
function naechsterWerktag(start: Date, richtung: 1 | -1, feiertage: ReadonlySet<string>): Date | null {
  for (let schritt = 1; schritt <= 14; schritt++) {
    const kandidat = plusTage(start, schritt * richtung);
    const wochentag = kandidat.getUTCDay();
    if (wochentag === 0 || wochentag === 6) continue;
    if (feiertage.has(tagSchluessel(kandidat))) continue;
    return kandidat;
  }
  return null;
}

// ---------------------------------------------------------------------------
//  Vom Kalendertag zum Zeitpunkt
// ---------------------------------------------------------------------------

const ZURICH = 'Europe/Zurich';

const zuercherTeile = new Intl.DateTimeFormat('en-US', {
  timeZone: ZURICH,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * Der Zeitpunkt, an dem in Zürich der genannte Kalendertag um 00:00 beginnt.
 *
 * Dieselbe Rechnung wie `zurichMidnight` in `src/lib/bi/periods.ts` — bewusst
 * hier noch einmal und nicht importiert: Jenes Modul gehört der
 * Kennzahlmaschine, und eine Abhängigkeit von dort in den Vertragskern hiesse,
 * dass eine Änderung an den Periodengrenzen der Auswertung den Einsatzplan
 * verschieben könnte.
 */
export function zuercherMitternacht(tag: Date): Date {
  const versuch = Date.UTC(tag.getUTCFullYear(), tag.getUTCMonth(), tag.getUTCDate());
  const felder: Record<string, number> = {};
  for (const teil of zuercherTeile.formatToParts(new Date(versuch))) {
    if (teil.type !== 'literal') felder[teil.type] = Number(teil.value);
  }
  const gesehen = Date.UTC(
    felder.year!,
    felder.month! - 1,
    felder.day!,
    felder.hour! === 24 ? 0 : felder.hour!,
    felder.minute!,
    felder.second!,
  );
  return new Date(versuch - (gesehen - versuch));
}

/**
 * Kalendertag plus Minuten seit Mitternacht → Zeitpunkt in Ortszeit.
 *
 * **Warum nicht einfach Minuten auf die Mitternacht addieren.** An den beiden
 * Umstellungstagen hat die Nacht 23 bzw. 25 Stunden; eine Addition auf den
 * UTC-Zeitpunkt der Mitternacht verschöbe den Einsatz dann um eine Stunde.
 * „Ab 06:00" heisst sechs Uhr in Bern, im Sommer wie im Winter — deshalb wird
 * der Versatz **am Zieltag selbst** abgelesen und nicht von der Mitternacht
 * übernommen.
 *
 * Für die Lücke am Frühjahrsumstellungstag (02:00–03:00 gibt es nicht) fällt
 * das Ergebnis auf 03:00 Ortszeit; für die doppelte Stunde im Herbst gilt die
 * erste. Beides ist die übliche Auslegung und hier festgehalten, damit es
 * niemand für einen Zufall hält.
 */
export function zuercherZeitpunkt(tag: Date, minuten: number): Date {
  const roh = zuercherMitternacht(alsTag(tag)).getTime() + minuten * 60_000;

  // Gegenprobe: Zeigt der Zeitpunkt in Zürich tatsächlich die gewünschte
  // Uhrzeit? Wenn nicht, lag eine Umstellung dazwischen — dann um die
  // Differenz nachkorrigieren.
  const felder: Record<string, number> = {};
  for (const teil of zuercherTeile.formatToParts(new Date(roh))) {
    if (teil.type !== 'literal') felder[teil.type] = Number(teil.value);
  }
  const istMinute = (felder.hour! === 24 ? 0 : felder.hour!) * 60 + felder.minute!;
  const abweichung = istMinute - minuten;
  if (abweichung === 0) return new Date(roh);
  return new Date(roh - abweichung * 60_000);
}

// ---------------------------------------------------------------------------
//  Abrechnungsperioden
// ---------------------------------------------------------------------------

export type Abrechnungszyklus = 'PER_VISIT' | 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';

export interface Abrechnungsperiode {
  /** Erster Kalendertag der Periode — zugleich der Schlüssel gegen Doppelabrechnung. */
  start: Date;
  /** Erster Tag der **nächsten** Periode. Die obere Grenze schliesst nicht ein. */
  endeExklusiv: Date;
  label: string;
}

const MONATSNAMEN = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

/**
 * Die **kanonische** Abrechnungsperiode zu einem Stichtag.
 *
 * Kanonisch heisst: Zwei verschiedene Stichtage im selben Monat ergeben
 * dieselbe Periode. Das ist keine Bequemlichkeit, sondern die Bedingung dafür,
 * dass sich Doppelabrechnung über einen eindeutigen Index verhindern lässt:
 * Wäre der Zeitraum frei wählbar, gäbe es beliebig viele sich überlappende
 * „Perioden", und jede davon wäre ein neuer Schlüssel.
 *
 * `PER_VISIT` rechnet ebenfalls monatlich ab — nicht, weil je Einsatz
 * fakturiert würde, sondern weil auch dort die Rechnung einen Zeitraum
 * braucht, über den sie die Einsätze zusammenfasst. Was sich unterscheidet,
 * ist die Preisbildung, nicht der Rhythmus des Belegs.
 */
export function abrechnungsperiode(zyklus: Abrechnungszyklus, stichtag: Date): Abrechnungsperiode {
  const tag = alsTag(stichtag);
  const jahr = tag.getUTCFullYear();
  const monat = tag.getUTCMonth();

  switch (zyklus) {
    case 'QUARTERLY': {
      const start = Math.floor(monat / 3) * 3;
      return {
        start: new Date(Date.UTC(jahr, start, 1)),
        endeExklusiv: new Date(Date.UTC(jahr, start + 3, 1)),
        label: `Q${start / 3 + 1} ${jahr}`,
      };
    }
    case 'SEMIANNUAL': {
      const start = monat < 6 ? 0 : 6;
      return {
        start: new Date(Date.UTC(jahr, start, 1)),
        endeExklusiv: new Date(Date.UTC(jahr, start + 6, 1)),
        label: `${start === 0 ? '1.' : '2.'} Halbjahr ${jahr}`,
      };
    }
    case 'ANNUAL':
      return {
        start: new Date(Date.UTC(jahr, 0, 1)),
        endeExklusiv: new Date(Date.UTC(jahr + 1, 0, 1)),
        label: String(jahr),
      };
    default:
      return {
        start: new Date(Date.UTC(jahr, monat, 1)),
        endeExklusiv: new Date(Date.UTC(jahr, monat + 1, 1)),
        label: `${MONATSNAMEN[monat]} ${jahr}`,
      };
  }
}

/** Die Periode vor der, in die der Stichtag fällt — der Normalfall beim Fakturieren. */
export function vorherigePeriode(zyklus: Abrechnungszyklus, stichtag: Date): Abrechnungsperiode {
  const laufend = abrechnungsperiode(zyklus, stichtag);
  return abrechnungsperiode(zyklus, plusTage(laufend.start, -1));
}

// ---------------------------------------------------------------------------
//  Fristen
// ---------------------------------------------------------------------------

/**
 * Der späteste Tag, an dem eine Kündigung noch fristgerecht wäre.
 *
 * **Eine Rechnung, keine Rechtsauskunft.** Sie beantwortet: „Wann muss eine
 * Kündigung spätestens da sein, damit sie zum berechneten Ende wirkt?" Ob sie
 * es dann tatsächlich ist, entscheidet nicht dieses Modul — Zugang,
 * Schriftform und Auslegung sind Rechtsfragen.
 */
export function kuendigungsfrist(
  vertragsende: Date | null,
  noticePeriodDays: number,
): Date | null {
  if (!vertragsende) return null;
  return plusTage(alsTag(vertragsende), -Math.max(0, Math.trunc(noticePeriodDays)));
}

/**
 * Das Wirkungsdatum einer Kündigung: Kündigungstag plus Frist.
 *
 * Bei einem **befristeten** Vertrag mit automatischer Verlängerung endet er
 * zum nächsten Laufzeitende, das nach Ablauf der Frist liegt — nicht
 * irgendwann mittendrin. Genau deshalb steht hier eine Fallunterscheidung und
 * nicht eine Addition.
 */
export function kuendigungswirkung(params: {
  gekuendigtAm: Date;
  noticePeriodDays: number;
  vertragsende: Date | null;
  renewalType: 'NONE' | 'AUTOMATIC' | 'MANUAL';
  renewalPeriodMonths: number | null;
}): Date {
  const fruehestens = plusTage(alsTag(params.gekuendigtAm), Math.max(0, Math.trunc(params.noticePeriodDays)));

  if (!params.vertragsende) return fruehestens;

  let ende = alsTag(params.vertragsende);
  if (params.renewalType !== 'AUTOMATIC' || !params.renewalPeriodMonths) {
    // Ohne automatische Verlängerung endet er zum vereinbarten Ende — es sei
    // denn, die Frist reicht darüber hinaus.
    return ende >= fruehestens ? ende : fruehestens;
  }

  for (let schutz = 0; schutz < 200 && ende < fruehestens; schutz++) {
    ende = plusMonate(ende, params.renewalPeriodMonths);
  }
  return ende;
}
