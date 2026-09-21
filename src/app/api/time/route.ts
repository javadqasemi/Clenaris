import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createTimeEntrySchema, timeEntryQuerySchema } from '@/lib/validation/operations';
import { getOrganizationId } from '@/server/services/organization.service';
import { createManualTimeEntry, listTimeEntries } from '@/server/services/timetracking.service';

export const runtime = 'nodejs';

/**
 * GET /api/time — erfasste Zeiten.
 *
 * `timetracking:read_all`. Die Berechtigung gab es seit jeher und wurde von
 * genau einem Endpunkt geprüft (dem Buchhaltungsexport) — es gab keinen Weg,
 * die Zeiten **anzusehen**, ohne sie zu exportieren.
 *
 * Die Summe der Minuten kommt über **alle** Treffer, nicht über die
 * angezeigte Seite. Eine Seitensumme wäre die häufigste Fehlerquelle einer
 * solchen Ansicht: Sie sieht aus wie die Monatssumme und ist es nicht, und
 * niemand merkt es, solange der Monat auf eine Seite passt.
 */
export const GET = defineRoute({
  permissions: ['timetracking:read_all'],
  query: timeEntryQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ query }) =>
    ok(
      await listTimeEntries({
        organizationId: await getOrganizationId(),
        employeeId: query.employeeId,
        jobId: query.jobId,
        from: query.from,
        to: query.to,
        approved: query.approved === undefined ? undefined : query.approved === 'true',
        nurOffen: query.nurOffen === 'true',
        page: query.page,
        pageSize: query.pageSize,
      }),
    ),
});

/**
 * POST /api/time — eine Zeit von Hand erfassen.
 *
 * Der Fall: Jemand hat das Stempeln vergessen, war ohne Empfang unterwegs oder
 * die Erfassung ist bei einem Gerätewechsel verlorengegangen. Ohne diesen Weg
 * bliebe nur, die Stunde nicht zu bezahlen oder sie neben dem System zu
 * führen — und beides passiert dann auch.
 *
 * `timetracking:approve`, nicht `timetracking:own`: Wer für **andere** Zeiten
 * einträgt, trifft eine Lohnentscheidung. Die eigene Zeit stempelt man.
 *
 * Der Eintrag wird als `manual` gekennzeichnet. Das ist keine Verdächtigung,
 * sondern die Auskunft, die eine Lohnkontrolle braucht: Eine gestempelte Zeit
 * hat einen Zeitpunkt und einen Ort, eine erfasste hat eine Person, die sie
 * eingetragen hat — und die steht im Prüfprotokoll.
 */
export const POST = defineRoute({
  permissions: ['timetracking:approve'],
  body: createTimeEntrySchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) =>
    created(
      await createManualTimeEntry({
        organizationId: await getOrganizationId(),
        actorId: session.id,
        ip,
        input: {
          employeeId: body.employeeId,
          jobId: body.jobId ?? null,
          startedAt: body.startedAt,
          endedAt: body.endedAt,
          breakMin: body.breakMin,
          note: body.note ?? null,
        },
      }),
    ),
});
