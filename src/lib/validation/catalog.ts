import { z } from 'zod';
import type { Frequency, PricingModel, PropertyKind, ServiceKind } from '@prisma/client';

import { cuidSchema, moneySchema } from './common';

/**
 * Leistungskatalog und Preisgestaltung.
 *
 * Entscheide, die hier festgeschrieben sind:
 *
 *  • **Der Slug wird abgeleitet, nicht eingegeben.** Er steht in der
 *    öffentlichen Adresse (`/leistungen/umzugsreinigung`); ein Tippfehler
 *    darin kostet Suchmaschinenplätze und lässt sich nicht folgenlos
 *    korrigieren. Wer ihn bewusst setzen will, darf — geprüft wird trotzdem.
 *
 *  • **Preisfelder sind Zahlen, keine Zeichenketten.** Die Formulare
 *    normalisieren das Komma zum Punkt, bevor sie senden; hier kommt nur noch
 *    eine Zahl an. `moneySchema` erzwingt zwei Nachkommastellen — mehr kann
 *    die Datenbankspalte `Decimal(12,2)` ohnehin nicht halten, und stilles
 *    Runden beim Speichern wäre die schlimmste Variante.
 *
 *  • **Jedes Änderungsschema ist das Anlegeschema mit `.partial()`.** So kann
 *    ein Feld nicht versehentlich nur in einem der beiden Wege validiert
 *    werden. Wo eine Regel *zwischen* Feldern gilt (etwa: ein Stundenmodell
 *    braucht einen Stundenansatz), steht sie in einem `superRefine`, das
 *    beide Wege teilen.
 */

// ---------------------------------------------------------------------------
//  Bausteine
// ---------------------------------------------------------------------------

export const PRICING_MODELS = ['PER_HOUR', 'PER_SQM', 'FLAT', 'PER_UNIT', 'ON_REQUEST'] as const;

export const SERVICE_KINDS = [
  'OFFICE_CLEANING',
  'MOVE_OUT_CLEANING',
  'RESIDENTIAL_CLEANING',
  'WINDOW_CLEANING',
  'CONSTRUCTION_CLEANING',
  'BUILDING_MAINTENANCE',
  'SPECIAL',
] as const;

export const PROPERTY_KINDS = [
  'APARTMENT',
  'HOUSE',
  'OFFICE',
  'COMMERCIAL',
  'INDUSTRIAL',
  'CONSTRUCTION_SITE',
  'PRACTICE',
  'RESTAURANT',
  'SCHOOL',
  'OTHER',
] as const;

export const FREQUENCIES = [
  'ONCE',
  'WEEKLY',
  'BIWEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'SEMIANNUAL',
  'ANNUAL',
  'CUSTOM',
] as const;

