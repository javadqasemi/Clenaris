import { z } from 'zod';

/**
 * Globale Suche (Wave 17). Mindestens zwei Zeichen — ein einzelner Buchstabe
 * träfe alles und sagte nichts; höchstens 80, weil niemand länger sucht.
 */
export const globalSearchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Mindestens zwei Zeichen.').max(80),
});
