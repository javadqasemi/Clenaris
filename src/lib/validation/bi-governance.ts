import { z } from 'zod';

import { cuidSchema, dateOnlySchema, moneySchema } from './common';
import { searchQuery } from './queries';
import { TASK_PRIORITIES } from './bi-objectives';

/**
 * Risiko, Kontrollen (Abläufe, Standards, Compliance, Notfall) und
 * Massnahmen.
 *
 * Wahrscheinlichkeit und Auswirkung sind Stufen 1..5; die Schwere rechnet
 * der Dienst — sie steht nie im Anfragekörper, damit es keine zweite Rechnung
 * geben kann.
 */

export const RISK_CATEGORIES = [
  'FINANCIAL',
  'OPERATIONAL',
  'PERSONNEL',
  'LEGAL',
  'DATA_PROTECTION',
  'IT_SECURITY',
  'REPUTATION',
  'MARKET',
  'ENVIRONMENT',
] as const;
export const RISK_STATUSES = ['IDENTIFIED', 'ASSESSED', 'MITIGATING', 'ACCEPTED', 'CLOSED'] as const;
export const CONTROL_KINDS = ['SOP', 'QUALITY_STANDARD', 'COMPLIANCE', 'CONTINUITY'] as const;
export const CONTROL_STATUSES = ['DRAFT', 'ACTIVE', 'DUE', 'NON_COMPLIANT', 'RETIRED'] as const;
export const ACTION_KINDS = ['CORRECTIVE', 'PREVENTIVE', 'IMPROVEMENT'] as const;

const level = z.number().int().min(1).max(5);

// ---------------------------------------------------------------------------
//  Risiken
// ---------------------------------------------------------------------------

export const createRiskSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(6000).optional(),
  category: z.enum(RISK_CATEGORIES).default('OPERATIONAL'),
  status: z.enum(RISK_STATUSES).default('IDENTIFIED'),
  probability: level.default(3),
  impact: level.default(3),
  residualProbability: level.nullish(),
  residualImpact: level.nullish(),
  potentialLoss: moneySchema.nullish(),
  mitigationPlan: z.string().trim().max(6000).optional(),
  ownerId: cuidSchema.nullish(),
  reviewIntervalDays: z.number().int().min(7).max(730).default(90),
});
export type CreateRiskInput = z.infer<typeof createRiskSchema>;

export const updateRiskSchema = createRiskSchema.partial().strict();
export type UpdateRiskInput = z.infer<typeof updateRiskSchema>;

export const riskListQuery = searchQuery.extend({
  category: z.enum(RISK_CATEGORIES).optional(),
  status: z.enum(RISK_STATUSES).optional(),
  ownerId: cuidSchema.optional(),
  /** `1` = nur Einträge mit fälliger Prüfung. */
  faellig: z.enum(['0', '1']).default('0'),
});

/**
 * Prüfung abschliessen — setzt den nächsten Termin und darf die Bewertung
 * gleich mit aktualisieren. Eine Prüfung ohne Neubewertung ist erlaubt: dann
 * bestätigt sie nur, dass jemand hingeschaut hat.
 */
export const riskReviewSchema = z.object({
  note: z.string().trim().max(2000).optional(),
  probability: level.optional(),
  impact: level.optional(),
  residualProbability: level.nullish(),
  residualImpact: level.nullish(),
  status: z.enum(RISK_STATUSES).optional(),
});
export type RiskReviewInput = z.infer<typeof riskReviewSchema>;

// ---------------------------------------------------------------------------
//  Kontrollen
// ---------------------------------------------------------------------------

export const createControlSchema = z.object({
  kind: z.enum(CONTROL_KINDS).default('SOP'),
  status: z.enum(CONTROL_STATUSES).default('DRAFT'),
  reference: z.string().trim().max(80).optional(),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(10_000).optional(),
  evidenceNote: z.string().trim().max(2000).optional(),
  ownerId: cuidSchema.nullish(),
  reviewIntervalDays: z.number().int().min(7).max(1095).default(180),
});
export type CreateControlInput = z.infer<typeof createControlSchema>;

export const updateControlSchema = createControlSchema.partial().strict();
export type UpdateControlInput = z.infer<typeof updateControlSchema>;

export const controlListQuery = searchQuery.extend({
  kind: z.enum(CONTROL_KINDS).optional(),
  status: z.enum(CONTROL_STATUSES).optional(),
  faellig: z.enum(['0', '1']).default('0'),
});

export const controlReviewSchema = z.object({
  note: z.string().trim().max(2000).optional(),
  /** Ergebnis der Prüfung: weiterhin in Ordnung, oder eine Abweichung. */
  outcome: z.enum(['COMPLIANT', 'NON_COMPLIANT']).default('COMPLIANT'),
});
export type ControlReviewInput = z.infer<typeof controlReviewSchema>;

// ---------------------------------------------------------------------------
//  Massnahmen
// ---------------------------------------------------------------------------

export const createActionSchema = z
  .object({
    kind: z.enum(ACTION_KINDS).default('CORRECTIVE'),
    title: z.string().trim().min(3).max(200),
    rootCause: z.string().trim().max(4000).optional(),
    description: z.string().trim().max(6000).optional(),
    riskId: cuidSchema.nullish(),
    controlId: cuidSchema.nullish(),
    reviewId: cuidSchema.nullish(),
    dueOn: dateOnlySchema.nullish(),
    /** Mit Zuständigkeit entsteht zugleich eine Aufgabe mit Frist und Erinnerung. */
    assigneeId: cuidSchema.nullish(),
    priority: z.enum(TASK_PRIORITIES).default('NORMAL'),
  })
  .refine((d) => Boolean(d.riskId || d.controlId || d.reviewId), {
    message: 'Eine Massnahme gehört zu einem Risiko, einer Kontrolle oder einer Bewertung.',
    path: ['riskId'],
  });
export type CreateActionInput = z.infer<typeof createActionSchema>;

export const updateActionSchema = z
  .object({
    kind: z.enum(ACTION_KINDS).optional(),
    title: z.string().trim().min(3).max(200).optional(),
    rootCause: z.string().trim().max(4000).nullish(),
    description: z.string().trim().max(6000).nullish(),
    dueOn: dateOnlySchema.nullish(),
    completed: z.boolean().optional(),
    /** Wirksamkeitsprüfung — der Schritt, der bei CAPA am häufigsten fehlt. */
    effectivenessChecked: z.boolean().optional(),
    effectivenessNote: z.string().trim().max(2000).nullish(),
  })
  .strict();
export type UpdateActionInput = z.infer<typeof updateActionSchema>;

export const actionListQuery = z.object({
  riskId: cuidSchema.optional(),
  controlId: cuidSchema.optional(),
  reviewId: cuidSchema.optional(),
  /** `offen` = ohne Abschluss, `alle` = inklusive abgeschlossener. */
  status: z.enum(['offen', 'alle']).default('offen'),
});
