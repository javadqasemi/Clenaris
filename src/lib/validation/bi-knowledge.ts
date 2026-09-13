import { z } from 'zod';

import { assetUrlSchema, cuidSchema, dateOnlySchema, emailSchema, moneySchema } from './common';
import { searchQuery } from './queries';
import { TASK_PRIORITIES } from './bi-objectives';

/**
 * Wissen und Markt: Dokumentenablage, Wissensartikel, Wettbewerber,
 * Marktbeobachtungen, SWOT/PESTEL-Tafeln, Sitzungen.
 */

export const DOCUMENT_CATEGORIES = [
  'BUSINESS_PLAN',
  'CONTRACT',
  'INSURANCE',
  'EMPLOYEE',
  'CERTIFICATE',
  'LICENSE',
  'SUPPLIER',
  'TAX',
  'LEGAL',
  'POLICY',
  'OTHER',
] as const;
export const DOCUMENT_VISIBILITIES = ['MANAGEMENT', 'OPERATIONS', 'STAFF', 'EMPLOYEE_PRIVATE'] as const;
export const ARTICLE_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export const INSIGHT_KINDS = [
  'INDUSTRY',
  'CUSTOMER',
  'COMPETITOR',
  'TECHNOLOGY',
  'ECONOMY',
  'LEGAL',
  'ENVIRONMENT',
] as const;
export const ANALYSIS_KINDS = ['SWOT', 'PESTEL'] as const;
export const ANALYSIS_BUCKETS = [
  'STRENGTH',
  'WEAKNESS',
  'OPPORTUNITY',
  'THREAT',
  'POLITICAL',
  'ECONOMIC',
  'SOCIAL',
  'TECHNOLOGICAL',
  'ENVIRONMENTAL',
  'LEGAL',
] as const;

/** Welche Felder zu welcher Tafel gehören — die Maske zeigt nur diese. */
export const SWOT_BUCKETS = ['STRENGTH', 'WEAKNESS', 'OPPORTUNITY', 'THREAT'] as const;
export const PESTEL_BUCKETS = [
  'POLITICAL',
  'ECONOMIC',
  'SOCIAL',
  'TECHNOLOGICAL',
  'ENVIRONMENTAL',
  'LEGAL',
] as const;

const tags = z.array(z.string().trim().min(1).max(40)).max(20).default([]);

/**
 * Eine bereits hochgeladene Datei — der Browser hat sie über
 * `/api/files/upload-url` abgelegt und meldet hier, was dort liegt.
 */
export const uploadedFileSchema = z.object({
  path: z.string().trim().min(1).max(500),
  url: assetUrlSchema,
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(120),
  sizeBytes: z.number().int().min(0).max(50 * 1024 * 1024),
});
export type UploadedFileInput = z.infer<typeof uploadedFileSchema>;

// ---------------------------------------------------------------------------
//  Dokumente
// ---------------------------------------------------------------------------

export const createDocumentSchema = z.object({
  title: z.string().trim().min(2).max(200),
  category: z.enum(DOCUMENT_CATEGORIES).default('OTHER'),
  /**
   * Ohne Angabe entscheidet der Dienst: Personaldokumente werden
   * `EMPLOYEE_PRIVATE`, alles andere `MANAGEMENT`. Ein Standardwert, den man
   * im Formular übersehen kann, wird übersehen — deshalb steht er im Dienst.
   */
  visibility: z.enum(DOCUMENT_VISIBILITIES).optional(),
  description: z.string().trim().max(2000).optional(),
  tags,
  subjectEmployeeId: cuidSchema.nullish(),
  supplierId: cuidSchema.nullish(),
  validFrom: dateOnlySchema.nullish(),
  expiresOn: dateOnlySchema.nullish(),
  reminderDaysBefore: z.number().int().min(0).max(365).default(30),
  /** Erste Fassung — freiwillig, damit eine Akte auch vor der Datei existiert. */
  file: uploadedFileSchema.optional(),
  changeNote: z.string().trim().max(500).optional(),
});
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

export const updateDocumentSchema = createDocumentSchema
  .omit({ file: true, changeNote: true })
  .partial()
  .strict();
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;

