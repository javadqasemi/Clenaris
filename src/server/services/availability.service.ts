import 'server-only';

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { cache, cacheKeys } from '@/lib/redis';
import {
  ABLEHNUNGSTEXT,
  berechneSlots,
  einsatzfenster,
  naechsterTag,
  pruefeZeitraum,
  wochentag,
  zurichDatum,
  zurichZuUtc,
  type Anfrage,
  type Belegung,
  type Slot,
  type Tagesdaten,
} from '@/lib/scheduling/verfuegbarkeit';
import { withSettingsDefaults } from '@/lib/validation/settings';

import { activeStaffWhere } from './profile.service';

/**
 * Terminverfügbarkeit.
 *
 * Architekturentscheid (unverändert): Die Kapazität wird abgeleitet, nicht
 * als Slot-Tabelle gespeichert — bei 6–15 Mitarbeitenden und variablen
 * Einsatzdauern wäre eine Slot-Tabelle sofort inkonsistent.
 *
 * ---------------------------------------------------------------------------
 *  Was am 2026-09-26 falsch war, und woher die Daten jetzt kommen
 * ---------------------------------------------------------------------------
 *
 * Befund aus dem Produktsprint: Angebotene Zeiten passten nicht zuverlässig
 * zu den Arbeitszeiten. Zwei Fehler, die sich addierten:
 *
 *  1. **Falsche Dauer.** Der Buchungsassistent fragte mit `serviceId` und
 *     Datum; die Route schätzte daraus eine Dauer (`defaultDurationMin` bzw.
 *     m² × Minuten), die mit der Dauer der Preis-Engine nichts zu tun hatte
 *     (Zimmer, Bäder, Fenster, Haustiere, Zusatzleistungen). Die Zeitfenster
 *     waren für einen kürzeren Einsatz geschnitten als den gebuchten.
 *  2. **Keine Schliesszeit beim Abschluss.** `isSlotBookable` prüfte Feiertag
 *     und „Wochentag geschlossen", nie `opensAt`/`closesAt`. Ein Einsatz von
 *     20:00 bis 23:00 in einem Fenster bis 22:00 ging durch.
 *
 * Dazu kamen: fest verdrahtete 4 Stunden Vorlauf im Kalender und 1 Stunde
 * beim Abschluss, obwohl die Einstellungen `bookingMinNoticeHours` und
 * `bookingLeadDays` kennen; Arbeitszeiten der Mitarbeitenden (`Availability`)
 * blieben unbeachtet; unbestätigte Buchungen banden keine Kapazität, weil ihr
 * Einsatz erst beim Bestätigen entsteht; jährlich wiederkehrende Feiertage
 * griffen nur im Jahr ihres Eintrags; Abwesenheiten wurden als Zeilen statt
 * als Personen gezählt; der Zwischenspeicher wurde bei geänderten Zeiten nicht
 * geleert.
 *
 * Quellen der Wahrheit jetzt, je Frage genau eine:
 *
 *  | Frage                           | Quelle                                          |
 *  |---------------------------------|-------------------------------------------------|
 *  | Wann finden Einsätze statt?     | `OpeningHours` — Einsatzzeiten, sonst Öffnungszeiten |
 *  | Welche Tage sind gesperrt?      | `Holiday` (Datum oder jährlich wiederkehrend)   |
 *  | Wie lange dauert die Auswahl?   | Preis-Engine (`estimateBookingEffort`)          |
 *  | Wie kurzfristig / wie weit?     | `Organization.settings` (`bookingMinNoticeHours`, `bookingLeadDays`) |
 *  | Wer kann arbeiten?              | aktive Mitarbeitende, ihre `Availability`, bewilligte `Absence` |
 *  | Was ist schon belegt?           | `Job` (nicht storniert) + `Booking` ohne Einsatz (PENDING/CONFIRMED) |
 *  | Wie lange bleibt ein Team gebunden? | Ende + „Puffer zwischen Einsätzen" der Leistung |
 *
 * Die Rechnung selbst steht im reinen Kern `src/lib/scheduling/verfuegbarkeit.ts`.
 * Kein Zwischenspeicher mehr für die Zeitfenster: Die Abfragen eines ganzen
 * Kalenders laufen gebündelt (eine je Tabelle für den Zeitraum), und ein
 * Zwischenspeicher, dessen Leerung an sechs Stellen vergessen werden kann,
 * war selbst einer der Befunde.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export type TimeSlot = Slot;

/** Status, in denen eine Buchung ohne Einsatz trotzdem ein Team bindet. */
const BUCHUNG_BINDET = ['PENDING', 'CONFIRMED'] as const;

