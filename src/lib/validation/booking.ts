import { z } from 'zod';
import {
  addressSchema,
  consentSchema,
  cuidSchema,
  emailSchema,
  honeypotSchema,
  isoDateSchema,
  nameSchema,
  phoneSchema,
  postalCodeSchema,
} from './common';

const propertyKindEnum = z.enum([
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
]);

const frequencyEnum = z.enum([
  'ONCE',
  'WEEKLY',
  'BIWEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'SEMIANNUAL',
  'ANNUAL',
  'CUSTOM',
]);

export const extraSelectionSchema = z.object({
  extraId: cuidSchema,
  quantity: z.number().int().min(1).max(50).default(1),
});

/** Eingabe für die Sofort-Preisberechnung (öffentlich, ohne Login). */
export const priceEstimateSchema = z.object({
  serviceId: cuidSchema,
  squareMeters: z.number().int().min(5).max(5000).nullish(),
  rooms: z.number().min(0.5).max(40).nullish(),
  bathrooms: z.number().int().min(0).max(20).nullish(),
  windows: z.number().int().min(0).max(500).nullish(),
  propertyKind: propertyKindEnum.default('APARTMENT'),
  frequency: frequencyEnum.default('ONCE'),
  extras: z.array(extraSelectionSchema).max(20).default([]),
  scheduledStart: isoDateSchema.nullish(),
  postalCode: postalCodeSchema.nullish(),
  hasPets: z.boolean().default(false),
  manualHours: z.number().min(0.5).max(80).nullish(),
  couponCode: z.string().trim().max(40).nullish(),
  urgent: z.boolean().default(false),
});
export type PriceEstimateInput = z.infer<typeof priceEstimateSchema>;

/**
 * Öffentliche Online-Buchung.
 *
 * Die Buchung funktioniert mit *und* ohne Login: liegt keine Session vor,
 * wird anhand der E-Mail ein Kundendatensatz gefunden oder angelegt und ein
 * Magic-Link zur Verwaltung versendet. Das senkt die Abbruchrate im
 * Buchungstrichter deutlich.
 */
export const createBookingSchema = z
  .object({
    // Leistung
    serviceId: cuidSchema,
    extras: z.array(extraSelectionSchema).max(20).default([]),
    frequency: frequencyEnum.default('ONCE'),

    // Termin
    scheduledStart: isoDateSchema,
    manualHours: z.number().min(0.5).max(80).nullish(),
    urgent: z.boolean().default(false),

    // Objekt
    propertyKind: propertyKindEnum.default('APARTMENT'),
    squareMeters: z.number().int().min(5).max(5000).nullish(),
    rooms: z.number().min(0.5).max(40).nullish(),
    bathrooms: z.number().int().min(0).max(20).nullish(),
    windows: z.number().int().min(0).max(500).nullish(),
    hasPets: z.boolean().default(false),
    propertyId: cuidSchema.nullish(),

    // Kontakt (bei Gastbuchung erforderlich)
    firstName: nameSchema.optional(),
    lastName: nameSchema.optional(),
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
    companyName: z.string().trim().max(120).optional(),

    // Adresse
    addressId: cuidSchema.nullish(),
    address: addressSchema.optional(),

    // Sonstiges
    customerNote: z.string().trim().max(2000).optional(),
    accessNote: z.string().trim().max(500).optional(),
    couponCode: z.string().trim().max(40).optional(),
    fileIds: z.array(cuidSchema).max(10).default([]),

    // Wiederholung
    recurrence: z
      .object({
        interval: z.number().int().min(1).max(12).default(1),
        weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
        endDate: isoDateSchema.nullish(),
        count: z.number().int().min(2).max(104).nullish(),
      })
      .optional(),

    acceptTerms: consentSchema,
    website: honeypotSchema,
  })
  .refine((data) => Boolean(data.addressId) || Boolean(data.address), {
    message: 'Bitte geben Sie die Einsatzadresse an.',
    path: ['address'],
  })
  .refine((data) => data.frequency === 'ONCE' || Boolean(data.recurrence), {
    message: 'Bitte legen Sie den Wiederholungsrhythmus fest.',
    path: ['recurrence'],
  });
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const rescheduleBookingSchema = z.object({
  scheduledStart: isoDateSchema,
  reason: z.string().trim().max(500).optional(),
});
export type RescheduleBookingInput = z.infer<typeof rescheduleBookingSchema>;

export const cancelBookingSchema = z.object({
  reason: z.string().trim().min(3, 'Bitte nennen Sie einen Grund.').max(500),
});
export type CancelBookingInput = z.infer<typeof cancelBookingSchema>;

/** Interne Bearbeitung durch Admin/Manager. */
export const updateBookingSchema = z.object({
  status: z
    .enum(['DRAFT', 'PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'])
    .optional(),
  scheduledStart: isoDateSchema.optional(),
  durationMin: z.number().int().min(30).max(1440).optional(),
  crewSize: z.number().int().min(1).max(20).optional(),
  internalNote: z.string().trim().max(2000).optional(),
  customerNote: z.string().trim().max(2000).optional(),
  accessNote: z.string().trim().max(500).optional(),
});
export type UpdateBookingInput = z.infer<typeof updateBookingSchema>;

export const bookingListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum(['DRAFT', 'PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'])
    .optional(),
  customerId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().trim().max(120).optional(),
  sort: z.string().max(40).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/** Verfügbarkeitsabfrage für den Terminwähler. */
export const availabilityQuerySchema = z.object({
  serviceId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ungültiges Datum.'),
  durationMin: z.coerce.number().int().min(30).max(1440).default(120),
  crewSize: z.coerce.number().int().min(1).max(20).default(1),
});
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

/**
 * Öffentliche Preisschätzung.
 *
 * Die Website kennt Leistungen über ihren Slug (`/leistungen/umzugsreinigung`),
 * das Buchungsformular über die ID. Beide Wege führen zur selben Rechnung —
 * einer von beiden muss angegeben sein.
 */
export const publicEstimateSchema = priceEstimateSchema
  .omit({ serviceId: true })
  .extend({
    serviceId: z.string().min(1).optional(),
    serviceSlug: z.string().min(1).optional(),
  })
  .refine((data) => Boolean(data.serviceId) || Boolean(data.serviceSlug), {
    message: 'Bitte wählen Sie eine Dienstleistung.',
    path: ['serviceId'],
  });
export type PublicEstimateInput = z.infer<typeof publicEstimateSchema>;
