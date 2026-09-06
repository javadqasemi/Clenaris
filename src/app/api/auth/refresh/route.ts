import { cookies } from 'next/headers';

import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { UnauthorizedError } from '@/lib/errors';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  hashToken,
  verifyRefreshToken,
} from '@/lib/auth/jwt';
import { createSession } from '@/lib/auth/session';
import { logger } from '@/lib/logger';

const log = logger('auth/refresh');

export const runtime = 'nodejs';

/**
 * POST /api/auth/refresh
 *
 * Token-Rotation mit Wiederverwendungserkennung.
 *
 * Jeder Refresh gibt einen neuen Token derselben `family` aus und widerruft
 * den alten. Taucht ein bereits widerrufener Token erneut auf, wurde er
 * gestohlen — dann wird die ganze Familie invalidiert und die Person muss sich
 * neu anmelden. Das ist die Standardabwehr gegen Replay-Angriffe auf
 * Refresh-Tokens (OAuth 2.1, Abschnitt zu Refresh Token Rotation).
 */
export const POST = definePublicRoute({
  handler: async () => {
    const store = await cookies();
    const token = store.get(REFRESH_COOKIE)?.value;
    if (!token) throw new UnauthorizedError('Keine Sitzung gefunden.');

    const claims = await verifyRefreshToken(token);
    if (!claims) {
      store.delete(REFRESH_COOKIE);
      store.delete(ACCESS_COOKIE);
      throw new UnauthorizedError('Die Sitzung ist abgelaufen.');
    }

    const tokenHash = await hashToken(token);
    const record = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: {
        user: { select: { id: true, status: true, deletedAt: true } },
      },
    });

    // Unbekannt oder abgelaufen → Sitzung beenden.
    if (!record || record.expiresAt < new Date()) {
      store.delete(REFRESH_COOKIE);
      store.delete(ACCESS_COOKIE);
      throw new UnauthorizedError('Die Sitzung ist abgelaufen.');
    }

    // Wiederverwendung eines widerrufenen Tokens → ganze Familie sperren.
    if (record.revokedAt) {
      await prisma.refreshToken.updateMany({
        where: { family: record.family, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      store.delete(REFRESH_COOKIE);
      store.delete(ACCESS_COOKIE);
      log.warn('Token-Wiederverwendung erkannt — Familie gesperrt', { family: record.family });
      throw new UnauthorizedError(
        'Aus Sicherheitsgründen wurde die Sitzung beendet. Bitte melden Sie sich erneut an.',
      );
    }

    if (!record.user || record.user.deletedAt || record.user.status !== 'ACTIVE') {
      store.delete(REFRESH_COOKIE);
      store.delete(ACCESS_COOKIE);
      throw new UnauthorizedError('Dieses Konto ist nicht mehr aktiv.');
    }

    // Alten Token entwerten, neuen in derselben Familie ausstellen.
    await prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });

    const session = await createSession({ userId: record.user.id, family: record.family });

    return ok({
      id: session.user.id,
      role: session.user.role,
      email: session.user.email,
    });
  },
});
