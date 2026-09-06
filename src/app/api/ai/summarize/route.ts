import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { summarize } from '@/lib/ai/features';
import { summarizeSchema } from '@/lib/validation/ai';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** POST /api/ai/summarize — langen Text auf das Wesentliche kürzen. */
export const POST = defineRoute({
  permissions: ['ai:use'],
  body: summarizeSchema,
  rateLimit: 'aiGenerate',
  handler: async ({ body }) => {
    const text = await summarize({
      text: body.text,
      focus: body.focus,
      maxSentences: body.maxSentences,
    });

    return ok({ text });
  },
});
