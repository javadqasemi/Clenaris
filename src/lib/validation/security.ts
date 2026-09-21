import { z } from 'zod';

/**
 * Schemata des Sicherheitszentrums.
 *
 * Die Aufzählungswerte stehen hier **ausgeschrieben** und nicht als
 * `z.nativeEnum(SecurityCategory)`. Das ist Absicht: Diese Datei speist auch
 * die OpenAPI-Beschreibung, und `nativeEnum` erzeugt dort eine Referenz auf
 * einen Prisma-Typ, den niemand ausserhalb dieses Projekts auflösen kann. Der
 * Preis ist eine Liste, die beim Erweitern des Aufzählungstyps mitgepflegt
 * werden muss — und den zahlt `npm run docs`, das die Abweichung meldet.
 */

export const securityCategorySchema = z.enum([
  'AUTHENTICATION',
  'SESSION',
  'ACCESS',
  'PUBLIC_LINK',
  'FILE',
  'SYSTEM',
]);

export const securitySeveritySchema = z.enum(['INFO', 'WARNING', 'CRITICAL']);

export const securityEventQuerySchema = z.object({
  category: securityCategorySchema.optional(),
  severity: securitySeveritySchema.optional(),
  /**
   * Als Zeichenkette, weil eine Abfragezeichenfolge nichts anderes kennt.
   * `'true'` und nichts sonst — ein `Boolean(wert)` hielte auch `'false'` für
   * wahr, und das ist der Fehler, der bei Filtern am längsten unbemerkt bleibt.
   */
  nurOffen: z.literal('true').optional(),
  userId: z.string().cuid().optional(),
  seite: z.coerce.number().int().min(1).optional(),
  proSeite: z.coerce.number().int().min(1).max(200).optional(),
});

export const acknowledgeEventSchema = z.object({
  /**
   * Was die bestätigende Person festgehalten hat. Freiwillig: Ein Zwang zur
   * Begründung führt zu „ok" in jedem Feld, und das ist schlechter als nichts,
   * weil es aussieht wie eine Einordnung.
   */
  note: z.string().trim().max(1000).optional(),
});

export type SecurityEventQuery = z.infer<typeof securityEventQuerySchema>;
export type AcknowledgeEventInput = z.infer<typeof acknowledgeEventSchema>;
