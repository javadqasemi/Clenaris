import { defineRoute } from '@/lib/api/handler';
import { buildPagination, created, paginated } from '@/lib/api/response';
import { ForbiddenError, NotFoundError } from '@/lib/errors';
import { prisma } from '@/lib/db';
import { can } from '@/lib/auth/rbac';
import { jobListQuery } from '@/lib/validation/queries';
import { createJobSchema } from '@/lib/validation/operations';
import { createJob, listJobs } from '@/server/services/job.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * Einsätze als Sammlung.
 *
 * Beide Funktionen des Dienstes — `listJobs` und `createJob` — waren
 * vollständig ausprogrammiert und getestet-fähig, aber über HTTP nicht
 * erreichbar: Die Verwaltungsseite rief `listJobs` direkt auf, und ein Einsatz
 * ohne vorangehende Buchung liess sich überhaupt nicht anlegen. Genau das
 * braucht der Betrieb aber laufend — Nachbesserung, Sonderauftrag,
 * Hauswartung auf Zuruf.
 */

/**
 * GET /api/jobs — Einsätze mit Filter, Sortierung und Blätterung.
 *
 * `job:read` sieht alles, `job:read_assigned` nur die eigenen. Die
 * Einschränkung steht in der `where`-Klausel des Dienstes (`employeeId`) und
 * nicht in der Darstellung: Ausgeblendetes HTML ist auf der Leitung trotzdem
 * sichtbar, und eine Liste, die zuerst alles lädt und dann filtert, hat die
 * Daten bereits gelesen.
 *
 * Mitarbeitende, die einen fremden `employeeId`-Filter mitschicken, bekommen
 * trotzdem nur die eigenen Einsätze — der eigene Wert überschreibt den
 * mitgeschickten, statt die Anfrage abzulehnen. Das ist die freundlichere
 * Variante desselben Ergebnisses.
 *
 * Objektangaben sind bewusst nicht Teil der Liste: Schlüsseldepot,
 * Zugangshinweis und Alarmcode gehören auf den Rapport des Einsatzes, nicht in
 * eine Übersicht, die zwanzig Adressen auf einmal ausliefert.
 */
export const GET = defineRoute({
  permissions: ['job:read', 'job:read_assigned'],
  anyPermission: true,
  query: jobListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query, session }) => {
    const nurEigene = !can(session.role, 'job:read');

    const { items, total } = await listJobs({
      organizationId: await getOrganizationId(),
      status: query.status,
      employeeId: nurEigene ? (session.profileId ?? '__keines__') : query.employeeId,
      customerId: query.customerId,
      contractId: query.contractId,
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
 * POST /api/jobs — Einsatz ohne Buchung anlegen.
 *
 * Die drei Fremdschlüssel aus dem Körper werden gegen den Mandanten geprüft,
 * bevor der Dienst sie verwendet. Ohne diese Prüfung liesse sich ein Einsatz
 * an eine fremde Kundenakte oder an ein fremdes Objekt hängen, und der Fehler
 * fiele erst auf, wenn das Team vor der falschen Tür steht — oder gar nicht,
 * sondern nur als fremde Adresse auf einem Rapport.
 *
 * Ob das gewählte Team zu dieser Zeit überhaupt kann, entscheidet
 * `assignment.service.ts` innerhalb der Transaktion des Dienstes.
 */
export const POST = defineRoute({
  permissions: ['job:create'],
  body: createJobSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();

    const customer = await prisma.customer.count({
      where: { id: body.customerId, organizationId, deletedAt: null },
    });
    if (!customer) throw new NotFoundError('Kundschaft');

    /**
     * Adresse und Objekt müssen *dieser* Kundschaft gehören, nicht bloss
     * demselben Mandanten. Sonst führte der Rapport das Team zur Adresse
     * einer anderen Kundin — mit deren Schlüsseldepot und Zugangshinweis.
     */
    if (body.addressId) {
      const address = await prisma.address.count({
        where: { id: body.addressId, customerId: body.customerId },
      });
      if (!address) throw new NotFoundError('Adresse');
    }

    if (body.propertyId) {
      const property = await prisma.property.count({
        where: { id: body.propertyId, customerId: body.customerId, deletedAt: null },
      });
      if (!property) throw new NotFoundError('Objekt');
    }

    if (body.serviceId) {
      // `Service` kennt kein `deletedAt` — der Katalog wird nicht weich
      // gelöscht, sondern über `active` stillgelegt. Eine stillgelegte
      // Leistung bleibt für einen Einsatz zulässig: Sie steht in alten
      // Aufträgen und darf dort nicht verschwinden.
      const service = await prisma.service.count({
        where: { id: body.serviceId, organizationId },
      });
      if (!service) throw new NotFoundError('Leistung');
    }

    if (body.bookingId) {
      const booking = await prisma.booking.count({
        where: { id: body.bookingId, organizationId, customerId: body.customerId, deletedAt: null },
      });
      if (!booking) throw new NotFoundError('Buchung');
    }

    /**
     * Ein Team mitzugeben ist Zuteilung, nicht Anlage. Wer nur `job:create`
     * hat, legt den Einsatz unbesetzt an und überlässt die Einteilung der
     * Disposition — sonst wäre das Anlegeformular der Umweg um `job:assign`.
     */
    if (body.employeeIds.length > 0 && !can(session.role, 'job:assign')) {
      throw new ForbiddenError(
        'Zum Zuteilen von Personal fehlt Ihnen die Berechtigung. Legen Sie den Einsatz ohne Team an.',
      );
    }

    const job = await createJob({ organizationId, input: body, actorId: session.id });

    return created({ id: job.id, number: job.number, status: job.status });
  },
});
