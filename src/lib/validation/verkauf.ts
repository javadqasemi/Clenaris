import { z } from 'zod';

/**
 * Besichtigung / Objektaufnahme (Wave 12).
 *
 * **Kein Preisfeld.** Die Aufnahme hält fest, was vor Ort gemessen wurde —
 * Fläche, Räume, Fenster, Turnus, Zusatzleistungen. Den Preis rechnet der
 * Server mit derselben Preisberechnung wie die Online-Buchung. Ein Feld, in
 * das jemand einen Preis schreiben könnte, würde die Offerte vom Katalog
 * lösen, ohne dass es jemand bemerkt.
 */

const PROPERTY_KINDS = ['APARTMENT', 'HOUSE', 'OFFICE', 'COMMERCIAL', 'INDUSTRIAL', 'CONSTRUCTION_SITE', 'PRACTICE', 'RESTAURANT', 'SCHOOL', 'OTHER'] as const;
const FREQUENCIES = ['ONCE', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'] as const;
const kennung = z.string().min(1).max(64);

const adresse = {
  street: z.string().trim().max(160).nullable().optional(),
  postalCode: z.string().trim().regex(/^\d{4}$/, 'Postleitzahl mit vier Ziffern.').nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
};

export const siteVisitCreateSchema = z
  .object({
    leadId: kennung.optional(),
    customerId: kennung.optional(),
    propertyId: kennung.optional(),
    scheduledAt: z.string().datetime({ offset: true }),
    assessorId: kennung.nullable().optional(),
    propertyKind: z.enum(PROPERTY_KINDS).default('OFFICE'),
    hasPets: z.boolean().default(false),
    accessNotes: z.string().trim().max(2000).nullable().optional(),
    ...adresse,
  })
  .refine((w) => Boolean(w.leadId) || Boolean(w.customerId), {
    message: 'Eine Besichtigung gehört zu einer Anfrage oder einer Kundschaft.',
    path: ['customerId'],
  });

export const siteVisitUpdateSchema = z
  .object({
    scheduledAt: z.string().datetime({ offset: true }).optional(),
    assessorId: kennung.nullable().optional(),
    propertyKind: z.enum(PROPERTY_KINDS).optional(),
    hasPets: z.boolean().optional(),
    accessNotes: z.string().trim().max(2000).nullable().optional(),
    findings: z.string().trim().max(8000).nullable().optional(),
    ...adresse,
  })
  .refine((w) => Object.keys(w).length > 0, { message: 'Es wurde nichts zum Ändern angegeben.' });

export const siteVisitAreaSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    serviceId: kennung,
    squareMeters: z.number().int().min(1).max(100_000).nullable().optional(),
    rooms: z.number().min(0.5).max(500).nullable().optional(),
    bathrooms: z.number().int().min(0).max(200).nullable().optional(),
    windows: z.number().int().min(0).max(5000).nullable().optional(),
    frequency: z.enum(FREQUENCIES).default('ONCE'),
    extras: z.array(z.object({ extraId: kennung, quantity: z.number().int().min(1).max(100) })).max(30).default([]),
    manualHours: z.number().min(0.25).max(500).nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  });

/** Die Flächen werden als Ganzes gesetzt — Reihenfolge ist die Position. */
export const siteVisitAreasSchema = z.object({
  areas: z.array(siteVisitAreaSchema).min(1, 'Mindestens eine Fläche.').max(50),
});

export const siteVisitCompleteSchema = z.object({
  findings: z.string().trim().max(8000).optional(),
});

export const siteVisitCancelSchema = z.object({
  reason: z.string().trim().min(3, 'Bitte einen Grund angeben.').max(500),
});

export const siteVisitQuoteSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  validDays: z.number().int().min(1).max(180).default(30),
  introText: z.string().trim().max(4000).optional(),
});

export const siteVisitQuerySchema = z.object({
  status: z.enum(['PLANNED', 'DONE', 'CANCELLED']).optional(),
  leadId: kennung.optional(),
  customerId: kennung.optional(),
});

export const siteVisitAreaParams = z.object({ id: kennung, areaId: kennung });

export type SiteVisitCreateInput = z.infer<typeof siteVisitCreateSchema>;
export type SiteVisitUpdateInput = z.infer<typeof siteVisitUpdateSchema>;
export type SiteVisitAreaInput = z.infer<typeof siteVisitAreaSchema>;
export type SiteVisitQuoteInput = z.infer<typeof siteVisitQuoteSchema>;
