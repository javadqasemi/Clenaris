import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma, toNumber } from '@/lib/db';
import { generateQuoteDraft } from '@/lib/ai/features';
import { quoteDraftSchema } from '@/lib/validation/ai';
import { getOrganizationId } from '@/server/services/organization.service';
import { protokolliereKiNutzung } from '@/server/services/ai-governance.service';

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
  handler: async ({ body, session, ip }) => {
    const organizationId = await getOrganizationId();

    // Kontext aus den Stammdaten anreichern, damit das Modell nicht raten muss.
    const [customer, lead, service] = await Promise.all([
      body.customerId
        ? prisma.customer.findFirst({
            where: { id: body.customerId, organizationId },
            select: {
              type: true,
              // Nur, um sie im Anfragetext zu schwärzen — sie gehen nicht hinaus.
              firstName: true,
              lastName: true,
              companyName: true,
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
            select: { serviceKind: true, city: true, company: true, firstName: true, lastName: true },
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
      /*
        F-15: Die Anfrage nennt oft die Person oder Firma selbst („Guten Tag,
        hier ist Anna Keller von der Keller Treuhand AG"). Für die Kalkulation
        ist das unnötig; die bekannten Namen gehen als `[NAME]` hinaus.
      */
      bekannteNamen: [customer?.firstName, customer?.lastName, customer?.companyName, lead?.firstName, lead?.lastName, lead?.company],
    });
    await protokolliereKiNutzung({ organizationId, userId: session.id, funktion: 'Offertentwurf', ip });

    return ok(draft);
  },
});
