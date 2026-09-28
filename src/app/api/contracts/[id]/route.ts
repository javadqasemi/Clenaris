import { defineRoute } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { can } from '@/lib/auth/rbac';
import { prisma, toNumber } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { idParam } from '@/lib/validation/queries';
import { contractUpdateSchema } from '@/lib/validation/contracts';
import {
  contractVisibilityWhere,
  deleteContractDraft,
  updateContract,
} from '@/server/services/contract.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/contracts/{id} — ein Vertrag mit seiner gesamten Geschichte.
 *
 * Bewusst **eine** Abfrage statt sechs Endpunkten für Versionen, Leistungen,
 * Pläne, Änderungen und Preisanpassungen: Die Vertragsakte wird immer als
 * Ganzes betrachtet, und sechs Abrufe hintereinander wären sechs Momente, in
 * denen sich der Zustand zwischen zwei Antworten ändern kann.
 */
export const GET = defineRoute({
  permissions: ['contract:read', 'contract:read_own'],
  anyPermission: true,
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session }) => {
    const organizationId = await getOrganizationId();

    let nurKundeId: string | null = null;
    if (!can(session.role, 'contract:read')) {
      const kunde = await prisma.customer.findFirst({
        where: { organizationId, userId: session.id, deletedAt: null },
        select: { id: true },
      });
      nurKundeId = kunde?.id ?? '__ohne_akte__';
    }

    const vertrag = await prisma.contract.findFirst({
      where: { id: params.id, ...contractVisibilityWhere({ organizationId, nurKundeId }) },
      include: {
        customer: { select: { id: true, number: true, companyName: true, firstName: true, lastName: true, email: true } },
        property: { select: { id: true, label: true, address: true } },
        quote: { select: { id: true, number: true, status: true, acceptedAt: true } },
        responsibleEmployee: { select: { id: true, user: { select: { firstName: true, lastName: true } } } },
        salesOwner: { select: { id: true, user: { select: { firstName: true, lastName: true } } } },
        serviceManager: { select: { id: true, user: { select: { firstName: true, lastName: true } } } },
        versions: {
          orderBy: { versionNumber: 'desc' },
          include: {
            services: {
              orderBy: { position: 'asc' },
              include: {
                service: { select: { id: true, name: true, kind: true } },
                building: { select: { id: true, name: true } },
                schedules: { include: { exceptions: { orderBy: { originalDate: 'asc' } } } },
              },
            },
          },
        },
        amendments: { orderBy: { requestedAt: 'desc' } },
        priceAdjustments: { orderBy: { effectiveFrom: 'desc' } },
      },
    });
    if (!vertrag) throw new NotFoundError('Vertrag nicht gefunden.');

    /**
     * Die Zahl der bereits erzeugten Einsätze je Version.
     *
     * Sie beantwortet die Frage, die bei einer Vertragsänderung als Erstes
     * gestellt wird: „Was hängt an der alten Fassung?" — und sie belegt
     * zugleich die Zusicherung aus Wave 10, dass ein Einsatz seine Version
     * behält.
     */
    const einsaetzeJeVersion = await prisma.job.groupBy({
      by: ['contractVersionId'],
      where: { contractId: vertrag.id, deletedAt: null },
      _count: { _all: true },
    });
    const zahlJeVersion = new Map(
      einsaetzeJeVersion.map((zeile) => [zeile.contractVersionId, zeile._count._all]),
    );

    return ok({
      ...vertrag,
      versions: vertrag.versions.map((version) => ({
        ...version,
        baseAmount: toNumber(version.baseAmount),
        hourlyRate: version.hourlyRate ? toNumber(version.hourlyRate) : null,
        unitPrice: version.unitPrice ? toNumber(version.unitPrice) : null,
        vatRate: toNumber(version.vatRate),
        indexBaseValue: version.indexBaseValue ? toNumber(version.indexBaseValue) : null,
        einsaetze: zahlJeVersion.get(version.id) ?? 0,
        services: version.services.map((leistung) => ({
          ...leistung,
          quantity: leistung.quantity ? toNumber(leistung.quantity) : null,
        })),
      })),
      priceAdjustments: vertrag.priceAdjustments.map((anpassung) => ({
        ...anpassung,
        oldAmount: toNumber(anpassung.oldAmount),
        newAmount: toNumber(anpassung.newAmount),
        percent: anpassung.percent ? toNumber(anpassung.percent) : null,
        indexOldValue: anpassung.indexOldValue ? toNumber(anpassung.indexOldValue) : null,
        indexNewValue: anpassung.indexNewValue ? toNumber(anpassung.indexNewValue) : null,
      })),
    });
  },
});

/**
 * PATCH /api/contracts/{id} — Kopfdaten ändern.
 *
 * Konditionen sind hier nicht dabei, und zwar auch nicht bei einem Entwurf:
 * Sie stehen an der Version, und `PATCH /versions/{id}` ist der Weg dorthin.
 * Zwei Türen zu denselben Feldern wären zwei Stellen, an denen die
 * Versionsregel durchgesetzt werden müsste.
 */
export const PATCH = defineRoute({
  permissions: ['contract:update'],
  params: idParam,
  body: contractUpdateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await updateContract({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        actorId: session.id,
        ip,
        input: body,
      }),
    ),
});

/**
 * DELETE /api/contracts/{id} — einen Entwurf verwerfen.
 *
 * Der Dienst verweigert es für jeden Vertrag, der je in Kraft war (422). Ein
 * gelaufener Vertrag ist ein Beleg; er wird beendet, nicht entfernt. Deshalb
 * heisst die Berechtigung auch `contract:delete_draft` und nicht
 * `contract:delete` — der Name sagt, was möglich ist.
 */
export const DELETE = defineRoute({
  permissions: ['contract:delete_draft'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await deleteContractDraft({
      organizationId: await getOrganizationId(),
      contractId: params.id,
      actorId: session.id,
      ip,
    });
    return noContent();
  },
});
