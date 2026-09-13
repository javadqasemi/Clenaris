import { z } from 'zod';
import {
  assetUrlSchema,
  cuidSchema,
  dateOnlySchema,
  moneySchema,
  percentSchema,
  timeSchema,
} from './common';

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

/**
 * Checkliste eines Einsatzes vollständig setzen.
 *
 * Bewusst „ersetzen" statt „einzelne Punkte anlegen/ändern/löschen": Eine
 * Checkliste wird als Ganzes bearbeitet — Punkte werden umsortiert, umbenannt,
 * zusammengelegt. Drei Endpunkte dafür hiessen drei Netzrunden für eine
 * Bearbeitung und ein Zwischenzustand, in dem die Liste weder alt noch neu ist.
 *
 * `id` bleibt erhalten, wo sie mitgeschickt wird — nur so überlebt der
 * Erledigt-Haken eines Punktes, den jemand nur umbenannt hat.
 */
export const jobChecklistSchema = z.object({
  items: z
    .array(
      z.object({
        id: cuidSchema.optional(),
        label: z.string().trim().min(2, 'Bitte benennen Sie den Punkt.').max(200),
        room: z.string().trim().max(80).nullish(),
        required: z.boolean().default(true),
      }),
    )
    .max(200),
  /** Bestehende Erledigt-Haken übernehmen (Standard) oder zurücksetzen. */
  keepProgress: z.boolean().default(true),
});
export type JobChecklistInput = z.infer<typeof jobChecklistSchema>;

/** Eine der hinterlegten Standardchecklisten übernehmen. */
export const jobChecklistTemplateSchema = z.object({
  kind: z.enum([
    'RESIDENTIAL_CLEANING',
    'MOVE_OUT_CLEANING',
    'OFFICE_CLEANING',
    'WINDOW_CLEANING',
    'CONSTRUCTION_CLEANING',
    'BUILDING_MAINTENANCE',
    'SPECIAL',
  ]),
  /** true = bestehende Punkte ersetzen, false = anhängen. */
  replace: z.boolean().default(false),
});
export type JobChecklistTemplateInput = z.infer<typeof jobChecklistTemplateSchema>;

/**
 * Team eines Einsatzes.
 *
 * Anders als `assignJobSchema` (Kalender: „diese Leute, erste ist Leitung")
 * trägt hier jede Person ihre eigene Rolle. Im Kalender ist die Zuteilung eine
 * schnelle Geste, auf der Einsatzseite eine bewusste Aufstellung — Lernende
 * und Aufsicht lassen sich nur hier unterscheiden.
 */
export const jobTeamSchema = z.object({
  members: z
    .array(
      z.object({
        employeeId: cuidSchema,
        role: z.enum(['LEAD', 'MEMBER', 'TRAINEE', 'SUPERVISOR']).default('MEMBER'),
      }),
    )
    .max(20)
    .refine(
      (list) => new Set(list.map((member) => member.employeeId)).size === list.length,
      { message: 'Jede Person darf nur einmal im Team stehen.' },
    ),
  /** Nur neu hinzugekommene Personen werden benachrichtigt. */
  notify: z.boolean().default(true),
});
export type JobTeamInput = z.infer<typeof jobTeamSchema>;

/**
 * Nachkalkulation.
 *
 * `recalculate` und die Zahlenfelder schliessen sich aus: Entweder man lässt
 * die Werte aus Zeiterfassung, Material und Auftrag neu herleiten, oder man
 * setzt sie von Hand. Beides in einem Aufruf wäre eine Rechnung, deren
 * Ergebnis von der Reihenfolge abhinge.
 */
export const jobCostingSchema = z
  .object({
    revenue: moneySchema.optional(),
    laborCost: moneySchema.optional(),
    materialCost: moneySchema.optional(),
    /** Aus Zeiterfassung, Materialverbrauch und Auftragswert neu herleiten. */
    recalculate: z.boolean().default(false),
    /** Abnahme der Nachkalkulation — setzt den Einsatz auf „kontrolliert". */
    approve: z.boolean().default(false),
    note: z.string().trim().max(2000).optional(),
  })
  .refine(
    (data) =>
      !data.recalculate ||
      (data.revenue === undefined &&
        data.laborCost === undefined &&
        data.materialCost === undefined),
    {
      message: 'Neu berechnen und Werte von Hand setzen schliessen sich aus.',
      path: ['recalculate'],
    },
  );
export type JobCostingInput = z.infer<typeof jobCostingSchema>;

/** Foto nachträglich einordnen — Art, Raum, Bildlegende. */
export const updateJobPhotoSchema = z
  .object({
    type: z.enum(['BEFORE', 'AFTER', 'DAMAGE', 'DOCUMENT', 'OTHER']).optional(),
    caption: z.string().trim().max(300).nullish(),
    room: z.string().trim().max(80).nullish(),
  })
  .strict();
export type UpdateJobPhotoInput = z.infer<typeof updateJobPhotoSchema>;

/** Verwendetes Material eines Einsatzes vollständig setzen. */
export const jobMaterialsSchema = z.object({
  materials: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(120),
        sku: z.string().trim().max(60).nullish(),
        quantity: z.number().min(0.01).max(10000),
        unit: z.string().trim().max(20).default('Stk.'),
        unitCost: moneySchema.default(0),
        billable: z.boolean().default(false),
      }),
    )
    .max(50),
});
export type JobMaterialsInput = z.infer<typeof jobMaterialsSchema>;

/**
 * Ein- und Ausstempeln aus dem Mitarbeitendenportal.
 *
 * `lat` und `lng` sind **freiwillig**, und das ist die ganze Pointe: In
 * Tiefgaragen, Kellern und Treppenhäusern gibt es kein GPS. Zuvor verlangte
 * das Schema beide Werte, worauf das Portal in diesem Fall `0/0` schickte —
 * Koordinaten mitten im Atlantik. Der Server rechnete daraus pflichtbewusst
 * eine Entfernung von einigen tausend Kilometern zur Einsatzadresse aus,
 * markierte jede Stempelung ohne Empfang als verdächtig und legte einen
 * Standortnachweis an, der schlicht erfunden war.
 *
 * „Kein Standort" muss darstellbar sein, sonst wird er erfunden.
 */
export const clockSchema = z.object({
  jobId: cuidSchema,
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  accuracy: z.number().min(0).max(100_000).nullish(),
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
  url: assetUrlSchema,
  thumbnailUrl: assetUrlSchema.optional(),
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

/**
 * Ändern: alle Felder freiwillig — **ohne** `role`.
 *
 * Die Rolle ist keine Personalangabe, sondern eine Rechtevergabe. Sie stand
 * hier drin, und `employee:update` besitzt auch die Betriebsleitung — die
 * damit über die Personalakte ein Konto zur Administration hätte machen
 * können, ohne je `role:assign` zu besitzen. Rollen wechselt ausschliesslich
 * `PATCH /api/users/:id/role`.
 */
export const updateEmployeeSchema = createEmployeeSchema
  .omit({ role: true, sendInvite: true })
  .partial()
  .extend({
    active: z.boolean().optional(),
    terminatedAt: dateOnlySchema.optional(),
  });
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

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
