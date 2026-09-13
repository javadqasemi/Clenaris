import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { assetFieldSchema } from '@/lib/validation/cms';
import { getOrganizationId } from '@/server/services/organization.service';
import { updateAssetField } from '@/server/services/content.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/content/asset — ein Bild an seinem Datensatz austauschen.
 *
 * **Warum es diesen Endpunkt neben `/api/content` gibt.** Der dortige Endpunkt
 * schreibt Textbausteine: Schlüssel aus dem Register, Entwurfsstand, Freigabe.
 * Die Bilder der Website gehören dagegen Datensätzen — ein Vorher-/Nachher-Paar
 * dem Galerieeintrag, das Kopfbild der Leistung. Beides in einen Endpunkt zu
 * zwingen hiesse, zwei verschiedene Dinge hinter einem Namen zu verstecken.
 *
 * Was hier zählt, ist die Herkunft des Aufrufs: Die Redaktion zeigt in der
 * Vorschau auf ein Bild und tauscht es dort aus, statt die Galerieverwaltung zu
 * suchen. Wohin geschrieben wird, entscheidet trotzdem der Server anhand seiner
 * eigenen Liste (`ASSET_FIELDS`) — Tabelle und Spalte kommen aus der Anfrage
 * und sind damit nicht vertrauenswürdig.
 */
export const PATCH = defineRoute({
  permissions: ['content:update'],
  body: assetFieldSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();

    const result = await updateAssetField({
      organizationId,
      entity: body.entity,
      id: body.id,
      field: body.field,
      url: body.url,
      actorId: session.id,
    });

    return ok(result);
  },
});
