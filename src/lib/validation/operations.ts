import { z } from 'zod';
import { cuidSchema, dateOnlySchema, moneySchema, percentSchema, timeSchema } from './common';

// ---------------------------------------------------------------------------
//  Offerten
// ---------------------------------------------------------------------------

export const quoteItemSchema = z.object({
  id: cuidSchema.optional(),
  serviceId: cuidSchema.nullish(),
  name: z.string().trim().min(2, 'Bezeichnung ist erforderlich.').max(200),
  description: z.string().trim().max(2000).optional(),
  quantity: z.number().min(0.01).max(10000),
  unit: z.string().trim().max(20).default('Std.'),
  unitPrice: moneySchema,
  discount: percentSchema.default(0),
  vatRate: z.number().min(0).max(30).default(8.1),
  optional: z.boolean().default(false),
});
export type QuoteItemInput = z.infer<typeof quoteItemSchema>;

/**
 * Basisobjekt ohne `.refine`, damit `.partial()` für das Update-Schema
 * verfügbar bleibt — `ZodEffects` (das Ergebnis von `.refine`) kennt diese
 * Methode nicht.
 */
const quoteBaseSchema = z.object({
  customerId: cuidSchema.optional(),
  leadId: cuidSchema.optional(),
  propertyId: cuidSchema.optional(),
  title: z.string().trim().min(3, 'Bitte geben Sie einen Titel an.').max(200),
  validUntil: dateOnlySchema,
  introText: z.string().trim().max(4000).optional(),
  outroText: z.string().trim().max(4000).optional(),
  terms: z.string().trim().max(8000).optional(),
  internalNote: z.string().trim().max(4000).optional(),
  discountType: z.enum(['PERCENT', 'FIXED']).optional(),
  discountValue: z.number().min(0).max(1_000_000).default(0),
  items: z.array(quoteItemSchema).min(1, 'Mindestens eine Position ist erforderlich.').max(100),
});

export const createQuoteSchema = quoteBaseSchema.refine(
  (d) => Boolean(d.customerId) || Boolean(d.leadId),
  {
    message: 'Bitte verknüpfen Sie die Offerte mit einem Kunden oder Lead.',
    path: ['customerId'],
  },
);
export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;

export const updateQuoteSchema = quoteBaseSchema.partial();
export type UpdateQuoteInput = z.infer<typeof updateQuoteSchema>;

export const sendQuoteSchema = z.object({
  email: z.string().email().optional(),
  subject: z.string().trim().max(200).optional(),
  message: z.string().trim().max(4000).optional(),
  attachPdf: z.boolean().default(true),
});

