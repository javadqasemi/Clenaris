import { z } from 'zod';

import { cuidSchema } from './common';

/**
 * Nachrichten zwischen Kundschaft und Betrieb.
 *
 * Threads statt Einzelnachrichten: eine Rückfrage zu einer Buchung soll auch
 * drei Wochen später noch im Zusammenhang lesbar sein. Der Betreff ist deshalb
 * Pflicht — er ist die Überschrift der Akte, nicht Zierde.
 */
export const createThreadSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(3, 'Bitte geben Sie einen Betreff an.')
    .max(160, 'Der Betreff ist zu lang.'),
  body: z
    .string()
    .trim()
    .min(5, 'Bitte schreiben Sie mindestens fünf Zeichen.')
    .max(5000, 'Die Nachricht ist zu lang.'),
  bookingId: cuidSchema.optional(),
  jobId: cuidSchema.optional(),
});
export type CreateThreadInput = z.infer<typeof createThreadSchema>;

export const replyMessageSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Die Nachricht darf nicht leer sein.')
    .max(5000, 'Die Nachricht ist zu lang.'),
  /** Anhänge werden vorab direkt zu Supabase geladen, hier kommen nur die IDs an. */
  fileIds: z.array(cuidSchema).max(5).optional(),
  /** Nur Mitarbeitende: schliesst den Thread mit der Antwort ab. */
  close: z.boolean().optional(),
});
export type ReplyMessageInput = z.infer<typeof replyMessageSchema>;
