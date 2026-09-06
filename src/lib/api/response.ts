import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';

import { type AppError, isAppError } from '@/lib/errors';
import { serialize } from '@/lib/db';
import { logger } from '@/lib/logger';

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
        const target = (error.meta as { target?: string[] })?.target?.join(', ') ?? 'Wert';
        return NextResponse.json(
          {
            error: {
              code: 'CONFLICT',
              message: `Dieser ${target} ist bereits vergeben.`,
            },
          },
          { status: 409 },
        );
      }
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

  log.error('Unbehandelter Fehler', { error });
  return NextResponse.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Es ist ein unerwarteter Fehler aufgetreten.',
      },
    },
    { status: 500 },
  );
}
