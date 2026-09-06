import { z } from 'zod';

import { emailSchema, nameSchema, optionalPhoneSchema } from './common';

/**
 * Benutzerkonten.
 *
 * Entscheide:
 *
 *  • **Kein Passwortfeld.** Ein Konto wird per Einladung angelegt; die Person
 *    vergibt ihr Passwort selbst über einen einmaligen Link. Ein Feld, in das
 *    die Administration ein Startpasswort tippt, führt zwangsläufig dazu, dass
 *    dieses Passwort per E-Mail oder Chat weitergegeben wird — und dort
 *    liegenbleibt.
 *
 *  • **Die Rolle steht in einem eigenen Schema.** Sie zu ändern ist eine
 *    andere Handlung als Stammdaten zu pflegen: sie verlangt `role:assign`,
 *    die nur die Systemverantwortung hat. Wären beide im selben Schema, müsste
 *    der Endpunkt sie auseinanderdividieren — und würde es irgendwann
 *    vergessen.
 */

export const USER_ROLES = ['CUSTOMER', 'EMPLOYEE', 'MANAGER', 'ADMIN', 'SUPER_ADMIN'] as const;
export const USER_STATUS = ['PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED'] as const;

export const inviteUserSchema = z.object({
  email: emailSchema,
  firstName: nameSchema,
  lastName: nameSchema,
  phone: optionalPhoneSchema,
  role: z.enum(USER_ROLES),
  locale: z.enum(['DE', 'FR', 'IT', 'EN']).default('DE'),
});

export const updateUserSchema = z.object({
  firstName: nameSchema.optional(),
  lastName: nameSchema.optional(),
  phone: optionalPhoneSchema,
  email: emailSchema.optional(),
  locale: z.enum(['DE', 'FR', 'IT', 'EN']).optional(),
  /**
   * Sperren und Entsperren. `PENDING` fehlt bewusst: dieser Zustand entsteht
   * nur durch eine Einladung und lässt sich nicht von Hand herstellen.
   */
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']).optional(),
  notifyByEmail: z.boolean().optional(),
  notifyBySms: z.boolean().optional(),
});

/** Rollenwechsel — eigene Handlung, eigene Berechtigung. */
export const assignRoleSchema = z.object({
  role: z.enum(USER_ROLES),
});

export type InviteUserInput = z.infer<typeof inviteUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type AssignRoleInput = z.infer<typeof assignRoleSchema>;

export const USER_STATUS_LABELS: Record<(typeof USER_STATUS)[number], string> = {
  PENDING: 'Eingeladen',
  ACTIVE: 'Aktiv',
  SUSPENDED: 'Gesperrt',
  DISABLED: 'Deaktiviert',
};
