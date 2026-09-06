import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { writeEmail } from '@/lib/ai/features';
import { emailDraftSchema } from '@/lib/validation/ai';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/ai/email
 *
 * Erzeugt einen E-Mail-Entwurf. Der Endpunkt versendet bewusst nichts — der
 * Text geht an Kundschaft, also gibt ihn eine Person frei.
 */
export const POST = defineRoute({
  permissions: ['ai:use'],
  body: emailDraftSchema,
  rateLimit: 'aiGenerate',
  handler: async ({ body, session }) => {
    const result = await writeEmail({
      purpose: body.purpose,
      recipientName: body.recipientName,
      context: body.context,
      tone: body.tone,
      senderName: session.name,
    });

    return ok(result);
  },
});
