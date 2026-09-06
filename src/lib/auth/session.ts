import 'server-only';

import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { cache as reactCache } from 'react';
import type { UserRole } from '@prisma/client';

import { prisma } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  cookieOptions,
  hashToken,
  randomToken,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
} from './jwt';
import { can, type Permission } from './rbac';
import { ForbiddenError, UnauthorizedError } from '@/lib/errors';

export interface SessionUser {
  id: string;
  organizationId: string;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
  role: UserRole;
  avatarUrl: string | null;
  locale: string;
  /** Customer-ID bzw. Employee-ID der Person, falls vorhanden. */
  profileId: string | null;
}

/**
 * Aktuelle Session lesen.
 *
 * `React.cache` dedupliziert den Aufruf innerhalb eines Requests: Layout,
 * Page und mehrere Server Components teilen sich eine einzige Auswertung.
 */
export const getSession = reactCache(async (): Promise<SessionUser | null> => {
  const store = await cookies();
  const token = store.get(ACCESS_COOKIE)?.value;
  if (!token) return null;

  const claims = await verifyAccessToken(token);
  if (!claims) return null;

  return {
    id: claims.sub,
    organizationId: claims.org,
    email: claims.email,
    firstName: claims.name.split(' ')[0] ?? '',
    lastName: claims.name.split(' ').slice(1).join(' '),
    name: claims.name,
    role: claims.role,
    avatarUrl: (claims.avatar as string | undefined) ?? null,
    locale: (claims.locale as string | undefined) ?? 'de',
    profileId: claims.pid ?? null,
  };
});

/**
 * Session inkl. frischer DB-Prüfung. Für sicherheitskritische Operationen
 * (Zahlungen, Rollenänderungen), wo ein gesperrter Account sofort wirken muss.
 */
export async function getVerifiedSession(): Promise<SessionUser | null> {
  const session = await getSession();
  if (!session) return null;

  const user = await prisma.user.findFirst({
    where: { id: session.id, status: 'ACTIVE', deletedAt: null },
    select: { id: true, role: true, organizationId: true },
  });
  if (!user) return null;

  // Rolle könnte seit Ausstellung des Tokens geändert worden sein.
  return { ...session, role: user.role, organizationId: user.organizationId };
}

export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  return session;
}

export async function requireRole(...roles: UserRole[]): Promise<SessionUser> {
  const session = await requireSession();
  if (!roles.includes(session.role)) {
    throw new ForbiddenError(`Rolle ${session.role} ist für diese Aktion nicht berechtigt.`);
  }
  return session;
}

export async function requirePermission(...permissions: Permission[]): Promise<SessionUser> {
  const session = await requireSession();
  const missing = permissions.filter((p) => !can(session.role, p));
  if (missing.length > 0) {
    throw new ForbiddenError(`Fehlende Berechtigung: ${missing.join(', ')}`);
  }
  return session;
}

/**
 * Seitenschutz für Server Components.
 *
 * Unterschied zu `requirePermission`: fehlt die Berechtigung, endet die Seite
 * mit 404 statt mit einem Fehler.
 *
 * Zwei Gründe. Erstens landet ein geworfener Fehler in der Fehlergrenze des
 * Bereichs — die Person sähe „Da ist etwas schiefgelaufen", obwohl nichts
 * schiefgegangen ist. Zweitens verrät ein 403 die *Existenz* der Seite: wer
 * sie nicht benutzen darf, muss auch nicht wissen, dass es sie gibt. In der
 * Navigation taucht sie ohnehin nicht auf.
 *
 * Für Endpunkte bleibt es beim 403 — dort ist der Aufrufer die eigene
 * Applikation, und die soll den Unterschied kennen.
 */
export async function requirePagePermission(
  ...permissions: Permission[]
): Promise<SessionUser> {
  const session = await requireSession();
  const missing = permissions.filter((p) => !can(session.role, p));
  if (missing.length > 0) notFound();
  return session;
}

/** Die Customer-ID der aktuellen Session — für „nur eigene Daten"-Filter. */
export async function requireCustomerId(): Promise<{ session: SessionUser; customerId: string }> {
  const session = await requireSession();
  if (session.role === 'CUSTOMER') {
    if (!session.profileId) throw new ForbiddenError('Kein Kundenprofil verknüpft.');
    return { session, customerId: session.profileId };
  }
  throw new ForbiddenError('Diese Ressource ist Kundenkonten vorbehalten.');
}

export async function requireEmployeeId(): Promise<{ session: SessionUser; employeeId: string }> {
  const session = await requireSession();
  if (!session.profileId || session.role === 'CUSTOMER') {
    throw new ForbiddenError('Kein Mitarbeitendenprofil verknüpft.');
  }
  return { session, employeeId: session.profileId };
}

// ---------------------------------------------------------------------------
//  Session-Lebenszyklus
// ---------------------------------------------------------------------------

interface CreateSessionInput {
  userId: string;
  /** Bestehende Rotationsfamilie beim Refresh weiterführen. */
  family?: string;
}

/**
 * Erzeugt Access- und Refresh-Token, setzt beide Cookies und persistiert den
 * Refresh-Token-Hash. Rotation: jeder Refresh erzeugt einen neuen Token in
 * derselben `family`; taucht ein bereits widerrufener Token wieder auf, wird
 * die ganze Familie invalidiert (Token-Reuse-Detection).
 */
export async function createSession({ userId, family }: CreateSessionInput) {
  const env = serverEnv();

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      locale: true,
      avatarUrl: true,
      organizationId: true,
      customer: { select: { id: true } },
      employee: { select: { id: true } },
    },
  });

  const profileId = user.customer?.id ?? user.employee?.id ?? undefined;

  const accessToken = await signAccessToken({
    sub: user.id,
    org: user.organizationId,
    role: user.role,
    email: user.email,
    name: `${user.firstName} ${user.lastName}`.trim(),
    pid: profileId,
    locale: user.locale.toLowerCase(),
    avatar: user.avatarUrl ?? undefined,
  } as never);

  const jti = randomToken(24);
  const tokenFamily = family ?? randomToken(16);
  const refreshToken = await signRefreshToken({ userId: user.id, jti, family: tokenFamily });

  const hdrs = await headers();
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: await hashToken(refreshToken),
      family: tokenFamily,
      userAgent: hdrs.get('user-agent')?.slice(0, 300) ?? null,
      ip: clientIpFrom(hdrs),
      expiresAt: new Date(Date.now() + env.JWT_REFRESH_TTL * 1000),
    },
  });

  const store = await cookies();
  store.set(ACCESS_COOKIE, accessToken, cookieOptions(env.JWT_ACCESS_TTL));
  store.set(REFRESH_COOKIE, refreshToken, cookieOptions(env.JWT_REFRESH_TTL));

  return { accessToken, refreshToken, user };
}

export async function destroySession() {
  const store = await cookies();
  const refreshToken = store.get(REFRESH_COOKIE)?.value;

  if (refreshToken) {
    const tokenHash = await hashToken(refreshToken);
    await prisma.refreshToken
      .updateMany({ where: { tokenHash }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  }

  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
}

/** Alle Sessions eines Benutzers beenden (Passwortwechsel, Sperrung). */
export async function revokeAllSessions(userId: string) {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export function clientIpFrom(hdrs: Headers): string | null {
  return (
    hdrs.get('cf-connecting-ip') ??
    hdrs.get('x-real-ip') ??
    hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null
  );
}