/** Kundenantwort auf eine Offerte über den öffentlichen Link. */
export const respondQuoteSchema = z
  .object({
    decision: z.enum(['ACCEPT', 'REJECT']),
    signatureDataUrl: z
      .string()
      .max(500_000, 'Die Unterschrift ist zu gross.')
      .regex(/^data:image\/(png|jpeg);base64,/, 'Ungültiges Unterschriftsformat.')
      .optional(),
    signatureName: z.string().trim().max(120).optional(),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine((d) => d.decision !== 'ACCEPT' || Boolean(d.signatureDataUrl && d.signatureName), {
    message: 'Zur Annahme sind Name und Unterschrift erforderlich.',
    path: ['signatureName'],
  });
export type RespondQuoteInput = z.infer<typeof respondQuoteSchema>;

export const convertQuoteSchema = z.object({
  target: z.enum(['BOOKING', 'INVOICE']),
  scheduledStart: z.coerce.date().optional(),
  addressId: cuidSchema.optional(),
})
  .refine((d) => d.target !== 'BOOKING' || Boolean(d.scheduledStart), {
    message: 'Für die Umwandlung in eine Buchung ist ein Termin erforderlich.',
    path: ['scheduledStart'],
  });

// ---------------------------------------------------------------------------
//  Jobs / Einsätze
// ---------------------------------------------------------------------------

export const createJobSchema = z.object({
  bookingId: cuidSchema.optional(),
  customerId: cuidSchema,
  addressId: cuidSchema.optional(),
  propertyId: cuidSchema.optional(),
  serviceId: cuidSchema.optional(),
  title: z.string().trim().min(3).max(200),
  scheduledStart: z.coerce.date(),
  scheduledEnd: z.coerce.date(),
  crewSize: z.number().int().min(1).max(20).default(1),
  estimatedMin: z.number().int().min(15).max(1440).default(120),
  travelMin: z.number().int().min(0).max(480).default(0),
  description: z.string().trim().max(4000).optional(),
  internalNote: z.string().trim().max(4000).optional(),
  customerNote: z.string().trim().max(4000).optional(),
  employeeIds: z.array(cuidSchema).max(20).default([]),
  checklist: z
    .array(
      z.object({
        label: z.string().trim().min(2).max(200),
        room: z.string().trim().max(80).optional(),
        required: z.boolean().default(true),
      }),
    )
    .max(100)
    .default([]),
})
  .refine((d) => d.scheduledEnd > d.scheduledStart, {
    message: 'Das Ende muss nach dem Beginn liegen.',
    path: ['scheduledEnd'],
  });
export type CreateJobInput = z.infer<typeof createJobSchema>;

export const updateJobSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  status: z
    .enum([
      'UNASSIGNED', 'SCHEDULED', 'DISPATCHED', 'EN_ROUTE', 'IN_PROGRESS',
      'ON_HOLD', 'COMPLETED', 'VERIFIED', 'CANCELLED',
    ])
    .optional(),
  scheduledStart: z.coerce.date().optional(),
  scheduledEnd: z.coerce.date().optional(),
  crewSize: z.number().int().min(1).max(20).optional(),
  estimatedMin: z.number().int().min(15).max(1440).optional(),
  travelMin: z.number().int().min(0).max(480).optional(),
  description: z.string().trim().max(4000).optional(),
  internalNote: z.string().trim().max(4000).optional(),
  customerNote: z.string().trim().max(4000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});
export type UpdateJobInput = z.infer<typeof updateJobSchema>;

/** Drag & Drop im Kalender. */
export const moveJobSchema = z.object({
  scheduledStart: z.coerce.date(),
  scheduledEnd: z.coerce.date(),
  employeeId: cuidSchema.optional(),
}).refine((d) => d.scheduledEnd > d.scheduledStart, {
  message: 'Das Ende muss nach dem Beginn liegen.',
  path: ['scheduledEnd'],
});

export const assignJobSchema = z.object({
  employeeIds: z.array(cuidSchema).min(1, 'Bitte wählen Sie mindestens eine Person.').max(20),
  role: z.enum(['LEAD', 'MEMBER', 'TRAINEE', 'SUPERVISOR']).default('MEMBER'),
  notify: z.boolean().default(true),
});

export const completeJobSchema = z.object({
  completionNote: z.string().trim().max(4000).optional(),
  signatureDataUrl: z
    .string()
    .max(500_000)
    .regex(/^data:image\/(png|jpeg);base64,/, 'Ungültiges Unterschriftsformat.')
    .optional(),
  signatureName: z.string().trim().max(120).optional(),
  materials: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(120),
        sku: z.string().trim().max(60).optional(),
        quantity: z.number().min(0.01).max(10000),
        unit: z.string().trim().max(20).default('Stk.'),
        unitCost: moneySchema.default(0),
        billable: z.boolean().default(false),
      }),
    )
    .max(50)
    .default([]),
});
export type CompleteJobInput = z.infer<typeof completeJobSchema>;

export const checklistToggleSchema = z.object({
  done: z.boolean(),
  note: z.string().trim().max(500).optional(),
});

/** GPS-Ein-/Ausstempeln aus dem Mitarbeiterportal. */
export const clockSchema = z.object({
  jobId: cuidSchema,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(10000).optional(),
  note: z.string().trim().max(500).optional(),
});
export type ClockInput = z.infer<typeof clockSchema>;

