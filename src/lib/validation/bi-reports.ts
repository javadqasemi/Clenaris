import { z } from 'zod';

import { dateOnlySchema } from './common';
import { recipientListSchema } from './bi-knowledge';

/**
 * Wiederkehrende Führungsberichte.
 *
 * Der Zeitplan sagt, *wann* und *an wen*; der Inhalt ergibt sich aus der Art.
 * Erzeugt wird über den bestehenden Nachtlauf — ein eigener Scheduler wäre
 * eine zweite Zeitquelle mit eigenen Ausfallarten.
 */

export const REPORT_KINDS = [
  'BUSINESS_PERFORMANCE',
  'FINANCIAL',
  'MARKETING',
  'SALES',
  'EMPLOYEE',
  'CUSTOMER',
  'QUARTERLY_REVIEW',
] as const;
export const REPORT_CADENCES = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'] as const;
export const REPORT_FORMATS = ['PDF', 'XLSX', 'DOCX'] as const;

export const createReportScheduleSchema = z.object({
  name: z.string().trim().min(2).max(120),
  kind: z.enum(REPORT_KINDS).default('BUSINESS_PERFORMANCE'),
  cadence: z.enum(REPORT_CADENCES).default('MONTHLY'),
  format: z.enum(REPORT_FORMATS).default('PDF'),
  /**
   * Bei wöchentlichem Takt der Wochentag (1 = Montag … 7 = Sonntag), sonst
   * der Tag im Monat. Der 28. ist die Obergrenze, damit der Februar nicht
   * ausfällt.
   */
  runOnDay: z.number().int().min(1).max(28).default(1),
  recipients: recipientListSchema.default([]),
  active: z.boolean().default(true),
});
export type CreateReportScheduleInput = z.infer<typeof createReportScheduleSchema>;

export const updateReportScheduleSchema = createReportScheduleSchema.partial().strict();
export type UpdateReportScheduleInput = z.infer<typeof updateReportScheduleSchema>;

/** Bericht ausserplanmässig erzeugen. */
export const generateReportSchema = z
  .object({
    kind: z.enum(REPORT_KINDS),
    format: z.enum(REPORT_FORMATS).default('PDF'),
    periodStart: dateOnlySchema,
    periodEnd: dateOnlySchema,
  })
  .refine((d) => d.periodEnd > d.periodStart, {
    message: 'Das Ende des Zeitraums muss nach dem Beginn liegen.',
    path: ['periodEnd'],
  });
export type GenerateReportInput = z.infer<typeof generateReportSchema>;

export const reportListQuery = z.object({
  kind: z.enum(REPORT_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
