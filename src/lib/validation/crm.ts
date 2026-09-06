import { z } from 'zod';
import {
  addressSchema,
  consentSchema,
  cuidSchema,
  dateOnlySchema,
  emailSchema,
  honeypotSchema,
  localeSchema,
  nameSchema,
  optionalPhoneSchema,
  percentSchema,
  phoneSchema,
  postalCodeSchema,
} from './common';

const serviceKindEnum = z.enum([
  'OFFICE_CLEANING',
  'MOVE_OUT_CLEANING',
  'RESIDENTIAL_CLEANING',
  'WINDOW_CLEANING',
  'CONSTRUCTION_CLEANING',
  'BUILDING_MAINTENANCE',
  'SPECIAL',
]);

// ---------------------------------------------------------------------------
//  Leads
// ---------------------------------------------------------------------------

/** Öffentliches Kontaktformular — erzeugt einen Lead. */
export const contactFormSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  email: emailSchema,
  phone: optionalPhoneSchema,
  company: z.string().trim().max(120).optional(),
  postalCode: postalCodeSchema.optional(),
  city: z.string().trim().max(80).optional(),
  serviceKind: serviceKindEnum.optional(),
  message: z
    .string()
    .trim()
    .min(10, 'Bitte beschreiben Sie Ihr Anliegen (mind. 10 Zeichen).')
    .max(4000),
  acceptPrivacy: consentSchema,
  // Kampagnen-Tracking
  utmSource: z.string().max(80).optional(),
  utmMedium: z.string().max(80).optional(),
  utmCampaign: z.string().max(120).optional(),
  referrerUrl: z.string().max(500).optional(),
  landingPath: z.string().max(300).optional(),
  website: honeypotSchema,
});
export type ContactFormInput = z.infer<typeof contactFormSchema>;

/** Offertanfrage — ausführlicher als das Kontaktformular. */
export const quoteRequestSchema = contactFormSchema.extend({
  serviceKind: serviceKindEnum,
  street: z.string().trim().max(120).optional(),
  squareMeters: z.number().int().min(5).max(20000).optional(),
  rooms: z.number().min(0.5).max(100).optional(),
  frequency: z
    .enum(['ONCE', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'CUSTOM'])
    .default('ONCE'),
  preferredDate: dateOnlySchema.optional(),
  fileIds: z.array(cuidSchema).max(10).default([]),
});
export type QuoteRequestInput = z.infer<typeof quoteRequestSchema>;

export const createLeadSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  email: emailSchema,
  phone: optionalPhoneSchema,
  company: z.string().trim().max(120).optional(),
  street: z.string().trim().max(120).optional(),
  postalCode: postalCodeSchema.optional(),
  city: z.string().trim().max(80).optional(),
  serviceKind: serviceKindEnum.optional(),
  message: z.string().trim().max(4000).optional(),
  estimatedValue: z.number().min(0).max(1_000_000).optional(),
  source: z
    .enum([
      'WEBSITE', 'PHONE', 'EMAIL', 'REFERRAL', 'GOOGLE_ADS',
      'META_ADS', 'SEO', 'WALK_IN', 'PARTNER', 'OTHER',
    ])
    .default('WEBSITE'),
  stageId: cuidSchema.optional(),
  ownerId: cuidSchema.optional(),
  nextFollowUpAt: z.coerce.date().optional(),
  tagIds: z.array(cuidSchema).max(20).default([]),
});
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

export const updateLeadSchema = createLeadSchema.partial().extend({
  status: z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST']).optional(),
  lostReason: z.string().trim().max(500).optional(),
  score: z.number().int().min(0).max(100).optional(),
});
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

