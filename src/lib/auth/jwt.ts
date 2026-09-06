import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { UserRole } from '@prisma/client';
import { serverEnv } from '@/lib/env';

/**
 * JWT-Handling mit `jose` — bewusst *nicht* `jsonwebtoken`.
 * `jose` läuft in der Edge-Runtime (Web Crypto), damit die Middleware Tokens
 * verifizieren kann, ohne Node-APIs zu benötigen.
 *
 * Token-Strategie:
 *  • Access-Token  (15 min, httpOnly Cookie) — trägt die Claims für RBAC.
 *  • Refresh-Token (30 Tage, httpOnly Cookie) — opak, nur als SHA-256-Hash in
 *    der DB, mit Rotation + Reuse-Detection über die `family`-Spalte.
 */

export const ACCESS_COOKIE = 'clenaris_at';
export const REFRESH_COOKIE = 'clenaris_rt';

export interface AccessTokenClaims extends JWTPayload {
  sub: string; // User-ID
  org: string; // Organization-ID
  role: UserRole;
  email: string;
  name: string;
  /** Employee- oder Customer-ID, je nach Rolle — spart Joins im Hot Path. */
  pid?: string;
  typ: 'access';
}

export interface RefreshTokenClaims extends JWTPayload {
  sub: string;
  jti: string;
  fam: string;
  typ: 'refresh';
}

let cachedSecret: Uint8Array | null = null;

function secret(): Uint8Array {
  if (!cachedSecret) {
    cachedSecret = new TextEncoder().encode(serverEnv().JWT_SECRET);
  }
  return cachedSecret;
}

const ISSUER = 'clenaris';
const AUDIENCE = 'clenaris-app';

export async function signAccessToken(
  claims: Omit<AccessTokenClaims, 'typ' | 'iat' | 'exp' | 'iss' | 'aud'>,
): Promise<string> {
  const ttl = serverEnv().JWT_ACCESS_TTL;
  return new SignJWT({ ...claims, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${ttl}s`)
    .sign(secret());
}

export async function signRefreshToken(params: {
  userId: string;
  jti: string;
  family: string;
}): Promise<string> {
  const ttl = serverEnv().JWT_REFRESH_TTL;
  return new SignJWT({ jti: params.jti, fam: params.family, typ: 'refresh' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(params.userId)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${ttl}s`)
    .sign(secret());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (payload.typ !== 'access') return null;
    return payload as AccessTokenClaims;
  } catch {
    return null;
  }
}

export async function verifyRefreshToken(token: string): Promise<RefreshTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (payload.typ !== 'refresh') return null;
    return payload as RefreshTokenClaims;
  } catch {
    return null;
  }
}

/**
 * SHA-256 über Web Crypto — funktioniert in Node- und Edge-Runtime.
 * Refresh-Tokens werden nie im Klartext gespeichert.
 */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Kryptografisch sicherer, URL-tauglicher Zufallsstring. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function cookieOptions(maxAgeSeconds: number) {
  const env = serverEnv();
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
    ...(env.AUTH_COOKIE_DOMAIN ? { domain: env.AUTH_COOKIE_DOMAIN } : {}),
  };
}
