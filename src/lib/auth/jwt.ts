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
  /**
   * Farbschema aus dem Konto.
   *
   * Im Token statt in einer Abfrage: Es wird auf *jeder* Seite des
   * Applikationsrahmens gebraucht, und dafür eine Datenbankabfrage aufzuwenden
   * wäre unverhältnismässig. Dass der Wert bis zur nächsten Erneuerung des
   * Tokens (höchstens 15 Minuten) veraltet sein kann, ist folgenlos: Er wirkt
   * ohnehin nur auf Geräten, die noch keine eigene Wahl getroffen haben, und
   * das Gerät, auf dem gerade umgestellt wurde, gehört nicht dazu.
   */
  thm?: string;
  /**
   * Kennung einer laufenden Geräteübergabe — die Sperre (Gate 4D).
   *
   * Steht sie im Token, hält gerade jemand anderes dieses Gerät und die
   * Mitarbeitersitzung ist blockiert. Als Anspruch im Token statt als
   * Abfrage je Aufruf: Die Prüfung kostet so nichts, und sie liegt an
   * derselben Stelle wie Rolle und Organisation.
   *
   * Der Umweg, der damit **nicht** offensteht: Wer das Zugangstoken
   * löscht, bekommt kein unbelastetes zurück — `createSession` schlägt die
   * Übergabe bei jeder Erneuerung in der Datenbank nach und prägt sie
   * erneut ein. Die Datenbank bleibt die Wahrheit, das Token nur ihr
   * schneller Abdruck.
   */
  lck?: string;
  /**
   * „Angemeldet bleiben" wurde gewählt (seit 2026-09-28).
   *
   * Im Zugangstoken, damit der Rahmen der Anwendung ohne Abfrage weiss,
   * welches Leerlauffenster gilt (`SESSION_IDLE_TTL` oder
   * `SESSION_REMEMBER_IDLE_TTL`). Die Entscheidung selbst trägt der
   * Erneuerungstoken (`RefreshTokenClaims.rem`) — signiert, also nicht
   * nachträglich zu setzen.
   */
  rem?: true;
  typ: 'access';
}

export interface RefreshTokenClaims extends JWTPayload {
  sub: string;
  jti: string;
  fam: string;
  /**
   * Dauerhafte Sitzung. Fehlt der Anspruch, ist die Sitzung an das
   * Browserfenster gebunden: Cookies ohne `Max-Age`, kurzes Leerlauffenster.
   * Er wandert bei jeder Rotation mit (`refreshSession`), sonst wäre
   * „Angemeldet bleiben" nach der ersten Erneuerung vergessen.
   */
  rem?: true;
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
  persistent?: boolean;
}): Promise<string> {
  const ttl = serverEnv().JWT_REFRESH_TTL;
  return new SignJWT({ jti: params.jti, fam: params.family, ...(params.persistent ? { rem: true } : {}), typ: 'refresh' })
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

/**
 * Cookie-Optionen der Sitzung.
 *
 * `null` ergibt ein **Sitzungscookie** — ohne `Max-Age` und ohne `Expires`.
 * Der Browser verwirft es, wenn er beendet wird. Das ist seit 2026-09-28 die
 * Vorgabe; nur wer „Angemeldet bleiben" wählt, bekommt eine Laufzeit.
 *
 * Was das **nicht** verspricht: dass ein geschlossener Browser immer
 * abgemeldet ist. Browser mit Sitzungswiederherstellung („Tabs vom letzten Mal
 * öffnen") stellen auch Sitzungscookies wieder her, und das Schliessen eines
 * Fensters ist kein Ereignis, das eine Seite verlässlich bemerkt. Die Grenze,
 * die immer gilt, ist deshalb das Leerlauffenster auf dem Server
 * (`refreshSession`) — siehe `docs/SITZUNG.md`.
 */
export function cookieOptions(maxAgeSeconds: number | null) {
  const env = serverEnv();
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    ...(maxAgeSeconds === null ? {} : { maxAge: maxAgeSeconds }),
    ...(env.AUTH_COOKIE_DOMAIN ? { domain: env.AUTH_COOKIE_DOMAIN } : {}),
  };
}
