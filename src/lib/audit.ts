import 'server-only';

import type { AuditAction } from '@prisma/client';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { freitextSchwaerzen, GESCHWAERZT, istSensiblerSchluessel, wertSchwaerzen } from '@/lib/sensitive-fields';

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

/**
 * Feldnamen, deren Werte nie im Log landen — die ausdrücklich benannten.
 *
 * Seit dem Audit vom 2026-09-23 ist das **nicht mehr die ganze Regel**. Die
 * Liste bleibt als lesbare Zusicherung stehen (`protokoll-und-schranken`
 * prüft sie), entschieden wird aber über `istSensiblerSchluessel` aus
 * `src/lib/sensitive-fields.ts`: Teilwort-Muster für ganze Familien (`salary`,
 * `birth`, `emergency`, `token` …) und Felder je Entität. Die exakte Liste
 * allein hatte `hourlyRate`, `monthlySalary` und `birthday` durchgelassen.
 * `hourlyRate` steht absichtlich nicht in dieser Liste: Sie gilt für jede
 * Entität, und `Service.hourlyRate` ist ein Katalogpreis. Beim Personal
 * schwärzt ihn die Entitätsregel.
 */
export const REDACTED_FIELDS = new Set([
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
  'monthlySalary',
  'birthday',
]);

function sensibel(key: string, entity?: string): boolean {
  return REDACTED_FIELDS.has(key) || istSensiblerSchluessel(key, entity);
}

/**
 * Exportiert, damit das Sicherheitsprotokoll dieselbe Redigierung benutzt und
 * nicht eine zweite, die auseinanderläuft. Eine zweite Liste gepflegter
 * Feldnamen wäre eine Liste, die beim nächsten neuen Geheimnis nur an einer
 * Stelle ergänzt wird — und man merkt es an der Stelle, an der es zählt.
 *
 * `entity` schaltet die Felder dazu, die nur in dieser Entität Personendaten
 * sind (`Employee.city`, `Payslip.alv`). Die Tiefenbegrenzung kürzt, statt
 * ungefiltert durchzulassen — die frühere Fassung gab ab Tiefe 4 den Wert
 * unverändert zurück.
 */
export function redact(value: unknown, entity?: string): unknown {
  const geschwaerzt = wertSchwaerzen(value, entity);
  // `REDACTED_FIELDS` enthält Namen, die das Muster ohnehin trifft; sie hier
  // ein zweites Mal zu prüfen hält die ausdrücklich benannten Felder auch
  // dann geschützt, wenn jemand ein Muster enger fasst.
  return ausdruecklicheFelder(geschwaerzt, 0);
}

function ausdruecklicheFelder(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) return value.map((v) => ausdruecklicheFelder(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_FIELDS.has(key) && val !== undefined ? GESCHWAERZT : ausdruecklicheFelder(val, depth + 1);
  }
  return out;
}

/**
 * Nur die tatsächlich geänderten Felder festhalten.
 *
 * Bei einem sensiblen Feld steht im Ergebnis weiterhin der Schlüssel — das
 * Protokoll zeigt, **dass** sich `monthlySalary` geändert hat, nur nicht von
 * welchem auf welchen Betrag.
 */
export function diff<T extends Record<string, unknown>>(
  before: T | null,
  after: T,
  entity?: string,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);

  for (const key of keys) {
    const from = before?.[key];
    const to = after[key];
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes[key] = sensibel(key, entity) ? { from: GESCHWAERZT, to: GESCHWAERZT } : { from, to };
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
        // Auch die Zusammenfassung ist Freitext, in dem eine IBAN oder
        // AHV-Nummer stehen könnte; die erkennbaren Formate werden ersetzt.
        summary: input.summary ? freitextSchwaerzen(input.summary).slice(0, 500) : null,
        changes: input.changes ? (redact(input.changes, input.entity) as object) : undefined,
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
