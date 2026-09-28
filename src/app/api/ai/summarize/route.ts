import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { summarize } from '@/lib/ai/features';
import { summarizeSchema } from '@/lib/validation/ai';
import { protokolliereKiNutzung } from '@/server/services/ai-governance.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** POST /api/ai/summarize — langen Text auf das Wesentliche kürzen. */
export const POST = defineRoute({
  permissions: ['ai:use'],
  body: summarizeSchema,
  rateLimit: 'aiGenerate',
  handler: async ({ body, session, ip }) => {
    const text = await summarize({
      text: body.text,
      focus: body.focus,
      maxSentences: body.maxSentences,
    });
    await protokolliereKiNutzung({ organizationId: session.organizationId, userId: session.id, funktion: 'Zusammenfassung', ip });

    return ok({ text });
  },
});
