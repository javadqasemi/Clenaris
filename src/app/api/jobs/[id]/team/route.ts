import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { jobTeamSchema } from '@/lib/validation/operations';
import { setJobTeam } from '@/server/services/job.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PUT /api/jobs/:id/team — Team des Einsatzes setzen, mit Rolle je Person.
 *
 * Getrennt von `/assign`: Der Kalender teilt schnell zu („diese Leute"), diese
 * Route stellt bewusst auf („Leitung, zwei Mitarbeitende, eine lernende
 * Person"). Beide enden in `JobAssignment`, aber mit unterschiedlicher
 * Sorgfalt — und `/assign` darf niemand verlieren, weil er die Rollen nicht
 * kennt: Es setzt die erste Person auf LEAD und lässt den Rest auf MEMBER.
 *
 * Ein leeres Team ist erlaubt und setzt den Einsatz zurück auf „nicht
 * zugeteilt" — das ist der einzige Weg, eine Fehlzuteilung ganz aufzulösen.
 */
export const PUT = defineRoute({
  permissions: ['job:assign'],
  params: idParam,
  body: jobTeamSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    await setJobTeam({
      organizationId: await getOrganizationId(),
      jobId: params.id,
      input: body,
      actorId: session.id,
    });

    return ok({ id: params.id, size: body.members.length });
  },
});
