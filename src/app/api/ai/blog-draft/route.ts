import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { generateBlogDraft } from '@/lib/ai/features';
import { blogDraftSchema } from '@/lib/validation/ai';
import { protokolliereKiNutzung } from '@/server/services/ai-governance.service';

export const runtime = 'nodejs';
export const maxDuration = 180;

/** POST /api/ai/blog-draft — Rohtext für einen Ratgeberartikel. */
export const POST = defineRoute({
  permissions: ['ai:use', 'blog:create'],
  body: blogDraftSchema,
  rateLimit: 'aiGenerate',
  handler: async ({ body, session, ip }) => {
    const draft = await generateBlogDraft({
      topic: body.topic,
      keywords: body.keywords,
      wordCount: body.wordCount,
    });
    await protokolliereKiNutzung({ organizationId: session.organizationId, userId: session.id, funktion: 'Blog-Entwurf', ip });

    return ok(draft);
  },
});
