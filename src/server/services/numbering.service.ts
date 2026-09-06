import 'server-only';

import { prisma, type Tx } from '@/lib/db';

/**
 * Lückenlose Belegnummern.
 *
 * Architekturentscheid: Die Schweizer Buchhaltungsvorschriften (Art. 957a OR,
 * MWSTG) verlangen fortlaufende, lückenlose Rechnungsnummern. `MAX(number)+1`
 * ist unter Nebenläufigkeit unsicher, `AUTOINCREMENT` erzeugt Lücken bei
 * Rollbacks. Deshalb: eine eigene Sequenztabelle, die innerhalb der
 * Geschäftstransaktion mit `UPDATE ... RETURNING` atomar hochgezählt wird.
 * Rollt die Transaktion zurück, rollt auch die Nummer zurück — genau das
 * gewünschte Verhalten, denn dann existiert der Beleg nicht.
 *
 * Format: PREFIX-JAHR-LAUFNUMMER, z. B. RE-2026-00042
 */

export type SequenceScope = 'invoice' | 'quote' | 'booking' | 'job' | 'credit_note' | 'customer' | 'lead' | 'employee';

const PREFIX_FIELD: Record<SequenceScope, string> = {
  invoice: 'invoiceNumberPrefix',
  quote: 'quoteNumberPrefix',
  booking: 'bookingNumberPrefix',
  job: 'jobNumberPrefix',
  credit_note: 'creditNumberPrefix',
  customer: '',
  lead: '',
  employee: '',
};

const STATIC_PREFIX: Partial<Record<SequenceScope, string>> = {
  customer: 'K',
  lead: 'L',
  employee: 'MA',
};

export interface NextNumberResult {
  number: string;
  sequence: number;
  year: number;
}

/**
 * Nächste Nummer im Kontext einer Transaktion ziehen.
 * MUSS innerhalb von `prisma.$transaction` aufgerufen werden, damit die
 * Nummer bei einem Fehler nicht verbraucht wird.
 */
export async function nextNumber(
  tx: Tx,
  organizationId: string,
  scope: SequenceScope,
  at: Date = new Date(),
): Promise<NextNumberResult> {
  const year = at.getUTCFullYear();

  // `upsert` + `increment` ist auf PostgreSQL atomar: der UPDATE-Zweig sperrt
  // die Zeile bis zum Commit, konkurrierende Transaktionen warten.
  const sequence = await tx.numberSequence.upsert({
    where: { organizationId_scope_year: { organizationId, scope, year } },
    create: { organizationId, scope, year, current: 1 },
    update: { current: { increment: 1 } },
    select: { current: true },
  });

  const prefix = await resolvePrefix(tx, organizationId, scope);
  const padded = String(sequence.current).padStart(5, '0');

  return {
    number: `${prefix}-${year}-${padded}`,
    sequence: sequence.current,
    year,
  };
}

async function resolvePrefix(
  tx: Tx,
  organizationId: string,
  scope: SequenceScope,
): Promise<string> {
  const staticPrefix = STATIC_PREFIX[scope];
  if (staticPrefix) return staticPrefix;

  const field = PREFIX_FIELD[scope];
  const org = await tx.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: {
      invoiceNumberPrefix: true,
      quoteNumberPrefix: true,
      bookingNumberPrefix: true,
      jobNumberPrefix: true,
      creditNumberPrefix: true,
    },
  });

  return (org as unknown as Record<string, string>)[field] ?? 'DOC';
}

/** Aktueller Zählerstand — für die QR-Referenz und Vorschauen im Admin. */
export async function peekSequence(
  organizationId: string,
  scope: SequenceScope,
  year = new Date().getUTCFullYear(),
): Promise<number> {
  const row = await prisma.numberSequence.findUnique({
    where: { organizationId_scope_year: { organizationId, scope, year } },
    select: { current: true },
  });
  return row?.current ?? 0;
}
