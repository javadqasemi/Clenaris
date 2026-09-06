import { z } from 'zod';
import type { EmploymentType, PostStatus } from '@prisma/client';

import { SERVICE_KINDS, slugify } from './catalog';

/**
 * Redaktionelle Objekte der Website: häufige Fragen, Referenzbilder,
 * Stellenangebote.
 *
 * Sie stehen zusammen, weil sie dieselbe Form haben — ein Datensatz, der auf
 * einer öffentlichen Seite erscheint, mit Reihenfolge und Sichtbarkeit — und
 * weil drei Dateien mit je zwanzig Zeilen mehr Verwaltung als Nutzen wären.
 *
 * Gemeinsamer Entscheid: **jedes Bildfeld verlangt eine vollständige
 * `https`-Adresse.** Ein relativer Pfad würde beim Rendern auf der Website
 * still ins Leere zeigen, und ein `http`-Bild liefe in einer `https`-Seite in
 * die Mixed-Content-Sperre des Browsers — beides Fehler, die man erst auf der
 * fertigen Seite sieht.
 */

const imageUrl = z
  .string()
  .trim()
  .url('Bitte eine vollständige Bildadresse angeben.')
  .startsWith('https://', 'Bilder müssen über https ausgeliefert werden.')
  .max(500);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Der Text ist zu lang (max. ${max} Zeichen).`)
    .optional()
    .transform((v) => (v === '' ? undefined : v));

// ---------------------------------------------------------------------------
//  Häufige Fragen
// ---------------------------------------------------------------------------

const faqFields = {
  question: z
    .string()
    .trim()
    .min(8, 'Die Frage ist zu kurz.')
    .max(200, 'Die Frage ist zu lang — eine FAQ-Frage soll in eine Zeile passen.'),
  answer: z
    .string()
    .trim()
    .min(20, 'Die Antwort ist zu kurz (mind. 20 Zeichen).')
    .max(2000, 'Die Antwort ist zu lang (max. 2000 Zeichen).'),
  category: z.string().trim().min(2).max(60).default('Allgemein'),
  locale: z.enum(['DE', 'FR', 'IT', 'EN']).default('DE'),
  position: z.number().int().min(0).max(999).default(0),
  active: z.boolean().default(true),
};

export const createFaqSchema = z.object(faqFields);
export const updateFaqSchema = z.object(faqFields).partial();

export type CreateFaqInput = z.infer<typeof createFaqSchema>;
export type UpdateFaqInput = z.infer<typeof updateFaqSchema>;

// ---------------------------------------------------------------------------
//  Galerie (Vorher / Nachher)
// ---------------------------------------------------------------------------

const galleryFields = {
  title: z.string().trim().min(3, 'Ein Titel ist erforderlich.').max(120),
  description: optionalText(500),
  serviceKind: z.enum(SERVICE_KINDS).optional().nullable(),
  beforeUrl: imageUrl,
  afterUrl: imageUrl,
  location: optionalText(120),
  featured: z.boolean().default(false),
  position: z.number().int().min(0).max(999).default(0),
  published: z.boolean().default(true),
};

/**
 * Vorher und Nachher dürfen nicht dasselbe Bild sein.
 *
 * Klingt trivial, passiert aber beim Kopieren der Adresse regelmässig — und
 * das Ergebnis ist ein Schieberegler, der nichts zeigt. Auf der Startseite ist
 * genau dieser Vergleich das stärkste Argument des Betriebs.
 */
function distinctImages(
  value: { beforeUrl?: string; afterUrl?: string },
  ctx: z.RefinementCtx,
) {
  if (value.beforeUrl && value.afterUrl && value.beforeUrl === value.afterUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['afterUrl'],
      message: 'Vorher und Nachher zeigen dasselbe Bild — der Vergleich bliebe leer.',
    });
  }
}

export const createGalleryItemSchema = z.object(galleryFields).superRefine(distinctImages);
export const updateGalleryItemSchema = z
  .object(galleryFields)
  .partial()
  .superRefine(distinctImages);

export type CreateGalleryItemInput = z.infer<typeof createGalleryItemSchema>;
export type UpdateGalleryItemInput = z.infer<typeof updateGalleryItemSchema>;

// ---------------------------------------------------------------------------
//  Stellenangebote
// ---------------------------------------------------------------------------

export const EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'HOURLY',
  'TEMPORARY',
  'APPRENTICE',
  'CONTRACTOR',
] as const;

export const POST_STATUS = ['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'] as const;

/**
 * Abgleich mit den Prisma-Enums zur Bauzeit.
 *
 * Beim ersten Anlauf standen hier `INTERNSHIP` und `FREELANCE` — Werte, die
 * das Schema nicht kennt. Zur Laufzeit hätte Prisma sie abgewiesen, aber erst
 * beim Speichern eines Stellenangebots. Diese Prüfung bricht stattdessen den
 * Build.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const WEBSITE_ENUMS_IN_SYNC: [
  Exact<EmploymentType, (typeof EMPLOYMENT_TYPES)[number]>,
  Exact<PostStatus, (typeof POST_STATUS)[number]>,
] = [true, true];

const jobPostingFields = {
  title: z.string().trim().min(5, 'Ein Titel ist erforderlich.').max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Nur Kleinbuchstaben, Ziffern und einzelne Bindestriche.'),
  location: z.string().trim().min(2).max(80).default('Bern'),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('FULL_TIME'),
  workloadFrom: z.number().int().min(10).max(100).default(80),
  workloadTo: z.number().int().min(10).max(100).default(100),
  description: z
    .string()
    .trim()
    .min(80, 'Die Beschreibung ist zu kurz — eine Stellenanzeige unter 80 Zeichen wird nicht gelesen.')
    .max(8000),
  requirements: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  benefits: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  salaryFrom: z.number().min(0).max(9_999_999).optional().nullable(),
  salaryTo: z.number().min(0).max(9_999_999).optional().nullable(),
  status: z.enum(POST_STATUS).default('DRAFT'),
  closesAt: z
    .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Bitte ein Datum im Format JJJJ-MM-TT.'), z.literal('')])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
};

function jobPostingRules(
  value: {
    workloadFrom?: number;
    workloadTo?: number;
    salaryFrom?: number | null;
    salaryTo?: number | null;
  },
  ctx: z.RefinementCtx,
) {
  if (
    value.workloadFrom !== undefined &&
    value.workloadTo !== undefined &&
    value.workloadFrom > value.workloadTo
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['workloadTo'],
      message: 'Das obere Pensum muss mindestens so hoch sein wie das untere.',
    });
  }

  if (
    value.salaryFrom != null &&
    value.salaryTo != null &&
    value.salaryFrom > value.salaryTo
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['salaryTo'],
      message: 'Der obere Lohn muss mindestens so hoch sein wie der untere.',
    });
  }
}

export const createJobPostingSchema = z.object(jobPostingFields).superRefine(jobPostingRules);
export const updateJobPostingSchema = z
  .object(jobPostingFields)
  .partial()
  .superRefine(jobPostingRules);

export type CreateJobPostingInput = z.infer<typeof createJobPostingSchema>;
export type UpdateJobPostingInput = z.infer<typeof updateJobPostingSchema>;

// ---------------------------------------------------------------------------
//  Reihenfolge
// ---------------------------------------------------------------------------

export const websiteReorderSchema = z.object({
  entity: z.enum(['faq', 'gallery']),
  ids: z.array(z.string().min(1)).min(1).max(200),
});

export type WebsiteReorderInput = z.infer<typeof websiteReorderSchema>;

export { slugify };

// ---------------------------------------------------------------------------
//  Beschriftungen
// ---------------------------------------------------------------------------

export const EMPLOYMENT_TYPE_LABELS: Record<(typeof EMPLOYMENT_TYPES)[number], string> = {
  FULL_TIME: 'Vollzeit',
  PART_TIME: 'Teilzeit',
  HOURLY: 'Im Stundenlohn',
  TEMPORARY: 'Befristet',
  APPRENTICE: 'Lehrstelle',
  CONTRACTOR: 'Auf Auftragsbasis',
};

export const POST_STATUS_LABELS: Record<(typeof POST_STATUS)[number], string> = {
  DRAFT: 'Entwurf',
  SCHEDULED: 'Geplant',
  PUBLISHED: 'Veröffentlicht',
  ARCHIVED: 'Archiviert',
};
