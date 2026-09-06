import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { translate } from '@/lib/ai/features';
import { translateSchema } from '@/lib/validation/ai';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/ai/translate
 *
 * Übersetzt Kundenkommunikation in die weiteren Landessprachen. Platzhalter
 * der Form `{{name}}` bleiben unverändert — so lassen sich auch E-Mail-
 * Vorlagen übersetzen, ohne sie zu zerstören.
 */
export const POST = defineRoute({
  permissions: ['ai:use'],
  body: translateSchema,
  rateLimit: 'aiGenerate',
  handler: async ({ body }) => {
    const text = await translate({
      text: body.text,
      targetLocale: body.targetLocale,
      preserveFormatting: body.preserveFormatting,
    });

    return ok({ text });
  },
});
