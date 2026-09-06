import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { BusinessRuleError } from '@/lib/errors';
import { optimizeRoute, type RouteStop } from '@/lib/ai/features';
import { dispatchSuggestSchema } from '@/lib/validation/ai';
import { getOrganization, getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * POST /api/ai/dispatch
 *
 * Schlägt Reihenfolge und Startzeiten für die Einsätze eines Tages vor.
 *
 * Architekturentscheid: Das Ergebnis wird *nicht* automatisch gespeichert. Die
 * Disposition kennt Randbedingungen, die nicht in der Datenbank stehen —
 * Baustellenzufahrten, Schlüsselübergaben, persönliche Absprachen. Der
 * Vorschlag ist eine Entscheidungshilfe, die Umsetzung bleibt im Kalender.
 */
export const POST = defineRoute({
  permissions: ['ai:use', 'job:dispatch'],
  body: dispatchSuggestSchema,
  rateLimit: 'aiGenerate',
  handler: async ({ body }) => {
    const organizationId = await getOrganizationId();
    const org = await getOrganization();

    const dayStart = new Date(`${body.date}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);

    const jobs = await prisma.job.findMany({
      where: {
        organizationId,
        deletedAt: null,
        status: { notIn: ['CANCELLED', 'COMPLETED', 'VERIFIED'] },
        scheduledStart: { gte: dayStart, lt: dayEnd },
      },
      orderBy: { scheduledStart: 'asc' },
      include: {
        address: true,
        service: { select: { kind: true } },
      },
    });

    if (jobs.length === 0) {
      throw new BusinessRuleError('Für diesen Tag sind keine Einsätze geplant.');
    }
    if (jobs.length > 25) {
      throw new BusinessRuleError(
        'Für mehr als 25 Einsätze pro Tag ist die automatische Planung nicht ausgelegt. Bitte teilen Sie den Tag auf mehrere Teams auf.',
      );
    }

    const stops: RouteStop[] = jobs.map((job) => {
      const address = job.address
        ? `${job.address.street} ${job.address.streetNo ?? ''}, ${job.address.postalCode} ${job.address.city}`.replace(
            /\s+/g,
            ' ',
          )
        : 'Adresse unbekannt';

      const time = (date: Date) =>
        new Intl.DateTimeFormat('de-CH', {
          timeZone: 'Europe/Zurich',
          hour: '2-digit',
          minute: '2-digit',
        }).format(date);

      return {
        jobId: job.id,
        jobNumber: job.number,
        address,
        lat: job.address?.lat ?? null,
        lng: job.address?.lng ?? null,
        // Ein Zeitfenster von ±90 Minuten um den geplanten Termin.
        earliestStart: time(new Date(job.scheduledStart.getTime() - 90 * 60_000)),
        latestStart: time(new Date(job.scheduledStart.getTime() + 90 * 60_000)),
        durationMinutes: job.estimatedMin,
        priority: job.service?.kind === 'MOVE_OUT_CLEANING' ? 'hoch' : 'normal',
      };
    });

    const plan = await optimizeRoute({
      date: body.date,
      startAddress: `${org.street} ${org.streetNo ?? ''}, ${org.postalCode} ${org.city}`.replace(
        /\s+/g,
        ' ',
      ),
      stops,
    });

    // Die Job-Nummern anreichern, damit die Oberfläche lesbare Bezüge zeigt.
    const numbersById = new Map(jobs.map((job) => [job.id, job.number]));

    return ok({
      ...plan,
      order: plan.order.map((entry) => ({
        ...entry,
        jobNumber: numbersById.get(entry.jobId) ?? entry.jobId,
      })),
    });
  },
});
