import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { updateTimeEntrySchema } from '@/lib/validation/operations';
import { getOrganizationId } from '@/server/services/organization.service';
import { deleteTimeEntry, updateTimeEntry } from '@/server/services/timetracking.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/time/:id — eine Erfassung korrigieren.
 *
 * **Eine freigegebene Zeit lässt sich nicht ändern** (422). Sie ist die
 * Grundlage einer Abrechnung; wer sie korrigieren will, hebt zuerst die
 * Freigabe auf. Diese Schwelle macht aus „freigegeben" eine Aussage statt
 * einer Anzeige.
 *
 * Die Dauer rechnet der Dienst neu und passt dabei die Lohnkosten des
 * Einsatzes an — `clockOut` schreibt sie fort, und eine Korrektur, die das
 * nicht nachzieht, lässt die Nachkalkulation auseinanderlaufen.
 */
export const PATCH = defineRoute({
  permissions: ['timetracking:approve'],
  params: idParam,
  body: updateTimeEntrySchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await updateTimeEntry({
        organizationId: await getOrganizationId(),
        entryId: params.id,
        actorId: session.id,
        ip,
        input: body,
      }),
    ),
});

/**
 * DELETE /api/time/:id — eine Erfassung entfernen.
 *
 * Nur, solange sie nicht freigegeben ist. Der Fall dahinter ist der
 * Doppeleintrag: zweimal eingestempelt, einmal vergessen auszustempeln. Ihn
 * auf null Minuten zu korrigieren wäre eine Zeile, die aussieht wie Arbeit
 * ohne Dauer — löschen ist hier die ehrlichere Handlung.
 *
 * Die Lohnkosten des Einsatzes werden um die entfallenen Minuten gesenkt.
 */
export const DELETE = defineRoute({
  permissions: ['timetracking:approve'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) =>
    ok(
      await deleteTimeEntry({
        organizationId: await getOrganizationId(),
        entryId: params.id,
        actorId: session.id,
        ip,
      }),
    ),
});
