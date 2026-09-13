/**
 * Perioden der Kennzahlmaschine.
 *
 * Bewusst ohne `server-only` und ohne Pfad-Aliasse: dieses Modul wird vom
 * Nachtlauf, vom Rückwärtsfüll-Skript, von den Seiten *und* von den Prüfungen
 * gebraucht, und die Prüfungen importieren relativ.
 *
 * **Warum Europe/Zurich und nicht UTC.** Ein Monat endet für die Firma um
 * Mitternacht in Bern, nicht um Mitternacht in Greenwich. Eine Rechnung, die
 * am 31. März um 23:30 Uhr ausgestellt wird, gehört in den März — in UTC läge
 * sie bereits im April, und die Monatsumsätze stimmten nie mit der
 * Buchhaltung überein. Die Grenze wird deshalb als *Zürcher* Mitternacht
 * berechnet und als UTC-Zeitpunkt abgefragt.
 *
 * Der Periodenschlüssel (`periodStart`) ist dagegen ein reiner Kalendertag
 * (`@db.Date`) und trägt keine Zeitzone: `2026-03-01` ist der März, egal wo.
 */

export type PeriodName = 'DAY' | 'WEEK' | 'MONTH' | 'QUARTER' | 'YEAR';

export interface PeriodBounds {
  period: PeriodName;
  /** Kalendertag des Periodenbeginns, als UTC-Mitternacht (für `@db.Date`). */
  periodStart: Date;
  /** Letzter Kalendertag der Periode, als UTC-Mitternacht (für `@db.Date`). */
  periodEnd: Date;
  /** Erster Zeitpunkt der Periode in Zürich, als Instant (für `timestamptz`). */
  from: Date;
  /** Erster Zeitpunkt der *nächsten* Periode — die obere, ausschliessende Grenze. */
  to: Date;
  /** Anzeigetext, etwa „März 2026" oder „Q2 2026". */
  label: string;
}

const ZURICH = 'Europe/Zurich';

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ZURICH,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Zürcher Kalenderfelder eines Zeitpunkts. */
export function zurichParts(instant: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const map: Record<string, number> = {};
  for (const part of partsFormatter.formatToParts(instant)) {
    if (part.type !== 'literal') map[part.type] = Number(part.value);
  }
  // `hour12: false` liefert für Mitternacht je nach Laufzeit „24".
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour === 24 ? 0 : map.hour,
    minute: map.minute,
    second: map.second,
  };
}

/** Der Instant, an dem in Zürich der genannte Kalendertag um 00:00 beginnt. */
export function zurichMidnight(year: number, month0: number, day: number): Date {
  // Erster Wurf: UTC-Mitternacht. Dann den Versatz ablesen, den Zürich zu
  // diesem Zeitpunkt hat, und ihn abziehen. An Umstellungstagen liegt die
  // Mitternacht selbst nie in der Lücke, deshalb reicht eine Iteration.
  const guess = Date.UTC(year, month0, day);
  const seen = zurichParts(new Date(guess));
  const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
  const offsetMs = seenAsUtc - guess;
  return new Date(guess - offsetMs);
}

/** Kalendertag als UTC-Mitternacht — die Form, die `@db.Date` erwartet. */
export function dateOnly(year: number, month0: number, day: number): Date {
  return new Date(Date.UTC(year, month0, day));
}

/** Kalendertag (Zürich) eines Instants als UTC-Mitternacht. */
export function toDateOnly(instant: Date): Date {
  const p = zurichParts(instant);
  return dateOnly(p.year, p.month - 1, p.day);
}

const MONTHS = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];

/**
 * Die Periode, in die ein Zeitpunkt fällt.
 *
 * Wochen beginnen am Montag (ISO 8601) — im deutschsprachigen Raum die
 * einzige Lesart, die niemand erklären muss.
 */
