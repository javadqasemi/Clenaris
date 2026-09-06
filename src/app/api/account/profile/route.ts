import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { audit, diff } from '@/lib/audit';
import { updateProfileSchema } from '@/lib/validation/auth';

export const runtime = 'nodejs';

/**
 * PATCH /api/account/profile
 *
 * Eigene Stammdaten und Benachrichtigungseinstellungen ändern. Die E-Mail-
 * Adresse ist bewusst nicht dabei: ein Wechsel muss über einen
 * Bestätigungslink an die *neue* Adresse laufen, sonst liesse sich ein Konto
 * durch Adressänderung übernehmen.
 *
 * Änderungen an der Marketing-Einwilligung werden zusätzlich in `consents`
 * protokolliert — das verlangt die Nachweispflicht nach DSGVO Art. 7 Abs. 1.
 */
export const PATCH = defineRoute({
  body: updateProfileSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: session.id },
      select: {
        firstName: true,
        lastName: true,
        phone: true,
        locale: true,
        theme: true,
        notifyByEmail: true,
        notifyBySms: true,
        marketingOptIn: true,
      },
    });

    const user = await prisma.user.update({
      where: { id: session.id },
      data: {
        ...(body.firstName !== undefined ? { firstName: body.firstName } : {}),
        ...(body.lastName !== undefined ? { lastName: body.lastName } : {}),
        ...(body.phone !== undefined ? { phone: body.phone || null } : {}),
        ...(body.locale !== undefined ? { locale: body.locale } : {}),
        ...(body.theme !== undefined ? { theme: body.theme } : {}),
        ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl || null } : {}),
        ...(body.notifyByEmail !== undefined ? { notifyByEmail: body.notifyByEmail } : {}),
        ...(body.notifyBySms !== undefined ? { notifyBySms: body.notifyBySms } : {}),
        ...(body.marketingOptIn !== undefined ? { marketingOptIn: body.marketingOptIn } : {}),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        locale: true,
        organizationId: true,
        marketingOptIn: true,
      },
    });

    // Kundendatensatz mitführen, damit Rechnungen die aktuellen Angaben tragen.
    await prisma.customer.updateMany({
      where: { userId: user.id },
      data: {
        ...(body.firstName !== undefined ? { firstName: body.firstName } : {}),
        ...(body.lastName !== undefined ? { lastName: body.lastName } : {}),
        ...(body.phone !== undefined ? { phone: body.phone || null } : {}),
        ...(body.locale !== undefined ? { language: body.locale } : {}),
      },
    });

    if (body.marketingOptIn !== undefined && body.marketingOptIn !== before.marketingOptIn) {
      await prisma.consent.create({
        data: {
          userId: user.id,
          type: 'MARKETING_EMAIL',
          granted: body.marketingOptIn,
          ip: ip ?? null,
        },
      });
    }

    await audit.updated({
      organizationId: user.organizationId,
      userId: user.id,
      entity: 'User',
      entityId: user.id,
      summary: 'Profil aktualisiert',
      changes: diff(before, { ...before, ...body } as never),
      ip,
    });

    return ok({ id: user.id, firstName: user.firstName, lastName: user.lastName });
  },
});
