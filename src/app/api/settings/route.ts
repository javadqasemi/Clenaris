import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { audit, diff } from '@/lib/audit';
import {
  updateOperationSettingsSchema,
  withSettingsDefaults,
} from '@/lib/validation/settings';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * Betriebseinstellungen.
 *
 * Schema und Standardwerte stehen in `@/lib/validation/settings` — Endpunkt,
 * Bearbeitungsmaske und Doku lesen dieselbe Quelle. Getrennt wären sie beim
 * ersten neuen Schalter auseinandergelaufen.
 */

/** GET /api/settings — mit Standardwerten aufgefüllt. */
export const GET = defineRoute({
  permissions: ['settings:read'],
  rateLimit: 'apiRead',
  handler: async () => {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: await getOrganizationId() },
      select: { settings: true },
    });
    return ok(withSettingsDefaults(org.settings));
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
  body: updateOperationSettingsSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const organizationId = await getOrganizationId();
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { settings: true },
    });

    const before = withSettingsDefaults(org.settings);
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
