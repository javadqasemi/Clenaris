import { z } from 'zod';

import { cuidSchema, dateOnlySchema } from './common';
import { searchQuery } from './queries';
import { KPI_DIRECTIONS, KPI_PERIODS, KPI_UNITS } from './bi-kpi';

/**
 * Ziele auf drei Flughöhen: Strategie, Ziel (OKR), Initiative (Roadmap).
 *
 * Ein Schema für alle drei — sie sind dasselbe Objekt mit unterschiedlicher
 * Reichweite. Was sich unterscheidet (Quartal gegenüber Start/Ende), ist
 * freiwillig, damit eine Mehrjahresstrategie nicht in ein Quartalsraster
 * gezwungen wird.
 */

export const OBJECTIVE_HORIZONS = ['STRATEGY', 'OBJECTIVE', 'INITIATIVE'] as const;
export const OBJECTIVE_LEVELS = ['COMPANY', 'DEPARTMENT', 'PERSONAL'] as const;
export const OBJECTIVE_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'AT_RISK',
  'ACHIEVED',
  'MISSED',
  'CANCELLED',
] as const;
export const TASK_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

const money = z.number().min(0).max(1e9);

export const createObjectiveSchema = z
  .object({
    horizon: z.enum(OBJECTIVE_HORIZONS).default('OBJECTIVE'),
    level: z.enum(OBJECTIVE_LEVELS).default('COMPANY'),
    status: z.enum(OBJECTIVE_STATUSES).default('DRAFT'),
    title: z.string().trim().min(3, 'Bitte geben Sie einen Titel an.').max(200),
    description: z.string().trim().max(6000).optional(),
    department: z.string().trim().max(80).optional(),
    priority: z.enum(TASK_PRIORITIES).default('NORMAL'),
    parentId: cuidSchema.nullish(),
    ownerId: cuidSchema.nullish(),
    fiscalYear: z.number().int().min(2000).max(2100).nullish(),
    quarter: z.number().int().min(1).max(4).nullish(),
    startsOn: dateOnlySchema.nullish(),
    endsOn: dateOnlySchema.nullish(),
    /** Ohne Prüfzyklus verrottet ein Ziel still; mit ihm zählt der Nachtlauf. */
    reviewIntervalDays: z.number().int().min(7).max(730).nullish(),
    budgetAmount: money.nullish(),
    expectedRoiPct: z.number().min(-100).max(10_000).nullish(),
  })
  .refine((d) => !d.startsOn || !d.endsOn || d.endsOn >= d.startsOn, {
    message: 'Das Ende darf nicht vor dem Beginn liegen.',
    path: ['endsOn'],
  });
export type CreateObjectiveInput = z.infer<typeof createObjectiveSchema>;

export const updateObjectiveSchema = createObjectiveSchema.innerType().partial().strict();
export type UpdateObjectiveInput = z.infer<typeof updateObjectiveSchema>;

export const objectiveListQuery = searchQuery.extend({
  horizon: z.enum(OBJECTIVE_HORIZONS).optional(),
  level: z.enum(OBJECTIVE_LEVELS).optional(),
  status: z.enum(OBJECTIVE_STATUSES).optional(),
  fiscalYear: z.coerce.number().int().min(2000).max(2100).optional(),
  quarter: z.coerce.number().int().min(1).max(4).optional(),
  ownerId: cuidSchema.optional(),
  parentId: cuidSchema.optional(),
  /** `1` = auch archivierte (erreichte, verfehlte, abgebrochene) Ziele. */
  archiv: z.enum(['0', '1']).default('0'),
});
export type ObjectiveListQuery = z.infer<typeof objectiveListQuery>;

/** Zeitachse der Roadmap: nur Initiativen und Strategien mit Datum. */
export const objectiveTimelineQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  horizon: z.enum(OBJECTIVE_HORIZONS).optional(),
  status: z.enum(OBJECTIVE_STATUSES).optional(),
});

/**
 * Schlüsselergebnis.
 *
 * Mit `kpiDefinitionId` rechnet es sich selbst aus dem Snapshot; ohne ist es
 * manuell und wird als solches gekennzeichnet.
 */
export const createKeyResultSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    kpiDefinitionId: cuidSchema.nullish(),
    kpiPeriod: z.enum(KPI_PERIODS).nullish(),
    unit: z.enum(KPI_UNITS).default('COUNT'),
    direction: z.enum(KPI_DIRECTIONS).default('UP_IS_GOOD'),
    startValue: z.number().min(-1e12).max(1e12).default(0),
    targetValue: z.number().min(-1e12).max(1e12),
    currentValue: z.number().min(-1e12).max(1e12).optional(),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  })
  .refine((d) => !d.kpiDefinitionId || Boolean(d.kpiPeriod), {
    message: 'Für ein automatisches Schlüsselergebnis braucht es die Periode der Kennzahl.',
    path: ['kpiPeriod'],
  });
export type CreateKeyResultInput = z.infer<typeof createKeyResultSchema>;

export const updateKeyResultSchema = createKeyResultSchema.innerType().partial().strict();
export type UpdateKeyResultInput = z.infer<typeof updateKeyResultSchema>;

export const keyResultCheckinSchema = z.object({
  value: z.number().min(-1e12).max(1e12),
  comment: z.string().trim().max(2000).optional(),
});
export type KeyResultCheckinInput = z.infer<typeof keyResultCheckinSchema>;

/** Prüfung abschliessen — freiwillige Notiz fürs Protokoll. */
export const reviewNoteSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});

/** Massnahme zu einem Ziel — wird eine gewöhnliche Aufgabe. */
export const objectiveTaskSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(4000).optional(),
  priority: z.enum(TASK_PRIORITIES).default('NORMAL'),
  dueAt: z.coerce.date().optional(),
  assigneeId: cuidSchema.optional(),
});
export type ObjectiveTaskInput = z.infer<typeof objectiveTaskSchema>;