export const manualTimeEntrySchema = z.object({
  jobId: cuidSchema.optional(),
  employeeId: cuidSchema.optional(),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date(),
  breakMin: z.number().int().min(0).max(480).default(0),
  note: z.string().trim().max(500).optional(),
}).refine((d) => d.endedAt > d.startedAt, {
  message: 'Das Ende muss nach dem Beginn liegen.',
  path: ['endedAt'],
});

export const jobPhotoSchema = z.object({
  type: z.enum(['BEFORE', 'AFTER', 'DAMAGE', 'DOCUMENT', 'OTHER']).default('BEFORE'),
  url: z.string().url('Ungültige Bild-URL.'),
  thumbnailUrl: z.string().url().optional(),
  caption: z.string().trim().max(300).optional(),
  room: z.string().trim().max(80).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

// ---------------------------------------------------------------------------
//  Personal
// ---------------------------------------------------------------------------

export const createEmployeeSchema = z.object({
  firstName: z.string().trim().min(2).max(80),
  lastName: z.string().trim().min(2).max(80),
  email: z.string().email(),
  phone: z.string().trim().max(30).optional(),
  role: z.enum(['ADMIN', 'MANAGER', 'EMPLOYEE']).default('EMPLOYEE'),
  employmentType: z
    .enum(['FULL_TIME', 'PART_TIME', 'HOURLY', 'TEMPORARY', 'APPRENTICE', 'CONTRACTOR'])
    .default('FULL_TIME'),
  position: z.string().trim().max(80).default('Reinigungskraft'),
  department: z.string().trim().max(80).optional(),
  hiredAt: dateOnlySchema,
  hourlyRate: moneySchema.optional(),
  monthlySalary: moneySchema.optional(),
  workloadPct: z.number().int().min(10).max(100).default(100),
  vacationDaysPerYear: z.number().min(0).max(60).default(20),
  ahvNumber: z
    .string()
    .regex(/^756\.\d{4}\.\d{4}\.\d{2}$/, 'Die AHV-Nummer hat das Format 756.1234.5678.90.')
    .optional(),
  iban: z.string().trim().max(40).optional(),
  nationality: z.string().trim().max(60).optional(),
  permitType: z.enum(['CH', 'B', 'C', 'G', 'L', 'F', 'N']).optional(),
  permitValidUntil: dateOnlySchema.optional(),
  emergencyContact: z.string().trim().max(120).optional(),
  emergencyPhone: z.string().trim().max(30).optional(),
  driverLicense: z.boolean().default(false),
  vehiclePlate: z.string().trim().max(20).optional(),
  languages: z.array(z.enum(['DE', 'EN', 'FR', 'IT'])).default(['DE']),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#0B7285'),
  sendInvite: z.boolean().default(true),
});
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

export const updateEmployeeSchema = createEmployeeSchema.partial().extend({
  active: z.boolean().optional(),
  terminatedAt: dateOnlySchema.optional(),
});

export const absenceRequestSchema = z.object({
  type: z
    .enum([
      'VACATION', 'SICK', 'ACCIDENT', 'MILITARY', 'MATERNITY',
      'PATERNITY', 'UNPAID', 'TRAINING', 'OTHER',
    ])
    .default('VACATION'),
  startDate: dateOnlySchema,
  endDate: dateOnlySchema,
  halfDay: z.boolean().default(false),
  reason: z.string().trim().max(1000).optional(),
}).refine((d) => d.endDate >= d.startDate, {
  message: 'Das Enddatum darf nicht vor dem Startdatum liegen.',
  path: ['endDate'],
});
export type AbsenceRequestInput = z.infer<typeof absenceRequestSchema>;

export const absenceDecisionSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  decisionNote: z.string().trim().max(1000).optional(),
});

export const availabilitySchema = z.object({
  entries: z
    .array(
      z.object({
        weekday: z.number().int().min(0).max(6),
        startTime: timeSchema,
        endTime: timeSchema,
      }),
    )
    .max(30),
});
