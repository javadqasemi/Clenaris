import { cache } from '@/lib/redis';
import { RateLimitError } from '@/lib/errors';

/**
 * Fixed-Window-Rate-Limiting über Redis (bzw. In-Memory-Fallback).
 *
 * Architekturentscheid: Fixed Window statt Sliding Log — ein einziger
 * `INCR`+`EXPIRE` pro Request, damit das Limit selbst unter Last billig bleibt.
 * Für die Missbrauchsabwehr, die wir hier brauchen (Login-Bruteforce,
 * Formular-Spam, teure KI-Endpunkte), ist die Ungenauigkeit an der
 * Fenstergrenze irrelevant. Cloudflare übernimmt vorgelagert die
 * volumetrische Abwehr.
 */

export interface RateLimitRule {
  /** Erlaubte Anfragen pro Fenster. */
  limit: number;
  /** Fensterlänge in Sekunden. */
  windowSeconds: number;
}

export const RATE_LIMITS = {
  login: { limit: 8, windowSeconds: 300 },
  register: { limit: 5, windowSeconds: 3600 },
  passwordReset: { limit: 4, windowSeconds: 3600 },
  contactForm: { limit: 6, windowSeconds: 3600 },
  bookingCreate: { limit: 12, windowSeconds: 3600 },
  quoteRequest: { limit: 10, windowSeconds: 3600 },
  priceEstimate: { limit: 90, windowSeconds: 60 },
  newsletter: { limit: 5, windowSeconds: 3600 },
  aiGenerate: { limit: 30, windowSeconds: 3600 },
  aiChat: { limit: 60, windowSeconds: 3600 },
  fileUpload: { limit: 60, windowSeconds: 600 },
  apiRead: { limit: 300, windowSeconds: 60 },
  apiWrite: { limit: 90, windowSeconds: 60 },
  webhook: { limit: 600, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  retryAfter: number;
}

/**
 * Zählt einen Treffer und meldet, ob das Limit überschritten wurde.
 * `identifier` ist üblicherweise IP, User-ID oder E-Mail.
 */
export async function checkRateLimit(
  name: RateLimitName,
  identifier: string,
): Promise<RateLimitResult> {
  const rule = RATE_LIMITS[name];
  const key = `rl:${name}:${identifier}`;

  const count = await cache.incr(key, rule.windowSeconds);
  const remaining = Math.max(0, rule.limit - count);
  const success = count <= rule.limit;
  const retryAfter = success ? 0 : Math.max(1, await cache.ttl(key));

  return { success, limit: rule.limit, remaining, retryAfter };
}

/** Wie `checkRateLimit`, wirft aber bei Überschreitung. */
export async function enforceRateLimit(
  name: RateLimitName,
  identifier: string,
): Promise<RateLimitResult> {
  const result = await checkRateLimit(name, identifier);
  if (!result.success) throw new RateLimitError(result.retryAfter);
  return result;
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
  };
  if (!result.success) headers['Retry-After'] = String(result.retryAfter);
  return headers;
}

/** Zähler zurücksetzen — z. B. nach erfolgreichem Login. */
export async function resetRateLimit(name: RateLimitName, identifier: string): Promise<void> {
  await cache.del(`rl:${name}:${identifier}`);
}

/** Client-IP aus den üblichen Proxy-Headern (Cloudflare → Vercel → App). */
export function getClientIp(request: Request): string {
  const h = request.headers;
  return (
    h.get('cf-connecting-ip') ??
    h.get('x-real-ip') ??
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    '127.0.0.1'
  );
}
