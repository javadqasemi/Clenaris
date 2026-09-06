import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { audit, diff } from '@/lib/audit';
import { seoDefinitionFor } from '@/lib/cms/registry';
import { updateSeoSchema } from '@/lib/validation/cms';
import { getOrganizationId } from '@/server/services/organization.service';
import { invalidateSeo } from '@/server/services/content.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/seo — Suchmaschinenangaben einer Seite pflegen.
 *
 * Architekturentscheide:
 *
 *  • **Leeren heisst zurücksetzen**, wie bei den Textbausteinen: ein leeres
 *    Feld löscht die Zeile, und es gilt wieder der Registerwert. So kann die
 *    Redaktion einen misslungenen Titel jederzeit rückgängig machen.
 *
 *  • **`noIndex` wird gesondert protokolliert.** Es ist die einzige Schaltung
 *    hier, die eine Seite aus den Suchergebnissen wirft — versehentlich
 *    gesetzt kostet sie Umsatz, und man will nachvollziehen können, wer sie
 *    wann gesetzt hat.
 *
 *  • **Der Seitencache wird geleert.** Der Titel steckt im erzeugten HTML;
 *    ohne Neuaufbau bliebe der alte stehen.
 */
export const PATCH = defineRoute({
  permissions: ['seo:update'],
  body: updateSeoSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();
    const definition = seoDefinitionFor(body.path);

    const before = await prisma.seoMeta.findUnique({
      where: { organizationId_path_locale: { organizationId, path: body.path, locale: 'DE' } },
      select: { title: true, description: true, keywords: true, ogImageUrl: true, noIndex: true },
    });

    const title = body.title?.trim() ?? '';
    const description = body.description?.trim() ?? '';
    const ogImageUrl = body.ogImageUrl?.trim() ?? '';

    // Nichts gepflegt und nicht ausgeblendet → die Zeile hat keinen Zweck.
    const isEmpty =
      title === '' &&
      description === '' &&
      ogImageUrl === '' &&
      body.keywords.length === 0 &&
      !body.noIndex;

    if (isEmpty) {
      if (before) {
        await prisma.seoMeta.delete({
          where: { organizationId_path_locale: { organizationId, path: body.path, locale: 'DE' } },
        });
      }
    } else {
      await prisma.seoMeta.upsert({
        where: { organizationId_path_locale: { organizationId, path: body.path, locale: 'DE' } },
        create: {
          organizationId,
          path: body.path,
          locale: 'DE',
          title: title || null,
          description: description || null,
          keywords: body.keywords,
          ogImageUrl: ogImageUrl || null,
          noIndex: body.noIndex,
          updatedById: session.id,
        },
        update: {
          title: title || null,
          description: description || null,
          keywords: body.keywords,
          ogImageUrl: ogImageUrl || null,
          noIndex: body.noIndex,
          updatedById: session.id,
        },
      });
    }

    await invalidateSeo(organizationId, body.path);

    const after = {
      title: title || null,
      description: description || null,
      keywords: body.keywords,
      ogImageUrl: ogImageUrl || null,
      noIndex: body.noIndex,
    };

    await audit.updated({
      organizationId,
      userId: session.id,
      entity: 'SeoMeta',
      entityId: body.path,
      summary:
        `Suchmaschinenangaben für „${definition?.label ?? body.path}" geändert` +
        (body.noIndex && !before?.noIndex ? ' — Seite aus dem Index genommen' : '') +
        (!body.noIndex && before?.noIndex ? ' — Seite wieder freigegeben' : ''),
      changes: diff(before as never, after as never),
    });

    return ok({ path: body.path, reset: isEmpty });
  },
});