export const addDocumentVersionSchema = z.object({
  file: uploadedFileSchema,
  changeNote: z.string().trim().max(500).optional(),
});
export type AddDocumentVersionInput = z.infer<typeof addDocumentVersionSchema>;

/** Ohne Angabe die geltende Fassung. */
export const documentDownloadQuery = z.object({
  version: z.coerce.number().int().min(1).max(10_000).optional(),
});

export const documentListQuery = searchQuery.extend({
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  visibility: z.enum(DOCUMENT_VISIBILITIES).optional(),
  tag: z.string().trim().max(40).optional(),
  /** Nur Dokumente, die innerhalb dieser Frist ablaufen. */
  ablaufTage: z.coerce.number().int().min(1).max(365).optional(),
});

// ---------------------------------------------------------------------------
//  Wissensartikel
// ---------------------------------------------------------------------------

export const createArticleSchema = z.object({
  title: z.string().trim().min(3).max(200),
  summary: z.string().trim().max(500).optional(),
  body: z.string().trim().min(10).max(60_000),
  category: z.string().trim().min(2).max(60).default('Allgemein'),
  tags,
  status: z.enum(ARTICLE_STATUSES).default('DRAFT'),
  visibility: z.enum(['MANAGEMENT', 'OPERATIONS', 'STAFF']).default('STAFF'),
  videoUrl: z.string().trim().url().max(500).nullish(),
  reviewIntervalDays: z.number().int().min(30).max(1095).nullish(),
});
export type CreateArticleInput = z.infer<typeof createArticleSchema>;

export const updateArticleSchema = createArticleSchema.partial().strict();
export type UpdateArticleInput = z.infer<typeof updateArticleSchema>;

export const articleListQuery = searchQuery.extend({
  category: z.string().trim().max(60).optional(),
  status: z.enum(ARTICLE_STATUSES).optional(),
  tag: z.string().trim().max(40).optional(),
});

// ---------------------------------------------------------------------------
//  Wettbewerber und Markt
// ---------------------------------------------------------------------------

export const createCompetitorSchema = z
  .object({
    name: z.string().trim().min(2).max(160),
    website: z.string().trim().url().max(300).nullish(),
    region: z.string().trim().max(120).nullish(),
    services: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
    priceFrom: moneySchema.nullish(),
    priceTo: moneySchema.nullish(),
    priceNote: z.string().trim().max(500).nullish(),
    strengths: z.string().trim().max(4000).nullish(),
    weaknesses: z.string().trim().max(4000).nullish(),
    marketPosition: z.string().trim().max(500).nullish(),
    reviewScore: z.number().min(0).max(5).nullish(),
    reviewCount: z.number().int().min(0).max(1_000_000).nullish(),
    notes: z.string().trim().max(6000).nullish(),
    reviewIntervalDays: z.number().int().min(30).max(1095).default(180),
  })
  .refine((d) => d.priceFrom == null || d.priceTo == null || d.priceTo >= d.priceFrom, {
    message: 'Der obere Preis darf nicht unter dem unteren liegen.',
    path: ['priceTo'],
  });
export type CreateCompetitorInput = z.infer<typeof createCompetitorSchema>;

export const updateCompetitorSchema = createCompetitorSchema.innerType().partial().strict();
export type UpdateCompetitorInput = z.infer<typeof updateCompetitorSchema>;

export const createMarketInsightSchema = z.object({
  kind: z.enum(INSIGHT_KINDS).default('INDUSTRY'),
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(10).max(10_000),
  sourceUrl: z.string().trim().url().max(500).nullish(),
  sourceName: z.string().trim().max(160).nullish(),
  observedOn: dateOnlySchema,
  impactNote: z.string().trim().max(2000).nullish(),
  reviewIntervalDays: z.number().int().min(30).max(1095).default(365),
});
export type CreateMarketInsightInput = z.infer<typeof createMarketInsightSchema>;

export const updateMarketInsightSchema = createMarketInsightSchema.partial().strict();
export type UpdateMarketInsightInput = z.infer<typeof updateMarketInsightSchema>;

export const marketListQuery = searchQuery.extend({
  kind: z.enum(INSIGHT_KINDS).optional(),
  faellig: z.enum(['0', '1']).default('0'),
});

// ---------------------------------------------------------------------------
//  SWOT und PESTEL
// ---------------------------------------------------------------------------

