import { z } from 'zod';

/**
 * Betriebseinstellungen.
 *
 * Sie liegen im JSON-Feld `Organization.settings` und nicht in eigenen
 * Spalten: Es sind Schalter, die sich häufiger ändern als das Schema, und
 * jeder von ihnen bräuchte sonst eine Migration.
 *
 * Das Schema ist trotzdem streng. Ein freies JSON-Feld ohne Prüfung wäre die
 * Stelle, an der ein Tippfehler im Schlüssel eine Einstellung stillschweigend
 * wirkungslos macht — der Fehler, den man erst Wochen später bemerkt, wenn
 * keine Mahnung mehr rausgeht.
 *
 * Schema *und* Standardwerte stehen hier, damit Endpunkt, Maske und Doku
 * dieselbe Quelle haben. Getrennt wären sie beim ersten neuen Schalter
 * auseinandergelaufen.
 */

export const operationSettingsSchema = z
  .object({
  /** Wie viele Tage im Voraus gebucht werden kann. */
  bookingLeadDays: z.number().int().min(0).max(365),
  /** Wie kurzfristig eine Buchung noch möglich ist, in Stunden. */
  bookingMinNoticeHours: z.number().int().min(0).max(720),
  /** Ab wann eine Stornierung kostenpflichtig wird, in Stunden. */
  cancellationDeadlineHours: z.number().int().min(0).max(720),
  /** Automatische Terminerinnerung per SMS. */
  smsRemindersEnabled: z.boolean(),
  /** Mahnläufe automatisch starten. */
  autoDunningEnabled: z.boolean(),
  /** Tage bis zur ersten Mahnung nach Fälligkeit. */
  firstReminderAfterDays: z.number().int().min(1).max(90),
  /** Bewertungsanfrage nach abgeschlossenem Einsatz, in Tagen. */
  reviewRequestAfterDays: z.number().int().min(0).max(90),
    /** Neue Bewertungen erst nach Freigabe anzeigen. */
    moderateReviews: z.boolean(),
  })
  /**
   * `strict`, nicht das voreingestellte Abschneiden.
   *
   * Zod wirft unbekannte Schlüssel sonst stillschweigend weg. Genau dann macht
   * ein Tippfehler — `moderatReviews` statt `moderateReviews` — die Einstellung
   * wirkungslos, und niemand merkt es, weil die Antwort 200 lautet. Das ist der
   * Fehler, den man Wochen später bemerkt, wenn eine Bewertung ungeprüft auf
   * der Website steht.
   */
  .strict();

/** Für den Endpunkt: gesendet wird nur, was sich ändert. */
export const updateOperationSettingsSchema = operationSettingsSchema.partial().strict();

export type OperationSettings = z.infer<typeof operationSettingsSchema>;

/**
 * Auslieferungswerte.
 *
 * Ein fehlender Schlüssel ist kein Fehler, sondern der Wert, mit dem das
 * System ausgeliefert wurde — sonst müsste jede neue Einstellung rückwirkend
 * in jede bestehende Organisation geschrieben werden.
 */
export const OPERATION_SETTINGS_DEFAULTS: OperationSettings = {
  bookingLeadDays: 90,
  bookingMinNoticeHours: 24,
  cancellationDeadlineHours: 48,
  smsRemindersEnabled: true,
  autoDunningEnabled: true,
  firstReminderAfterDays: 10,
  reviewRequestAfterDays: 2,
  moderateReviews: true,
};

// ---------------------------------------------------------------------------
//  Feiertage
// ---------------------------------------------------------------------------

/**
 * Feiertage und Betriebsferien.
 *
 * Ein Feiertag sperrt den Buchungsassistenten für diesen Tag und zählt bei
 * Abwesenheiten nicht als Ferientag — er wirkt also auf zwei Stellen, die
 * beide still falsch rechnen, wenn er fehlt. Bis hierher liess er sich nur
 * über den Seed pflegen; der Ostermontag des nächsten Jahres brauchte einen
 * Entwicklungseinsatz.
 *
 * Das Datum ist ein Kalendertag ohne Uhrzeit (`JJJJ-MM-TT`): `Holiday.date`
 * ist eine `@db.Date`-Spalte, und ein Zeitstempel mit Zeitzone würde je nach
 * Server um einen Tag verrutschen.
 */
const holidayFields = {
  name: z.string().trim().min(2, 'Bitte benennen Sie den Feiertag.').max(80),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Bitte ein Datum im Format JJJJ-MM-TT.')
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Ungültiges Datum.'),
  /** true = jedes Jahr am selben Kalendertag (Neujahr, Nationalfeiertag). */
  recurring: z.boolean().default(false),
  canton: z
    .string()
    .trim()
    .length(2, 'Zwei Buchstaben, z. B. BE.')
    .toUpperCase()
    .optional()
    .nullable(),
};

export const createHolidaySchema = z.object(holidayFields);
export const updateHolidaySchema = z.object(holidayFields).partial();

export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;
export type UpdateHolidayInput = z.infer<typeof updateHolidaySchema>;

/** Gespeicherten Stand mit den Auslieferungswerten auffüllen. */
export function withSettingsDefaults(stored: unknown): OperationSettings {
  return {
    ...OPERATION_SETTINGS_DEFAULTS,
    ...((stored as Partial<OperationSettings> | null) ?? {}),
  };
}
