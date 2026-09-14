/**
 * Rechenkerne der Unternehmensführung — reine Funktionen ohne Datenbank.
 *
 * Alles, was hier steht, ist mit festen Zahlen prüfbar und wird von den
 * Prüfungen in `tests/api/bi-rechenkerne.test.ts` direkt importiert. Deshalb
 * keine Pfad-Aliasse und kein `server-only`: die Prüfungen laufen mit `tsx`
 * ausserhalb des Next-Bundles.
 *
 * Die Dienste in `src/server/services/` holen die Daten und rufen diese
 * Funktionen — sie rechnen selbst nichts, damit es zu jeder Zahl genau eine
 * Rechnung gibt.
 */

export type Direction = 'UP_IS_GOOD' | 'DOWN_IS_GOOD';

// ---------------------------------------------------------------------------
//  Gesundheitswert
// ---------------------------------------------------------------------------

/**
 * Teilnote 0..100.
 *
 * Linear zwischen Warnschwelle und Zielwert, an beiden Enden gekappt. Ein
 * weicher Verlauf (Sigmoid) sähe eleganter aus, wäre aber nicht erklärbar —
 * und Erklärbarkeit ist bei dieser Zahl der ganze Punkt. Wer fragt, warum die
 * Liquidität 62 Punkte hat, soll die Rechnung in einem Satz hören.
 *
 * Die Richtung steckt bereits in der Lage von `warn` und `target`: bei
 * `DOWN_IS_GOOD` liegt die Warnschwelle *über* dem Ziel, und die Formel dreht
 * sich von selbst. Wer die Schwellen verkehrt herum setzt, bekommt eine
 * verkehrte Note — genau das soll die Oberfläche beim Setzen prüfen.
 */
export function subScore(value: number, warn: number, target: number): number {
  const span = target - warn;
  if (span === 0) return value === target ? 100 : 0;
  const raw = ((value - warn) / span) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export interface WeightedItem {
  subScore: number;
  weight: number;
}

/**
 * Gewichteter Mittelwert; Einträge mit Gewicht 0 fliessen nicht ein. Ohne
 * gewichtete Einträge gibt es keinen Wert — `null`, nicht 0.
 */
export function weightedScore(items: WeightedItem[]): number | null {
  const weighted = items.filter((item) => item.weight > 0);
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight === 0) return null;
  return Math.round(weighted.reduce((sum, item) => sum + item.subScore * item.weight, 0) / totalWeight);
}

export type HealthStatus = 'EXCELLENT' | 'GOOD' | 'ATTENTION' | 'CRITICAL';

/** Vier Stufen statt einer Farbe — die Schwellen stehen an genau einer Stelle. */
export function healthStatus(score: number): HealthStatus {
  if (score >= 85) return 'EXCELLENT';
  if (score >= 70) return 'GOOD';
  if (score >= 50) return 'ATTENTION';
  return 'CRITICAL';
}

// ---------------------------------------------------------------------------
//  Fortschritt eines Schlüsselergebnisses
// ---------------------------------------------------------------------------

/**
 * 0..100 zwischen Start- und Zielwert.
 *
 * Bei `DOWN_IS_GOOD` liegt der Zielwert unter dem Start — die Formel bleibt
 * dieselbe, weil der Bruch das Vorzeichen mitnimmt. Start = Ziel ist der
 * Sonderfall „halten": erreicht, sobald der Wert auf der richtigen Seite ist.
 */
