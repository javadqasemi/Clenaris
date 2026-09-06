import { z } from 'zod';

import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createCtaSchema } from '@/lib/validation/cta';
import { createCta, listCtas } from '@/server/services/cta.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

const listQuery = z.object({
  /** `1` zeigt auch den Papierkorb. */
  papierkorb: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
});

/**
 * GET /api/cta — alle Handlungsaufrufe, auch abgeschaltete.
 *
 * Ohne Blätterung: es sind wenige Dutzend Einträge, und die Verwaltung
 * sortiert sie um. Blättern hiesse, über Seitengrenzen zu sortieren.
 */
export const GET = defineRoute({
  permissions: ['cta:read'],
  query: listQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => ok(await listCtas(await getOrganizationId(), query.papierkorb)),
});

/**
 * POST /api/cta — neuen Handlungsaufruf anlegen.
 *
 * Das Ziel wird gegen eine Positivliste geprüft (interner Pfad, https, tel,
 * mailto). Ein freies Adressfeld wäre der direkte Weg zu einem
 * `javascript:`-Ziel auf der öffentlichen Website.
 */
export const POST = defineRoute({
  permissions: ['cta:create'],
  body: createCtaSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const cta = await createCta({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return created({ id: cta.id, key: cta.key });
  },
});