/**
 * Alles, was die Rechnung für einen Zeitraum braucht — eine Abfrage je
 * Tabelle, unabhängig von der Zahl der Tage.
 */
async function ladeZeitraum(
  db: Db,
  organizationId: string,
  von: string,
  tage: number,
  ausnahmen: { buchungId?: string | null } = {},
  anforderung?: Qualifikationsanforderung,
): Promise<Tagesdaten[]> {
  const bis = naechsterTag(von, tage - 1);
  const zeitraumStart = zurichZuUtc(von, '00:00');
  const zeitraumEnde = zurichZuUtc(naechsterTag(bis), '00:00');
  const verlangt = [...new Set((anforderung?.qualifikationen ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean))];

  const [zeiten, feiertage, personal, abwesenheiten, einsaetze, buchungen, faehigkeiten] = await Promise.all([
    db.openingHours.findMany({ where: { organizationId } }),
    db.holiday.findMany({
      where: {
        organizationId,
        OR: [
          { date: { gte: new Date(`${von}T00:00:00.000Z`), lte: new Date(`${bis}T00:00:00.000Z`) } },
          { recurring: true },
        ],
      },
    }),
    db.employee.findMany({
      where: activeStaffWhere(organizationId),
      select: { id: true, availability: { select: { weekday: true, startTime: true, endTime: true } } },
    }),
    db.absence.findMany({
      where: {
        status: 'APPROVED',
        employee: activeStaffWhere(organizationId),
        startDate: { lte: new Date(`${bis}T00:00:00.000Z`) },
        endDate: { gte: new Date(`${von}T00:00:00.000Z`) },
      },
      select: { employeeId: true, startDate: true, endDate: true },
    }),
    db.job.findMany({
      where: {
        organizationId,
        deletedAt: null,
        status: { notIn: ['CANCELLED'] },
        scheduledStart: { lt: zeitraumEnde },
        scheduledEnd: { gt: zeitraumStart },
        ...(ausnahmen.buchungId ? { OR: [{ bookingId: null }, { bookingId: { not: ausnahmen.buchungId } }] } : {}),
      },
      select: {
        scheduledStart: true,
        scheduledEnd: true,
        crewSize: true,
        service: { select: { bufferMinutes: true } },
        booking: { select: { items: { select: { service: { select: { bufferMinutes: true } } } } } },
      },
    }),
    /**
     * Unbestätigte Buchungen binden ihr Team schon jetzt. Ihr Einsatz entsteht
     * erst beim Bestätigen (`confirmBooking`), und bis dahin sah die Rechnung
     * sie nicht — zwei Online-Buchungen konnten denselben letzten Platz
     * nacheinander bekommen. Bestätigte Buchungen haben ihren Einsatz; sie
     * kommen hier nur vor, wenn er fehlt (Altbestand), und werden dann
     * ebenfalls gezählt.
     */
    db.booking.findMany({
      where: {
        organizationId,
        deletedAt: null,
        status: { in: [...BUCHUNG_BINDET] },
        scheduledStart: { lt: zeitraumEnde },
        scheduledEnd: { gt: zeitraumStart },
        jobs: { none: { deletedAt: null, status: { not: 'CANCELLED' } } },
        ...(ausnahmen.buchungId ? { id: { not: ausnahmen.buchungId } } : {}),
      },
      select: { scheduledStart: true, scheduledEnd: true, crewSize: true, items: { select: { service: { select: { bufferMinutes: true } } } } },
    }),
    verlangt.length > 0
      ? db.employeeSkill.findMany({
          where: { employee: activeStaffWhere(organizationId) },
          select: { employeeId: true, name: true, certifiedUntil: true },
        })
      : Promise.resolve([]),
  ]);

  const belegungen: Belegung[] = [
    /**
     * Puffer eines Einsatzes: der grösste seiner Leistungen (2026-09-27).
     *
     * Bis hierher zählte nur `Job.service` — die *erste* Leistung, weil das
     * Feld einwertig ist (siehe `createJobsForBooking`). Eine Buchung aus
     * Büroreinigung (15 Min. Puffer) und Grundreinigung (60 Min.) hielt vor
     * der Bestätigung 60 Minuten frei, danach nur noch 15: Die Bestätigung
     * gab Kapazität frei, die es nicht gab. Jetzt rechnet der Einsatz
     * dieselbe Grösse wie seine Buchung, nämlich das Maximum.
     */
    ...einsaetze.map((j) => ({
      start: j.scheduledStart,
      ende: j.scheduledEnd,
      crew: j.crewSize,
      pufferMin: Math.max(0, j.service?.bufferMinutes ?? 0, ...(j.booking?.items ?? []).map((i) => i.service.bufferMinutes)),
    })),
    ...buchungen.map((b) => ({
      start: b.scheduledStart,
      ende: b.scheduledEnd,
      crew: b.crewSize,
      pufferMin: Math.max(0, ...b.items.map((i) => i.service.bufferMinutes)),
    })),
  ];
  const arbeitszeitenGepflegt = personal.some((p) => p.availability.length > 0);

  const ergebnis: Tagesdaten[] = [];
  for (let i = 0; i < tage; i += 1) {
    const datum = naechsterTag(von, i);
    const wt = wochentag(datum);
    const feiertag = feiertage.find((f) => {
      const d = f.date.toISOString().slice(0, 10);
      return d === datum || (f.recurring && d.slice(5) === datum.slice(5));
    });
    const zeile = zeiten.find((z) => z.weekday === wt) ?? null;
    let fenster = feiertag ? null : einsatzfenster(zeile);
    let grund = feiertag ? `Feiertag: ${feiertag.name}` : fenster ? undefined : 'An diesem Tag finden keine Einsätze statt.';
    const tagStart = zurichZuUtc(datum, '00:00');
    const tagEnde = zurichZuUtc(naechsterTag(datum), '00:00');

    const personen = personal.map((p) => ({
      id: p.id,
      fenster: p.availability.length
        ? p.availability.filter((a) => a.weekday === wt).map((a) => ({ von: a.startTime, bis: a.endTime }))
        : null,
      // Personen, nicht Zeilen: Zwei Einträge derselben Person am selben
      // Tag machen sie nicht zweimal abwesend. Ein halber Tag zählt als
      // ganzer — ob Vor- oder Nachmittag, steht nirgends.
      abwesend: abwesenheiten.some(
        (a) =>
          a.employeeId === p.id &&
          a.startDate.toISOString().slice(0, 10) <= datum &&
          a.endDate.toISOString().slice(0, 10) >= datum,
      ),
    }));

    /**
     * Genug qualifizierte Leute an diesem Tag? (2026-09-27)
     *
     * Die Kapazität zählte Köpfe. Eine Leistung, die eine Qualifikation
     * verlangt (`Service.requiredSkills`), liess sich deshalb an einem Tag
     * buchen, an dem niemand mit dieser Qualifikation arbeitet — die Buchung
     * ging durch, und die Zuteilung (`assignment.service.ts`) wies danach
     * jede Person ab. Ein zugesagter Termin, den niemand besetzen darf.
     *
     * Bewusst die kleinste richtige Regel: Es müssen mindestens so viele
     * anwesende Personen mit allen verlangten Qualifikationen (gültig am
     * Einsatztag) existieren, wie das Team gross ist. Welche davon zur
     * gewählten Uhrzeit schon anderswo eingeteilt sind, rechnet die
     * Kopfzählung weiter pauschal — eine Zuordnung Person ↔ Belegung gibt es
     * vor der Disposition nicht, und sie zu erfinden wäre eine Genauigkeit,
     * die das Modell nicht hat. Ein Tag ohne ausreichend Qualifizierte ist
     * deshalb geschlossen, mit Begründung, im Kalender wie beim Abschluss.
     */
    if (fenster && anforderung && verlangt.length > 0) {
      const qualifiziert = personen.filter((p) => {
        if (p.abwesend) return false;
        const kann = new Set(
          faehigkeiten
            .filter((f) => f.employeeId === p.id && (!f.certifiedUntil || f.certifiedUntil.toISOString().slice(0, 10) >= datum))
            .map((f) => f.name.trim().toLowerCase()),
        );
        return verlangt.every((s) => kann.has(s));
      }).length;
      if (qualifiziert < anforderung.crew) {
        fenster = null;
        grund = 'An diesem Tag ist nicht genug Personal mit der verlangten Qualifikation eingeplant.';
      }
    }

    ergebnis.push({
      datum,
      fenster,
      grund,
      arbeitszeitenGepflegt,
      personen,
      belegungen: belegungen.filter((b) => b.start < tagEnde && b.ende.getTime() + b.pufferMin * 60_000 > tagStart.getTime()),
    });
  }
  return ergebnis;
}

