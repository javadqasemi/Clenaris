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

/**
 * Eine Auftragsposition in der Bearbeitungsmaske.
 *
 * `serviceId` ist Pflicht — anders als in der Offerte, wo Freitextpositionen
 * erwünscht sind. Ein Auftrag wird disponiert, kalkuliert und ausgewertet:
 * Dauer, Crew-Grösse, Deckungsbeitrag je Leistung und die Umsatzstatistik
 * hängen alle an der Katalogleistung. Eine Position ohne sie fiele aus jeder
 * dieser Rechnungen heraus, ohne dass es jemandem auffiele.
 */
export const bookingItemInputSchema = z.object({
  serviceId: cuidSchema,
  name: z.string().trim().min(2, 'Bitte benennen Sie die Position.').max(160),
  description: z.string().trim().max(500).nullish(),
  quantity: z.number().min(0).max(100_000),
  unit: z.string().trim().min(1).max(20),
  unitPrice: z.number().min(0).max(1_000_000),
  /** Nur die erste Position trägt die Einsatzdauer — sie steuert die Planung. */
  durationMin: z.number().int().min(0).max(10_080).default(0),
});
export type BookingItemInput = z.infer<typeof bookingItemInputSchema>;

export const bookingExtraInputSchema = z.object({
  extraId: cuidSchema,
  name: z.string().trim().min(2).max(160),
  quantity: z.number().int().min(1).max(200).default(1),
  unitPrice: z.number().min(0).max(100_000),
});
export type BookingExtraInput = z.infer<typeof bookingExtraInputSchema>;

/**
 * Interne Bearbeitung durch Verwaltung und Betriebsleitung.
 *
 * Alle Felder sind freiwillig, damit eine Maske nur senden muss, was sie
 * angefasst hat — und damit ein Teilformular (nur Notiz, nur Status) nicht die
 * ganze Buchung mitschicken muss.
 *
 * `.strict()` ist hier wichtiger als anderswo: Diese Maske schreibt Preise. Ein
 * Tippfehler im Feldnamen würde ohne `.strict()` still verworfen, die Antwort
 * lautete 200, und die Person hielte einen Rabatt für gespeichert, den niemand
 * gespeichert hat.
 *
 * Welche dieser Felder eine bestimmte Rolle tatsächlich ändern darf, entscheidet
 * nicht das Schema, sondern `updateBooking` anhand der Rechtematrix — ein Schema
 * kennt die Rolle nicht.
 */
export const updateBookingSchema = z
  .object({
    status: z
      .enum(['DRAFT', 'PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'])
      .optional(),

    // Termin und Kapazität
    scheduledStart: isoDateSchema.optional(),
    durationMin: z.number().int().min(30).max(1440).optional(),
    crewSize: z.number().int().min(1).max(20).optional(),

    // Kundschaft, Adresse, Objekt
    customerId: cuidSchema.optional(),
    addressId: cuidSchema.optional(),
    address: addressSchema.optional(),
    propertyId: cuidSchema.nullish(),
    propertyKind: propertyKindEnum.optional(),
    squareMeters: z.number().int().min(5).max(5000).nullish(),
    rooms: z.number().min(0.5).max(40).nullish(),
    windows: z.number().int().min(0).max(500).nullish(),

    // Turnus
    frequency: frequencyEnum.optional(),
    recurrence: z
      .object({
        interval: z.number().int().min(1).max(12).default(1),
        weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
        endDate: isoDateSchema.nullish(),
        count: z.number().int().min(2).max(104).nullish(),
      })
      .nullish(),

    // Positionen und Preis
    items: z.array(bookingItemInputSchema).min(1).max(30).optional(),
    /**
     * Je Zusatzleistung höchstens eine Zeile — die Datenbank erzwingt das über
     * `@@unique([bookingId, extraId])`. Ohne diese Prüfung käme der Verstoss
     * als 500 zurück statt als Hinweis am richtigen Feld.
     */
    extras: z
      .array(bookingExtraInputSchema)
      .max(20)
      .refine((list) => new Set(list.map((extra) => extra.extraId)).size === list.length, {
        message: 'Jede Zusatzleistung darf nur einmal vorkommen — bitte die Menge erhöhen.',
      })
      .optional(),
    travelFee: z.number().min(0).max(10_000).optional(),
    discountAmount: z.number().min(0).max(1_000_000).optional(),
    vatRate: z.number().min(0).max(100).optional(),

    // Notizen
    internalNote: z.string().trim().max(2000).nullish(),
    customerNote: z.string().trim().max(2000).nullish(),
    accessNote: z.string().trim().max(500).nullish(),

    /** Grund der Änderung — landet in der Änderungsspur am Auftrag. */
    changeReason: z.string().trim().max(500).optional(),
  })
  .strict();
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
