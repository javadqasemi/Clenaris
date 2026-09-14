import { z } from 'zod';

import { cuidSchema, dateOnlySchema, moneySchema } from './common';
import { KPI_UNITS } from './bi-kpi';

/**
 * Finanzplanung: Budget, Investitionen, Szenarien.
 *
 * Budgetzeilen hängen an der bestehenden Ausgabenkategorie — die Ist-Spalte
 * kommt damit aus `Expense`, ohne zweite Kostenartenlogik. Szenarien speichern
 * Treiber, nicht Ergebnisse; das Ergebnis rechnet der Dienst.
 */

export const EXPENSE_CATEGORIES = [
  'MATERIAL',
  'EQUIPMENT',
  'VEHICLE',
  'FUEL',
  'INSURANCE',
  'RENT',
  'SALARY',
  'SOCIAL_SECURITY',
  'MARKETING',
  'SOFTWARE',
  'TRAINING',
  'TAXES',
  'OTHER',
] as const;

export const BUDGET_STATUSES = ['DRAFT', 'APPROVED', 'CLOSED'] as const;
export const INVESTMENT_STATUSES = [
  'PLANNED',
  'APPROVED',
  'ORDERED',
  'ACTIVE',
  'DISPOSED',
  'CANCELLED',
] as const;
export const DEPRECIATION_METHODS = ['NONE', 'STRAIGHT_LINE', 'DECLINING'] as const;
export const SCENARIO_KINDS = ['BEST', 'EXPECTED', 'WORST'] as const;

/**
 * Die Treiber, die der Rechenkern kennt. Unbekannte Schlüssel weist bereits
 * das Schema ab — ein Szenario mit einer Annahme, die niemand liest, sähe
 * gerechnet aus und wäre es nicht.
 */
export const SCENARIO_DRIVERS = [
  'jobsPerMonth',
  'averageTicket',
  'laborCostPct',
  'materialCostPct',
  'overheadPerMonth',
  'investmentPerMonth',
  'churnPct',
  'paymentDelayDays',
  'hoursPerJob',
  'targetUtilizationPct',
] as const;
export type ScenarioDriver = (typeof SCENARIO_DRIVERS)[number];

// ---------------------------------------------------------------------------
//  Budget
// ---------------------------------------------------------------------------

export const createBudgetPeriodSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    fiscalYear: z.number().int().min(2000).max(2100),
    startsOn: dateOnlySchema,
    endsOn: dateOnlySchema,
    note: z.string().trim().max(2000).optional(),
  })
  .refine((d) => d.endsOn > d.startsOn, {
    message: 'Das Ende muss nach dem Beginn liegen.',
    path: ['endsOn'],
  });
export type CreateBudgetPeriodInput = z.infer<typeof createBudgetPeriodSchema>;

export const updateBudgetPeriodSchema = createBudgetPeriodSchema.innerType().partial().strict();
export type UpdateBudgetPeriodInput = z.infer<typeof updateBudgetPeriodSchema>;

export const budgetListQuery = z.object({
  fiscalYear: z.coerce.number().int().min(2000).max(2100).optional(),
  status: z.enum(BUDGET_STATUSES).optional(),
});

/** Genau zwölf Monatswerte — die Datenbank prüft die Länge nicht. */
const monthlyPlanSchema = z
  .array(moneySchema)
  .length(12, 'Der Monatsplan braucht genau zwölf Werte.');

export const createBudgetLineSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  label: z.string().trim().min(2).max(120),
  plannedAmount: moneySchema,
  /** Ohne Angabe verteilt der Dienst den Jahresbetrag gleichmässig. */
  monthlyPlan: monthlyPlanSchema.optional(),
  note: z.string().trim().max(1000).optional(),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});
export type CreateBudgetLineInput = z.infer<typeof createBudgetLineSchema>;

export const updateBudgetLineSchema = createBudgetLineSchema
  .partial()
  .extend({
    /** Nachtrag nach der Genehmigung — Plan und Nachtrag bleiben getrennt sichtbar. */
    revisedAmount: moneySchema.nullish(),
  })
  .strict();
export type UpdateBudgetLineInput = z.infer<typeof updateBudgetLineSchema>;

// ---------------------------------------------------------------------------
//  Investitionen
// ---------------------------------------------------------------------------

