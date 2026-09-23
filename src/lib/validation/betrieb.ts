import { z } from 'zod';

/**
 * Schemata des Betriebs (Wave 11): Reklamationen/Vorfälle, Material und
 * Lager, Geräte.
 *
 * **Keine Frist von aussen.** Die Reaktionsfrist einer Reklamation kommt aus
 * der Vertragsfassung, die am Meldezeitpunkt galt — kein Feld nimmt sie
 * entgegen. Eine Frist, die man beim Erfassen setzen könnte, wäre eine, die
 * man nach einer verpassten Reaktion nachträglich passend setzt.
 *
 * **Kein Bestand von aussen.** Der Lagerbestand ist die Summe der
 * Bewegungen; es gibt kein Feld „Bestand".
 */

const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT.');
const text = (max: number) => z.string().trim().min(1).max(max);
const betrag = z.number().min(0).max(1_000_000);

// ---------------------------------------------------------------------------
//  Reklamationen und Vorfälle
// ---------------------------------------------------------------------------

export const COMPLAINT_KINDS = ['COMPLAINT', 'INCIDENT', 'DAMAGE'] as const;
export const COMPLAINT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const COMPLAINT_CHANNELS = ['PHONE', 'EMAIL', 'PORTAL', 'ON_SITE', 'OTHER'] as const;
export const COMPLAINT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REJECTED'] as const;

/** Erfassen durch den Betrieb — auch im Namen der Kundschaft (Telefon, vor Ort). */
export const complaintCreateSchema = z.object({
  customerId: z.string().min(1),
  propertyId: z.string().min(1).nullable().optional(),
  contractId: z.string().min(1).nullable().optional(),
  jobId: z.string().min(1).nullable().optional(),
  kind: z.enum(COMPLAINT_KINDS).default('COMPLAINT'),
  severity: z.enum(COMPLAINT_SEVERITIES).default('MEDIUM'),
  channel: z.enum(COMPLAINT_CHANNELS).default('PHONE'),
  title: text(160),
  description: text(4000),
  /**
   * Wann die Meldung einging — für telefonische Meldungen, die erst später
   * erfasst werden. Nicht in der Zukunft (Dienst) und nicht älter als 30
   * Tage: Eine rückdatierte Meldung verschöbe die Frist.
   */
  reportedAt: z.string().datetime({ offset: true }).optional(),
  assigneeId: z.string().min(1).nullable().optional(),
});

/** Meldung der Kundschaft im Kundenbereich — ohne Schweregrad, Kanal und Zuständigkeit. */
export const complaintOwnCreateSchema = z.object({
  propertyId: z.string().min(1).nullable().optional(),
  jobId: z.string().min(1).nullable().optional(),
  kind: z.enum(COMPLAINT_KINDS).default('COMPLAINT'),
  title: text(160),
  description: text(4000),
});

export const complaintUpdateSchema = z
  .object({
    severity: z.enum(COMPLAINT_SEVERITIES).optional(),
    assigneeId: z.string().min(1).nullable().optional(),
    internalNote: z.string().trim().max(4000).nullable().optional(),
    title: text(160).optional(),
  })
  .refine((wert) => Object.keys(wert).length > 0, { message: 'Es wurde nichts zum Ändern angegeben.' });

export const COMPLAINT_ACTIONS = ['ACKNOWLEDGE', 'START', 'RESOLVE', 'CLOSE', 'REJECT', 'REOPEN'] as const;

export const complaintTransitionSchema = z
  .object({
    action: z.enum(COMPLAINT_ACTIONS),
    /** Für die Kundschaft sichtbar — Pflicht beim Erledigen und Ablehnen. */
    resolution: z.string().trim().max(4000).optional(),
  })
  .superRefine((wert, ctx) => {
    if ((wert.action === 'RESOLVE' || wert.action === 'REJECT') && !wert.resolution?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['resolution'], message: 'Bitte festhalten, was getan wurde bzw. warum abgelehnt wird.' });
    }
  });

export const complaintQuerySchema = z.object({
  status: z.enum(COMPLAINT_STATUSES).optional(),
  customerId: z.string().min(1).optional(),
  /** Nur die, deren Reaktionsfrist verstrichen ist, ohne dass reagiert wurde. */
  ueberfaellig: z.enum(['true', 'false']).optional(),
  offen: z.enum(['true', 'false']).optional(),
});

export const complaintCorrectiveActionSchema = z.object({
  title: text(160),
  rootCause: z.string().trim().max(2000).optional(),
  dueOn: datum.optional(),
});

// ---------------------------------------------------------------------------
//  Material und Lager
// ---------------------------------------------------------------------------

export const materialCreateSchema = z.object({
  sku: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9._-]+$/, 'Nur Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich.'),
  name: text(120),
  unit: z.string().trim().min(1).max(20).default('Stk.'),
  unitCost: betrag.default(0),
  minStock: betrag.default(0),
  note: z.string().trim().max(1000).nullable().optional(),
});