/** Was eine Auswahl an Personal verlangt — siehe den Qualifikationsabschnitt in `ladeZeitraum`. */
export interface Qualifikationsanforderung {
  qualifikationen: string[];
  crew: number;
}

/**
 * Puffer und Qualifikationen einer Leistungsauswahl, aus dem Katalog.
 *
 * Eine Stelle für beide Grössen, weil sie dieselbe Frage beantworten („was
 * bindet diese Auswahl?") und bis 2026-09-27 an drei Stellen je anders
 * berechnet wurden: das Anlegen nahm die Preis-Engine, das Bearbeiten eine
 * eigene Abfrage, das Verschieben gar nichts.
 */
export async function leistungsbedarf(
  db: Db,
  organizationId: string,
  serviceIds: string[],
): Promise<{ pufferMin: number; qualifikationen: string[] }> {
  const ids = [...new Set(serviceIds)];
  if (ids.length === 0) return { pufferMin: 0, qualifikationen: [] };
  const leistungen = await db.service.findMany({
    where: { id: { in: ids }, organizationId },
    select: { bufferMinutes: true, requiredSkills: true },
  });
  return {
    pufferMin: Math.max(0, ...leistungen.map((l) => l.bufferMinutes)),
    qualifikationen: [...new Set(leistungen.flatMap((l) => l.requiredSkills))],
  };
}

