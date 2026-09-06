import 'server-only';

import type { AuditAction } from '@prisma/client';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

const log = logger('audit');

/**
 * Revisionssichere Protokollierung.
 *
 * Architekturentscheid: Audit-Schreibvorgänge dürfen die eigentliche
 * Geschäftstransaktion niemals zum Scheitern bringen — sie laufen deshalb
 * ausserhalb der Transaktion und schlucken Fehler (mit Console-Log). Für die
 * Nachvollziehbarkeit nach DSG/DSGVO reicht das, weil jede Mutation zusätzlich
 * über `updatedAt` und die Domänen-Statusfelder rekonstruierbar ist.
 */

/** Feldnamen, deren Werte nie im Log landen. */
const REDACTED_FIELDS = new Set([
  'password',
  'passwordHash',
  'twoFactorSecret',
  'tokenHash',
  'token',
  'ahvNumber',
  'alarmCode',
  'iban',
  'signatureDataUrl',
  'apiKey',
  'secret',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_FIELDS.has(key) ? '[redigiert]' : redact(val, depth + 1);
  }
  return out;
}

/** Nur die tatsächlich geänderten Felder festhalten. */
export function diff<T extends Record<string, unknown>>(
  before: T | null,
  after: T,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);

  for (const key of keys) {
    const from = before?.[key];
    const to = after[key];
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes[key] = {
      from: REDACTED_FIELDS.has(key) ? '[redigiert]' : from,
      to: REDACTED_FIELDS.has(key) ? '[redigiert]' : to,
    };
  }
  return changes;
}

export interface AuditInput {
  organizationId: string;
  userId?: string | null;
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  summary?: string;
  changes?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        summary: input.summary?.slice(0, 500) ?? null,
        changes: input.changes ? (redact(input.changes) as object) : undefined,
        ip: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
      },
    });
  } catch (error) {
    log.error('Protokollierung fehlgeschlagen', { error });
  }
}

/** Bequemer Wrapper für Erstellen/Ändern/Löschen. */
export const audit = {
  created: (ctx: Omit<AuditInput, 'action'>) => recordAudit({ ...ctx, action: 'CREATE' }),
  updated: (ctx: Omit<AuditInput, 'action'>) => recordAudit({ ...ctx, action: 'UPDATE' }),
  deleted: (ctx: Omit<AuditInput, 'action'>) => recordAudit({ ...ctx, action: 'DELETE' }),
  exported: (ctx: Omit<AuditInput, 'action'>) => recordAudit({ ...ctx, action: 'EXPORT' }),
  denied: (ctx: Omit<AuditInput, 'action'>) => recordAudit({ ...ctx, action: 'ACCESS_DENIED' }),
  payment: (ctx: Omit<AuditInput, 'action'>) => recordAudit({ ...ctx, action: 'PAYMENT' }),
};
