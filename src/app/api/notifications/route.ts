import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * GET /api/notifications — die letzten 25 In-App-Benachrichtigungen.
 *
 * `rateLimit: 'apiRead'` (300/min je Sitzung) ist hier nicht Zierrat: Die
 * Glocke im App-Rahmen fragt über React Query regelmässig nach, und der
 * Endpunkt liest bei jedem Aufruf die Datenbank. Ohne Begrenzung genügt ein
 * angemeldetes Konto mit einer Schleife, um den Verbindungspool zu belegen —
 * die vier Benachrichtigungsendpunkte waren die einzigen angemeldeten
 * Leseendpunkte des Systems ohne jede Schranke.
 */
export const GET = defineRoute({
  permissions: ['notification:read_own'],
  rateLimit: 'apiRead',
  handler: async ({ session }) => {
    const notifications = await prisma.notification.findMany({
      where: { userId: session.id, channel: 'IN_APP' },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: {
        id: true,
        title: true,
        body: true,
        link: true,
        readAt: true,
        createdAt: true,
      },
    });

    return ok(notifications);
  },
});
