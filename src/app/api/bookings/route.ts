import { defineRoute } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { searchQuery } from '@/lib/validation/queries';
import { staffBookingSchema } from '@/lib/validation/booking';
import { createBooking, listBookings } from '@/server/services/booking.service';
import { getOrganizationId } from '@/server/services/organization.service';
import { z } from 'zod';

export const runtime = 'nodejs';

const listQuery = searchQuery.extend({
  status: z
    .enum(['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'])
    .optional(),
  customerId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * GET /api/bookings — Buchungen mit Filter und Blätterung.
 *
 * Die Kundensicht auf einen Auftrag. Die Betriebssicht steht unter
 * `/api/jobs`: eine Buchung kann mehrere Einsätze erzeugen, und ein Einsatz
 * kann ohne Buchung bestehen.
 */
export const GET = defineRoute({
  permissions: ['booking:read'],
  query: listQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const { items, total } = await listBookings({
      organizationId: await getOrganizationId(),
      status: query.status,
      customerId: query.customerId,
      from: query.from,
      to: query.to,
      q: query.q,
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort,
      order: query.order,
    });

    return paginated(items, buildPagination(query.page, query.pageSize, total));
  },
});

/**
 * POST /api/bookings — Buchung im Büro erfassen.
 *
 * **Warum es diesen Endpunkt zusätzlich zu `/api/public/bookings` gibt.**
 * Bis hierher musste das Büro die öffentliche Route benutzen. Das hatte drei
 * Folgen, die alle falsch waren: Jede telefonische Buchung zählte in den
 * Auswertungen als „Website", das Rate-Limit des Buchungstrichters
 * (`bookingCreate`) galt auch für die Sachbearbeitung, und die Kundschaft
 * liess sich nur über eine bereits erfasste Adresse auflösen — wer noch keine
 * hatte, war nicht buchbar.
 *
 * **Was gleich bleibt.** Der Dienst ist derselbe. Preis, Dauer, Mannschaft,
 * Mehrwertsteuer, Rabatt und Gutschein rechnet weiterhin ausschliesslich der
 * Server; aus der Anfrage kommt nur, *was* gebucht wird, nie *was es kostet*.
 * Ein zweiter Buchungsweg wäre ein zweiter Ort, an dem ein Preis entstehen
 * kann — und damit zwei Wahrheiten.
 *
 * **Was anders ist.** Die Kundschaft kommt als `customerId` (mandantengeprüft
 * im Dienst), die Herkunft ist wählbar, es gibt eine interne Notiz, und die
 * Kapazitätsprüfung lässt sich ausdrücklich übergehen. Die Meldung „Neue
 * Online-Buchung" ans Büro entfällt; die Bestätigung an die Kundschaft geht
 * unverändert hinaus.
 */
export const POST = defineRoute({
  permissions: ['booking:create'],
  body: staffBookingSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const { customerId, source, internalNote, overrideCapacity, ...core } = body;

    const { booking, confirmationUrl } = await createBooking({
      organizationId: await getOrganizationId(),
      input: core,
      session,
      ip,
      office: { customerId, source, internalNote, overrideCapacity },
    });

    return created({
      id: booking.id,
      number: booking.number,
      status: booking.status,
      scheduledStart: booking.scheduledStart,
      scheduledEnd: booking.scheduledEnd,
      grossTotal: booking.grossTotal,
      confirmationUrl,
    });
  },
});
