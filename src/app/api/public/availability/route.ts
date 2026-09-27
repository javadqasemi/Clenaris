import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { estimateBookingEffort } from '@/lib/pricing/engine';
import { verfuegbarkeitAnfrageSchema } from '@/lib/validation/booking';
import { availabilityCheckQuery } from '@/lib/validation/queries';
import { prisma } from '@/lib/db';
import { getAvailableDays, getAvailableSlots, leistungsbedarf } from '@/server/services/availability.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/public/availability?serviceId=…&date=2026-09-12
 *
 * Die Zeitfenster eines Tages für **eine** Leistung — die Form von vor dem
 * Produktsprint, für bestehende Aufrufer. Ohne `durationMin` rechnet der
 * Server die Dauer seit 2026-09-26 mit derselben Funktion wie der Preis
 * (`estimateBookingEffort`); vorher stand hier eine eigene, abweichende
 * Schätzung, und genau diese Abweichung liess zu kurze Einsätze ins Fenster
 * passen. Der Buchungsassistent nutzt `POST`.
 */
export const GET = definePublicRoute({
  query: availabilityCheckQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const organizationId = await getOrganizationId();
    const [aufwand, bedarf] = await Promise.all([
      estimateBookingEffort(
        { leistungen: [{ serviceId: query.serviceId, squareMeters: query.squareMeters ?? null, extras: [] }] },
        organizationId,
      ),
      leistungsbedarf(prisma, organizationId, [query.serviceId]),
    ]);

    return ok(
      await getAvailableSlots({
        organizationId,
        date: query.date,
        durationMin: query.durationMin ?? aufwand.durationMinutes,
        crewSize: query.crewSize ?? aufwand.crewSize,
        bufferMin: aufwand.bufferMinutes,
        qualifikationen: bedarf.qualifikationen,
      }),
    );
  },
});

/**
 * POST /api/public/availability — der Kalender für die ganze Auswahl.
 *
 * Nimmt die gewählten Leistungen samt ihren Angaben, nicht eine Dauer: Dauer,
 * Teamgrösse und Puffer rechnet der Server. Liefert je Tag, ob er ein
 * buchbares Zeitfenster hat, und die Zeitfenster selbst. Ein Tag ohne
 * buchbares Fenster ist im Kalender nicht wählbar.
 *
 * POST statt GET, weil die Auswahl verschachtelt ist (Leistungen mit Fläche,
 * Fenstern und Zusatzleistungen je Leistung) — als Adresszeile wäre sie ein
 * zweites, schlechter geprüftes Format derselben Daten.
 */
export const POST = definePublicRoute({
  body: verfuegbarkeitAnfrageSchema,
  rateLimit: 'apiRead',
  handler: async ({ body }) => {
    const organizationId = await getOrganizationId();
    const [aufwand, bedarf] = await Promise.all([
      estimateBookingEffort({ leistungen: body.leistungen, hasPets: body.hasPets }, organizationId),
      leistungsbedarf(prisma, organizationId, body.leistungen.map((l) => l.serviceId)),
    ]);
    const tage = await getAvailableDays({
      organizationId,
      von: body.von,
      tage: body.tage,
      durationMin: aufwand.durationMinutes,
      crewSize: aufwand.crewSize,
      bufferMin: aufwand.bufferMinutes,
      qualifikationen: bedarf.qualifikationen,
    });
    return ok({ dauerMin: aufwand.durationMinutes, crew: aufwand.crewSize, tage });
  },
});
