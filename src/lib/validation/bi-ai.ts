import { z } from 'zod';

import { cuidSchema, dateOnlySchema } from './common';

/**
 * Der Führungsassistent.
 *
 * Ein Endpunkt, mehrere Fähigkeiten — unterschieden über `kind`. Jede
 * liefert einen *Entwurf* mit Begründung, Datenquelle und Vertrauensgrad;
 * keine schreibt in Ziele, Risiken oder Budgets. Das Muster ist das der
 * bestehenden KI-Endpunkte: die KI schlägt vor, ein Mensch entscheidet.
 */
export const biAssistantSchema = z.discriminatedUnion('kind', [
  /** Zeitraum in Prosa zusammenfassen — Kennzahlen, Auffälligkeiten, Empfehlungen. */
  z.object({
    kind: z.literal('summarizePeriod'),
    from: dateOnlySchema,
    to: dateOnlySchema,
    /** Freitextfrage an die Zahlen, etwa „Warum ist die Marge gesunken?". */
    question: z.string().trim().max(1000).optional(),
  }),
  /** SWOT-Entwurf aus Kennzahlen, Wettbewerbern und Marktbeobachtungen. */
  z.object({ kind: z.literal('draftSwot') }),
  /** PESTEL-Entwurf aus den Marktbeobachtungen. */
  z.object({ kind: z.literal('draftPestel') }),
  /** Risikovorschläge aus Kennzahlverlauf, Register und offenen Massnahmen. */
  z.object({ kind: z.literal('suggestRisks') }),
  /** Budgetabweichung erklären. */
  z.object({ kind: z.literal('explainVariance'), budgetId: cuidSchema }),
  /** Rohnotizen zu einem Protokoll mit Beschlüssen und Pendenzen. */
  z.object({
    kind: z.literal('meetingMinutes'),
    notes: z.string().trim().min(20).max(20_000),
    title: z.string().trim().max(200).optional(),
  }),
  /** Quartalsrückblick aus Zielen, Check-ins und Snapshots. */
  z.object({
    kind: z.literal('quarterlyReview'),
    fiscalYear: z.number().int().min(2000).max(2100),
    quarter: z.number().int().min(1).max(4),
  }),
  /** Kundenfeedback (Bewertungen) eines Zeitraums auswerten. */
  z.object({ kind: z.literal('analyzeFeedback'), from: dateOnlySchema, to: dateOnlySchema }),
  /** Marketingvorschläge aus Leadquellen, Konversion und Kosten je Lead. */
  z.object({ kind: z.literal('marketingIdeas') }),
]);
export type BiAssistantInput = z.infer<typeof biAssistantSchema>;
