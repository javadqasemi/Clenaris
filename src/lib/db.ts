import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Prisma-Singleton.
 *
 * Architekturentscheid: In der Entwicklung erzeugt Hot-Reload sonst pro Änderung
 * einen neuen Client und erschöpft den Connection-Pool. Auf Vercel läuft jede
 * Lambda-Instanz mit `connection_limit=1` gegen den Supabase-Pooler (PgBouncer),
 * Migrationen laufen über `DIRECT_URL`.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createClient() {
  return new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? [{ level: 'warn', emit: 'stdout' }, { level: 'error', emit: 'stdout' }]
        : [{ level: 'error', emit: 'stdout' }],
    errorFormat: process.env.NODE_ENV === 'development' ? 'pretty' : 'minimal',
  });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export { Prisma };
export type { PrismaClient };

/** Transaktions-Client-Typ für Services, die innerhalb `$transaction` laufen. */
export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/** Prisma-Fehler in sprechende Meldungen übersetzen. */
export function isUniqueConstraintError(error: unknown, target?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  if (!target) return true;
  const meta = error.meta as { target?: string[] | string } | undefined;
  const fields = Array.isArray(meta?.target) ? meta?.target : [meta?.target];
  return fields.some((f) => f === target);
}

export function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2025' || error.code === 'P2001')
  );
}

/**
 * Decimal → number. Prisma liefert `Decimal`-Objekte, die nicht serialisierbar
 * sind. Alle API-Antworten laufen durch diesen Konverter.
 */
export function toNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

/** Rekursiv Decimal/Date in JSON-taugliche Werte umwandeln. */
export function serialize<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, val) => {
      if (val instanceof Date) return val.toISOString();
      if (val && typeof val === 'object' && 'toFixed' in val && 's' in val && 'd' in val) {
        return Number(val.toString());
      }
      if (typeof val === 'bigint') return val.toString();
      return val;
    }),
  ) as T;
}
