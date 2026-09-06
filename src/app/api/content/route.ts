import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { ValidationError } from '@/lib/errors';
import { audit } from '@/lib/audit';
import { definitionFor } from '@/lib/cms/registry';
import { updateContentSchema, validateEntries } from '@/lib/validation/cms';
import { getOrganizationId } from '@/server/services/organization.service';
import { invalidateContent } from '@/server/services/content.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/content — Website-Texte pflegen.
 *
 * Architekturentscheide:
 *
 *  • **Ein Aufruf für alle Änderungen eines Formulars.** Die Redaktion ändert
 *    selten ein einzelnes Feld; eine Sammelübergabe erspart zwanzig Anfragen
 *    und lässt das Prüfprotokoll einen Vorgang statt zwanzig zeigen.
 *
 *  • **Leeren heisst zurücksetzen.** Wird ein Feld geleert, wird die Zeile
 *    gelöscht statt eine leere gespeichert — die Website zeigt dann wieder den
 *    Auslieferungstext. So kommt man immer zurück, ohne den ursprünglichen
 *    Wortlaut nachschlagen zu müssen.
 *
 *  • **Der Cache wird sofort geleert.** Sonst zeigt die Website bis zu fünf
 *    Minuten den alten Text, und die Redaktion glaubt, das Speichern habe
 *    nicht funktioniert.
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

    const toDelete: string[] = [];
    const toUpsert: { key: string; value: string | string[] }[] = [];

    for (const entry of body.entries) {
      const definition = definitionFor(entry.key)!;
      const isEmpty =
        definition.kind === 'list'
          ? !Array.isArray(entry.value) || entry.value.filter((v) => v.trim()).length === 0
          : typeof entry.value !== 'string' || entry.value.trim() === '';

      if (isEmpty) toDelete.push(entry.key);
      else {
        toUpsert.push({
          key: entry.key,
          value:
            definition.kind === 'list'
              ? (entry.value as string[]).map((v) => v.trim()).filter(Boolean)
              : (entry.value as string).trim(),
        });
      }
    }

    await prisma.$transaction([
      ...(toDelete.length
        ? [
            prisma.contentBlock.deleteMany({
              where: { organizationId, locale: 'DE', key: { in: toDelete } },
            }),
          ]
        : []),
      ...toUpsert.map((entry) =>
        prisma.contentBlock.upsert({
          where: {
            organizationId_key_locale: { organizationId, key: entry.key, locale: 'DE' },
          },
          create: {
            organizationId,
            key: entry.key,
            locale: 'DE',
            value: entry.value,
            updatedById: session.id,
          },
          update: { value: entry.value, updatedById: session.id },
        }),
      ),
    ]);

    await invalidateContent(organizationId);

    await audit.updated({
      organizationId,
      userId: session.id,
      entity: 'ContentBlock',
      entityId: 'website',
      summary:
        `Website-Inhalte geändert: ${toUpsert.length} gepflegt` +
        (toDelete.length ? `, ${toDelete.length} auf Standard zurückgesetzt` : ''),
      // Der geänderte Wortlaut gehört ins Protokoll: bei einer Reklamation
      // muss belegbar sein, was zum Zeitpunkt der Buchung auf der Website
      // stand und wer es geändert hat.
      changes: Object.fromEntries(
        body.entries.map((entry) => [
          entry.key,
          {
            from: null,
            to: Array.isArray(entry.value) ? entry.value.join(' · ') : entry.value,
          },
        ]),
      ),
    });

    return ok({ updated: toUpsert.length, reset: toDelete.length });
  },
});