export const analysisEntrySchema = z.object({
  bucket: z.enum(ANALYSIS_BUCKETS),
  title: z.string().trim().min(2).max(200),
  detail: z.string().trim().max(2000).nullish(),
  weight: z.number().int().min(1).max(5).default(3),
  sortOrder: z.number().int().min(0).max(100).default(0),
});
export type AnalysisEntryInput = z.infer<typeof analysisEntrySchema>;

/**
 * Die Felder müssen zur Tafel passen: ein „Stärke"-Eintrag auf einer
 * PESTEL-Tafel wäre eine Karte, die die Maske nie anzeigt.
 */
function bucketsMatchKind(kind: 'SWOT' | 'PESTEL', entries: { bucket: string }[]): boolean {
  const allowed: readonly string[] = kind === 'SWOT' ? SWOT_BUCKETS : PESTEL_BUCKETS;
  return entries.every((entry) => allowed.includes(entry.bucket));
}

export const createAnalysisBoardSchema = z
  .object({
    kind: z.enum(ANALYSIS_KINDS),
    title: z.string().trim().min(3).max(200),
    preparedOn: dateOnlySchema,
    summary: z.string().trim().max(6000).optional(),
    reviewIntervalDays: z.number().int().min(30).max(1095).default(365),
    entries: z.array(analysisEntrySchema).max(80).default([]),
    /** Eine neue Fassung dieser Tafel — die alte bleibt als Vorgängerin stehen. */
    supersedesId: cuidSchema.optional(),
  })
  .refine((d) => bucketsMatchKind(d.kind, d.entries), {
    message: 'Die Einträge passen nicht zur Art der Tafel.',
    path: ['entries'],
  });
export type CreateAnalysisBoardInput = z.infer<typeof createAnalysisBoardSchema>;

export const updateAnalysisBoardSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    preparedOn: dateOnlySchema.optional(),
    summary: z.string().trim().max(6000).nullish(),
    reviewIntervalDays: z.number().int().min(30).max(1095).optional(),
    /** Ersetzt alle Einträge — die Tafel wird als Ganzes bearbeitet. */
    entries: z.array(analysisEntrySchema).max(80).optional(),
  })
  .strict();
export type UpdateAnalysisBoardInput = z.infer<typeof updateAnalysisBoardSchema>;

export const analysisListQuery = z.object({
  kind: z.enum(ANALYSIS_KINDS).optional(),
});

// ---------------------------------------------------------------------------
//  Sitzungen
// ---------------------------------------------------------------------------

export const meetingActionItemSchema = z.object({
  title: z.string().trim().min(3).max(200),
  assigneeId: cuidSchema.nullish(),
  dueAt: z.coerce.date().nullish(),
  priority: z.enum(TASK_PRIORITIES).default('NORMAL'),
});

export const createMeetingSchema = z.object({
  title: z.string().trim().min(3).max(200),
  heldAt: z.coerce.date(),
  location: z.string().trim().max(160).nullish(),
  agenda: z.string().trim().max(10_000).nullish(),
  minutes: z.string().trim().max(30_000).nullish(),
  decisions: z.string().trim().max(10_000).nullish(),
  guestNames: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  participantIds: z.array(cuidSchema).max(50).default([]),
  objectiveId: cuidSchema.nullish(),
  /** Pendenzen — werden zu gewöhnlichen Aufgaben mit Frist und Erinnerung. */
  actionItems: z.array(meetingActionItemSchema).max(50).default([]),
});
export type CreateMeetingInput = z.infer<typeof createMeetingSchema>;

export const updateMeetingSchema = createMeetingSchema
  .omit({ actionItems: true })
  .partial()
  .extend({
    /** Weitere Pendenzen, die beim Bearbeiten dazukommen. */
    actionItems: z.array(meetingActionItemSchema).max(50).optional(),
  })
  .strict();
export type UpdateMeetingInput = z.infer<typeof updateMeetingSchema>;

export const meetingListQuery = searchQuery.extend({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  objectiveId: cuidSchema.optional(),
});

/** Empfänger für Berichte — hier, weil die Berichte dieselbe Prüfung nutzen. */
export const recipientListSchema = z.array(emailSchema).max(20);
