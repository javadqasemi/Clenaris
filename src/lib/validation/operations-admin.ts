import { z } from 'zod';
import type { AutomationActionType, AutomationTrigger } from '@prisma/client';

import { moneySchema, postalCodeSchema } from './common';

/**
 * Betriebseinstellungen, die keine Fachdomäne für sich sind: Einsatzgebiet,
 * Newsletter, Automatisierungen und Vorlagen.
 *
 * Sie stehen zusammen, weil jede für sich zu klein für eine eigene Datei wäre
 * und alle vier dieselbe Rolle haben — sie stellen ein, wie der Betrieb
 * arbeitet, statt Geschäftsvorfälle abzubilden.
 */

// ---------------------------------------------------------------------------
//  Einsatzgebiet
// ---------------------------------------------------------------------------

const serviceAreaFields = {
  postalCode: postalCodeSchema,
  city: z.string().trim().min(2, 'Der Ort ist erforderlich.').max(80),
  canton: z.string().trim().length(2, 'Zwei Buchstaben, z. B. BE.').toUpperCase().default('BE'),
  travelFee: moneySchema.default(0),
  travelMinutes: z
    .number()
    .int('Bitte ganze Minuten angeben.')
    .min(0)
    .max(240, 'Über vier Stunden Anfahrt ist kein Einsatzgebiet mehr.')
    .default(0),
  active: z.boolean().default(true),
  lat: z.number().min(-90).max(90).optional().nullable(),
  lng: z.number().min(-180).max(180).optional().nullable(),
};

export const createServiceAreaSchema = z.object(serviceAreaFields);
export const updateServiceAreaSchema = z.object(serviceAreaFields).partial();

/**
 * Mehrere Postleitzahlen auf einmal erfassen.
 *
 * Ein Einsatzgebiet entsteht selten Zeile für Zeile — meist übernimmt man eine
 * Liste aus einer Karte oder einer Tabelle. Einzeln erfasst wären das
 * vierzig Formulare.
 */
export const bulkServiceAreaSchema = z.object({
  areas: z.array(z.object(serviceAreaFields)).min(1).max(500),
  /** true = bestehende Einträge mit gleicher PLZ überschreiben. */
  overwrite: z.boolean().default(false),
});

export type CreateServiceAreaInput = z.infer<typeof createServiceAreaSchema>;
export type UpdateServiceAreaInput = z.infer<typeof updateServiceAreaSchema>;
export type BulkServiceAreaInput = z.infer<typeof bulkServiceAreaSchema>;

// ---------------------------------------------------------------------------
//  Newsletter
// ---------------------------------------------------------------------------

/**
 * Abonnentendaten lassen sich **nicht** bearbeiten — nur lesen und entfernen.
 *
 * Die E-Mail-Adresse ist der Identifikator; sie zu ändern hiesse, jemand
 * anderen anzuschreiben, ohne dass diese Person zugestimmt hat. Der
 * Bestätigungsstatus ist ein Nachweis nach DSG und darf schon gar nicht von
 * Hand gesetzt werden. Was bleibt, ist das Austragen — und das ist ohnehin
 * die einzige Handlung, um die eine Kundschaft je bittet.
 */
export const newsletterListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  confirmed: z.enum(['0', '1']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type NewsletterListQuery = z.infer<typeof newsletterListQuery>;

// ---------------------------------------------------------------------------
//  Automatisierungen
// ---------------------------------------------------------------------------

export const AUTOMATION_TRIGGERS = [
  'BOOKING_CREATED',
  'BOOKING_CONFIRMED',
  'BOOKING_REMINDER_24H',
  'BOOKING_REMINDER_2H',
  'BOOKING_COMPLETED',
  'BOOKING_CANCELLED',
  'QUOTE_SENT',
  'QUOTE_ACCEPTED',
  'QUOTE_EXPIRING',
  'INVOICE_ISSUED',
  'INVOICE_DUE_SOON',
  'INVOICE_OVERDUE',
  'JOB_ASSIGNED',
  'JOB_COMPLETED',
  'CUSTOMER_BIRTHDAY',
  'REVIEW_REQUEST',
  'LEAD_CREATED',
  'LEAD_IDLE',
  'TASK_DUE',
  'RECURRING_BOOKING_GENERATE',
] as const;

export const AUTOMATION_ACTION_TYPES = [
  'SEND_EMAIL',
  'SEND_SMS',
  'CREATE_TASK',
  'CREATE_NOTIFICATION',
  'UPDATE_STATUS',
  'WEBHOOK',
  'AI_GENERATE',
] as const;

/** Bricht den Build, wenn Prisma-Enum und Liste auseinanderlaufen. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const AUTOMATION_ENUMS_IN_SYNC: [
  Exact<AutomationTrigger, (typeof AUTOMATION_TRIGGERS)[number]>,
  Exact<AutomationActionType, (typeof AUTOMATION_ACTION_TYPES)[number]>,
] = [true, true];

const automationActionSchema = z.object({
  type: z.enum(AUTOMATION_ACTION_TYPES),
  config: z.record(z.unknown()).default({}),
  position: z.number().int().min(0).max(99).default(0),
});

const automationFields = {
  name: z.string().trim().min(3, 'Ein Name ist erforderlich.').max(120),
  description: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  trigger: z.enum(AUTOMATION_TRIGGERS),
  conditions: z.record(z.unknown()).default({}),
  /**
   * Verzögerung in Minuten. Negativ heisst „davor" — sinnvoll nur bei
   * terminbezogenen Auslösern, etwa eine Erinnerung 24 Stunden vor dem
   * Einsatz.
   */
  delayMinutes: z
    .number()
    .int()
    .min(-60 * 24 * 30, 'Höchstens 30 Tage davor.')
    .max(60 * 24 * 90, 'Höchstens 90 Tage danach.')
    .default(0),
  active: z.boolean().default(true),
  actions: z.array(automationActionSchema).min(1, 'Ohne Aktion passiert nichts.').max(10),
};