export const createInvestmentSchema = z
  .object({
    name: z.string().trim().min(2).max(160),
    category: z.enum(EXPENSE_CATEGORIES).default('EQUIPMENT'),
    status: z.enum(INVESTMENT_STATUSES).default('PLANNED'),
    description: z.string().trim().max(4000).optional(),
    supplierId: cuidSchema.nullish(),
    purchaseAmount: moneySchema,
    plannedOn: dateOnlySchema.nullish(),
    purchasedOn: dateOnlySchema.nullish(),
    commissionedOn: dateOnlySchema.nullish(),
    disposedOn: dateOnlySchema.nullish(),
    disposalProceeds: moneySchema.nullish(),
    method: z.enum(DEPRECIATION_METHODS).default('STRAIGHT_LINE'),
    usefulLifeYears: z.number().int().min(1).max(50).nullish(),
    residualValue: moneySchema.default(0),
    expectedAnnualBenefit: moneySchema.nullish(),
    assetTag: z.string().trim().max(40).nullish(),
    location: z.string().trim().max(120).nullish(),
    ownerId: cuidSchema.nullish(),
  })
  .refine((d) => d.residualValue <= d.purchaseAmount, {
    message: 'Der Restwert darf den Anschaffungswert nicht übersteigen.',
    path: ['residualValue'],
  });
export type CreateInvestmentInput = z.infer<typeof createInvestmentSchema>;

export const updateInvestmentSchema = createInvestmentSchema.innerType().partial().strict();
export type UpdateInvestmentInput = z.infer<typeof updateInvestmentSchema>;

export const investmentListQuery = z.object({
  status: z.enum(INVESTMENT_STATUSES).optional(),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  q: z.string().trim().max(120).optional(),
});

/** Stichtag für Restwert und Abschreibungsplan; ohne Angabe heute. */
export const depreciationQuery = z.object({
  asOf: z.coerce.date().optional(),
});

// ---------------------------------------------------------------------------
//  Szenarien
// ---------------------------------------------------------------------------

export const scenarioAssumptionSchema = z.object({
  key: z.enum(SCENARIO_DRIVERS),
  label: z.string().trim().min(2).max(120),
  value: z.number().min(-1e9).max(1e9),
  unit: z.enum(KPI_UNITS).default('COUNT'),
  /** Monatliche Veränderung in Prozent — Wachstum ohne zwölf Einzelwerte. */
  monthlyChangePct: z.number().min(-50).max(50).default(0),
  note: z.string().trim().max(500).optional(),
  sortOrder: z.number().int().min(0).max(100).default(0),
});
export type ScenarioAssumptionInput = z.infer<typeof scenarioAssumptionSchema>;

export const createScenarioSchema = z.object({
  name: z.string().trim().min(2).max(120),
  kind: z.enum(SCENARIO_KINDS).default('EXPECTED'),
  fiscalYear: z.number().int().min(2000).max(2100),
  horizonMonths: z.number().int().min(3).max(60).default(12),
  description: z.string().trim().max(2000).optional(),
  openingCash: z.number().min(-1e9).max(1e9).default(0),
  /**
   * Ohne Annahmen belegt der Dienst das Szenario aus den letzten zwölf
   * Monaten vor. Ein leeres Formular mit acht Zahlenfeldern füllt niemand aus.
   */
  assumptions: z
    .array(scenarioAssumptionSchema)
    .max(20)
    .refine((list) => new Set(list.map((a) => a.key)).size === list.length, {
      message: 'Jeder Treiber darf nur einmal vorkommen.',
    })
    .optional(),
});
export type CreateScenarioInput = z.infer<typeof createScenarioSchema>;

export const updateScenarioSchema = createScenarioSchema.partial().strict();
export type UpdateScenarioInput = z.infer<typeof updateScenarioSchema>;

export const scenarioListQuery = z.object({
  fiscalYear: z.coerce.number().int().min(2000).max(2100).optional(),
  kind: z.enum(SCENARIO_KINDS).optional(),
});

/** Vergleich: die drei Fälle eines Jahres, oder ausdrücklich genannte. */
export const scenarioCompareQuery = z.object({
  fiscalYear: z.coerce.number().int().min(2000).max(2100).optional(),
  ids: z
    .string()
    .max(400)
    .transform((value) => value.split(',').map((id) => id.trim()).filter(Boolean))
    .optional(),
});
