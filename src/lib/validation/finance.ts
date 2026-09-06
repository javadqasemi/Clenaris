import { z } from 'zod';
import { cuidSchema, dateOnlySchema, moneySchema, percentSchema } from './common';

export const invoiceItemSchema = z.object({
  id: cuidSchema.optional(),
  jobId: cuidSchema.nullish(),
  name: z.string().trim().min(2, 'Bezeichnung ist erforderlich.').max(200),
  description: z.string().trim().max(2000).optional(),
  quantity: z.number().min(0.01).max(10000),
  unit: z.string().trim().max(20).default('Std.'),
  unitPrice: moneySchema,
  discount: percentSchema.default(0),
  vatRate: z.number().min(0).max(30).default(8.1),
});
export type InvoiceItemInput = z.infer<typeof invoiceItemSchema>;

export const createInvoiceSchema = z.object({
  customerId: cuidSchema,
  bookingId: cuidSchema.optional(),
  quoteId: cuidSchema.optional(),
  issueDate: dateOnlySchema.optional(),
  dueDate: dateOnlySchema.optional(),
  periodFrom: dateOnlySchema.optional(),
  periodTo: dateOnlySchema.optional(),
  introText: z.string().trim().max(4000).optional(),
  outroText: z.string().trim().max(4000).optional(),
  notes: z.string().trim().max(4000).optional(),
  discountAmount: moneySchema.default(0),
  items: z.array(invoiceItemSchema).min(1, 'Mindestens eine Position ist erforderlich.').max(200),
  /** true = direkt ausstellen (Nummer vergeben, unveränderlich). */
  issueImmediately: z.boolean().default(false),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export const updateInvoiceSchema = createInvoiceSchema.partial().omit({ issueImmediately: true });

/** Sammelrechnung aus mehreren abgeschlossenen Jobs. */
export const invoiceFromJobsSchema = z.object({
  customerId: cuidSchema,
  jobIds: z.array(cuidSchema).min(1, 'Bitte wählen Sie mindestens einen Auftrag.').max(100),
  periodFrom: dateOnlySchema.optional(),
  periodTo: dateOnlySchema.optional(),
  issueImmediately: z.boolean().default(false),
});

export const sendInvoiceSchema = z.object({
  email: z.string().email().optional(),
  subject: z.string().trim().max(200).optional(),
  message: z.string().trim().max(4000).optional(),
});

export const recordPaymentSchema = z.object({
  amount: moneySchema.refine((v) => v > 0, 'Der Betrag muss grösser als 0 sein.'),
  method: z.enum([
    'CARD', 'TWINT', 'BANK_TRANSFER', 'CASH', 'SEPA', 'GIFT_CARD', 'CREDIT_NOTE', 'OTHER',
  ]).default('BANK_TRANSFER'),
  paidAt: z.coerce.date().optional(),
  reference: z.string().trim().max(120).optional(),
  note: z.string().trim().max(1000).optional(),
});
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const createCreditNoteSchema = z.object({
  invoiceId: cuidSchema.optional(),
  customerId: cuidSchema,
  reason: z.string().trim().min(3, 'Bitte geben Sie einen Grund an.').max(500),
  issueDate: dateOnlySchema.optional(),
  items: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(200),
        quantity: z.number().min(0.01).max(10000).default(1),
        unit: z.string().trim().max(20).default('Stk.'),
        unitPrice: moneySchema,
        vatRate: z.number().min(0).max(30).default(8.1),
      }),
    )
    .min(1, 'Mindestens eine Position ist erforderlich.')
    .max(100),
});
export type CreateCreditNoteInput = z.infer<typeof createCreditNoteSchema>;

export const createExpenseSchema = z.object({
  supplierId: cuidSchema.optional(),
  category: z.enum([
    'MATERIAL', 'EQUIPMENT', 'VEHICLE', 'FUEL', 'INSURANCE', 'RENT', 'SALARY',
    'SOCIAL_SECURITY', 'MARKETING', 'SOFTWARE', 'TRAINING', 'TAXES', 'OTHER',
  ]).default('MATERIAL'),
  description: z.string().trim().min(3, 'Bitte beschreiben Sie die Ausgabe.').max(300),
  reference: z.string().trim().max(120).optional(),
  expenseDate: dateOnlySchema,
  netAmount: moneySchema,
  vatRate: z.number().min(0).max(30).default(8.1),
  paid: z.boolean().default(false),
  paidAt: z.coerce.date().optional(),
  vatDeductible: z.boolean().default(true),
  notes: z.string().trim().max(2000).optional(),
  fileIds: z.array(cuidSchema).max(10).default([]),
});
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const createSupplierSchema = z.object({
  name: z.string().trim().min(2, 'Name ist erforderlich.').max(140),
  contactName: z.string().trim().max(120).optional(),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().trim().max(30).optional(),
  street: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().max(10).optional(),
  city: z.string().trim().max(80).optional(),
  country: z.string().trim().length(2).default('CH'),
  vatNumber: z.string().trim().max(40).optional(),
  iban: z.string().trim().max(40).optional(),
  paymentTermDays: z.number().int().min(0).max(180).default(30),
  notes: z.string().trim().max(2000).optional(),
});
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

/** Zahlung starten (Stripe Card / TWINT). */
export const startPaymentSchema = z.object({
  invoiceId: cuidSchema,
  method: z.enum(['CARD', 'TWINT']).default('CARD'),
  returnUrl: z.string().url().optional(),
});
export type StartPaymentInput = z.infer<typeof startPaymentSchema>;

export const accountingExportSchema = z.object({
  format: z.enum(['csv', 'bexio', 'abacus', 'banana', 'datev']).default('csv'),
  periodFrom: dateOnlySchema,
  periodTo: dateOnlySchema,
  include: z
    .array(z.enum(['invoices', 'payments', 'expenses', 'credit_notes']))
    .min(1)
    .default(['invoices', 'payments', 'expenses']),
}).refine((d) => d.periodTo >= d.periodFrom, {
  message: 'Das Enddatum darf nicht vor dem Startdatum liegen.',
  path: ['periodTo'],
});
export type AccountingExportInput = z.infer<typeof accountingExportSchema>;

export const reportQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  granularity: z.enum(['day', 'week', 'month', 'quarter', 'year']).default('month'),
  compare: z.coerce.boolean().default(true),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

// ---------------------------------------------------------------------------
//  Zahlung, Storno und Versand
// ---------------------------------------------------------------------------

/**
 * Online-Zahlung starten.
 *
 * Der Betrag kommt bewusst *nicht* mit: er stammt immer aus dem Feld
 * `balance` der Rechnung. Ein vom Client gelieferter Betrag wäre eine
 * Einladung, eine Rechnung über zwei Franken zu begleichen.
 */
export const payInvoiceSchema = z.object({
  method: z.enum(['CARD', 'TWINT']).default('CARD'),
});
export type PayInvoiceInput = z.infer<typeof payInvoiceSchema>;

/** Storno verlangt einen Grund — er landet im Prüfprotokoll und in der Gutschrift. */
export const cancelInvoiceSchema = z.object({
  reason: z.string().trim().min(3, 'Bitte nennen Sie einen Grund.').max(500),
});
export type CancelInvoiceInput = z.infer<typeof cancelInvoiceSchema>;

/** Abweichende Empfängeradresse beim Versand; sonst gilt die der Kundenakte. */
export const sendInvoiceEmailSchema = z.object({
  email: z.string().email().optional(),
});
export type SendInvoiceEmailInput = z.infer<typeof sendInvoiceEmailSchema>;