export const convertLeadSchema = z.object({
  createCustomer: z.boolean().default(true),
  sendWelcomeEmail: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
//  Kunden
// ---------------------------------------------------------------------------

export const createCustomerSchema = z.object({
  type: z.enum(['PRIVATE', 'BUSINESS']).default('PRIVATE'),
  companyName: z.string().trim().max(140).optional(),
  firstName: nameSchema,
  lastName: nameSchema,
  email: emailSchema,
  phone: optionalPhoneSchema,
  mobile: optionalPhoneSchema,
  vatNumber: z.string().trim().max(40).optional(),
  language: localeSchema,
  birthday: dateOnlySchema.optional(),
  notes: z.string().trim().max(4000).optional(),
  internalNotes: z.string().trim().max(4000).optional(),
  paymentTermDays: z.number().int().min(0).max(180).default(30),
  discountPercent: percentSchema.default(0),
  creditLimit: z.number().min(0).max(1_000_000).optional(),
  taxExempt: z.boolean().default(false),
  tagIds: z.array(cuidSchema).max(20).default([]),
  address: addressSchema.optional(),
  /** Legt gleichzeitig einen Login an und versendet die Einladung. */
  createLogin: z.boolean().default(false),
})
  .refine((d) => d.type !== 'BUSINESS' || Boolean(d.companyName), {
    message: 'Für Geschäftskunden ist der Firmenname erforderlich.',
    path: ['companyName'],
  });
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z.object({
  type: z.enum(['PRIVATE', 'BUSINESS']).optional(),
  companyName: z.string().trim().max(140).optional(),
  firstName: nameSchema.optional(),
  lastName: nameSchema.optional(),
  email: emailSchema.optional(),
  phone: optionalPhoneSchema,
  mobile: optionalPhoneSchema,
  vatNumber: z.string().trim().max(40).optional(),
  language: localeSchema.optional(),
  birthday: dateOnlySchema.optional(),
  notes: z.string().trim().max(4000).optional(),
  internalNotes: z.string().trim().max(4000).optional(),
  paymentTermDays: z.number().int().min(0).max(180).optional(),
  discountPercent: percentSchema.optional(),
  creditLimit: z.number().min(0).max(1_000_000).optional(),
  taxExempt: z.boolean().optional(),
  blocked: z.boolean().optional(),
  blockedReason: z.string().trim().max(500).optional(),
  tagIds: z.array(cuidSchema).max(20).optional(),
});
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

// ---------------------------------------------------------------------------
//  Adressen, Objekte, Kontakte
// ---------------------------------------------------------------------------

export const createAddressSchema = addressSchema.extend({
  firstName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  company: z.string().trim().max(140).optional(),
  isBilling: z.boolean().default(false),
  isDefault: z.boolean().default(false),
});
export type CreateAddressInput = z.infer<typeof createAddressSchema>;

export const createPropertySchema = z.object({
  label: z.string().trim().min(2, 'Bitte benennen Sie das Objekt.').max(80),
  kind: z.enum([
    'APARTMENT', 'HOUSE', 'OFFICE', 'COMMERCIAL', 'INDUSTRIAL',
    'CONSTRUCTION_SITE', 'PRACTICE', 'RESTAURANT', 'SCHOOL', 'OTHER',
  ]).default('APARTMENT'),
  addressId: cuidSchema.optional(),
  address: addressSchema.optional(),
  squareMeters: z.number().int().min(5).max(50000).optional(),
  rooms: z.number().min(0.5).max(200).optional(),
  bathrooms: z.number().int().min(0).max(50).optional(),
  windows: z.number().int().min(0).max(2000).optional(),
  floor: z.number().int().min(-5).max(60).optional(),
  hasBalcony: z.boolean().default(false),
  hasGarden: z.boolean().default(false),
  hasPets: z.boolean().default(false),
  hasElevator: z.boolean().default(false),
  parkingInfo: z.string().trim().max(300).optional(),
  keyLocation: z.string().trim().max(300).optional(),
  alarmCode: z.string().trim().max(60).optional(),
  accessNote: z.string().trim().max(1000).optional(),
  notes: z.string().trim().max(2000).optional(),
})
  .refine((d) => Boolean(d.addressId) || Boolean(d.address), {
    message: 'Bitte geben Sie eine Adresse an.',
    path: ['address'],
  });
export type CreatePropertyInput = z.infer<typeof createPropertySchema>;

export const createContactSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  position: z.string().trim().max(80).optional(),
  email: emailSchema.optional(),
  phone: optionalPhoneSchema,
  mobile: optionalPhoneSchema,
  isPrimary: z.boolean().default(false),
  notes: z.string().trim().max(1000).optional(),
});
export type CreateContactInput = z.infer<typeof createContactSchema>;

