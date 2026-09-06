import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma, toNumber } from '@/lib/db';
import { generateQuoteDraft } from '@/lib/ai/features';
import { quoteDraftSchema } from '@/lib/validation/ai';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * POST /api/ai/quote-draft
 *
 * Erzeugt einen Offertentwurf aus einer Kundenanfrage.
 *
 * Der Stundenansatz kommt aus dem Leistungskatalog, nicht aus dem Modell — so
 * bleibt die Kalkulation an die eigenen Preise gebunden. Das Modell verteilt
 * den Aufwand auf Positionen, es erfindet keine Tarife.
 */
export const POST = defineRoute({
  permissions: ['ai:use', 'quote:create'],
  body: quoteDraftSchema,
  rateLimit: 'aiGenerate',
  handler: async ({ body }) => {
    const organizationId = await getOrganizationId();

    // Kontext aus den Stammdaten anreichern, damit das Modell nicht raten muss.
    const [customer, lead, service] = await Promise.all([
      body.customerId
        ? prisma.customer.findFirst({
            where: { id: body.customerId, organizationId },
            select: {
              type: true,
              addresses: {
                where: { isDefault: true },
                take: 1,
                select: { city: true },
              },
            },
          })
        : Promise.resolve(null),
      body.leadId
        ? prisma.lead.findFirst({
            where: { id: body.leadId, organizationId },
            select: { serviceKind: true, city: true, company: true },
          })
        : Promise.resolve(null),
      prisma.service.findFirst({
        where: {
          organizationId,
          active: true,
          ...(body.serviceKind ? { kind: body.serviceKind } : {}),
        },
        orderBy: { position: 'asc' },
        select: { kind: true, hourlyRate: true },
      }),
    ]);

    const draft = await generateQuoteDraft({
      serviceKind: body.serviceKind ?? lead?.serviceKind ?? service?.kind ?? 'RESIDENTIAL_CLEANING',
      propertyKind: body.propertyKind ?? 'APARTMENT',
      squareMeters: body.squareMeters,
      rooms: body.rooms,
      windows: body.windows,
      frequency: body.frequency ?? 'ONCE',
      customerMessage: body.message,
      customerType: customer?.type ?? (lead?.company ? 'BUSINESS' : 'PRIVATE'),
      // Fällt der Katalog aus, gilt der interne Mindestansatz.
      hourlyRate: toNumber(service?.hourlyRate) || 62,
      city: customer?.addresses[0]?.city ?? lead?.city ?? null,
    });

    return ok(draft);
  },
});
