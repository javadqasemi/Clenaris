import { z } from 'zod';

import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { LEGAL_SLUGS, updateLegalSchema } from '@/lib/validation/navigation';
import { getLegalDocument, upsertLegalDocument } from '@/server/services/navigation.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

const slugParam = z.object({ slug: z.enum(LEGAL_SLUGS) });

/** GET /api/legal/:slug */
export const GET = defineRoute({
  permissions: ['legal:read'],
  params: slugParam,
  rateLimit: 'apiRead',
  handler: async ({ params }) =>
    ok(await getLegalDocument(await getOrganizationId(), params.slug)),
});

/**
 * PUT /api/legal/:slug — Rechtstext setzen.
 *
 * `PUT`, weil der Körper den vollständigen Text beschreibt; ein Teil-Update
 * eines Rechtstexts ergibt keinen Sinn.
 *
 * Ob eine Änderung eine **neue Fassung** ist, entscheidet die Redaktion über
 * `newVersion` und nicht ein Zähler: eine korrigierte Kommasetzung ist keine,
 * eine geänderte Aufbewahrungsfrist schon. Nur ein Mensch kann das
 * unterscheiden — und die Fassungsnummer ist der Bezugspunkt, wenn jemand
 * fragt, welchen AGB er zugestimmt hat.
 *
 * Es gibt kein Löschen: die vier Adressen sind aus Fusszeile, Cookie-Hinweis
 * und E-Mails verlinkt, und eine fehlende Datenschutzerklärung ist ein
 * Rechtsmangel.
 */
export const PUT = defineRoute({
  permissions: ['legal:update'],
  params: slugParam,
  body: updateLegalSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const document = await upsertLegalDocument({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      slug: params.slug,
      input: body,
    });
    return ok({ id: document.id, slug: document.slug, version: document.version });
  },
});
