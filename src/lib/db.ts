import { Prisma, type PrismaClient } from '@prisma/client';

import { erzeugePrismaClient } from './prisma-client';

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

// Seit Prisma 7 über den Treiberadapter (`prisma-client.ts`), Adresse aus `DATABASE_URL`.
function createClient() {
  return erzeugePrismaClient({
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

/**
 * Transaktions-Client-Typ für Services, die innerhalb `$transaction` laufen.
 *
 * Prismas eigener Typ statt einer eigenen Ausschlussliste (seit Prisma 7,
 * 2026-09-29): Die Liste liess `$transaction` weg, Prisma 7 nimmt es in
 * `TransactionClient` auf — beide Typen passten danach nicht mehr zueinander.
 * Welche Methoden eine Transaktion hat, entscheidet Prisma.
 */
export type Tx = Prisma.TransactionClient;

/**
 * Die Einzelheiten eines Datenbankfehlers — in beiden Formen, die Prisma
 * liefert (seit Prisma 7, 2026-09-29).
 *
 * Bis Prisma 6 standen die betroffenen Spalten in `meta.target` und der
 * SQLSTATE einer rohen Abfrage in `meta.code`. Mit dem Treiberadapter liegen
 * sie unter `meta.driverAdapterError.cause`: `constraint.fields` oder — wenn
 * Postgres nur den Namen des Index meldet — `constraint.index`
 * (etwa `materials_organizationId_barcode_key`), der SQLSTATE in
 * `originalCode`. Gemessen gegen die Testdatenbank. Ohne diese Stelle hätte
 * jede Prüfung auf `meta.target` still „nichts gefunden" gemeldet: der
 * Lagerbestand „Artikelnummer vergeben" beim doppelten Strichcode, die
 * Fehlerabbildung eine Verklemmung als 500 statt 409.
 */
interface AdapterUrsache {
  originalCode?: string;
  constraint?: { fields?: string[]; index?: string };
}

function adapterUrsache(error: Prisma.PrismaClientKnownRequestError): AdapterUrsache | undefined {
  return (error.meta as { driverAdapterError?: { cause?: AdapterUrsache } } | undefined)?.driverAdapterError?.cause;
}

/** Spalten (oder der Indexname) einer verletzten Eindeutigkeit — leer, wenn unbekannt. */
export function eindeutigkeitsFelder(error: unknown): string[] {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return [];
  const ziel = (error.meta as { target?: string[] | string } | undefined)?.target;
  if (Array.isArray(ziel)) return ziel.map(String);
  if (typeof ziel === 'string') return [ziel];
  const constraint = adapterUrsache(error)?.constraint;
  if (constraint?.fields?.length) return constraint.fields.map(String);
  return constraint?.index ? [constraint.index] : [];
}

/** SQLSTATE des zugrunde liegenden Postgres-Fehlers (etwa `40P01`), falls gemeldet. */
export function sqlZustand(error: unknown): string | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const alt = (error.meta as { code?: unknown } | undefined)?.code;
  if (typeof alt === 'string') return alt;
  return adapterUrsache(error)?.originalCode;
}

/**
 * Eindeutigkeit verletzt? Mit `target`: an dieser Spalte — ein Indexname, der
 * die Spalte enthält, zählt mit (die Adapterform meldet oft nur den Index).
 */
export function isUniqueConstraintError(error: unknown, target?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  if (!target) return true;
  return eindeutigkeitsFelder(error).some((f) => f === target || f.includes(target));
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
