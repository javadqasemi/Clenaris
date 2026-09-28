import { defineRoute } from '@/lib/api/handler';
import { buildPagination, created, ok } from '@/lib/api/response';
import { qualityInspectionCreateSchema, qualityQuerySchema } from '@/lib/validation/quality';
import { getOrganizationId } from '@/server/services/organization.service';
import { createInspection, listInspections } from '@/server/services/quality.service';

export const runtime = 'nodejs';

/**
 * GET /api/quality-inspections — Begehungen.
 *
 * **Die Kundschaft liest dieselbe Liste**, eingegrenzt in der
 * `where`-Klausel: nur die eigenen Objekte und Verträge, und nur
 * abgeschlossene — ein Entwurf ist eine Momentaufnahme, keine Feststellung.
 * `internalNote` fehlt in der Auswahl; ein Feld, das nur die Anzeige
 * ausblendet, stünde trotzdem auf der Leitung.
 */
export const GET = defineRoute({
  permissions: ['quality:read', 'quality:read_own'],
  anyPermission: true,
  query: qualityQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ query, session }) => {
    const { items, total } = await listInspections({
      organizationId: await getOrganizationId(),
      role: session.role,
      // `profileId` ist bei einem Kundenkonto die Kundenakte — dieselbe
      // Auflösung wie in `requireCustomerId()`.
      customerId: session.role === 'CUSTOMER' ? (session.profileId ?? null) : null,
      filter: query,
    });

    return ok(items, { meta: buildPagination(query.page, query.perPage, total) });
  },
});

/**
 * POST /api/quality-inspections — eine Begehung erfassen.
 *
 * Sie entsteht als **Entwurf**. Die Punktzahl rechnet der Server aus den
 * Positionen; ein mitgeschicktes Ergebnis gibt es im Schema nicht.
 *
 * Der **Massstab** wird dabei eingefroren: festgehalten wird, welche
 * Vertragsfassung am Tag der Begehung galt und welchen Zielwert sie zusagte.
 * Eine Kontrolle, die nach einer Vertragsänderung anders ausfiele, wäre kein
 * Beleg.
 *
 * Abgewiesen wird (422): eine Begehung ohne Vertrag **und** ohne Objekt (das
 * wäre eine Notiz), eine Nachkontrolle zu einem Entwurf, und eine zweite
 * Nachkontrolle zu derselben Begehung.
 */
export const POST = defineRoute({
  permissions: ['quality:inspect'],
  body: qualityInspectionCreateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) =>
    created(
      await createInspection({
        organizationId: await getOrganizationId(),
        actorId: session.id,
        ip,
        input: body,
      }),
    ),
});
