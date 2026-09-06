import { z } from 'zod';

import { cuidSchema } from './common';

/**
 * Eingaben der KI-Endpunkte.
 *
 * Die Obergrenzen sind keine Schikane, sondern Kostenkontrolle: jedes Zeichen
 * im Prompt kostet Token. `maxSentences`, `wordCount` und `maxLength` binden
 * ausserdem die *Ausgabe*, damit ein Modell nicht ungefragt drei Seiten
 * schreibt, wo drei Sätze verlangt waren.
 */

export const blogDraftSchema = z.object({
  topic: z.string().trim().min(5, 'Bitte nennen Sie ein Thema.').max(200),
  keywords: z.array(z.string().trim().max(60)).max(10).default([]),
  wordCount: z.number().int().min(300).max(2000).default(900),
});
export type BlogDraftInput = z.infer<typeof blogDraftSchema>;

export const dispatchSuggestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ungültiges Datum.'),
});
export type DispatchSuggestInput = z.infer<typeof dispatchSuggestSchema>;

export const emailDraftSchema = z.object({
  purpose: z.string().trim().min(3, 'Bitte nennen Sie den Zweck.').max(200),
  recipientName: z.string().trim().max(120).default('Kundin/Kunde'),
  context: z.string().trim().min(10, 'Bitte geben Sie etwas Kontext an.').max(4000),
  tone: z
    .enum(['freundlich', 'sachlich', 'entschuldigend', 'bestimmt', 'werblich'])
    .default('freundlich'),
});
export type EmailDraftInput = z.infer<typeof emailDraftSchema>;

/** Leistungsarten wie in `ServiceKind` — hier als eigenständige Liste, weil die
 *  Zod-Schicht nicht von Prisma abhängen soll. */
export const aiServiceKindEnum = z.enum([
  'OFFICE_CLEANING',
  'MOVE_OUT_CLEANING',
  'RESIDENTIAL_CLEANING',
  'WINDOW_CLEANING',
  'CONSTRUCTION_CLEANING',
  'BUILDING_MAINTENANCE',
  'SPECIAL',
]);

export const quoteDraftSchema = z.object({
  message: z.string().trim().min(10, 'Bitte beschreiben Sie die Anfrage.').max(4000),
  customerId: cuidSchema.optional(),
  leadId: cuidSchema.optional(),
  serviceKind: aiServiceKindEnum.optional(),
  propertyKind: z.string().max(40).optional(),
  squareMeters: z.number().int().min(5).max(20_000).optional(),
  rooms: z.number().min(0.5).max(200).optional(),
  windows: z.number().int().min(0).max(2000).optional(),
  frequency: z.string().max(20).optional(),
});
export type QuoteDraftInput = z.infer<typeof quoteDraftSchema>;

export const summarizeSchema = z.object({
  text: z.string().trim().min(40, 'Der Text ist zu kurz für eine Zusammenfassung.').max(40_000),
  focus: z.string().trim().max(200).optional(),
  maxSentences: z.number().int().min(2).max(15).default(6),
});
export type SummarizeInput = z.infer<typeof summarizeSchema>;

export const translateSchema = z.object({
  text: z.string().trim().min(3, 'Bitte geben Sie einen Text ein.').max(20_000),
  // Bewusst ohne Vorgabewert: „übersetzen wohin" ist die eigentliche Frage.
  targetLocale: z.enum(['DE', 'EN', 'FR', 'IT']),
  preserveFormatting: z.boolean().default(true),
});
export type TranslateInput = z.infer<typeof translateSchema>;

/**
 * Chat auf der Website.
 *
 * Der Verlauf reist bei jeder Frage mit und ist auf acht Beiträge begrenzt.
 * Serverseitige Sitzungen wären bequemer, aber ein anonymer Besucher soll
 * keinen Datensatz erzeugen, bevor er überhaupt etwas gebucht hat.
 */
export const chatSchema = z.object({
  message: z.string().trim().min(1, 'Bitte stellen Sie eine Frage.').max(500),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(4000),
      }),
    )
    .max(8)
    .default([]),
});
export type ChatInput = z.infer<typeof chatSchema>;
