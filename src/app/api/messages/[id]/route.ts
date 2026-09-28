import { defineRoute, idParam } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { replyMessageSchema } from '@/lib/validation/messaging';
import { readThread, replyToThread } from '@/server/services/message.service';

export const runtime = 'nodejs';

/**
 * GET /api/messages/:id
 *
 * Liefert den Verlauf und markiert beim Lesen die Gegenseite als gelesen —
 * jeweils nur die Nachrichten, die man selbst *nicht* geschrieben hat. Die
 * Sichtregel (Büro, eigene Kundschaft, zugeteilte Mitarbeitende) steht bei
 * `loadThread` in `message.service.ts`.
 */
export const GET = defineRoute({
  permissions: ['message:read', 'message:read_own'],
  anyPermission: true,
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session }) => {
    return ok(await readThread(params.id, session));
  },
});

/**
 * POST /api/messages/:id — antworten.
 *
 * Ein geschlossener Verlauf nimmt keine Antworten mehr an; wer nachfragen
 * will, eröffnet einen neuen. Das hält alte Akten stabil und verhindert, dass
 * eine erledigte Reklamation Monate später wieder aufgeht. Umgesetzt in
 * `replyToThread` (`message.service.ts`).
 */
export const POST = defineRoute({
  permissions: ['message:create', 'message:write_own'],
  anyPermission: true,
  params: idParam,
  body: replyMessageSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const message = await replyToThread({ threadId: params.id, session, input: body });
    return created({ id: message.id });
  },
});
