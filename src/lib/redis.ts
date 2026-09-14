import Redis from 'ioredis';
import { logger } from '@/lib/logger';

const log = logger('redis');

/**
 * Redis für Rate-Limiting, Caching und kurzlebige Sperren.
 *
 * Architekturentscheid: Redis ist *optional*. Fehlt `REDIS_URL` (lokale
 * Entwicklung, CI), fällt die Implementierung automatisch auf einen In-Memory-
 * Store zurück. Das Verhalten der Aufrufer bleibt identisch — nur die
 * Prozessübergreifende Konsistenz geht verloren, was lokal irrelevant ist.
 */

interface CacheDriver {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  incr(key: string, ttlSeconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
}

class MemoryDriver implements CacheDriver {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  private prune(key: string) {
    const entry = this.store.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string) {
    return this.prune(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number) {
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async del(key: string) {
    this.store.delete(key);
  }

  async incr(key: string, ttlSeconds: number) {
    const entry = this.prune(key);
    const next = Number(entry?.value ?? 0) + 1;
    this.store.set(key, {
      value: String(next),
      expiresAt: entry?.expiresAt ?? Date.now() + ttlSeconds * 1000,
    });
    return next;
  }

  async ttl(key: string) {
    const entry = this.prune(key);
    if (!entry || entry.expiresAt === null) return -1;
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  async keys(pattern: string) {
    const rx = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    const out: string[] = [];
    for (const key of this.store.keys()) {
      if (rx.test(key) && this.prune(key)) out.push(key);
    }
    return out;
  }
}

class RedisDriver implements CacheDriver {
  constructor(private client: Redis) {}

  get(key: string) {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number) {
    if (ttlSeconds) await this.client.set(key, value, 'EX', ttlSeconds);
    else await this.client.set(key, value);
  }

  async del(key: string) {
    await this.client.del(key);
  }

  async incr(key: string, ttlSeconds: number) {
    // Atomar: Zähler erhöhen und beim ersten Treffer TTL setzen.
    const results = await this.client.multi().incr(key).ttl(key).exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    const currentTtl = Number(results?.[1]?.[1] ?? -1);
    if (currentTtl < 0) await this.client.expire(key, ttlSeconds);
    return count;
  }

  async ttl(key: string) {
    return this.client.ttl(key);
  }

  async keys(pattern: string) {
    const found: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      found.push(...batch);
    } while (cursor !== '0');
    return found;
  }
}

const globalForRedis = globalThis as unknown as {
  redisClient?: Redis;
  cacheDriver?: CacheDriver;
};

function resolveDriver(): CacheDriver {
  if (globalForRedis.cacheDriver) return globalForRedis.cacheDriver;

  const url = process.env.REDIS_URL;
  if (!url) {
    globalForRedis.cacheDriver = new MemoryDriver();
    return globalForRedis.cacheDriver;
  }

  const client =
    globalForRedis.redisClient ??
    new Redis(url, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: false,
      connectTimeout: 5_000,
      retryStrategy: (times) => Math.min(times * 200, 3_000),
    });

  client.on('error', (err) => {
    // Redis-Ausfälle dürfen keine Requests killen — wir loggen und arbeiten weiter.
    log.error('Verbindungsfehler', { error: err.message });
  });

  globalForRedis.redisClient = client;
  globalForRedis.cacheDriver = new RedisDriver(client);
  return globalForRedis.cacheDriver;
}

export const cache = {
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await resolveDriver().get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },

  async set(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
    try {
      await resolveDriver().set(key, JSON.stringify(value), ttlSeconds);
    } catch {
      /* Cache-Fehler sind nie fatal */
    }
  },

  async del(key: string): Promise<void> {
    try {
      await resolveDriver().del(key);
    } catch {
      /* noop */
    }
  },

  async delByPattern(pattern: string): Promise<void> {
    try {
      const driver = resolveDriver();
      const keys = await driver.keys(pattern);
      await Promise.all(keys.map((k) => driver.del(k)));
    } catch {
      /* noop */
    }
  },

  async incr(key: string, ttlSeconds: number): Promise<number> {
    return resolveDriver().incr(key, ttlSeconds);
  },

  async ttl(key: string): Promise<number> {
    return resolveDriver().ttl(key);
  },

  /** Cache-Aside: Wert lesen oder via `producer` erzeugen und ablegen. */
  async remember<T>(key: string, ttlSeconds: number, producer: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== null) return hit;
    const value = await producer();
    await this.set(key, value, ttlSeconds);
    return value;
  },
};

/**
 * Cache-Schlüssel — **alle** an dieser Stelle.
 *
 * Nicht aus Ordnungsliebe. Wer einen Schlüssel beim Lesen und beim Löschen je
 * einmal von Hand schreibt, schreibt ihn irgendwann verschieden, und dann
 * passiert nichts Sichtbares: Der Löschbefehl trifft einen Schlüssel, den es
 * nicht gibt, der Eintrag bleibt stehen, und die Änderung erscheint erst nach
 * Ablauf der Frist. Genau so lagen die Firmendaten fünf Minuten und das
 * Einsatzgebiet eine Stunde hinter der Wirklichkeit zurück, ohne dass
 * irgendwo ein Fehler auftauchte.
 *
 * Eine Funktion, die beide Seiten bedient, kann nicht auseinanderlaufen.
 */
export const cacheKeys = {
  services: (orgId: string) => `org:${orgId}:services`,
  serviceAreas: (orgId: string) => `org:${orgId}:service-areas`,
  organization: (slug: string) => `org:slug:${slug}`,
  dashboardKpis: (orgId: string, range: string) => `org:${orgId}:kpi:${range}`,
  availability: (orgId: string, date: string) => `org:${orgId}:avail:${date}`,
  blogPost: (slug: string, locale: string) => `blog:${locale}:${slug}`,
  publicFaqs: (orgId: string, locale: string) => `org:${orgId}:faq:${locale}`,
  reviewsSummary: (orgId: string) => `org:${orgId}:reviews:summary`,
  content: (orgId: string, locale: string) => `content:${orgId}:${locale}`,
  seo: (orgId: string, path: string, locale: string) => `seo:${orgId}:${path}:${locale}`,
  navigation: (orgId: string, location: string) => `nav:${orgId}:${location}`,
  legal: (orgId: string, slug: string) => `legal:${orgId}:${slug}`,
  ctas: (orgId: string) => `cta:${orgId}`,
  aiChatContext: (orgId: string) => `ai:chat-context:${orgId}`,
};
