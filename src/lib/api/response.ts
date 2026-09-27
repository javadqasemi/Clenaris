import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';

import { type AppError, isAppError } from '@/lib/errors';
import { serialize } from '@/lib/db';
import { logger } from '@/lib/logger';
import { aktuelleRequestId } from '@/lib/observability/context';

const log = logger('api');

/**
 * Einheitliches Antwortformat der REST-API.
 *
 * Erfolg:  { data: T, meta?: {...} }
 * Fehler:  { error: { code, message, details? } }
 *
 * Dieses Format ist in `docs/openapi.yaml` als `Envelope` dokumentiert und wird
 * vom React-Query-Client (`lib/api/client.ts`) automatisch ausgepackt.
 */

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export function ok<T>(data: T, init?: { status?: number; headers?: HeadersInit; meta?: unknown }) {
  return NextResponse.json(
    { data: serialize(data), ...(init?.meta ? { meta: serialize(init.meta) } : {}) },
    { status: init?.status ?? 200, headers: init?.headers },
  );
}

export function created<T>(data: T, headers?: HeadersInit) {
  return ok(data, { status: 201, headers });
}

export function noContent(headers?: HeadersInit) {
  return new NextResponse(null, { status: 204, headers });
}

export function paginated<T>(items: T[], meta: PaginationMeta, headers?: HeadersInit) {
  return ok(items, { meta, headers });
}

export function buildPagination(page: number, pageSize: number, total: number): PaginationMeta {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

export function fail(error: AppError, headers?: HeadersInit) {
  return NextResponse.json(error.toJSON(), { status: error.status, headers });
}

/**
 * Zentrale Fehlerübersetzung. Jeder Route Handler leitet Exceptions hierher —
 * damit gibt es genau eine Stelle, an der interne Details gefiltert werden.
 */
export function toErrorResponse(error: unknown): NextResponse {
  if (isAppError(error)) {
    const headers: Record<string, string> = {};
    if (error.code === 'RATE_LIMITED') {
      const retryAfter = (error.details as { retryAfter?: number } | undefined)?.retryAfter;
      if (retryAfter) headers['Retry-After'] = String(retryAfter);
    }
    if (!error.expose) {
      log.error(error.code, { message: error.message, cause: error.cause });
    }
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.expose
            ? error.message
            : 'Ein externer Dienst ist derzeit nicht erreichbar. Bitte später erneut versuchen.',
          ...(error.details !== undefined && error.expose ? { details: error.details } : {}),
        },
      },
      { status: error.status, headers },
    );
  }

  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Die Eingaben sind ungültig.',
          details: error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
          })),
        },
      },
      { status: 422 },
    );
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002': {
        /*
          Ohne Spaltennamen (2026-09-27). Vorher stand das Prisma-Ziel in der
          Meldung — „Dieser documentId, version ist bereits vergeben." —, also
          interne Feldnamen vor der Kundschaft, und kein Mensch konnte damit
          etwas anfangen. Wo ein Dienst eine sprechende Meldung kennt, wirft er
          selbst einen `ConflictError`; hier bleibt die allgemeine. Das Ziel
          steht im Protokoll, wo es zur Fehlersuche gebraucht wird.
        */
        log.warn('Eindeutigkeit verletzt', { target: (error.meta as { target?: unknown })?.target });
        return NextResponse.json(
          {
            error: {
              code: 'CONFLICT',
              message: 'Dieser Wert ist bereits vergeben. Bitte laden Sie die Ansicht neu und prüfen Sie die Eingabe.',
            },
          },
          { status: 409 },
        );
      }
      case 'P2010':
        // Rohe Abfrage (`$queryRaw`/`$executeRaw`): Verklemmung (40P01) und
        // Serialisierungsfehler (40001) sind derselbe Fall wie P2034 darunter;
        // jeder andere Fehler einer rohen Abfrage bleibt unbehandelt.
        if (!['40P01', '40001'].includes(String((error.meta as { code?: unknown })?.code ?? ''))) break;
      // falls through
      case 'P2034':
        /*
          Schreibkonflikt oder Verklemmung zweier Transaktionen (2026-09-27).
          Bis dahin fiel er als unbehandelter Fehler auf 500 — dabei ist er
          kein Fehler der Anwendung, sondern „gleichzeitig mit jemand anderem
          geschrieben", und ein erneuter Versuch gelingt. 409 sagt genau das.
        */
        return NextResponse.json(
          {
            error: {
              code: 'CONFLICT',
              message: 'Gleichzeitig wurde derselbe Datensatz geändert. Bitte versuchen Sie es erneut.',
            },
          },
          { status: 409 },
        );
      case 'P2025':
        return NextResponse.json(
          { error: { code: 'NOT_FOUND', message: 'Der Datensatz wurde nicht gefunden.' } },
          { status: 404 },
        );
      case 'P2003':
        return NextResponse.json(
          {
            error: {
              code: 'CONFLICT',
              message: 'Der Datensatz ist noch mit anderen Objekten verknüpft.',
            },
          },
          { status: 409 },
        );
    }
  }

  /*
    Verklemmung oder Serialisierungsfehler, die nicht als P2034/P2010 kommen
    (2026-09-27). Im Release-Lauf erreichte eine Verklemmung aus `updateMany`
    die Antwort als unbekannter Fehler (`PrismaClientUnknownRequestError`) mit
    der Postgres-Meldung im Text — und wurde zu 500. Erkannt wird sie am
    SQLSTATE oder an der Meldung der Datenbank; die Antwort ist dieselbe wie
    oben, ohne die Meldung selbst nach aussen zu geben.
  */
  if (
    (error instanceof Prisma.PrismaClientUnknownRequestError || error instanceof Prisma.PrismaClientKnownRequestError) &&
    /40P01|40001|deadlock detected|could not serialize access/i.test(error.message)
  ) {
    return NextResponse.json(
      { error: { code: 'CONFLICT', message: 'Gleichzeitig wurde derselbe Datensatz geändert. Bitte versuchen Sie es erneut.' } },
      { status: 409 },
    );
  }

  log.error('Unbehandelter Fehler', { error });

  /**
   * Die Anfragekennung **im Rumpf**, nicht nur in der Kopfzeile.
   *
   * Die Kopfzeile `X-Request-Id` steht an jeder Antwort, aber niemand liest
   * Kopfzeilen, wenn etwas schiefgeht — man sieht die Fehlermeldung auf dem
   * Bildschirm und schreibt eine Nachricht. Steht die Kennung in der Meldung,
   * steht sie in dieser Nachricht, und aus „bei mir kam ein Fehler, so gegen
   * halb drei" wird ein Filter über das Protokoll.
   *
   * Sie verrät nichts: eine Zufalls-UUID, die nur für diese eine Anfrage gilt
   * und nirgends als Zugang taugt. Genau deshalb steht sie **nur** hier und
   * nicht bei den übrigen Fehlern — ein abgelehnter Zugriff oder eine
   * ungültige Eingabe braucht keine Nachforschung, und eine Kennung an jeder
   * Absage lädt dazu ein, sie irgendwo zu sammeln.
   */
  const rid = aktuelleRequestId();

  return NextResponse.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: rid
          ? `Es ist ein unerwarteter Fehler aufgetreten. Kennung: ${rid}`
          : 'Es ist ein unerwarteter Fehler aufgetreten.',
        ...(rid ? { requestId: rid } : {}),
      },
    },
    { status: 500 },
  );
}