// ---------------------------------------------------------------------------
//  Aktivitäten & Aufgaben
// ---------------------------------------------------------------------------

export const createActivitySchema = z.object({
  type: z.enum(['NOTE', 'CALL', 'EMAIL', 'SMS', 'MEETING', 'TASK', 'FILE_UPLOAD']).default('NOTE'),
  subject: z.string().trim().min(2, 'Bitte geben Sie einen Betreff an.').max(200),
  body: z.string().trim().max(8000).optional(),
  durationMinutes: z.number().int().min(0).max(1440).optional(),
  occurredAt: z.coerce.date().optional(),
  customerId: cuidSchema.optional(),
  leadId: cuidSchema.optional(),
  jobId: cuidSchema.optional(),
  bookingId: cuidSchema.optional(),
  quoteId: cuidSchema.optional(),
  invoiceId: cuidSchema.optional(),
});
export type CreateActivityInput = z.infer<typeof createActivitySchema>;

export const createTaskSchema = z.object({
  title: z.string().trim().min(3, 'Bitte geben Sie einen Titel an.').max(200),
  description: z.string().trim().max(4000).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  dueAt: z.coerce.date().optional(),
  reminderAt: z.coerce.date().optional(),
  assigneeId: cuidSchema.optional(),
  customerId: cuidSchema.optional(),
  leadId: cuidSchema.optional(),
  jobId: cuidSchema.optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = createTaskSchema.partial().extend({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(),
});
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

// ---------------------------------------------------------------------------
//  Nachrichten & Bewertungen
// ---------------------------------------------------------------------------

export const createMessageSchema = z.object({
  threadId: cuidSchema.optional(),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1, 'Die Nachricht darf nicht leer sein.').max(8000),
  customerId: cuidSchema.optional(),
  jobId: cuidSchema.optional(),
  fileIds: z.array(cuidSchema).max(10).default([]),
});
export type CreateMessageInput = z.infer<typeof createMessageSchema>;

export const createReviewSchema = z.object({
  bookingId: cuidSchema.optional(),
  rating: z.number().int().min(1, 'Bitte vergeben Sie mindestens 1 Stern.').max(5),
  title: z.string().trim().max(120).optional(),
  body: z
    .string()
    .trim()
    .min(10, 'Bitte schreiben Sie mindestens 10 Zeichen.')
    .max(2000),
  authorName: nameSchema.optional(),
});
export type CreateReviewInput = z.infer<typeof createReviewSchema>;

export const newsletterSchema = z.object({
  email: emailSchema,
  firstName: z.string().trim().max(80).optional(),
  locale: localeSchema,
  source: z.string().max(80).optional(),
  website: honeypotSchema,
});
export type NewsletterInput = z.infer<typeof newsletterSchema>;

export const jobApplicationSchema = z.object({
  postingId: cuidSchema,
  firstName: nameSchema,
  lastName: nameSchema,
  email: emailSchema,
  phone: phoneSchema,
  message: z.string().trim().max(4000).optional(),
  cvFileId: cuidSchema.optional(),
  availableFrom: dateOnlySchema.optional(),
  acceptPrivacy: consentSchema,
  website: honeypotSchema,
});
export type JobApplicationInput = z.infer<typeof jobApplicationSchema>;