function automationRules(
  value: { trigger?: (typeof AUTOMATION_TRIGGERS)[number]; delayMinutes?: number },
  ctx: z.RefinementCtx,
) {
  /**
   * „Davor" ergibt nur Sinn, wenn der Auslöser ein künftiges Ereignis
   * bezeichnet. Bei „Rechnung ausgestellt" ist der Zeitpunkt bereits
   * vergangen — eine negative Verzögerung würde die Automatisierung nie
   * ausführen, ohne dass es jemand merkt.
   */
  const forwardLooking: string[] = [
    'BOOKING_REMINDER_24H',
    'BOOKING_REMINDER_2H',
    'QUOTE_EXPIRING',
    'INVOICE_DUE_SOON',
    'CUSTOMER_BIRTHDAY',
    'TASK_DUE',
    'RECURRING_BOOKING_GENERATE',
  ];
  if (
    value.delayMinutes !== undefined &&
    value.delayMinutes < 0 &&
    value.trigger &&
    !forwardLooking.includes(value.trigger)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['delayMinutes'],
      message:
        'Eine Verzögerung vor dem Auslöser ist nur bei terminbezogenen Auslösern möglich — sonst würde die Automatisierung nie laufen.',
    });
  }
}

export const createAutomationSchema = z.object(automationFields).superRefine(automationRules);
export const updateAutomationSchema = z
  .object(automationFields)
  .partial()
  .superRefine(automationRules);

export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;
export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>;

// ---------------------------------------------------------------------------
//  Vorlagen
// ---------------------------------------------------------------------------

/**
 * E-Mail- und SMS-Vorlagen lassen sich ändern, aber nicht anlegen oder
 * löschen.
 *
 * Der Schlüssel (`booking_confirmation`, `invoice_issued`, …) steht im Code:
 * dort wird die Vorlage nachgeschlagen. Eine frei angelegte Vorlage mit
 * eigenem Schlüssel würde von niemandem aufgerufen; eine gelöschte liesse
 * eine Bestätigungsmail ausfallen. Was die Redaktion ändern darf, ist der
 * *Text* — und das ist auch das, was sie ändern will.
 */
export const updateEmailTemplateSchema = z.object({
  subject: z.string().trim().min(3, 'Ein Betreff ist erforderlich.').max(200),
  bodyHtml: z.string().trim().min(20, 'Der Text ist zu kurz.').max(50_000),
  bodyText: z
    .string()
    .trim()
    .max(20_000)
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  active: z.boolean().optional(),
});

export const updateSmsTemplateSchema = z.object({
  /**
   * 480 Zeichen sind drei SMS-Segmente. Darüber wird es teuer, ohne dass es
   * jemand merkt — deshalb hier die Grenze und nicht erst beim Versand.
   */
  body: z
    .string()
    .trim()
    .min(10, 'Der Text ist zu kurz.')
    .max(480, 'Über 480 Zeichen kostet der Versand mehr als drei SMS je Empfänger.'),
  active: z.boolean().optional(),
});

export type UpdateEmailTemplateInput = z.infer<typeof updateEmailTemplateSchema>;
export type UpdateSmsTemplateInput = z.infer<typeof updateSmsTemplateSchema>;

// ---------------------------------------------------------------------------
//  Beschriftungen
// ---------------------------------------------------------------------------

export const AUTOMATION_TRIGGER_LABELS: Record<(typeof AUTOMATION_TRIGGERS)[number], string> = {
  BOOKING_CREATED: 'Buchung eingegangen',
  BOOKING_CONFIRMED: 'Buchung bestätigt',
  BOOKING_REMINDER_24H: '24 Stunden vor dem Termin',
  BOOKING_REMINDER_2H: '2 Stunden vor dem Termin',
  BOOKING_COMPLETED: 'Buchung abgeschlossen',
  BOOKING_CANCELLED: 'Buchung storniert',
  QUOTE_SENT: 'Offerte versendet',
  QUOTE_ACCEPTED: 'Offerte angenommen',
  QUOTE_EXPIRING: 'Offerte läuft bald ab',
  INVOICE_ISSUED: 'Rechnung ausgestellt',
  INVOICE_DUE_SOON: 'Rechnung wird bald fällig',
  INVOICE_OVERDUE: 'Rechnung überfällig',
  JOB_ASSIGNED: 'Einsatz zugewiesen',
  JOB_COMPLETED: 'Einsatz abgeschlossen',
  CUSTOMER_BIRTHDAY: 'Geburtstag der Kundschaft',
  REVIEW_REQUEST: 'Bewertung anfragen',
  LEAD_CREATED: 'Anfrage eingegangen',
  LEAD_IDLE: 'Anfrage liegt unbearbeitet',
  TASK_DUE: 'Aufgabe wird fällig',
  RECURRING_BOOKING_GENERATE: 'Wiederkehrende Buchung erzeugen',
};

export const AUTOMATION_ACTION_LABELS: Record<(typeof AUTOMATION_ACTION_TYPES)[number], string> = {
  SEND_EMAIL: 'E-Mail senden',
  SEND_SMS: 'SMS senden',
  CREATE_TASK: 'Aufgabe anlegen',
  CREATE_NOTIFICATION: 'Benachrichtigung erzeugen',
  UPDATE_STATUS: 'Status setzen',
  WEBHOOK: 'Webhook aufrufen',
  AI_GENERATE: 'Text mit KI erzeugen',
};
