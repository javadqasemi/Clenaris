/**
 * Rechenkern der Nachkalkulation eines Einsatzes — reine Funktionen ohne
 * Datenbank.
 *
 * Wie `lib/bi/math.ts`: keine Pfad-Aliasse, kein `server-only`, damit die
 * Rechnung mit festen Zahlen prüfbar bleibt und von der Detailseite (lesend)
 * wie vom Dienst (beim Neuberechnen) dieselbe Funktion aufgerufen wird. Zwei
 * Rechnungen für dieselbe Zahl hiessen früher oder später zwei Ergebnisse.
 *
 * **Warum die Lohnkosten zwei Quellen haben.** Erfasste Zeit ist die Wahrheit,
 * sobald es sie gibt: Minuten mal dem Ansatz, der beim Einstempeln
 * festgehalten wurde. Davor gab es nichts — ein Einsatz ohne Stempelung hatte
 * Lohnkosten null, und die Marge eines geplanten Einsatzes sah aus wie hundert
 * Prozent. Deshalb zählt für jede eingeteilte Person ohne erfasste Zeit die
 * *geplante* Dauer mal ihrem heutigen Ansatz. Die Quelle steht an jeder Zeile,
 * damit niemand eine Planzahl für einen Beleg hält.
 */

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Sollstunden eines Vollzeitmonats: 42 Stunden je Woche (Art. 9 ArG für
 * Betriebe ohne Gesamtarbeitsvertrag, in der Reinigung üblich) mal 52 Wochen
 * durch 12 Monate. Der Monatslohn im Personalstamm gilt für 100 % — das
 * Pensum skaliert den Lohn, nicht den Ansatz; deshalb kommt `workloadPct`
 * hier nicht vor.
 */
export const FULL_TIME_HOURS_PER_MONTH = 182;

export interface RateSource {
  hourlyRate: number | null;
  monthlySalary: number | null;
}

/**
 * Stundenansatz einer Person.
 *
 * Stundenlohn geht vor Monatslohn: Wer beides hat, wird nach Stunden bezahlt
 * und der Monatslohn ist ein Richtwert. Wer nur einen Monatslohn hat, bekommt
 * den auf Sollstunden umgelegt — sonst kosteten festangestellte Personen in
 * der Nachkalkulation nichts, und ihre Einsätze sähen rentabler aus als die
 * der Stundenlöhner.
 */
export function effectiveHourlyRate(source: RateSource): number {
  if (source.hourlyRate !== null && source.hourlyRate > 0) return source.hourlyRate;
  if (source.monthlySalary !== null && source.monthlySalary > 0) {
    return round2(source.monthlySalary / FULL_TIME_HOURS_PER_MONTH);
  }
  return 0;
}

export type LaborSource = 'tracked' | 'planned';

export interface LaborLine {
  employeeId: string;
  name: string;
  minutes: number;
  /** Bei mehreren Zeitbuchungen mit verschiedenen Ansätzen: der gewichtete Mittelwert. */
  hourlyRate: number;
  cost: number;
  source: LaborSource;
}

export interface MaterialLine {
  name: string;
  quantity: number;
  unit: string;
  unitCost: number;
  total: number;
  billable: boolean;
}

export interface JobCostBreakdown {
  labor: LaborLine[];
  laborCost: number;
  materials: MaterialLine[];
  materialCost: number;
  /** Nettobetrag des Auftrags; `null`, wenn kein Auftrag am Einsatz hängt. */
  revenue: number | null;
  /** Geplante Minuten je Person — Einsatzdauer plus Anfahrt. */
  plannedMinutes: number;
}

export interface JobCostInput {
  estimatedMin: number;
  travelMin: number;
  assignments: { employeeId: string; name: string; rate: RateSource }[];
  /** Nur abgeschlossene Zeitbuchungen; laufende haben noch keine Minuten. */
  timeEntries: { employeeId: string; name: string; minutes: number; hourlyRate: number | null }[];
  materials: { name: string; quantity: number; unit: string; unitCost: number; billable: boolean }[];
  bookingNet: number | null;
}

export function deriveJobCosts(input: JobCostInput): JobCostBreakdown {
  const rateOf = new Map(input.assignments.map((a) => [a.employeeId, a.rate]));

  // Erfasste Zeit je Person zusammenziehen. Der Ansatz der Buchung geht vor;
  // fehlt er (Buchung von Hand, Person ohne Ansatz beim Einstempeln), gilt
  // der heutige Ansatz — besser als null, und die Quelle bleibt „erfasst".
  const tracked = new Map<string, { name: string; minutes: number; cost: number }>();
  for (const entry of input.timeEntries) {
    const rate =
      entry.hourlyRate !== null && entry.hourlyRate > 0
        ? entry.hourlyRate
        : effectiveHourlyRate(rateOf.get(entry.employeeId) ?? { hourlyRate: null, monthlySalary: null });
    const current = tracked.get(entry.employeeId) ?? { name: entry.name, minutes: 0, cost: 0 };
    current.minutes += entry.minutes;
    current.cost += (entry.minutes / 60) * rate;
    tracked.set(entry.employeeId, current);
  }

  const labor: LaborLine[] = [];
  for (const [employeeId, line] of tracked) {
    labor.push({
      employeeId,
      name: line.name,
      minutes: line.minutes,
      hourlyRate: line.minutes > 0 ? round2(line.cost / (line.minutes / 60)) : 0,
      cost: round2(line.cost),
      source: 'tracked',
    });
  }

  const plannedMinutes = Math.max(0, input.estimatedMin + input.travelMin);
  for (const assignment of input.assignments) {
    if (tracked.has(assignment.employeeId)) continue;
    const rate = effectiveHourlyRate(assignment.rate);
    labor.push({
      employeeId: assignment.employeeId,
      name: assignment.name,
      minutes: plannedMinutes,
      hourlyRate: rate,
      cost: round2((plannedMinutes / 60) * rate),
      source: 'planned',
    });
  }

  const materials: MaterialLine[] = input.materials.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    unitCost: item.unitCost,
    total: round2(item.quantity * item.unitCost),
    billable: item.billable,
  }));

  return {
    labor,
    laborCost: round2(labor.reduce((sum, line) => sum + line.cost, 0)),
    materials,
    materialCost: round2(materials.reduce((sum, line) => sum + line.total, 0)),
    revenue: input.bookingNet,
    plannedMinutes,
  };
}
