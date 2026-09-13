import { z } from 'zod';

import { dateOnlySchema } from './common';

/**
 * Kennzahlen: Definitionen, Zielwerte, manuelle Werte.
 *
 * Die Aufzählungen stehen hier als eigenständige Listen und nicht als
 * Ableitung aus dem Prisma-Client: dieses Modul wird auch aus der
 * OpenAPI-Erzeugung importiert, die ohne Datenbankclient auskommen muss. Die
 * Deckungsgleichheit mit dem Schema sichert `tsc` über die Dienste, die beide
 * Seiten zusammenführen.
 */

export const KPI_UNITS = ['CURRENCY', 'PERCENT', 'COUNT', 'DAYS', 'HOURS', 'RATIO'] as const;
export const KPI_DIRECTIONS = ['UP_IS_GOOD', 'DOWN_IS_GOOD'] as const;
export const KPI_PERIODS = ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'] as const;
export const KPI_SOURCES = ['DERIVED', 'MANUAL'] as const;

export type KpiUnitName = (typeof KPI_UNITS)[number];
export type KpiPeriodName = (typeof KPI_PERIODS)[number];

/**
 * Technischer Schlüssel, z. B. `revenue.net`. Er steht in Snapshots und in
 * Schlüsselergebnissen und ist deshalb nach dem Anlegen nicht mehr änderbar.
 */
export const kpiKeySchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)*$/,
    'Der Schlüssel besteht aus Kleinbuchstaben, Ziffern und Punkten, z. B. „revenue.net".',
  )
  .max(80);

const kpiValueSchema = z.number().min(-1e12).max(1e12);

export const createKpiDefinitionSchema = z.object({
  key: kpiKeySchema,
  label: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).optional(),
  group: z.string().trim().min(2).max(60).default('Finanzen'),
  unit: z.enum(KPI_UNITS).default('CURRENCY'),
  direction: z.enum(KPI_DIRECTIONS).default('UP_IS_GOOD'),
  /**
   * `MANUAL` für Zahlen, die die Anwendung nicht kennen kann — Website-
   * Sitzungen, Google-Bewertungsschnitt. `DERIVED` verlangt einen Rechner im
   * Dienst; ohne ihn wird die Definition beim Anlegen abgewiesen.
   */
  source: z.enum(KPI_SOURCES).default('MANUAL'),
  periods: z.array(z.enum(KPI_PERIODS)).min(1).max(5).default(['MONTH']),
  targetValue: kpiValueSchema.nullish(),
  warnValue: kpiValueSchema.nullish(),
  healthWeight: z.number().int().min(0).max(100).default(0),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});
export type CreateKpiDefinitionInput = z.infer<typeof createKpiDefinitionSchema>;

/** Der Schlüssel bleibt — er hängt an Snapshots und Schlüsselergebnissen. */
export const updateKpiDefinitionSchema = createKpiDefinitionSchema
  .omit({ key: true, source: true })
  .partial()
  .strict();
export type UpdateKpiDefinitionInput = z.infer<typeof updateKpiDefinitionSchema>;

export const kpiListQuery = z.object({
  group: z.string().trim().max(60).optional(),
  active: z.enum(['0', '1']).optional(),
  q: z.string().trim().max(120).optional(),
});

/** Verlauf einer Kennzahl — Snapshots einer Periodenart über einen Zeitraum. */
export const kpiSeriesQuery = z.object({
  period: z.enum(KPI_PERIODS).default('MONTH'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(120).default(24),
});
export type KpiSeriesQuery = z.infer<typeof kpiSeriesQuery>;

/** Manueller Wert — nur für Kennzahlen mit `source = MANUAL`. */
export const manualKpiValueSchema = z.object({
  period: z.enum(KPI_PERIODS).default('MONTH'),
  periodStart: dateOnlySchema,
  value: kpiValueSchema,
  note: z.string().trim().max(500).optional(),
});
export type ManualKpiValueInput = z.infer<typeof manualKpiValueSchema>;

/** Zielwert für eine bestimmte Periode — die Ausnahme vom Dauerwert. */
export const kpiTargetSchema = z.object({
  period: z.enum(KPI_PERIODS).default('MONTH'),
  periodStart: dateOnlySchema,
  targetValue: kpiValueSchema,
  note: z.string().trim().max(500).optional(),
});
export type KpiTargetInput = z.infer<typeof kpiTargetSchema>;

/** Gewichte im Gesundheitswert — mehrere Kennzahlen in einem Aufruf. */
export const healthWeightsSchema = z.object({
  weights: z
    .array(z.object({ key: kpiKeySchema, healthWeight: z.number().int().min(0).max(100) }))
    .min(1)
    .max(100),
});
export type HealthWeightsInput = z.infer<typeof healthWeightsSchema>;

/** Zeitraum für Cockpit und Kennzahlübersicht. */
export const cockpitQuery = z.object({
  period: z.enum(['MONTH', 'QUARTER', 'YEAR']).default('MONTH'),
});
