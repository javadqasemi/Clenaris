import { z } from 'zod';

/**
 * Gemeinsame Bausteine. Jede Fehlermeldung ist auf Deutsch formuliert und wird
 * unverändert im Formular angezeigt — dadurch bleiben Client- und Server-
 * Validierung wortgleich.
 */

export const emailSchema = z
  .string()
  .trim()
  .min(1, 'E-Mail-Adresse ist erforderlich.')
  .max(255, 'E-Mail-Adresse ist zu lang.')
  .email('Bitte geben Sie eine gültige E-Mail-Adresse ein.')
  .toLowerCase();

/** Schweizer und internationale Nummern (E.164-fähig). */
export const phoneSchema = z
  .string()
  .trim()
  .regex(
    /^(\+|00)?[0-9\s().-]{9,20}$/,
    'Bitte geben Sie eine gültige Telefonnummer ein (z. B. 079 123 45 67).',
  );

export const optionalPhoneSchema = z
  .union([phoneSchema, z.literal('')])
  .optional()
  .transform((v) => (v === '' ? undefined : v));

export const passwordSchema = z
  .string()
  .min(10, 'Das Passwort muss mindestens 10 Zeichen lang sein.')
  .max(128, 'Das Passwort darf höchstens 128 Zeichen lang sein.')
  .regex(/[A-Z]/, 'Das Passwort muss mindestens einen Grossbuchstaben enthalten.')
  .regex(/[a-z]/, 'Das Passwort muss mindestens einen Kleinbuchstaben enthalten.')
  .regex(/[0-9]/, 'Das Passwort muss mindestens eine Ziffer enthalten.');

/** Schweizer PLZ: 1000–9999. */
export const postalCodeSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{3}$/, 'Bitte geben Sie eine gültige Schweizer Postleitzahl ein.');

export const nameSchema = z
  .string()
  .trim()
  .min(2, 'Bitte geben Sie mindestens 2 Zeichen ein.')
  .max(80, 'Der Eintrag ist zu lang (max. 80 Zeichen).');

export const cuidSchema = z.string().min(1, 'Ungültige ID.');

export const moneySchema = z
  .number()
  .min(0, 'Der Betrag darf nicht negativ sein.')
  .max(9_999_999, 'Der Betrag ist zu gross.')
  .multipleOf(0.01, 'Maximal zwei Nachkommastellen.');

export const percentSchema = z
  .number()
  .min(0, 'Der Wert darf nicht negativ sein.')
  .max(100, 'Der Wert darf 100 % nicht überschreiten.');

export const localeSchema = z.enum(['DE', 'EN', 'FR', 'IT']).default('DE');

export const addressSchema = z.object({
  label: z.string().trim().max(60).optional(),
  street: z.string().trim().min(2, 'Strasse ist erforderlich.').max(120),
  streetNo: z.string().trim().max(20).optional(),
  addition: z.string().trim().max(120).optional(),
  postalCode: postalCodeSchema,
  city: z.string().trim().min(2, 'Ort ist erforderlich.').max(80),
  canton: z.string().trim().length(2).default('BE'),
  country: z.string().trim().length(2).default('CH'),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  placeId: z.string().max(200).optional(),
  accessNote: z.string().trim().max(500).optional(),
});

/**
 * Honeypot-Feld gegen Formular-Bots: echte Nutzer füllen es nie aus.
 * Wird zusammen mit Rate-Limiting eingesetzt — kein CAPTCHA nötig.
 */
export const honeypotSchema = z
  .string()
  .max(0, 'Ungültige Anfrage.')
  .optional()
  .or(z.literal(''));

export const consentSchema = z.literal(true, {
  errorMap: () => ({ message: 'Bitte stimmen Sie der Datenschutzerklärung zu.' }),
});

/** Datum als ISO-String vom Client, in ein Date-Objekt konvertiert. */
export const isoDateSchema = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
  .transform((v) => new Date(v));

export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Bitte geben Sie ein gültiges Datum an (JJJJ-MM-TT).')
  .transform((v) => new Date(`${v}T00:00:00.000Z`));

/** "08:30" */
export const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Bitte geben Sie eine gültige Uhrzeit an (HH:MM).');
