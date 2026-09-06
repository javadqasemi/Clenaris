import { z } from 'zod';

import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { updateOpeningHours } from '@/server/services/company.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Bitte eine Uhrzeit im Format HH:MM angeben.');

/**
 * Die Woche als Ganzes.
 *
 * Sieben Zeilen kommen zusammen, sieben gehen zurück. Einzelne Tage zu pflegen
 * wäre bei einem Formular mit sieben Zeilen sieben Anfragen — und jede könnte
 * für sich fehlschlagen, was einen halb gespeicherten Wochenplan hinterliesse.
 */
const bodySchema = z.object({
  hours: z
    .array(
      z.object({
        weekday: z.number().int().min(0, 'Wochentag 0–6.').max(6, 'Wochentag 0–6.'),
        opensAt: z.union([timeSchema, z.literal('')]).optional(),
        closesAt: z.union([timeSchema, z.literal('')]).optional(),
        closed: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(7),
});

/** GET /api/opening-hours */
export const GET = defineRoute({
  permissions: ['company:read'],
  rateLimit: 'apiRead',
  handler: async () =>
    ok(
      await prisma.openingHours.findMany({
        where: { organizationId: await getOrganizationId() },
        orderBy: { weekday: 'asc' },
      }),
    ),
});

/**
 * PUT /api/opening-hours — die Woche setzen.
 *
 * `PUT` statt `PATCH`, weil der Körper den *vollständigen* gewünschten Zustand
 * beschreibt und nicht eine Teiländerung.
 */
export const PUT = defineRoute({
  permissions: ['company:update'],
  body: bodySchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const hours = await updateOpeningHours({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      hours: body.hours.map((hour) => ({
        weekday: hour.weekday,
        opensAt: hour.opensAt || null,
        closesAt: hour.closesAt || null,
        closed: hour.closed,
      })),
    });
    return ok(hours);
  },
});
