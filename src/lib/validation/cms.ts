import { z } from 'zod';

import { CONTENT_KEYS, SEO_PAGES, definitionFor } from '@/lib/cms/registry';

/**
 * Prüfregeln für die Inhaltspflege.
 *
 * Die Längenbegrenzungen kommen aus dem Register, nicht aus dieser Datei —
 * sonst gäbe es zwei Wahrheiten darüber, wie lang eine Überschrift sein darf.
 */

const contentValue = z.union([z.string(), z.array(z.string())]);

export const updateContentSchema = z.object({
  entries: z
    .array(
      z.object({
        key: z.string().min(1),
        value: contentValue,
      }),
    )
    .min(1, 'Es wurde nichts geändert.')
    .max(80),
});
export type UpdateContentInput = z.infer<typeof updateContentSchema>;

/**
 * Prüft die Werte gegen das Register.
 *
 * Bewusst als eigene Funktion statt als `superRefine`: der Aufrufer bekommt
 * die Fehler feldweise zurück und kann sie an der richtigen Eingabe anzeigen.
 */
export function validateEntries(
  entries: { key: string; value: string | string[] }[],
): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];

  for (const entry of entries) {
    const definition = definitionFor(entry.key);

    if (!definition) {
      errors.push({ field: entry.key, message: 'Unbekannter Inhaltsbaustein.' });
      continue;
    }

    if (definition.kind === 'list') {
      if (!Array.isArray(entry.value)) {
        errors.push({ field: entry.key, message: 'Hier wird eine Liste erwartet.' });
        continue;
      }
      if (definition.maxItems && entry.value.length > definition.maxItems) {
        errors.push({
          field: entry.key,
          message: `Höchstens ${definition.maxItems} Einträge.`,
        });
      }
      for (const item of entry.value) {
        if (definition.maxLength && item.length > definition.maxLength) {
          errors.push({
            field: entry.key,
            message: `Ein Eintrag ist länger als ${definition.maxLength} Zeichen.`,
          });
          break;
        }
      }
      continue;
    }

    if (typeof entry.value !== 'string') {
      errors.push({ field: entry.key, message: 'Hier wird ein Text erwartet.' });
      continue;
    }
    if (definition.maxLength && entry.value.length > definition.maxLength) {
      errors.push({
        field: entry.key,
        message: `Höchstens ${definition.maxLength} Zeichen — aktuell ${entry.value.length}.`,
      });
    }
  }

  return errors;
}

/** Die Schlüssel als Aufzählung — nutzbar für strengere Teilschemata. */
export const contentKeyEnum = z.enum(CONTENT_KEYS as [string, ...string[]]);

// ---------------------------------------------------------------------------
//  Suchmaschinen-Angaben
// ---------------------------------------------------------------------------

const SEO_PATHS = SEO_PAGES.map((page) => page.path) as [string, ...string[]];

export const updateSeoSchema = z.object({
  path: z.enum(SEO_PATHS),
  /**
   * Google schneidet Titel bei etwa 60 und Beschreibungen bei etwa 155
   * Zeichen ab. Die Grenzen sind grosszügiger gesetzt — die Redaktion wird
   * gewarnt, nicht gehindert.
   */
  title: z.string().trim().max(120).optional(),
  description: z.string().trim().max(320).optional(),
  keywords: z.array(z.string().trim().min(2).max(60)).max(15).default([]),
  ogImageUrl: z.string().url().max(500).optional().or(z.literal('')),
  noIndex: z.boolean().default(false),
});
export type UpdateSeoInput = z.infer<typeof updateSeoSchema>;

// ---------------------------------------------------------------------------
//  Stammdaten und Auftrittskanäle
// ---------------------------------------------------------------------------

const optionalUrl = z.string().url().max(300).optional().or(z.literal(''));

export const updateCompanySchema = z.object({
  name: z.string().trim().min(2).max(140),
  legalName: z.string().trim().max(180).optional().or(z.literal('')),
  email: z.string().email().max(200),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  whatsapp: z.string().trim().max(40).optional().or(z.literal('')),
  website: optionalUrl,

  street: z.string().trim().min(2).max(140),
  streetNo: z.string().trim().max(20).optional().or(z.literal('')),
  postalCode: z.string().regex(/^[1-9]\d{3}$/, 'Ungültige Postleitzahl.'),
  city: z.string().trim().min(2).max(80),

  vatNumber: z.string().trim().max(40).optional().or(z.literal('')),
  iban: z.string().trim().max(40).optional().or(z.literal('')),
  qrIban: z.string().trim().max(40).optional().or(z.literal('')),
  bankName: z.string().trim().max(120).optional().or(z.literal('')),

  logoUrl: optionalUrl,
  logoDarkUrl: optionalUrl,
  faviconUrl: optionalUrl,

  mapsUrl: optionalUrl,
  facebookUrl: optionalUrl,
  instagramUrl: optionalUrl,
  linkedinUrl: optionalUrl,
  tiktokUrl: optionalUrl,
  youtubeUrl: optionalUrl,
});
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;