/**
 * Vorlauf und Horizont aus den Einstellungen.
 *
 * Die Kundschaft bucht frühestens `bookingMinNoticeHours` im Voraus und
 * höchstens `bookingLeadDays` Tage weit. Das Büro ist an beides nicht
 * gebunden — wer anruft, weil es brennt, bekommt auch einen Termin morgen
 * früh, und ein Jahrestermin für die Grundreinigung wird im Büro heute schon
 * eingetragen („Ausserhalb buchen kann das Büro jederzeit von Hand", steht in
 * den Einstellungen). In der Vergangenheit bucht aber auch das Büro nicht.
 * Einsatzfenster und Kapazität gelten für beide Wege gleich.
 */
async function grenzen(db: Db, organizationId: string, kanal: 'oeffentlich' | 'buero') {
  const jetzt = Date.now();
  if (kanal === 'buero') {
    return { fruehestens: new Date(jetzt), spaetestens: new Date(jetzt + 10 * 365 * 86_400_000) };
  }
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  const einstellungen = withSettingsDefaults(org?.settings);
  return {
    fruehestens: new Date(jetzt + einstellungen.bookingMinNoticeHours * 3_600_000),
    spaetestens: new Date(jetzt + einstellungen.bookingLeadDays * 86_400_000),
  };
}

export interface AvailabilityParams {
  organizationId: string;
  /** Datum im Format JJJJ-MM-TT (lokale Schweizer Zeit). */
  date: string;
  durationMin: number;
  crewSize: number;
  bufferMin?: number;
  /** Verlangte Qualifikationen der Auswahl (`leistungsbedarf`). */
  qualifikationen?: string[];
}