export function keyResultProgress(
  startValue: number,
  targetValue: number,
  currentValue: number,
  direction: Direction,
): number {
  const span = targetValue - startValue;
  if (span === 0) {
    const reached = direction === 'UP_IS_GOOD' ? currentValue >= targetValue : currentValue <= targetValue;
    return reached ? 100 : 0;
  }
  const raw = ((currentValue - startValue) / span) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

// ---------------------------------------------------------------------------
//  Risiko
// ---------------------------------------------------------------------------

/** Schwere 1..25 — an genau einer Stelle, damit es keine zweite Rechnung gibt. */
export function riskSeverity(probability: number, impact: number): number {
  return probability * impact;
}

export type RiskBand = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export function riskBand(severity: number): RiskBand {
  if (severity >= 16) return 'CRITICAL';
  if (severity >= 10) return 'HIGH';
  if (severity >= 5) return 'MEDIUM';
  return 'LOW';
}

// ---------------------------------------------------------------------------
//  Abschreibung
// ---------------------------------------------------------------------------

export type DepreciationMethodName = 'NONE' | 'STRAIGHT_LINE' | 'DECLINING';

export interface DepreciationInput {
  purchaseAmount: number;
  residualValue: number;
  usefulLifeYears: number | null;
  method: DepreciationMethodName;
  /** Ganze Monate seit Inbetriebnahme bis zum Stichtag. */
  monthsInService: number;
}

export interface DepreciationResult {
  bookValue: number;
  accumulated: number;
  /** Abschreibung des laufenden Jahres bei linearer Methode; sonst der Betrag der letzten zwölf Monate. */
  annualCharge: number;
  /** Verbleibende Monate bis zum Restwert; `null` bei `NONE`. */
  remainingMonths: number | null;
  /** Degressiver Satz je Jahr, 0..1; nur bei `DECLINING`. */
  rate: number | null;
}

/**
 * Restwert zum Stichtag — pro rata temporis auf Monate genau.
 *
 * Gerechnet, nicht gespeichert: aus Anschaffungswert, Restwert, Nutzungsdauer
 * und Methode ergibt sich der Restwert zu jedem Stichtag eindeutig. Eine
 * Buchungstabelle wäre erst nötig, wenn die Abschreibung ins Rechnungswesen
 * gebucht würde.
 */
export function depreciation(input: DepreciationInput): DepreciationResult {
  const { purchaseAmount, residualValue, method } = input;
  const months = Math.max(0, input.monthsInService);

  if (method === 'NONE') {
    return { bookValue: purchaseAmount, accumulated: 0, annualCharge: 0, remainingMonths: null, rate: null };
  }

  const life = input.usefulLifeYears;
  if (!life || life <= 0) {
    throw new Error('Für eine Abschreibung braucht es die Nutzungsdauer in Jahren.');
  }
  const lifeMonths = life * 12;

  if (method === 'STRAIGHT_LINE') {
    const annual = (purchaseAmount - residualValue) / life;
    const raw = purchaseAmount - (annual * months) / 12;
    const bookValue = round2(Math.max(residualValue, raw));
    return {
      bookValue,
      accumulated: round2(purchaseAmount - bookValue),
      annualCharge: round2(months >= lifeMonths ? 0 : annual),
      remainingMonths: Math.max(0, lifeMonths - months),
      rate: null,
    };
  }

  // Degressiv: konstanter Satz, der nach `life` Jahren genau beim Restwert
  // landet. Ein Restwert von null ergäbe einen Satz von 100 % — die Anlage
  // wäre im ersten Monat weg. Deshalb verlangt der Dienst hier einen Restwert
  // über null; die Rechnung selbst schützt sich mit einem Rappen.
  const floor = Math.max(residualValue, 0.01);
  const rate = 1 - Math.pow(floor / purchaseAmount, 1 / life);
  const raw = purchaseAmount * Math.pow(1 - rate, months / 12);
  const bookValue = round2(Math.max(residualValue, raw));
  const previous = purchaseAmount * Math.pow(1 - rate, Math.max(0, months - 12) / 12);
  return {
    bookValue,
    accumulated: round2(purchaseAmount - bookValue),
    annualCharge: round2(Math.max(0, previous - Math.max(residualValue, raw))),
    remainingMonths: Math.max(0, lifeMonths - months),
    rate: Math.round(rate * 10_000) / 10_000,
  };
}

/** Restwert je Jahr über die Nutzungsdauer — für die Tabelle auf der Detailseite. */
export function depreciationSchedule(
  input: Omit<DepreciationInput, 'monthsInService'>,
): { year: number; bookValue: number; charge: number }[] {
  if (input.method === 'NONE' || !input.usefulLifeYears) return [];
  const rows: { year: number; bookValue: number; charge: number }[] = [];
  let previous = input.purchaseAmount;
  for (let year = 1; year <= input.usefulLifeYears; year += 1) {
    const { bookValue } = depreciation({ ...input, monthsInService: year * 12 });
    rows.push({ year, bookValue, charge: round2(previous - bookValue) });
    previous = bookValue;
  }
  return rows;
}

/** Amortisation in Jahren aus erwartetem Jahresnutzen; `null` ohne Nutzen. */
export function paybackYears(purchaseAmount: number, expectedAnnualBenefit: number | null): number | null {
  if (!expectedAnnualBenefit || expectedAnnualBenefit <= 0) return null;
  return Math.round((purchaseAmount / expectedAnnualBenefit) * 10) / 10;
}

/** Jährliche Rendite in Prozent auf den Anschaffungswert. */
export function roiPct(purchaseAmount: number, expectedAnnualBenefit: number | null): number | null {
  if (!expectedAnnualBenefit || purchaseAmount <= 0) return null;
  return Math.round((expectedAnnualBenefit / purchaseAmount) * 1000) / 10;
}

// ---------------------------------------------------------------------------
//  Budgetabweichung
// ---------------------------------------------------------------------------

export interface VarianceInput {
  /** Jahresplan (Nachtrag, sonst Plan). */
  plan: number;
  /** Zwölf Monatswerte; leer = gleichmässig verteilt. */
  monthlyPlan: number[];
  actual: number;
  /** Monate der Periode, die bereits begonnen haben (1..total). */
  elapsedMonths: number;
  totalMonths: number;
}

export interface VarianceResult {
  plan: number;
  planToDate: number;
  actual: number;
  /** Ist − anteiliger Plan; positiv = Überschreitung. */
  variance: number;
  /** Abweichung in Prozent des anteiligen Plans; `null` ohne Plan. */
  variancePct: number | null;
  /** Hochrechnung aufs Jahr; erst ab drei verstrichenen Monaten. */
  forecast: number | null;
  forecastVariance: number | null;
}

/**
 * Der anteilige Plan ist der Punkt. Ein Vergleich des Jahresplans mit dem Ist
 * von vier Monaten meldet im April überall eine gewaltige Unterschreitung und
 * trainiert alle darauf, die Abweichungsspalte zu übersehen.
 *
 * Die Hochrechnung gilt erst ab drei verstrichenen Monaten; davor ist sie
 * Rauschen mal zwölf.
 */
export function budgetVariance(input: VarianceInput): VarianceResult {
  const total = Math.max(1, input.totalMonths);
  const elapsed = Math.max(0, Math.min(total, input.elapsedMonths));

  const planToDate =
    input.monthlyPlan.length === total
      ? input.monthlyPlan.slice(0, elapsed).reduce((sum, v) => sum + v, 0)
      : (input.plan * elapsed) / total;

  const variance = round2(input.actual - planToDate);
  const variancePct = planToDate > 0 ? Math.round((variance / planToDate) * 1000) / 10 : null;
  const forecast = elapsed >= 3 ? round2((input.actual / elapsed) * total) : null;

  return {
    plan: round2(input.plan),
    planToDate: round2(planToDate),
    actual: round2(input.actual),
    variance,
    variancePct,
    forecast,
    forecastVariance: forecast === null ? null : round2(forecast - input.plan),
  };
}

// ---------------------------------------------------------------------------
//  Szenario
// ---------------------------------------------------------------------------

export interface ScenarioDriverInput {
  value: number;
  monthlyChangePct: number;
}

export interface ScenarioInput {
  horizonMonths: number;
  openingCash: number;
  drivers: Partial<Record<ScenarioDriverKey, ScenarioDriverInput>>;
  /** Aus dem Ist: Aufträge je Kundschaft und Monat; für „benötigte Kundschaft". */
  jobsPerCustomerMonth: number;
  /** Sollstunden je Vollzeitstelle und Monat (aus `Organization.weeklyHours`). */
  hoursPerFteMonth: number;
}

export type ScenarioDriverKey =
  | 'jobsPerMonth'
  | 'averageTicket'
  | 'laborCostPct'
  | 'materialCostPct'
  | 'overheadPerMonth'
  | 'investmentPerMonth'
  | 'churnPct'
  | 'paymentDelayDays'
  | 'hoursPerJob'
  | 'targetUtilizationPct';

export interface ScenarioMonth {
  month: number;
  jobs: number;
  revenue: number;
  variableCost: number;
  contribution: number;
  overhead: number;
  result: number;
  cumulativeResult: number;
  cashIn: number;
  investment: number;
  cash: number;
  employeesRequired: number;
  customersRequired: number;
}

export interface ScenarioResult {
  months: ScenarioMonth[];
  totals: {
    revenue: number;
    variableCost: number;
    contribution: number;
    overhead: number;
    investment: number;
    result: number;
    contributionMarginPct: number | null;
  };
  /** Erster Monat (1-basiert) mit kumuliertem Ergebnis ≥ 0; `null` = nie im Horizont. */
  breakEvenMonth: number | null;
  /** Umsatz je Monat, ab dem das Ergebnis null wäre — bei konstanten Fixkosten. */
  breakEvenRevenue: number | null;
  liquidityLow: { month: number; cash: number };
  closingCash: number;
  peakEmployees: number;
  peakCustomers: number;
}

function driverAt(drivers: ScenarioInput['drivers'], key: ScenarioDriverKey, month: number, fallback = 0): number {
  const d = drivers[key];
  if (!d) return fallback;
  return d.value * Math.pow(1 + d.monthlyChangePct / 100, month);
}

/**
 * Monatsweise Rechnung über den Horizont.
 *
 * Umsatz und Liquidität sind bewusst getrennt: der Zahlungsverzug verschiebt
 * die Einzahlung um ganze Monate nach hinten. Ein Szenario mit gutem
 * Jahresergebnis kann im vierten Monat zahlungsunfähig sein — genau diese
 * Zahl (`liquidityLow`) ist der Grund für die Rechnung.
 */
export function computeScenario(input: ScenarioInput): ScenarioResult {
  const horizon = Math.max(1, Math.round(input.horizonMonths));
  const delayMonths = Math.round(driverAt(input.drivers, 'paymentDelayDays', 0) / 30);
  const revenues: number[] = [];
  const months: ScenarioMonth[] = [];

  let cash = input.openingCash;
  let cumulative = 0;
  let breakEvenMonth: number | null = null;
  let low = { month: 1, cash: input.openingCash };
  const totals = { revenue: 0, variableCost: 0, contribution: 0, overhead: 0, investment: 0, result: 0 };
  let peakEmployees = 0;
  let peakCustomers = 0;

  for (let m = 0; m < horizon; m += 1) {
    const churn = driverAt(input.drivers, 'churnPct', 0);
    // Der Kundenverlust wirkt auf die Auftragszahl: was abspringt, bucht nicht.
    const jobs = driverAt(input.drivers, 'jobsPerMonth', m) * Math.pow(1 - churn / 100, m);
    const ticket = driverAt(input.drivers, 'averageTicket', m);
    const revenue = jobs * ticket;
    revenues.push(revenue);

    const variablePct =
      driverAt(input.drivers, 'laborCostPct', 0) + driverAt(input.drivers, 'materialCostPct', 0);
    const variableCost = (revenue * variablePct) / 100;
    const contribution = revenue - variableCost;
    const overhead = driverAt(input.drivers, 'overheadPerMonth', m);
    const investment = driverAt(input.drivers, 'investmentPerMonth', m);
    const result = contribution - overhead;
    cumulative += result;
    if (breakEvenMonth === null && cumulative >= 0) breakEvenMonth = m + 1;

    const cashIn = m - delayMonths >= 0 ? revenues[m - delayMonths] : 0;
    cash = cash + cashIn - variableCost - overhead - investment;
    if (cash < low.cash) low = { month: m + 1, cash: round2(cash) };

    const hoursPerJob = driverAt(input.drivers, 'hoursPerJob', 0, 3);
    const utilization = driverAt(input.drivers, 'targetUtilizationPct', 0, 80) / 100;
    const employeesRequired =
      input.hoursPerFteMonth > 0 && utilization > 0
        ? (jobs * hoursPerJob) / (input.hoursPerFteMonth * utilization)
        : 0;
    const customersRequired = input.jobsPerCustomerMonth > 0 ? jobs / input.jobsPerCustomerMonth : 0;
    peakEmployees = Math.max(peakEmployees, employeesRequired);
    peakCustomers = Math.max(peakCustomers, customersRequired);

    totals.revenue += revenue;
    totals.variableCost += variableCost;
    totals.contribution += contribution;
    totals.overhead += overhead;
    totals.investment += investment;
    totals.result += result;

    months.push({
      month: m + 1,
      jobs: Math.round(jobs * 10) / 10,
      revenue: round2(revenue),
      variableCost: round2(variableCost),
      contribution: round2(contribution),
      overhead: round2(overhead),
      result: round2(result),
      cumulativeResult: round2(cumulative),
      cashIn: round2(cashIn),
      investment: round2(investment),
      cash: round2(cash),
      employeesRequired: Math.round(employeesRequired * 10) / 10,
      customersRequired: Math.ceil(customersRequired),
    });
  }

  const marginPct = totals.revenue > 0 ? (totals.contribution / totals.revenue) * 100 : null;
  const overheadMonth0 = driverAt(input.drivers, 'overheadPerMonth', 0);
  const breakEvenRevenue = marginPct && marginPct > 0 ? round2((overheadMonth0 * 100) / marginPct) : null;

  return {
    months,
    totals: {
      revenue: round2(totals.revenue),
      variableCost: round2(totals.variableCost),
      contribution: round2(totals.contribution),
      overhead: round2(totals.overhead),
      investment: round2(totals.investment),
      result: round2(totals.result),
      contributionMarginPct: marginPct === null ? null : Math.round(marginPct * 10) / 10,
    },
    breakEvenMonth,
    breakEvenRevenue,
    liquidityLow: low,
    closingCash: round2(cash),
    peakEmployees: Math.round(peakEmployees * 10) / 10,
    peakCustomers: Math.ceil(peakCustomers),
  };
}

// ---------------------------------------------------------------------------
//  Kleinkram
// ---------------------------------------------------------------------------

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Veränderung in Prozent; `null`, wenn es keinen Vergleichswert gibt. */
export function changePct(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}
