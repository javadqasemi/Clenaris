import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { textAssistSchema } from '@/lib/validation/ai';
import { textAssistieren } from '@/server/services/text-assist.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/ai/text-assist — Textkorrektur und Textvorschläge.
 *
 * Dasselbe Recht wie Zusammenfassen und Übersetzen (`ai:use`: Leitung,
 * Administration, Systemverantwortung — nicht Mitarbeitende, nicht
 * Kundschaft), kein zusätzliches Schreibrecht auf den Datensatz: Der
 * Endpunkt schreibt nichts. Ob jemand den Text danach speichern darf,
 * entscheidet der Endpunkt des Formulars.
 *
 * Dieselbe Rate-Limit-Klasse wie alle KI-Entwürfe (`aiGenerate`), damit der
 * Textassistent kein zweites, grosszügigeres Kostenbudget neben den übrigen
 * KI-Funktionen öffnet.
 */
export const POST = defineRoute({
  permissions: ['ai:use'],
  body: textAssistSchema,
  rateLimit: 'aiGenerate',
  handler: async ({ body, session, ip }) =>
    ok(await textAssistieren(body, { organizationId: session.organizationId, userId: session.id, ip })),
});
