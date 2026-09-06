import { z } from 'zod';

import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { toggleCta } from '@/server/services/cta.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/cta/:id/publish — ein- oder ausschalten.
 *
 * Eigener Endpunkt und eigene Berechtigung (`cta:publish`), weil dies die
 * einzige Handlung ist, die etwas *auf der öffentlichen Website erscheinen
 * lässt*. Wer Texte vorbereiten darf, muss nicht auch veröffentlichen dürfen —
 * genau diese Trennung ist der Grund, warum es beide Rechte gibt.
 */
export const POST = defineRoute({
  permissions: ['cta:publish'],
  params: idParam,
  body: z.object({ active: z.boolean() }),
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const cta = await toggleCta({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      ctaId: params.id,
      active: body.active,
    });
    return ok({ id: cta.id, active: cta.active });
  },
});
