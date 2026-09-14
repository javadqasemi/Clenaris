import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { ValidationError } from '@/lib/errors';
import {
  contentActionSchema,
  updateContentSchema,
  validateEntries,
} from '@/lib/validation/cms';
import { getOrganizationId } from '@/server/services/organization.service';
import {
  discardContentDrafts,
  publishContent,
  saveContentDraft,
  unpublishContent,
} from '@/server/services/content.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/content — Website-Texte als **Entwurf** speichern.
 *
 * Architekturentscheide:
 *
 *  • **Speichern veröffentlicht nicht.** Vorher waren beide dasselbe: Ein
 *    Tastendruck, und ein halb fertiger Satz stand auf der Website. Wer eine
 *    Seite überarbeitet, braucht mehrere Anläufe — und in der Zwischenzeit
 *    liest Kundschaft mit. Die Freigabe ist jetzt ein eigener, bewusster
 *    Schritt (`POST` mit `action: 'publish'`).
 *
 *  • **Ein Aufruf für alle Änderungen eines Formulars.** Die Redaktion ändert
 *    selten ein einzelnes Feld; eine Sammelübergabe erspart zwanzig Anfragen
 *    und lässt das Prüfprotokoll einen Vorgang statt zwanzig zeigen.
 *
 *  • **Leeren heisst zurücksetzen.** Ein geleertes Feld führt zurück zum
 *    Auslieferungstext — der einzige Weg zurück, ohne den ursprünglichen
 *    Wortlaut nachschlagen zu müssen. Bei einem bereits veröffentlichten
 *    Baustein wird daraus ein *leerer Entwurf*, damit der Text nicht ohne
 *    Freigabe von der Website verschwindet.
 */
export const PATCH = defineRoute({
  permissions: ['content:update'],
  body: updateContentSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();

    const errors = validateEntries(body.entries);
    if (errors.length > 0) {
      throw new ValidationError('Bitte prüfen Sie die markierten Felder.', errors);
    }

    const result = await saveContentDraft({
      organizationId,
      values: Object.fromEntries(body.entries.map((entry) => [entry.key, entry.value])),
      actorId: session.id,
    });

    return ok({ saved: result.saved, reset: result.removed });
  },
});

/**
 * POST /api/content — Entwürfe freigeben, verwerfen oder einen Baustein
 * zurückziehen.
 *
 * Alle drei in einem Endpunkt, weil sie denselben Gegenstand betreffen und
 * dieselbe Berechtigung verlangen; die Handlung steht ausdrücklich im Körper
 * statt implizit im Pfad. Das Schema liegt wie alle anderen in
 * `lib/validation/cms.ts`, damit die OpenAPI-Erzeugung es kennt.
 */
export const POST = defineRoute({
  permissions: ['content:update'],
  body: contentActionSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    const organizationId = await getOrganizationId();

    if (body.action === 'publish') {
      const count = await publishContent({ organizationId, keys: body.keys, actorId: session.id });
      return ok({ published: count });
    }

    if (body.action === 'discard') {
      const count = await discardContentDrafts({
        organizationId,
        keys: body.keys,
        actorId: session.id,
      });
      return ok({ discarded: count });
    }

    await unpublishContent({ organizationId, key: body.key, actorId: session.id });
    return ok({ unpublished: body.key });
  },
});
