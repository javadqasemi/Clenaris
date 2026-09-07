import { definePublicRoute } from '@/lib/api/handler';
import { prisma, toNumber } from '@/lib/db';
import { hasIntegration } from '@/lib/env';
import { cache, cacheKeys } from '@/lib/redis';
import { formatCurrency } from '@/lib/utils';
import { streamText } from '@/lib/ai/client';
import { chatSystemPrompt } from '@/lib/ai/features';
import { chatSchema } from '@/lib/validation/ai';
import { getOrganizationId, getPublicCompanyInfo } from '@/server/services/organization.service';

export const runtime = 'nodejs';
// Antworten können bis zu einer Minute dauern; Streaming hält die Verbindung offen.
export const maxDuration = 60;

/**
 * POST /api/public/ai/chat
 *
 * Website-Assistent, Antwort als Server-Sent-Event-Strom.
 *
 * Sicherheitsentscheide:
 *  • Der Systemprompt weist das Modell an, Besuchernachrichten als *Daten* zu
 *    behandeln. Zusätzlich wird die Frage in Anführungszeichen gekapselt —
 *    das reduziert Prompt-Injection deutlich, auch wenn es sie nicht ausschliesst.
 *  • Kein Zugriff auf Kunden-, Buchungs- oder Rechnungsdaten. Der Assistent
 *    kennt nur den öffentlichen Leistungskatalog und das Einsatzgebiet.
 *  • Der Verlauf wird nicht gespeichert.
 */

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

export const POST = definePublicRoute({
  body: chatSchema,
  rateLimit: 'aiChat',
  handler: async ({ body }) => {
    if (!hasIntegration('ai')) {
      return sse(
        'Der Assistent ist derzeit nicht verfügbar. Rufen Sie uns an — wir helfen Ihnen gerne persönlich weiter.',
      );
    }

    const organizationId = await getOrganizationId();

    // Kontext ist für alle Besucher identisch → eine Stunde cachen.
    const context = await cache.remember(cacheKeys.aiChatContext(organizationId), 3600, async () => {
      const [company, services, areas] = await Promise.all([
        getPublicCompanyInfo(),
        prisma.service.findMany({
          where: { organizationId, active: true },
          orderBy: { position: 'asc' },
          select: {
            name: true,
            shortDesc: true,
            pricingModel: true,
            hourlyRate: true,
            pricePerSqm: true,
            minPrice: true,
            basePrice: true,
          },
        }),
        prisma.serviceArea.findMany({
          where: { organizationId, active: true },
          select: { city: true },
          distinct: ['city'],
          orderBy: { city: 'asc' },
        }),
      ]);

      const openingHours = company.openingHours
        .filter((hour) => !hour.closed && hour.opensAt)
        .map((hour) => `${WEEKDAYS[hour.weekday]} ${hour.opensAt}–${hour.closesAt}`)
        .join(', ');

      return {
        phone: company.phone ?? '',
        openingHours: openingHours || 'nach Vereinbarung',
        serviceAreas: areas.map((area) => area.city).join(', '),
        services: services.map((service) => ({
          name: service.name,
          shortDesc: service.shortDesc,
          from:
            service.pricingModel === 'PER_HOUR'
              ? `${formatCurrency(toNumber(service.hourlyRate))} pro Stunde`
              : service.pricingModel === 'ON_REQUEST'
                ? 'individuelle Offerte'
                : `${formatCurrency(toNumber(service.minPrice) || toNumber(service.basePrice))} pauschal`,
        })),
      };
    });

    const stream = streamText({
      system: chatSystemPrompt(context),
      // Die Besucherfrage wird als Zitat übergeben, nicht als Anweisung.
      prompt: `Frage einer Website-Besucherin oder eines Besuchers:\n"""\n${body.message}\n"""`,
      history: body.history.map((turn) => ({ role: turn.role, content: turn.content })),
      tier: 'fast',
      effort: 'low',
      maxTokens: 800,
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  },
});

/** Statische Antwort im SSE-Format, wenn die KI nicht konfiguriert ist. */
function sse(message: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: message })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    },
  );
}

