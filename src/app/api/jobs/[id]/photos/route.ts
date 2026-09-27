import { defineRoute, idParam } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { jobPhotoSchema } from '@/lib/validation/operations';
import { addJobPhoto } from '@/server/services/job.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/jobs/:id/photos
 *
 * Registriert ein bereits hochgeladenes und abgeschlossenes Foto am Einsatz.
 * Die Datei liegt zu diesem Zeitpunkt schon im Speicher — dieser Endpunkt
 * verknüpft sie nur, weshalb er sehr schnell ist.
 *
 * Die Verknüpfung selbst steht im Dienst (`addJobPhoto`) und geht durch die
 * eine Bindungsregel (`dateienBinden`): nur eine eigene, abgeschlossene, nicht
 * als schädlich erkannte und noch keinem Einsatz zugeordnete Datei. Bis
 * 2026-09-27 stand sie hier, mit eigenem Lesen und bedingungslosem Schreiben
 * und ohne Blick auf Urheberschaft und Prüfbefund (F-09b). Alle Schreibwege
 * laufen über Dienste — ein Handler, der selbst in Prisma schreibt, ist ein
 * zweiter Ort, an dem die Regel gepflegt werden müsste.
 */
export const POST = defineRoute({
  permissions: ['job:complete_assigned', 'job:update'],
  anyPermission: true,
  params: idParam,
  body: jobPhotoSchema,
  rateLimit: 'fileUpload',
  handler: async ({ params, body, session }) => {
    const photo = await addJobPhoto({
      organizationId: await getOrganizationId(),
      jobId: params.id,
      actorUserId: session.id,
      // Leere Kennung statt `undefined` für ein Mitarbeiterkonto ohne Profil:
      // Es ist dann keinem Einsatz zugeteilt, und die Prüfung im Dienst weist
      // es ab, statt es wie die Verwaltung zu behandeln.
      employeeId: session.role === 'EMPLOYEE' ? (session.profileId ?? '') : undefined,
      fotoUrheberId: session.profileId ?? null,
      input: body,
    });

    return created(photo);
  },
});
