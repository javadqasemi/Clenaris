import 'server-only';

import { cookies } from 'next/headers';

import { prisma } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { UnauthorizedError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { ACCESS_COOKIE, REFRESH_COOKIE, hashToken, verifyRefreshToken } from '@/lib/auth/jwt';
import { createSession } from '@/lib/auth/session';

const log = logger('auth/refresh');

/**
 * Sitzung erneuern — Rotation mit Wiederverwendungserkennung und Leerlauffenster.
 *
 * **Warum es diese Funktion gibt.** Der Zugangstoken lebt fünfzehn Minuten,
 * und bis hierher hat ihn nichts je erneuert: Wer eine Viertelstunde nach
 * der Anmeldung eine Seite öffnete, stand vor der Anmeldemaske — mitten in
 * der Arbeit, mit einem gültigen Refresh-Token im Browser, der nie gefragt
 * wurde. Jetzt rufen drei Stellen hier an: die Middleware (Seitenaufruf mit
 * abgelaufenem Zugangstoken), der API-Klient (401 auf einen Aufruf) und der
 * Aktivitätswächter im Rahmen der Anwendung (vorbeugend, solange gearbeitet
 * wird).
 *
 * **Das Leerlauffenster.** Erneuert wird nur, wenn der vorgelegte
 * Refresh-Token selbst jünger ist als `SESSION_IDLE_TTL`. Jede Erneuerung
 * stellt einen neuen Token aus, also wandert das Fenster mit der Aktivität —
 * und schliesst sich, sobald fünfzehn Minuten lang niemand etwas tut. Ohne
 * dieses Fenster wäre die Sitzung dreissig Tage lang wiederbelebbar, auch
 * aus einem vergessenen Tab auf einem geteilten Gerät. `JWT_REFRESH_TTL`
 * bleibt die absolute Obergrenze, die kein Fenster überschreitet.
 *
 * **Rotation.** Jeder Refresh gibt einen neuen Token derselben `family` aus
 * und widerruft den alten. Taucht ein bereits widerrufener Token erneut auf,
 * wurde er gestohlen — dann wird die ganze Familie invalidiert und die Person
 * muss sich neu anmelden (OAuth 2.1, Refresh Token Rotation).
 */
export async function refreshSession(): Promise<{ id: string; role: string; email: string }> {
  const store = await cookies();
  const token = store.get(REFRESH_COOKIE)?.value;
  if (!token) throw new UnauthorizedError('Keine Sitzung gefunden.');

  const forget = () => {
    store.delete(REFRESH_COOKIE);
    store.delete(ACCESS_COOKIE);
  };

  const claims = await verifyRefreshToken(token);
  if (!claims) {
    forget();
    throw new UnauthorizedError('Die Sitzung ist abgelaufen.');
  }

  const tokenHash = await hashToken(token);
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, status: true, deletedAt: true } } },
  });

  if (!record || record.expiresAt < new Date()) {
    forget();
    throw new UnauthorizedError('Die Sitzung ist abgelaufen.');
  }

  if (record.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { family: record.family, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    forget();
    log.warn('Token-Wiederverwendung erkannt — Familie gesperrt', { family: record.family });
    throw new UnauthorizedError(
      'Aus Sicherheitsgründen wurde die Sitzung beendet. Bitte melden Sie sich erneut an.',
    );
  }

  // Leerlauf: der Token wurde bei der letzten Aktivität ausgestellt. Liegt
  // die länger zurück als das Fenster, ist die Sitzung eingeschlafen — und
  // ein eingeschlafener Token wird widerrufen, nicht nur abgewiesen, damit
  // er auch später nicht mehr taugt.
  const idleMs = serverEnv().SESSION_IDLE_TTL * 1000;
  if (record.createdAt.getTime() + idleMs < Date.now()) {
    await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    forget();
    throw new UnauthorizedError('Die Sitzung wurde nach längerer Inaktivität beendet.');
  }

  if (!record.user || record.user.deletedAt || record.user.status !== 'ACTIVE') {
    forget();
    throw new UnauthorizedError('Dieses Konto ist nicht mehr aktiv.');
  }

  await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
  const session = await createSession({ userId: record.user.id, family: record.family });
  return { id: session.user.id, role: session.user.role, email: session.user.email };
}
