import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { scanResolveSchema } from '@/lib/validation/scan';
import { getOrganizationId } from '@/server/services/organization.service';
import { scanAufloesen } from '@/server/services/scan.service';

export const runtime = 'nodejs';

/**
 * POST /api/scan/resolve — einen gescannten oder eingefügten Text auflösen.
 *
 * Liest nur: Die Antwort nennt Treffer im Leserecht der Rolle und die
 * Schnellaktionen, die sie ausführen dürfte — ausgeführt wird nichts. POST
 * statt GET, damit der Inhalt nicht in Adresse und Zugriffsprotokoll landet
 * (`src/lib/validation/scan.ts`). Unbekannt, fremd, gelöscht und ohne Recht
 * ergeben dieselbe leere Antwort.
 */
export const POST = defineRoute({
  permissions: ['dashboard:view'],
  body: scanResolveSchema,
  rateLimit: 'scanResolve',
  // Je Person, nicht je Adresse: Im Büro teilen sich alle eine IP, und die
  // Inventur einer Kollegin soll nicht das Kontingent der anderen aufbrauchen.
  rateLimitKey: ({ session, ip }) => (session ? `person:${session.id}` : ip),
  handler: async ({ body, session }) => ok(await scanAufloesen({ organizationId: await getOrganizationId(), session, text: body.text })),
});
