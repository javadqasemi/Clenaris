import { z } from 'zod';

/**
 * Datenbereinigung — endgültiges Löschen ganzer Datenbereiche.
 *
 * Die Bereichsschlüssel stehen hier und nicht im Dienst, weil Formular und
 * Endpunkt dieselbe Liste brauchen: das Formular baut daraus die Auswahl,
 * der Endpunkt weist alles andere als 422 zurück. Beschriftung, Reihenfolge
 * und die eigentlichen Löschschritte gehören dem Dienst (`purge.service.ts`).
 */
export const PURGE_AREA_KEYS = [
  'finanzen',
  'auftraege',
  'crm',
  'kommunikation',
  'website',
  'fuehrung',
  'personal',
] as const;

export type PurgeAreaKey = (typeof PURGE_AREA_KEYS)[number];

/**
 * Der Satz, den die Systemverantwortung eintippen muss. Kein Häkchen, keine
 * Rückfrage im Dialog — ein Häkchen setzt man aus Gewohnheit, einen Satz
 * tippt man mit Absicht.
 */
export const PURGE_CONFIRMATION = 'ALLES LÖSCHEN';

export const purgeSchema = z.object({
  bereiche: z
    .array(z.enum(PURGE_AREA_KEYS))
    .min(1, 'Wählen Sie mindestens einen Bereich.')
    .transform((areas) => [...new Set(areas)]),
  bestaetigung: z
    .string()
    .trim()
    .refine((value) => value === PURGE_CONFIRMATION, {
      message: `Zur Bestätigung muss genau «${PURGE_CONFIRMATION}» eingegeben werden.`,
    }),
  /**
   * Nummernkreise der geleerten Bereiche neu beginnen lassen. Vor dem
   * Livegang gewollt (die erste echte Rechnung soll 00001 heissen), im
   * laufenden Betrieb nicht — Art. 957a OR verlangt eine lückenlose Folge.
   */
  nummernkreiseZuruecksetzen: z.boolean().default(false),
});

export type PurgeInput = z.infer<typeof purgeSchema>;
