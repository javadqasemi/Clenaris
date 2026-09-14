import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateBookingSchema } from '@/lib/validation/booking';
import { getBookingDetail, updateBooking } from '@/server/services/booking.service';
import { softDelete } from '@/server/services/trash.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/bookings/:id — Auftragsdetails.
 *
 * Kundschaft erhält nur den eigenen Auftrag; die Einschränkung setzt der
 * Service über den `customerId`-Filter, nicht der Handler. Wer die Prüfung in
 * den Handler legt, hat sie beim nächsten Aufrufer nicht mehr.
 */
export const GET = defineRoute({
  permissions: ['booking:read', 'booking:read_own'],
  anyPermission: true,
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session }) => {
    const booking = await getBookingDetail({
      organizationId: await getOrganizationId(),
      bookingId: params.id,
      customerId: session.role === 'CUSTOMER' ? (session.profileId ?? undefined) : undefined,
    });

    return ok(booking);
  },
});

/**
 * PATCH /api/bookings/:id — Auftrag bearbeiten.
 *
 * Ein einziger Endpunkt für Termin, Kundschaft, Adresse, Positionen, Preis,
 * Turnus, Notizen und Status. Die Alternative — je ein Endpunkt pro Feldgruppe
 * — hätte fünf Wege ergeben, auf denen dieselbe Buchung geändert wird, und
 * damit fünf Stellen, an denen die Änderungsspur und die Weitergabe an die
 * Einsätze hätten vergessen werden können.
 *
 * Welche Felder die anfragende Rolle tatsächlich ändern darf, entscheidet
 * `updateBooking` anhand der Rechtematrix: Die Betriebsleitung disponiert,
 * Preise ändert die Verwaltung.
 */
export const PATCH = defineRoute({
  permissions: ['booking:update'],
  params: idParam,
  body: updateBookingSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const booking = await updateBooking({
      organizationId: await getOrganizationId(),
      bookingId: params.id,
      input: body,
      actorId: session.id,
      actorRole: session.role,
    });

    return ok({ id: booking.id, status: booking.status, grossTotal: booking.grossTotal });
  },
});

/**
 * DELETE /api/bookings/:id — in den Papierkorb legen.
 *
 * Eine bereits verrechnete Buchung bleibt erhalten — eine Rechnung ohne Auftrag ist buchhalterisch nicht haltbar.
 *
 * Weich gelöscht: der Datensatz verschwindet aus allen Listen (jede Abfrage
 * filtert `deletedAt: null`), bleibt aber wiederherstellbar. Verknüpfte
 * Datensätze werden **nicht** mitgelöscht — ein Kaskadenlöschen wäre nicht
 * umkehrbar und widerspräche dem Zweck eines Papierkorbs.
 */
export const DELETE = defineRoute({
  permissions: ['booking:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await softDelete(
      'booking',
      { organizationId: await getOrganizationId(), actorId: session.id, ip },
      params.id,
    );
    return noContent();
  },
});
