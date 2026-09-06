import { z } from 'zod';
import {
  consentSchema,
  emailSchema,
  honeypotSchema,
  localeSchema,
  nameSchema,
  optionalPhoneSchema,
  passwordSchema,
} from './common';

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Bitte geben Sie Ihr Passwort ein.'),
  rememberMe: z.boolean().default(false),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = z
  .object({
    firstName: nameSchema,
    lastName: nameSchema,
    email: emailSchema,
    phone: optionalPhoneSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    locale: localeSchema,
    acceptTerms: consentSchema,
    marketingOptIn: z.boolean().default(false),
    website: honeypotSchema, // Honeypot
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Die Passwörter stimmen nicht überein.',
    path: ['confirmPassword'],
  });
export type RegisterInput = z.infer<typeof registerSchema>;

export const forgotPasswordSchema = z.object({
  email: emailSchema,
  website: honeypotSchema,
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    token: z.string().min(10, 'Ungültiger Link.'),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Die Passwörter stimmen nicht überein.',
    path: ['confirmPassword'],
  });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Bitte geben Sie Ihr aktuelles Passwort ein.'),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Die Passwörter stimmen nicht überein.',
    path: ['confirmPassword'],
  })
  .refine((data) => data.currentPassword !== data.password, {
    message: 'Das neue Passwort muss sich vom bisherigen unterscheiden.',
    path: ['password'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const updateProfileSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  phone: optionalPhoneSchema,
  locale: localeSchema.optional(),
  avatarUrl: z.string().url().optional().or(z.literal('')),
  theme: z.enum(['system', 'light', 'dark']).optional(),
  notifyByEmail: z.boolean().optional(),
  notifyBySms: z.boolean().optional(),
  marketingOptIn: z.boolean().optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const verifyEmailSchema = z.object({
  token: z.string().min(10, 'Ungültiger Bestätigungslink.'),
});

export const inviteUserSchema = z.object({
  email: emailSchema,
  firstName: nameSchema,
  lastName: nameSchema,
  role: z.enum(['ADMIN', 'MANAGER', 'EMPLOYEE', 'CUSTOMER']),
  locale: localeSchema,
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

/**
 * Ein Endpunkt für „Passwort vergessen", „Passwort neu setzen" und
 * „Einladung annehmen", unterschieden über `action`.
 *
 * Bewusst ein flaches Schema mit `superRefine` statt einer diskriminierten
 * Union: Zod kann `discriminatedUnion` nicht mit Zweigen kombinieren, die
 * selbst ein `.refine()` tragen — und die Passwortwiederholung ist genau
 * das. Die Feldprüfung pro Aktion delegiert deshalb an die jeweiligen
 * Einzelschemas.
 */
export const passwordActionSchema = z
  .object({
    action: z.enum(['forgot', 'reset', 'invite']),
    email: z.string().optional(),
    token: z.string().optional(),
    password: z.string().optional(),
    confirmPassword: z.string().optional(),
    website: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const result =
      data.action === 'forgot'
        ? forgotPasswordSchema.safeParse(data)
        : resetPasswordSchema.safeParse(data);

    if (!result.success) {
      for (const issue of result.error.issues) ctx.addIssue(issue);
    }
  });
export type PasswordActionInput = z.infer<typeof passwordActionSchema>;

/* -------------------------------------------------------------------------
 *  Zwei-Faktor-Anmeldung
 * ---------------------------------------------------------------------- */

/**
 * Der sechsstellige Code aus der App.
 *
 * Streng auf sechs Ziffern: hier wird nichts anderes akzeptiert, weil ein
 * abweichendes Format immer ein Tippfehler ist und die Meldung dann sagen
 * kann, was fehlt — statt den Versuch gegen das Anmelde-Limit zu zählen.
 */
export const twoFactorConfirmSchema = z.object({
  token: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Bitte die sechs Ziffern aus der App eingeben.'),
});
export type TwoFactorConfirmInput = z.infer<typeof twoFactorConfirmSchema>;

/**
 * Code **oder** Wiederherstellungscode.
 *
 * Beide Formen teilen sich ein Feld, weil die Person im Ernstfall nicht
 * zwischen zwei Eingabefeldern wählen soll. Die Unterscheidung trifft der
 * Dienst anhand der Form.
 */
export const twoFactorTokenSchema = z.object({
  token: z
    .string()
    .trim()
    .min(6, 'Bitte den Code eingeben.')
    .max(20, 'Der Code ist höchstens 20 Zeichen lang.'),
});
export type TwoFactorTokenInput = z.infer<typeof twoFactorTokenSchema>;

/** Ausschalten verlangt Passwort **und** Code. */
export const twoFactorDisableSchema = twoFactorTokenSchema.extend({
  password: z.string().min(1, 'Das Passwort ist erforderlich.'),
});
export type TwoFactorDisableInput = z.infer<typeof twoFactorDisableSchema>;
