import { defineRoute } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { qualityInspectionUpdateSchema } from '@/lib/validation/quality';
import { idParam } from '@/lib/validation/queries';
import { getOrganizationId } from '@/server/services/organization.service';
import { discardInspection, updateInspection } from '@/server/services/quality.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/quality-inspections/{id} — einen Entwurf ändern.
 *
 * **Nur Entwürfe** (422 sonst). Eine abgeschlossene Begehung ist ein Beleg;
 * korrigiert wird über eine Nachkontrolle, nicht durch Überschreiben.
 *
 * Die Positionen werden als Ganzes ersetzt, nicht zeilenweise abgeglichen —
 * dieselbe Entscheidung wie beim Leistungsumfang eines Vertragsentwurfs.
 * Verschiebt jemand das Begehungsdatum, verschiebt sich auch der Massstab:
 * Sonst trüge die Kontrolle die Zusage eines Tages, an dem sie nicht
 * stattfand.
 */
export const PATCH = defineRoute({
  permissions: ['quality:inspect'],
  params: idParam,
  body: qualityInspectionUpdateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await updateInspection({
        organizationId: await getOrganizationId(),
        inspectionId: params.id,
        actorId: session.id,
        ip,
        input: body,
      }),
    ),
});

/**
 * DELETE /api/quality-inspections/{id} — einen Entwurf verwerfen.
 *
 * Nur Entwürfe. Eine abgeschlossene Begehung wird nicht gelöscht — sie ist
 * ein Beleg, und dafür gibt es keine Ausnahme.
 */
export const DELETE = defineRoute({
  permissions: ['quality:inspect'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await discardInspection({
      organizationId: await getOrganizationId(),
      inspectionId: params.id,
      actorId: session.id,
      ip,
    });
    return noContent();
  },
});