export const materialUpdateSchema = z
  .object({
    name: text(120).optional(),
    unit: z.string().trim().min(1).max(20).optional(),
    unitCost: betrag.optional(),
    minStock: betrag.optional(),
    active: z.boolean().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((wert) => Object.keys(wert).length > 0, { message: 'Es wurde nichts zum Ändern angegeben.' });

export const STOCK_KINDS = ['RECEIPT', 'ISSUE', 'RETURN', 'ADJUSTMENT'] as const;

/**
 * Eine Lagerbewegung. Die Menge wird **ohne Vorzeichen** angegeben — die Art
 * bestimmt die Richtung. Nur die Inventurkorrektur trägt ein Vorzeichen, und
 * sie verlangt eine Begründung.
 */
export const stockMovementCreateSchema = z
  .object({
    kind: z.enum(STOCK_KINDS),
    quantity: z.number().refine((v) => v !== 0, 'Eine Bewegung über null ist keine.').refine((v) => Math.abs(v) <= 1_000_000, 'Zu gross.'),
    unitCost: betrag.optional(),
    jobId: z.string().min(1).nullable().optional(),
    reference: z.string().trim().max(120).nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .superRefine((wert, ctx) => {
    if (wert.kind !== 'ADJUSTMENT' && wert.quantity < 0) {
      ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'Die Menge ohne Vorzeichen angeben — die Art bestimmt die Richtung.' });
    }
    if (wert.kind === 'ADJUSTMENT' && !wert.note?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'Eine Inventurkorrektur braucht eine Begründung.' });
    }
    if (wert.kind === 'ISSUE' && !wert.jobId && !wert.note?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['jobId'], message: 'Eine Entnahme gehört zu einem Einsatz — oder braucht eine Begründung.' });
    }
  });

/** Material aus dem Lager für einen Einsatz — erzeugt Verbrauchszeile und Entnahme in einem Schritt. */
export const jobMaterialIssueSchema = z.object({
  materialId: z.string().min(1),
  quantity: z.number().positive().max(100_000),
  billable: z.boolean().default(false),
});

export const materialQuerySchema = z.object({
  nachbestellen: z.enum(['true', 'false']).optional(),
  inaktive: z.enum(['true', 'false']).optional(),
});

// ---------------------------------------------------------------------------
//  Geräte
// ---------------------------------------------------------------------------

export const equipmentCreateSchema = z.object({
  name: text(120),
  category: z.string().trim().max(60).nullable().optional(),
  serialNumber: z.string().trim().max(80).nullable().optional(),
  purchasedOn: datum.nullable().optional(),
  purchaseCost: betrag.nullable().optional(),
  maintenanceIntervalDays: z.number().int().min(1).max(3650).nullable().optional(),
  nextMaintenanceOn: datum.nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

export const equipmentUpdateSchema = z
  .object({
    name: text(120).optional(),
    category: z.string().trim().max(60).nullable().optional(),
    serialNumber: z.string().trim().max(80).nullable().optional(),
    maintenanceIntervalDays: z.number().int().min(1).max(3650).nullable().optional(),
    nextMaintenanceOn: datum.nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((wert) => Object.keys(wert).length > 0, { message: 'Es wurde nichts zum Ändern angegeben.' });

export const equipmentAssignSchema = z.object({
  /** `null` gibt das Gerät zurück ins Lager. */
  employeeId: z.string().min(1).nullable(),
});

export const equipmentMaintenanceSchema = z.object({
  performedOn: datum,
  kind: z.string().trim().min(1).max(60).default('Wartung'),
  note: z.string().trim().max(1000).optional(),
  cost: betrag.optional(),
  /** Nach der Wartung wieder verfügbar (Standard) — sonst bleibt der Status. */
  wiederVerfuegbar: z.boolean().default(true),
});

export const equipmentStatusSchema = z
  .object({
    status: z.enum(['AVAILABLE', 'MAINTENANCE', 'RETIRED']),
    reason: z.string().trim().max(500).optional(),
  })
  .superRefine((wert, ctx) => {
    if (wert.status === 'RETIRED' && !wert.reason?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Bitte den Grund der Ausmusterung angeben.' });
    }
  });

export const equipmentQuerySchema = z.object({
  status: z.enum(['AVAILABLE', 'IN_USE', 'MAINTENANCE', 'RETIRED']).optional(),
  wartungFaellig: z.enum(['true', 'false']).optional(),
});

export type ComplaintCreateInput = z.infer<typeof complaintCreateSchema>;
export type ComplaintOwnCreateInput = z.infer<typeof complaintOwnCreateSchema>;
export type ComplaintUpdateInput = z.infer<typeof complaintUpdateSchema>;
export type ComplaintTransitionInput = z.infer<typeof complaintTransitionSchema>;
export type MaterialCreateInput = z.infer<typeof materialCreateSchema>;
export type MaterialUpdateInput = z.infer<typeof materialUpdateSchema>;
export type StockMovementCreateInput = z.infer<typeof stockMovementCreateSchema>;
export type EquipmentCreateInput = z.infer<typeof equipmentCreateSchema>;
export type EquipmentUpdateInput = z.infer<typeof equipmentUpdateSchema>;
export type EquipmentMaintenanceInput = z.infer<typeof equipmentMaintenanceSchema>;
