import { z } from 'zod';
import type { NavLocation } from '@prisma/client';

import { ctaHrefSchema } from './cta';

/**
 * Navigation und Rechtstexte.
 *
 * Das Ziel eines Menüpunkts wird gegen dieselbe Positivliste geprüft wie ein
 * Handlungsaufruf — aus demselben Grund: der Wert wird von einer Person
 * eingetippt und landet unverändert in einem `href`. Ein Menüpunkt mit
 * `javascript:`-Ziel wäre auf jeder Seite der Website vorhanden, nicht nur auf
 * einer.
 */

export const NAV_LOCATIONS = [
  'HEADER',
  'HEADER_PANEL',
  'FOOTER_SERVICES',
  'FOOTER_COMPANY',
  'FOOTER_LEGAL',
] as const;

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const NAV_ENUMS_IN_SYNC: [Exact<NavLocation, (typeof NAV_LOCATIONS)[number]>] = [true];

const navFields = {
  location: z.enum(NAV_LOCATIONS),
  label: z
    .string()
    .trim()
    .min(2, 'Eine Beschriftung ist erforderlich.')
    .max(40, 'Zu lang — ein Menüpunkt muss in eine Zeile passen.'),
  href: ctaHrefSchema,
  description: z
    .string()
    .trim()
    .max(120, 'Die Erläuterung ist zu lang.')
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  icon: z
    .string()
    .trim()
    .max(40)
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  newTab: z.boolean().default(false),
  parentId: z.string().min(1).optional().nullable(),
  position: z.number().int().min(0).max(999).default(0),
  active: z.boolean().default(true),
};

/**
 * Ein Aufklappbereich braucht einen übergeordneten Punkt, alle anderen Orte
 * dürfen keinen haben.
 *
 * Ohne diese Regel entstünde ein Menüpunkt, der in `HEADER_PANEL` liegt, aber
 * an keinem Aufklapper hängt — er wäre gespeichert und nirgends sichtbar.
 */
function navRules(
  value: { location?: (typeof NAV_LOCATIONS)[number]; parentId?: string | null },
  ctx: z.RefinementCtx,
) {
  if (value.location === 'HEADER_PANEL' && !value.parentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['parentId'],
      message: 'Ein Punkt im Aufklappbereich braucht einen übergeordneten Eintrag der Kopfzeile.',
    });
  }
  if (value.location && value.location !== 'HEADER_PANEL' && value.parentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['parentId'],
      message: 'Nur Punkte im Aufklappbereich hängen an einem übergeordneten Eintrag.',
    });
  }
}

export const createNavItemSchema = z.object(navFields).superRefine(navRules);
export const updateNavItemSchema = z.object(navFields).partial().superRefine(navRules);

export type CreateNavItemInput = z.infer<typeof createNavItemSchema>;
export type UpdateNavItemInput = z.infer<typeof updateNavItemSchema>;

export const navReorderSchema = z.object({
  location: z.enum(NAV_LOCATIONS),
  /** Nur bei HEADER_PANEL gesetzt. */
  parentId: z.string().min(1).optional().nullable(),
  ids: z.array(z.string().min(1)).min(1).max(100),
});

export type NavReorderInput = z.infer<typeof navReorderSchema>;

export const NAV_LOCATION_LABELS: Record<(typeof NAV_LOCATIONS)[number], string> = {
  HEADER: 'Kopfzeile',
  HEADER_PANEL: 'Aufklappbereich der Kopfzeile',
  FOOTER_SERVICES: 'Fusszeile · Leistungen',
  FOOTER_COMPANY: 'Fusszeile · Unternehmen',
  FOOTER_LEGAL: 'Fusszeile · Rechtliches',
};

// ---------------------------------------------------------------------------
//  Rechtstexte
// ---------------------------------------------------------------------------

/**
 * Die vier Rechtstexte, die es auf einer Schweizer Geschäftswebsite braucht.
 *
 * Feste Liste statt freier Kurznamen: die Adressen sind verlinkt — aus der
 * Fusszeile, aus dem Cookie-Hinweis, aus E-Mails und aus dem
 * Buchungsformular. Ein frei gewählter Kurzname erzeugte eine Seite, auf die
 * nichts zeigt.
 */
export const LEGAL_SLUGS = ['impressum', 'datenschutz', 'agb', 'cookies'] as const;

export const LEGAL_LABELS: Record<(typeof LEGAL_SLUGS)[number], string> = {
  impressum: 'Impressum',
  datenschutz: 'Datenschutzerklärung',
  agb: 'Allgemeine Geschäftsbedingungen',
  cookies: 'Cookie-Hinweis',
};

export const updateLegalSchema = z.object({
  title: z.string().trim().min(3, 'Ein Titel ist erforderlich.').max(140),
  body: z
    .string()
    .trim()
    .min(100, 'Ein Rechtstext unter 100 Zeichen ist mit Sicherheit unvollständig.')
    .max(100_000),
  /**
   * Das Inkrafttreten. Es steht auf der Seite und ist der Bezugspunkt, wenn
   * jemand fragt, welcher Fassung er zugestimmt hat.
   */
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Bitte ein Datum im Format JJJJ-MM-TT.'),
  /**
   * true = inhaltliche Änderung, die Fassungsnummer zählt hoch.
   *
   * Bewusst eine Entscheidung der Redaktion und keine Automatik: eine
   * korrigierte Kommasetzung ist keine neue Fassung, eine geänderte
   * Aufbewahrungsfrist schon. Nur ein Mensch kann das unterscheiden.
   */
  newVersion: z.boolean().default(false),
});

export type UpdateLegalInput = z.infer<typeof updateLegalSchema>;
