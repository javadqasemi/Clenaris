import { z } from 'zod';

/** Abfrage des Zustellprotokolls (Wave 14). */
export const zustellprotokollQuerySchema = z.object({
  kanal: z.enum(['email', 'sms']).default('email'),
  status: z.string().trim().max(40).optional(),
  suche: z.string().trim().max(120).optional(),
  tage: z.coerce.number().int().min(1).max(365).default(30),
});
