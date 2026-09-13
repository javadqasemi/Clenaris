import { z } from 'zod';

import { cuidSchema, postalCodeSchema } from './common';

/**
 * Query-Parameter der Listen- und Nachschlage-Endpunkte.
 *
 * Sie stehen hier und nicht in den Routendateien, damit die OpenAPI-
 * Spezifikation aus denselben Schemas erzeugt werden kann, die zur Laufzeit
 * validieren. Eine Doku, die von der Validierung abweichen *kann*, weicht
 * früher oder später ab.
 *
 * Das Modul zieht bewusst keine serverseitigen Abhängigkeiten nach sich —
 * so lässt es sich auch aus einem einfachen Node-Skript importieren.
 */

// --- Bausteine --------------------------------------------------------------

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const searchQuery = paginationQuery.extend({
  q: z.string().trim().max(120).optional(),
  sort: z.string().max(60).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const dateRangeQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const idParam = z.object({ id: z.string().min(1) });

/** Zwei Segmente: die Kundenakte und die Adresse darin. */
export const addressParams = z.object({ id: z.string().min(1), addressId: z.string().min(1) });

/** Zwei Segmente: der Einsatz und das Foto daran. */
export const photoParams = z.object({ id: z.string().min(1), photoId: z.string().min(1) });

// --- CRM --------------------------------------------------------------------

export const customerListQuery = searchQuery.extend({
  type: z.enum(['PRIVATE', 'BUSINESS']).optional(),
});

export const leadListQuery = searchQuery.extend({
  status: z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST']).optional(),
  ownerId: cuidSchema.optional(),
});

export const employeeListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  includeInactive: z.coerce.boolean().default(false),
});

export const threadListQuery = z.object({
  status: z.enum(['open', 'closed', 'all']).default('open'),
});

// --- Finanzen ---------------------------------------------------------------

export const invoiceListQuery = searchQuery.extend({
  status: z
    .enum([
      'DRAFT',
      'ISSUED',
      'SENT',
      'PARTIALLY_PAID',
      'PAID',
      'OVERDUE',
      'CANCELLED',
      'WRITTEN_OFF',
    ])
    .optional(),
  customerId: cuidSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** Zeitraum für Exporte. Ohne Angabe liefert der Endpunkt das laufende Jahr. */
export const exportRangeQuery = dateRangeQuery;

// --- Einsätze ---------------------------------------------------------------

export const calendarRangeQuery = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  employeeId: cuidSchema.optional(),
});

// --- Öffentlich -------------------------------------------------------------

export const availabilityCheckQuery = z.object({
  serviceId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ungültiges Datum.'),
  durationMin: z.coerce.number().int().min(30).max(1440).optional(),
  crewSize: z.coerce.number().int().min(1).max(20).optional(),
  squareMeters: z.coerce.number().int().min(5).max(5000).optional(),
});

export const postalCodeQuery = z.object({
  postalCode: postalCodeSchema,
});

/** Öffentlicher Zugriffstoken für Offerten und Rechnungen (Magic Link). */
export const publicTokenParams = z.object({
  token: z.string().min(10, 'Ungültiger Zugriffslink.'),
});