/**
 * Abgleich der Listen oben mit den Prisma-Enums — zur *Bauzeit*.
 *
 * Diese Datei darf `@prisma/client` nicht zur Laufzeit laden (sie läuft auch
 * im Browser), deshalb sind die Werte von Hand aufgeführt. Genau daraus
 * entstünde sonst der klassische stille Fehler: jemand ergänzt eine
 * Objektart im Schema, das Formular kennt sie nicht, und die Preisregel greift
 * für diese Objektart nie.
 *
 * `Exact` verlangt Gleichheit in *beide* Richtungen. Läuft eine Liste aus dem
 * Tritt, wird der zugehörige Eintrag zu `never`, und die Zuweisung von `true`
 * bricht den Build mit einem Fingerzeig auf die Stelle.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

export const ENUMS_IN_SYNC: [
  Exact<ServiceKind, (typeof SERVICE_KINDS)[number]>,
  Exact<PricingModel, (typeof PRICING_MODELS)[number]>,
  Exact<PropertyKind, (typeof PROPERTY_KINDS)[number]>,
  Exact<Frequency, (typeof FREQUENCIES)[number]>,
] = [true, true, true, true];

/**
 * Slug für öffentliche Adressen.
 *
 * Kleinbuchstaben, Ziffern und einfache Bindestriche. Umlaute werden vom
 * Formular vorher übersetzt (ä→ae), nicht hier verworfen: „Büroreinigung"
 * soll `bueroreinigung` ergeben und nicht `broreinigung`.
 */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, 'Der Kurzname ist zu kurz.')
  .max(80, 'Der Kurzname ist zu lang (max. 80 Zeichen).')
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Nur Kleinbuchstaben, Ziffern und einzelne Bindestriche — z. B. umzugsreinigung.',
  );

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Der Text ist zu lang (max. ${max} Zeichen).`)
    .optional()
    .transform((v) => (v === '' ? undefined : v));

/** Aufzählungen wie „Das ist inbegriffen" — leere Zeilen fallen weg. */
const bulletList = (maxItems: number) =>
  z
    .array(z.string().trim().min(1).max(200, 'Ein Punkt ist zu lang (max. 200 Zeichen).'))
    .max(maxItems, `Höchstens ${maxItems} Einträge.`)
    .default([]);

/** MWST-Satz. Schweizer Sätze 2026: 8.1 / 3.8 / 2.6 / 0 %. */
const vatRateSchema = z
  .number()
  .min(0, 'Der Steuersatz darf nicht negativ sein.')
  .max(100, 'Der Steuersatz darf 100 % nicht überschreiten.')
  .multipleOf(0.01, 'Maximal zwei Nachkommastellen.');

// ---------------------------------------------------------------------------
//  Leistungen
// ---------------------------------------------------------------------------

const serviceFields = {
  name: z.string().trim().min(2, 'Der Name ist erforderlich.').max(80, 'Der Name ist zu lang.'),
  slug: slugSchema,
  kind: z.enum(SERVICE_KINDS),
  categoryId: cuidSchema.optional().nullable(),
  shortDesc: z
    .string()
    .trim()
    .min(10, 'Die Kurzbeschreibung ist zu kurz (mind. 10 Zeichen).')
    .max(200, 'Die Kurzbeschreibung ist zu lang (max. 200 Zeichen).'),
  description: z
    .string()
    .trim()
    .min(30, 'Die Beschreibung ist zu kurz (mind. 30 Zeichen).')
    .max(4000, 'Die Beschreibung ist zu lang (max. 4000 Zeichen).'),
  icon: z.string().trim().min(1).max(40).default('Sparkles'),
  heroImage: z
    .union([z.string().trim().url('Bitte geben Sie eine vollständige Bildadresse an.'), z.literal('')])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  active: z.boolean().default(true),
  featured: z.boolean().default(false),
  position: z.number().int().min(0).max(999).default(0),

  // Preislogik
  pricingModel: z.enum(PRICING_MODELS).default('PER_HOUR'),
  basePrice: moneySchema.default(0),
  hourlyRate: moneySchema.optional().nullable(),
  pricePerSqm: z
    .number()
    .min(0, 'Der Ansatz darf nicht negativ sein.')
    .max(9999, 'Der Ansatz ist zu gross.')
    .optional()
    .nullable(),
  minPrice: moneySchema.default(0),
  minHours: z
    .number()
    .min(0, 'Die Mindestdauer darf nicht negativ sein.')
    .max(99, 'Die Mindestdauer ist zu gross.')
    .default(2),
  vatRate: vatRateSchema.default(8.1),

  // Kapazitätsplanung
  defaultDurationMin: z
    .number()
    .int('Bitte geben Sie ganze Minuten an.')
    .min(15, 'Mindestens 15 Minuten.')
    .max(24 * 60, 'Höchstens 1440 Minuten (24 Stunden).')
    .default(120),
  minutesPerSqm: z
    .number()
    .min(0, 'Der Wert darf nicht negativ sein.')
    .max(60, 'Der Wert ist unplausibel hoch.')
    .default(1.2),
  defaultCrewSize: z
    .number()
    .int()
    .min(1, 'Mindestens eine Person.')
    .max(20, 'Höchstens 20 Personen.')
    .default(1),
  bufferMinutes: z
    .number()
    .int()
    .min(0)
    .max(240, 'Höchstens 240 Minuten Puffer.')
    .default(30),

  // Marketing und Suchmaschinen
  bulletPoints: bulletList(12),
  includes: bulletList(30),
  excludes: bulletList(30),
  seoTitle: optionalText(70),
  seoDescription: optionalText(180),
  keywords: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
};

/**
 * Regeln, die *zwischen* Feldern gelten.
 *
 * Ohne sie liesse sich eine Leistung mit Stundenmodell und leerem Ansatz
 * speichern — die Preis-Engine rechnete dann stillschweigend mit 0 und die
 * Buchung käme kostenlos heraus. Der Fehler soll im Formular auftreten,
 * nicht in der Rechnung.
 */
function crossFieldRules(
  value: {
    pricingModel?: (typeof PRICING_MODELS)[number];
    hourlyRate?: number | null;
    pricePerSqm?: number | null;
    basePrice?: number;
    minPrice?: number;
  },
  ctx: z.RefinementCtx,
) {
  if (value.pricingModel === 'PER_HOUR' && !value.hourlyRate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['hourlyRate'],
      message: 'Beim Stundenmodell ist ein Stundenansatz erforderlich.',
    });
  }

  if (value.pricingModel === 'PER_SQM' && !value.pricePerSqm) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pricePerSqm'],
      message: 'Beim Flächenmodell ist ein Ansatz pro m² erforderlich.',
    });
  }

  if (value.pricingModel === 'PER_UNIT' && !value.hourlyRate && !value.basePrice) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['hourlyRate'],
      message: 'Beim Stückmodell ist ein Preis pro Einheit erforderlich.',
    });
  }

  if (value.pricingModel === 'FLAT' && !value.basePrice) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['basePrice'],
      message: 'Bei der Pauschale ist ein Grundpreis erforderlich.',
    });
  }
}

export const createServiceSchema = z.object(serviceFields).superRefine(crossFieldRules);

/**
 * Beim Ändern sind alle Felder freiwillig — aber die Querregeln greifen
 * weiterhin, sobald das Preismodell mitgeschickt wird. Wer nur den Namen
 * ändert, muss den Ansatz nicht erneut senden.
 */
export const updateServiceSchema = z
  .object(serviceFields)
  .partial()
  .superRefine((value, ctx) => {
    if (value.pricingModel === undefined) return;
    crossFieldRules(value, ctx);
  });

export type CreateServiceInput = z.infer<typeof createServiceSchema>;
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;

// ---------------------------------------------------------------------------
//  Kategorien
// ---------------------------------------------------------------------------

const categoryFields = {
  name: z.string().trim().min(2, 'Der Name ist erforderlich.').max(60, 'Der Name ist zu lang.'),
  slug: slugSchema,
  description: optionalText(300),
  icon: z.string().trim().min(1).max(40).default('Sparkles'),
  position: z.number().int().min(0).max(999).default(0),
  active: z.boolean().default(true),
};

export const createCategorySchema = z.object(categoryFields);
export const updateCategorySchema = z.object(categoryFields).partial();

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

// ---------------------------------------------------------------------------
//  Zusatzleistungen
// ---------------------------------------------------------------------------

const extraFields = {
  name: z.string().trim().min(2, 'Der Name ist erforderlich.').max(80, 'Der Name ist zu lang.'),
  slug: slugSchema,
  description: optionalText(300),
  icon: z.string().trim().min(1).max(40).default('Plus'),
  price: moneySchema,
  pricingModel: z.enum(PRICING_MODELS).default('FLAT'),
  durationMin: z
    .number()
    .int('Bitte geben Sie ganze Minuten an.')
    .min(0, 'Die Zusatzdauer darf nicht negativ sein.')
    .max(8 * 60, 'Höchstens 480 Minuten.')
    .default(15),
  vatRate: vatRateSchema.default(8.1),
  active: z.boolean().default(true),
  position: z.number().int().min(0).max(999).default(0),
  /** Leistungen, bei denen dieser Zusatz angeboten wird. Leer = bei allen. */
  serviceIds: z.array(cuidSchema).max(50).default([]),
};

export const createExtraSchema = z.object(extraFields);
export const updateExtraSchema = z.object(extraFields).partial();

export type CreateExtraInput = z.infer<typeof createExtraSchema>;
export type UpdateExtraInput = z.infer<typeof updateExtraSchema>;

// ---------------------------------------------------------------------------
//  Preisregeln
// ---------------------------------------------------------------------------

/**
 * Bedingung einer Preisregel.
 *
 * Die Form entspricht `PriceRuleCondition` in `lib/pricing/types.ts` — dort
 * ist sie ein TypeScript-Typ, hier die Laufzeitprüfung. Beide müssen
 * zusammenpassen; deshalb steht in beiden Dateien ein Verweis auf die andere.
 *
 * `.strict()` ist Absicht: ein Tippfehler im Schlüssel („weekdays" statt
 * „weekday") würde sonst als leere Bedingung durchgehen und die Regel
 * *immer* greifen lassen — der teuerste denkbare stille Fehler.
 */
export const priceRuleConditionSchema = z
  .object({
    frequency: z.array(z.enum(FREQUENCIES)).min(1).optional(),
    propertyKind: z.array(z.enum(PROPERTY_KINDS)).min(1).optional(),
    weekday: z
      .array(z.number().int().min(0, 'Wochentag 0–6.').max(6, 'Wochentag 0–6.'))
      .min(1)
      .max(7)
      .optional(),
    hourFrom: z.number().int().min(0).max(23).optional(),
    hourTo: z.number().int().min(0).max(23).optional(),
    minSqm: z.number().min(0).max(100_000).optional(),
    maxSqm: z.number().min(0).max(100_000).optional(),
    hasPets: z.boolean().optional(),
    urgent: z.boolean().optional(),
    postalCode: z.array(z.string().regex(/^[1-9]\d{3}$/)).min(1).optional(),
  })
  .strict('Unbekanntes Merkmal in der Bedingung.')
  .superRefine((value, ctx) => {
    if (value.hourFrom !== undefined && value.hourTo !== undefined && value.hourFrom > value.hourTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hourTo'],
        message: 'Die Endstunde muss nach der Startstunde liegen.',
      });
    }
    if (value.minSqm !== undefined && value.maxSqm !== undefined && value.minSqm > value.maxSqm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxSqm'],
        message: 'Die Obergrenze muss über der Untergrenze liegen.',
      });
    }
  });

const priceRuleFields = {
  name: z.string().trim().min(2, 'Der Name ist erforderlich.').max(80, 'Der Name ist zu lang.'),
  /** null = gilt für alle Leistungen. */
  serviceId: cuidSchema.optional().nullable(),
  condition: priceRuleConditionSchema,
  multiplier: z
    .number()
    .min(0, 'Der Faktor darf nicht negativ sein.')
    .max(10, 'Ein Faktor über 10 ist mit Sicherheit ein Tippfehler.')
    .default(1),
  surcharge: z
    .number()
    .min(-9_999_999, 'Der Betrag ist zu klein.')
    .max(9_999_999, 'Der Betrag ist zu gross.')
    .multipleOf(0.01, 'Maximal zwei Nachkommastellen.')
    .default(0),
  priority: z.number().int().min(0).max(999).default(0),
  active: z.boolean().default(true),
};

/**
 * Eine Regel, die weder multipliziert noch einen Betrag addiert, ist ein
 * stiller Blindgänger: sie steht in der Liste, greift aber nie sichtbar.
 * Besser beim Speichern melden als später suchen.
 */
function requireEffect(
  value: { multiplier?: number; surcharge?: number },
  ctx: z.RefinementCtx,
) {
  const multiplier = value.multiplier ?? 1;
  const surcharge = value.surcharge ?? 0;
  if (multiplier === 1 && surcharge === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['multiplier'],
      message: 'Die Regel hätte keine Wirkung — setzen Sie einen Faktor oder einen Betrag.',
    });
  }
}

export const createPriceRuleSchema = z.object(priceRuleFields).superRefine(requireEffect);
export const updatePriceRuleSchema = z
  .object(priceRuleFields)
  .partial()
  .superRefine((value, ctx) => {
    if (value.multiplier === undefined && value.surcharge === undefined) return;
    requireEffect(value, ctx);
  });

export type CreatePriceRuleInput = z.infer<typeof createPriceRuleSchema>;
export type UpdatePriceRuleInput = z.infer<typeof updatePriceRuleSchema>;

// ---------------------------------------------------------------------------
//  Steuersätze
// ---------------------------------------------------------------------------

const taxRateFields = {
  name: z.string().trim().min(2, 'Der Name ist erforderlich.').max(60, 'Der Name ist zu lang.'),
  rate: vatRateSchema,
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
};

export const createTaxRateSchema = z.object(taxRateFields);
export const updateTaxRateSchema = z.object(taxRateFields).partial();

export type CreateTaxRateInput = z.infer<typeof createTaxRateSchema>;
export type UpdateTaxRateInput = z.infer<typeof updateTaxRateSchema>;

// ---------------------------------------------------------------------------
//  Gutscheine
// ---------------------------------------------------------------------------

const couponFields = {
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(3, 'Der Code ist zu kurz (mind. 3 Zeichen).')
    .max(24, 'Der Code ist zu lang (max. 24 Zeichen).')
    .regex(/^[A-Z0-9-]+$/, 'Nur Grossbuchstaben, Ziffern und Bindestriche.'),
  description: optionalText(200),
  discountType: z.enum(['PERCENT', 'FIXED']).default('PERCENT'),
  discountValue: z
    .number()
    .min(0.01, 'Der Rabatt muss grösser als null sein.')
    .max(9_999_999, 'Der Wert ist zu gross.'),
  minOrderValue: moneySchema.default(0),
  maxDiscount: moneySchema.optional().nullable(),
  status: z.enum(['ACTIVE', 'PAUSED', 'EXPIRED', 'DEPLETED']).default('ACTIVE'),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Bitte ein Datum im Format JJJJ-MM-TT.'),
  validUntil: z
    .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Bitte ein Datum im Format JJJJ-MM-TT.'), z.literal('')])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  usageLimit: z.number().int().min(1).max(1_000_000).optional().nullable(),
  perCustomerLimit: z.number().int().min(1).max(1000).default(1),
  firstOrderOnly: z.boolean().default(false),
  serviceKinds: z.array(z.enum(SERVICE_KINDS)).max(SERVICE_KINDS.length).default([]),
};

function couponRules(
  value: {
    discountType?: 'PERCENT' | 'FIXED';
    discountValue?: number;
    validFrom?: string;
    validUntil?: string;
  },
  ctx: z.RefinementCtx,
) {
  if (value.discountType === 'PERCENT' && value.discountValue !== undefined && value.discountValue > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['discountValue'],
      message: 'Ein Prozentrabatt über 100 % würde Geld auszahlen.',
    });
  }

  if (value.validFrom && value.validUntil && value.validUntil < value.validFrom) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['validUntil'],
      message: 'Das Enddatum liegt vor dem Startdatum.',
    });
  }
}

export const createCouponSchema = z.object(couponFields).superRefine(couponRules);
export const updateCouponSchema = z.object(couponFields).partial().superRefine(couponRules);

export type CreateCouponInput = z.infer<typeof createCouponSchema>;
export type UpdateCouponInput = z.infer<typeof updateCouponSchema>;

// ---------------------------------------------------------------------------
//  Reihenfolge
// ---------------------------------------------------------------------------

/**
 * Reihenfolge mehrerer Einträge in einem Zug setzen.
 *
 * Eine PATCH-Anfrage pro verschobener Zeile wäre nicht nur langsamer, sondern
 * auch nicht atomar: bräche die dritte ab, stünde die Liste in einem Zustand,
 * den niemand angeordnet hat.
 */
export const reorderSchema = z.object({
  entity: z.enum(['service', 'extra', 'category']),
  ids: z.array(cuidSchema).min(1, 'Es wurde nichts übermittelt.').max(200),
});

export type ReorderInput = z.infer<typeof reorderSchema>;

/** Aus einem Namen einen zulässigen Slug ableiten — im Formular vorbelegt. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
