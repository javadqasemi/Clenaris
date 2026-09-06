import { z } from 'zod';

import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { audit, diff } from '@/lib/audit';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * Betriebseinstellungen.
 *
 * Sie liegen im JSON-Feld `Organization.settings` und nicht in eigenen
 * Spalten: es sind Schalter, die sich häufiger ändern als das Schema, und
 * jeder von ihnen bräuchte sonst eine Migration.
 *
 * Das Schema hier ist trotzdem streng. Ein freies JSON-Feld ohne Prüfung wäre
 * die Stelle, an der ein Tippfehler im Schlüssel eine Einstellung
 * stillschweigend wirkungslos macht — der Fehler, den man erst Wochen später
 * bemerkt, wenn keine Mahnung mehr rausgeht.
 */
const settingsSchema = z
  .object({
    /** Wie viele Tage im Voraus gebucht werden kann. */
    bookingLeadDays: z.number().int().min(0).max(365),
    /** Wie kurzfristig eine Buchung noch möglich ist, in Stunden. */
    bookingMinNoticeHours: z.number().int().min(0).max(720),
    /** Ab wann eine Stornierung kostenpflichtig wird, in Stunden. */
    cancellationDeadlineHours: z.number().int().min(0).max(720),
    /** Automatische Terminerinnerung per SMS. */
    smsRemindersEnabled: z.boolean(),
    /** Mahnläufe automatisch starten. */
    autoDunningEnabled: z.boolean(),
    /** Tage bis zur ersten Mahnung nach Fälligkeit. */
    firstReminderAfterDays: z.number().int().min(1).max(90),
    /** Bewertungsanfrage nach abgeschlossenem Einsatz, in Tagen. */
    reviewRequestAfterDays: z.number().int().min(0).max(90),
    /** Neue Bewertungen erst nach Freigabe anzeigen. */
    moderateReviews: z.boolean(),
  })
  .partial();

const DEFAULTS = {
  bookingLeadDays: 90,
  bookingMinNoticeHours: 24,
  cancellationDeadlineHours: 48,
  smsRemindersEnabled: true,
  autoDunningEnabled: true,
  firstReminderAfterDays: 10,
  reviewRequestAfterDays: 2,
  moderateReviews: true,
};

/** GET /api/settings — mit Standardwerten aufgefüllt. */
export const GET = defineRoute({
  permissions: ['settings:read'],
  rateLimit: 'apiRead',
  handler: async () => {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: await getOrganizationId() },
      select: { settings: true },
    });
    // Ein fehlender Schlüssel ist kein Fehler, sondern der Auslieferungswert.
    return ok({ ...DEFAULTS, ...((org.settings as Record<string, unknown>) ?? {}) });
  },
});

/**
 * PATCH /api/settings — Teil-Update.
 *
 * Gesendet wird nur, was sich ändert; der Rest bleibt. Ein vollständiges
 * Überschreiben würde bei zwei gleichzeitig geöffneten Masken die Änderung
 * der jeweils anderen still verwerfen.
 */
export const PATCH = defineRoute({
  permissions: ['settings:update'],
  body: settingsSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const organizationId = await getOrganizationId();
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { settings: true },
    });

    const before = { ...DEFAULTS, ...((org.settings as Record<string, unknown>) ?? {}) };
    const after = { ...before, ...body };

    await prisma.organization.update({
      where: { id: organizationId },
      data: { settings: after },
    });

    await audit.updated({
      organizationId,
      userId: session.id,
      entity: 'Organization',
      entityId: organizationId,
      summary: 'Betriebseinstellungen geändert',
      changes: diff(before, after),
      ip,
    });

    return ok(after);
  },
});
