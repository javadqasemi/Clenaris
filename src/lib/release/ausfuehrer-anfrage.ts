import 'server-only';

import type { NextRequest } from 'next/server';
import type { ZodType } from 'zod';

import { ConfigurationError, UnauthorizedError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';

import { SIGNATUR_KOPF, ZEIT_KOPF, signaturPruefen } from './ausfuehrer-signatur';

const log = logger('release-ausfuehrer');

/** Die Anfragen des Ausführers sind klein; mehr ist kein Auftrag, sondern ein Versuch. */
const HOECHSTENS_BYTES = 16 * 1024;

/**
 * Rumpf lesen, Signatur prüfen, dann erst parsen — in dieser Reihenfolge.
 *
 * Geprüft wird über die **Rohbytes** (siehe `ausfuehrer-signatur.ts`); ein
 * Parsen vorher hiesse, ungeprüften Inhalt zu verarbeiten. Das Bearer-Token
 * hat die Fabrik (`defineCronRoute`) schon geprüft. Der Ablehnungsgrund geht
 * ins Protokoll, nach aussen immer dasselbe 401.
 */
export async function ausfuehrerAnfrage<T>(request: NextRequest, schema: ZodType<T>, quelle: 'rumpf' | 'abfrage'): Promise<T> {
  const schluessel = process.env.RELEASE_EXECUTOR_SIGNING_KEY?.trim();
  if (!schluessel) {
    throw new ConfigurationError('release-ausfuehrer', 'Die Schnittstelle des Release-Ausführers ist nicht eingerichtet (RELEASE_EXECUTOR_SIGNING_KEY).');
  }
  if (Number(request.headers.get('content-length') ?? 0) > HOECHSTENS_BYTES) throw new ValidationError('Anfrage zu gross.');
  const rumpf = request.method === 'GET' ? '' : await request.text();
  if (rumpf.length > HOECHSTENS_BYTES) throw new ValidationError('Anfrage zu gross.');

  const grund = signaturPruefen(schluessel, {
    methode: request.method,
    pfad: `${request.nextUrl.pathname}${request.nextUrl.search}`,
    zeit: request.headers.get(ZEIT_KOPF),
    signatur: request.headers.get(SIGNATUR_KOPF),
    rumpf,
  });
  if (grund) {
    log.warn('Anfrage des Release-Ausführers abgewiesen', { grund, pfad: request.nextUrl.pathname });
    throw new UnauthorizedError('Signatur des Ausführers ungültig.');
  }

  if (quelle === 'abfrage') return schema.parse(Object.fromEntries(request.nextUrl.searchParams));
  let roh: unknown;
  try {
    roh = JSON.parse(rumpf);
  } catch {
    throw new ValidationError('Kein gültiges JSON.');
  }
  return schema.parse(roh);
}
