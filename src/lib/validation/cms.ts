import { z } from 'zod';

import { CONTENT_KEYS, SEO_PAGES, definitionFor } from '@/lib/cms/registry';

import { assetUrlSchema } from './common';

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

/**
 * Freigeben, verwerfen, zurückziehen — die Handlung steht im Körper.
 *
 * Drei Handlungen in einem Endpunkt, weil sie denselben Gegenstand betreffen
 * und dieselbe Berechtigung verlangen. Ein `POST /api/content/publish` neben
 * `/api/content/discard` hätte drei fast gleiche Dateien ergeben.
 */
export const contentActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('publish'),
    /** Ohne Angabe: alle offenen Entwürfe. */
    keys: z.array(z.string().max(120)).max(500).optional(),
  }),
  z.object({
    action: z.literal('discard'),
    keys: z.array(z.string().max(120)).max(500).optional(),
  }),
  z.object({
    action: z.literal('unpublish'),
    key: z.string().min(1).max(120),
  }),
]);
export type ContentActionInput = z.infer<typeof contentActionSchema>;

/** Fassungsverlauf eines Bausteins abfragen. */
export const contentRevisionsQuery = z.object({ key: z.string().min(1).max(120) });

/** Eine frühere Fassung als Entwurf zurückholen. */
export const restoreRevisionSchema = z.object({ revisionId: z.string().min(1) });

/**
 * Vorschaumodus ein- oder ausschalten.
 *
 * `pfad` ist ein Rücksprungziel und wird im Endpunkt zusätzlich durch
 * `safeReturnPath` geprüft — das Schema begrenzt nur die Länge.
 */
export const previewQuery = z.object({
  pfad: z.string().max(512).optional(),
  aus: z.enum(['1']).optional(),
  nur: z.enum(['1']).optional(),
});

/**
 * Ein Bild an seinem Datensatz austauschen (aus der Website-Vorschau).
 *
 * `entity` und `field` sind absichtlich freie Zeichenketten: Welche Paare
 * erlaubt sind, entscheidet die Erlaubnisliste in `lib/cms/assets.ts` auf dem
 * Server. Ein Enum hier wäre eine zweite Kopie derselben Liste.
 *
 * `url: null` entfernt das Bild. Das ist bewusst möglich: Ein falsches Bild
 * ist schlimmer als gar keines, und die Seite kommt mit einem Platzhalter
 * zurecht.
 */
export const assetFieldSchema = z.object({
  entity: z.string().min(1).max(40),
  id: z.string().min(1).max(60),
  field: z.string().min(1).max(40),
  url: assetUrlSchema.nullable(),
});
export type AssetFieldInput = z.infer<typeof assetFieldSchema>;

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

/**
 * Freiwillige Adresse.
 *
 * `nullable()` ist hier nicht Bequemlichkeit: die Datenbank speichert leere
 * Felder als NULL, und `GET /api/company` gibt sie so zurück. Ohne das
 * scheiterte ein Formular, das die Firmendaten lädt und unverändert
 * zurückspeichert, an jedem leeren Feld — und niemand hätte etwas falsch
 * gemacht. Der Dienst wandelt leere Werte anschliessend wieder in NULL.
 */
const optionalUrl = z
  .union([z.string().url().max(300), z.literal(''), z.null()])
  .optional()
  .transform((v) => v ?? undefined);

/** Freiwilliges Textfeld — dieselbe Überlegung wie bei `optionalUrl`. */
const optionalText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.literal(''), z.null()])
    .optional()
    .transform((v) => v ?? undefined);

export const updateCompanySchema = z.object({
  name: z.string().trim().min(2).max(140),
  legalName: optionalText(180),
  email: z.string().email().max(200),
  phone: optionalText(40),
  whatsapp: optionalText(40),
  website: optionalUrl,

  street: z.string().trim().min(2).max(140),
  streetNo: optionalText(20),
  postalCode: z.string().regex(/^[1-9]\d{3}$/, 'Ungültige Postleitzahl.'),
  city: z.string().trim().min(2).max(80),

  vatNumber: optionalText(40),
  iban: optionalText(40),
  qrIban: optionalText(40),
  bankName: optionalText(120),

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
