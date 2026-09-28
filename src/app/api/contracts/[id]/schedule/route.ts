import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { scheduleGenerateSchema } from '@/lib/validation/contracts';
import { idParam } from '@/lib/validation/queries';
import { generateJobsForContract } from '@/server/services/contract-schedule.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * POST /api/contracts/{id}/schedule — Einsätze aus den Serien erzeugen.
 *
 * ---------------------------------------------------------------------------
 *  Idempotenz
 * ---------------------------------------------------------------------------
 *
 * **Derselbe Serientermin erzeugt nie zwei Einsätze.** Nicht „sollte nicht",
 * sondern kann nicht: `@@unique([serviceScheduleId, scheduleDate])` steht in
 * der Datenbank. Der Planer *versucht* anzulegen und wertet einen Verstoss
 * gegen den Index als „war schon da" — eine Prüfung im Code allein reichte
 * nicht, weil zwischen „gibt es schon?" und `INSERT` ein Moment liegt, in den
 * ein zweiter Lauf genau hineinpasst.
 *
 * Die Kennung ist der **Serientag**, nicht der tatsächliche Termin. Wird ein
 * Einsatz wegen eines Feiertags verschoben, bleibt der Serientag derselbe;
 * sonst entstünde beim Nachtragen eines Feiertags ein zweiter Einsatz.
 *
 * Ein zweiter Aufruf, ein paralleler Aufruf, ein Wiederholungsversuch nach
 * einem Fehler und ein Lauf nach einer Vertragsänderung führen deshalb alle
 * zum selben Bestand. Die Antwort zeigt beide Zahlen — `angelegt` und
 * `uebersprungen` —, und die zweite ist der Beweis.
 *
 * `probelauf: true` schreibt nichts und liefert dieselbe Auskunft. Für die
 * Oberfläche („was würde passieren") und für die Prüfreihe: Ein Planer, den
 * man nur durch Schreiben befragen kann, lässt sich schlecht prüfen.
 *
 * Nicht geplant wird für einen pausierten Vertrag, über das Kündigungsdatum
 * hinaus und über das Vertragsende hinaus. Keine dieser Grenzen ist eine
 * Warnung — der Planer hört an ihnen auf.
 */
export const POST = defineRoute({
  permissions: ['contract:update'],
  params: idParam,
  body: scheduleGenerateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await generateJobsForContract({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        actorId: session.id,
        ip,
        bis: body.bis,
        probelauf: body.probelauf,
      }),
    ),
});