/** Die Zeitfenster eines Tages — für die bestehende Einzeltag-Abfrage. */
export async function getAvailableSlots(params: AvailabilityParams) {
  const [tag] = await getAvailableDays({ ...params, von: params.date, tage: 1 });
  return tag!;
}

/**
 * Die Zeitfenster mehrerer Tage auf einmal — für den Kalender.
 *
 * Ein Tag gilt als verfügbar (`available`), wenn er mindestens ein buchbares
 * Zeitfenster hat. Nur solche Tage darf der Kalender auswählbar zeigen.
 */
export async function getAvailableDays(params: {
  organizationId: string;
  von: string;
  tage: number;
  durationMin: number;
  crewSize: number;
  bufferMin?: number;
  qualifikationen?: string[];
}) {
  const [tage, g] = await Promise.all([
    ladeZeitraum(prisma, params.organizationId, params.von, params.tage, {}, {
      qualifikationen: params.qualifikationen ?? [],
      crew: params.crewSize,
    }),
    grenzen(prisma, params.organizationId, 'oeffentlich'),
  ]);
  const anfrage: Anfrage = {
    dauerMin: params.durationMin,
    crew: params.crewSize,
    pufferMin: params.bufferMin ?? 0,
    ...g,
  };
  return tage.map((tag) => berechneSlots(tag, anfrage));
}

/**
 * Ist ein konkreter Termin (noch) buchbar? — beim Abschluss der Buchung und
 * beim Verschieben.
 *
 * Dieselbe Prüfung wie für jedes angebotene Zeitfenster (`pruefeZeitraum`),
 * mit denselben Daten. `db` erlaubt den Aufruf *innerhalb* der Transaktion,
 * die die Buchung schreibt — nach einer Sperre, siehe `createBooking`.
 */
export async function isSlotBookable(params: {
  organizationId: string;
  start: Date;
  durationMin: number;
  crewSize: number;
  bufferMin?: number;
  /** Im Büro gilt der Vorlauf der Kundschaft nicht. */
  kanal?: 'oeffentlich' | 'buero';
  /** Beim Verschieben: die eigene Buchung (und ihre Einsätze) nicht als Belegung zählen. */
  ohneBuchungId?: string | null;
  /** Verlangte Qualifikationen der Auswahl (`leistungsbedarf`). */
  qualifikationen?: string[];
  db?: Db;
}): Promise<{ ok: boolean; reason?: string }> {
  const db = params.db ?? prisma;
  const datum = zurichDatum(params.start);
  const [[tag], g] = await Promise.all([
    ladeZeitraum(db, params.organizationId, datum, 1, { buchungId: params.ohneBuchungId }, {
      qualifikationen: params.qualifikationen ?? [],
      crew: params.crewSize,
    }),
    grenzen(db, params.organizationId, params.kanal ?? 'oeffentlich'),
  ]);
  if (!tag!.fenster) return { ok: false, reason: tag!.grund ?? ABLEHNUNGSTEXT.GESCHLOSSEN };
  const { ablehnung } = pruefeZeitraum(tag!, params.start, {
    dauerMin: params.durationMin,
    crew: params.crewSize,
    pufferMin: params.bufferMin ?? 0,
    ...g,
  });
  return ablehnung ? { ok: false, reason: ABLEHNUNGSTEXT[ablehnung] } : { ok: true };
}

/**
 * Früher: Zwischenspeicher eines Tages leeren. Die Zeitfenster werden seit
 * 2026-09-26 nicht mehr zwischengespeichert; die Funktion räumt nur noch
 * Einträge aus der Zeit davor ab und bleibt, damit die Aufrufer in
 * `job.service.ts` und `booking.service.ts` nicht angefasst werden müssen.
 */
export async function invalidateAvailability(organizationId: string, date: Date) {
  await cache.delByPattern(`${cacheKeys.availability(organizationId, zurichDatum(date))}*`);
}
