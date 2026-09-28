import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { can } from '@/lib/auth/rbac';
import { prisma, toNumber } from '@/lib/db';
import { ForbiddenError } from '@/lib/errors';
import { contractCreateRequestSchema, contractQuerySchema } from '@/lib/validation/contracts';
import { plusTage, zuercherHeute } from '@/lib/contracts/serie';
import { contractVisibilityWhere, createContract } from '@/server/services/contract.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/contracts — Verträge auflisten.
 *
 * **Die Einschränkung steht in der `where`-Klausel, nicht in der Anzeige.**
 * `contract:read_own` haben Kundinnen und Kunden; ohne die Einschränkung sähe
 * eine Kundschaft über diesen Endpunkt jeden Vertrag der Firma. Verstecktes
 * HTML ist auf der Leitung trotzdem sichtbar — deshalb entscheidet die
 * Abfrage, nicht das Rendern.
 */
export const GET = defineRoute({
  permissions: ['contract:read', 'contract:read_own'],
  anyPermission: true,
  query: contractQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ query, session }) => {
    const organizationId = await getOrganizationId();

    const darfAlle = can(session.role, 'contract:read');
    let nurKundeId: string | null = null;
    if (!darfAlle) {
      const kunde = await prisma.customer.findFirst({
        where: { organizationId, userId: session.id, deletedAt: null },
        select: { id: true },
      });
      // Ohne Kundenakte gibt es nichts zu sehen — und das ist kein Fehler,
      // sondern eine leere Liste.
      nurKundeId = kunde?.id ?? '__ohne_akte__';
    }

    // Der Zürcher Tag (2026-09-27). `alsTag(new Date())` ist der UTC-Tag —
    // `serie.ts` selbst warnt davor.
    const heute = zuercherHeute();
    const where = {
      ...contractVisibilityWhere({ organizationId, nurKundeId }),
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId && darfAlle ? { customerId: query.customerId } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' as const } },
              { number: { contains: query.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...(query.fristInTagen
        ? { noticeDeadline: { gte: heute, lte: plusTage(heute, query.fristInTagen) } }
        : {}),
      ...(query.endeInTagen ? { endDate: { gte: heute, lte: plusTage(heute, query.endeInTagen) } } : {}),
    };

    const [gesamt, zeilen] = await Promise.all([
      prisma.contract.count({ where }),
      prisma.contract.findMany({
        where,
        orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        select: {
          id: true,
          number: true,
          title: true,
          status: true,
          startDate: true,
          endDate: true,
          noticeDeadline: true,
          customer: { select: { id: true, companyName: true, firstName: true, lastName: true } },
          property: { select: { id: true, label: true } },
          versions: {
            where: { status: 'ACTIVE' },
            select: { versionNumber: true, baseAmount: true, currency: true, billingCycle: true, pricingModel: true },
          },
        },
      }),
    ]);

    return ok({
      gesamt,
      page: query.page,
      perPage: query.perPage,
      contracts: zeilen.map((zeile) => {
        const geltend = zeile.versions[0];
        return {
          ...zeile,
          versions: undefined,
          aktiveVersion: geltend
            ? {
                versionNumber: geltend.versionNumber,
                baseAmount: toNumber(geltend.baseAmount),
                currency: geltend.currency,
                billingCycle: geltend.billingCycle,
                pricingModel: geltend.pricingModel,
              }
            : null,
        };
      }),
    });
  },
});

/**
 * POST /api/contracts — einen Vertragsentwurf anlegen.
 *
 * Der Vertrag entsteht **immer mit seiner ersten Version**: Ein Vertrag ohne
 * Konditionen wäre ein Datensatz ohne Inhalt, und jede spätere Abfrage müsste
 * den Fall behandeln. Nummer und Zustand entstehen nicht hier — der Entwurf
 * hat beides noch nicht.
 */
export const POST = defineRoute({
  permissions: ['contract:create'],
  body: contractCreateRequestSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    if (!can(session.role, 'contract:create')) throw new ForbiddenError();
    const vertrag = await createContract({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body.contract,
      version: body.version,
      services: body.services,
    });
    return created(vertrag);
  },
});