export function periodOf(period: PeriodName, instant: Date): PeriodBounds {
  const p = zurichParts(instant);
  const y = p.year;
  const m0 = p.month - 1;
  const d = p.day;

  switch (period) {
    case 'DAY': {
      return build(period, y, m0, d, y, m0, d + 1, `${String(d).padStart(2, '0')}.${String(m0 + 1).padStart(2, '0')}.${y}`);
    }
    case 'WEEK': {
      const weekday = new Date(Date.UTC(y, m0, d)).getUTCDay(); // 0 = Sonntag
      const back = (weekday + 6) % 7;
      const start = new Date(Date.UTC(y, m0, d - back));
      const sy = start.getUTCFullYear();
      const sm = start.getUTCMonth();
      const sd = start.getUTCDate();
      return build(period, sy, sm, sd, sy, sm, sd + 7, `Woche ab ${String(sd).padStart(2, '0')}.${String(sm + 1).padStart(2, '0')}.${sy}`);
    }
    case 'MONTH':
      return build(period, y, m0, 1, y, m0 + 1, 1, `${MONTHS[m0]} ${y}`);
    case 'QUARTER': {
      const q0 = Math.floor(m0 / 3) * 3;
      return build(period, y, q0, 1, y, q0 + 3, 1, `Q${q0 / 3 + 1} ${y}`);
    }
    case 'YEAR':
      return build(period, y, 0, 1, y + 1, 0, 1, String(y));
  }
}

function build(
  period: PeriodName,
  sy: number,
  sm: number,
  sd: number,
  ey: number,
  em: number,
  ed: number,
  label: string,
): PeriodBounds {
  const startKey = dateOnly(sy, sm, sd);
  const nextKey = dateOnly(ey, em, ed);
  const endKey = new Date(nextKey.getTime() - 86_400_000);
  return {
    period,
    periodStart: startKey,
    periodEnd: endKey,
    from: zurichMidnight(sy, sm, sd),
    to: zurichMidnight(ey, em, ed),
    label,
  };
}

/** Die Periode, die `steps` Perioden vor oder nach der gegebenen liegt. */
export function shiftPeriod(bounds: PeriodBounds, steps: number): PeriodBounds {
  const s = bounds.periodStart;
  const y = s.getUTCFullYear();
  const m = s.getUTCMonth();
  const d = s.getUTCDate();
  switch (bounds.period) {
    case 'DAY':
      return periodOf('DAY', zurichMidnight(y, m, d + steps));
    case 'WEEK':
      return periodOf('WEEK', zurichMidnight(y, m, d + steps * 7));
    case 'MONTH':
      return periodOf('MONTH', zurichMidnight(y, m + steps, 1));
    case 'QUARTER':
      return periodOf('QUARTER', zurichMidnight(y, m + steps * 3, 1));
    case 'YEAR':
      return periodOf('YEAR', zurichMidnight(y + steps, m, 1));
  }
}

/** Dieselbe Periode ein Jahr früher — für den Vorjahresvergleich. */
export function previousYear(bounds: PeriodBounds): PeriodBounds {
  const s = bounds.periodStart;
  return periodOf(bounds.period, zurichMidnight(s.getUTCFullYear() - 1, s.getUTCMonth(), s.getUTCDate()));
}

/** Die Periode, die den Kalendertag `periodStart` enthält. */
export function periodFromKey(period: PeriodName, periodStart: Date): PeriodBounds {
  return periodOf(
    period,
    zurichMidnight(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), periodStart.getUTCDate()),
  );
}

/** Anzahl Kalendertage zwischen zwei Kalendertagen (b − a). */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** Ganze Monate zwischen zwei Kalendertagen, abgerundet. */
export function wholeMonthsBetween(from: Date, to: Date): number {
  if (to < from) return 0;
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/** Kalendertag + n Tage. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Heute als Kalendertag (Zürich). */
export function today(): Date {
  return toDateOnly(new Date());
}

/** Arbeitstage Mo–Fr zwischen zwei Kalendertagen (inklusive), ohne Feiertage. */
export function workingDays(from: Date, to: Date, holidays: Date[] = []): number {
  const skip = new Set(holidays.map((h) => h.toISOString().slice(0, 10)));
  let count = 0;
  for (let t = from.getTime(); t <= to.getTime(); t += 86_400_000) {
    const day = new Date(t);
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (skip.has(day.toISOString().slice(0, 10))) continue;
    count += 1;
  }
  return count;
}
