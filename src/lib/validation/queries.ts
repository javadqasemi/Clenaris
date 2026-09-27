import { z } from 'zod';

import { cuidSchema, postalCodeSchema } from './common';
import { MEDIA_SCOPES } from './files';
import { USER_ROLES, USER_STATUS } from './users';

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
  /**
   * Nur Rechnungen aus diesem Vertrag.
   *
   * Ohne diesen Filter liesse sich „was wurde aus diesem Vertrag schon
   * fakturiert" nur beantworten, indem man die ganze Rechnungsliste durchsieht
   * — bei einem Vertrag über Jahre also gar nicht.
   */
  contractId: cuidSchema.optional(),
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

// --- Aus den Routen hierher (2026-09-27) ------------------------------------
//
// Diese Abfragen standen bis dahin in den Routendateien selbst. Validiert
// wurden sie dort genauso — dokumentiert aber nicht: Die Routenliste der
// OpenAPI-Beschreibung kann nur Schemata nennen, die sie importieren kann,
// und so fehlten bei zwanzig Endpunkten Körper oder Abfrage in der Doku.
// `npm run openapi` prüft seither, dass jede Route mit `body`/`query` beides
// auch in der Liste führt.

/** `0`/`1` in der Abfrage als Wahrheitswert. */
const schalter = z
  .enum(['0', '1'])
  .default('0')
  .transform((v) => v === '1');

export const absenceListQuery = z.object({
  status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  employeeId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const blogListQuery = z.object({
  status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']).optional(),
  q: z.string().trim().max(120).optional(),
});

export const bookingListQuery = searchQuery.extend({
  status: z.enum(['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW']).optional(),
  customerId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const ctaListQuery = z.object({
  /** `1` zeigt auch den Papierkorb. */
  papierkorb: schalter,
});

export const ctaDeleteQuery = z.object({
  /** `1` löscht endgültig statt in den Papierkorb. */
  endgueltig: schalter,
});

export const jobListQuery = searchQuery.extend({
  status: z
    .enum(['UNASSIGNED', 'SCHEDULED', 'DISPATCHED', 'EN_ROUTE', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'VERIFIED', 'CANCELLED'])
    .optional(),
  employeeId: z.string().min(1).optional(),
  customerId: z.string().min(1).optional(),
  /**
   * Alle Einsätze eines Vertrags (Wave 10).
   *
   * Die Frage „was ist aus diesem Vertrag entstanden" wird in der Vertragsakte
   * gestellt und beim Prüfen der Serienplanung. Ohne diesen Filter bliebe nur,
   * die ganze Liste zu holen und im Browser zu filtern — und das ist bei
   * einem Unterhaltsvertrag über zwei Jahre eine vierstellige Zahl Zeilen.
   */
  contractId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const mediaListQuery = paginationQuery.extend({
  q: z.string().trim().max(120).optional(),
  scope: z.enum(MEDIA_SCOPES).optional(),
  nurBilder: schalter,
});

/** `?trotzdem=1` löscht auch eine Datei, die an einem Beleg hängt. */
export const mediaDeleteQuery = z.object({ trotzdem: schalter });

export const paymentListQuery = paginationQuery.extend({
  status: z.enum(['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'CANCELLED']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().trim().max(120).optional(),
});

export const propertyListQuery = z.object({
  customerId: z.string().min(1).optional(),
  q: z.string().trim().max(120).optional(),
});

export const supplierListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  includeInactive: schalter,
});

export const userListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(USER_STATUS).optional(),
  papierkorb: schalter,
});

/**
 * Das Abrechnungsjahr in der Abfragezeichenfolge.
 *
 * Steht hier und nicht bei payroll.ts, weil die OpenAPI-Registrierung
 * Abfrageschemata aus dieser Datei bezieht — und weil ein Jahr keine
 * fachliche Regel der Lohnabrechnung ist, sondern ein Abfrageparameter.
 */
export const payrollYearQuery = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
});
