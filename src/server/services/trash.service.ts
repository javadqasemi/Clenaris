import 'server-only';

import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import type { Permission } from '@/lib/auth/rbac';

/**
 * Papierkorb: weiches Löschen und Wiederherstellen.
 *
 * Warum ein gemeinsames Modul und nicht neun Löschfunktionen:
 *
 *  • Der Ablauf ist überall derselbe — prüfen, ob der Datensatz existiert und
 *    zur Organisation gehört; prüfen, ob eine fachliche Regel dagegen spricht;
 *    `deletedAt` setzen; protokollieren. Neunmal ausgeschrieben liefe das
 *    auseinander, und die Stelle, die man beim Ergänzen vergisst, ist genau
 *    die, an der später Daten fehlen.
 *
 *  • **Unterschiedlich ist nur die fachliche Regel.** Sie steht deshalb als
 *    einzige Angabe je Eintrag im Register, mit einer Begründung im Klartext.
 *
 * Was hier *nicht* passiert: kaskadierendes Löschen. Ein weich gelöschter
 * Kunde behält seine Rechnungen; sie verschwinden nur aus den Listen, weil
 * jede Abfrage `deletedAt: null` filtert. Ein Kaskadenlöschen wäre nicht
 * wiederherstellbar und stünde im Widerspruch zum Zweck eines Papierkorbs.
 */

export type Recyclable =
  | 'customer'
  | 'lead'
  | 'booking'
  | 'quote'
  | 'invoice'
  | 'job'
  | 'property';

interface Definition {
  label: string;
  /** Berechtigung, die zum Löschen nötig ist — für die Dokumentation. */
  permission: Permission;
  /**
   * Fachliche Sperre. Gibt einen Satz zurück, wenn nicht gelöscht werden
   * darf — sonst `null`.
   */
  block?: (id: string) => Promise<string | null>;
  /** Kurzbeschreibung des Datensatzes für das Protokoll. */
  describe: (id: string) => Promise<string>;
}

/**
 * Bezeichner für das Protokoll — dieselbe Zeile, die auch der Nutzer sieht.
 */
async function labelOf(model: Recyclable, id: string): Promise<string> {
  switch (model) {
    case 'customer': {
      const row = await prisma.customer.findUnique({
        where: { id },
        select: { number: true, firstName: true, lastName: true, companyName: true },
      });
      return row ? `${row.number} · ${row.companyName ?? `${row.firstName} ${row.lastName}`}` : id;
    }
    case 'lead': {
      const row = await prisma.lead.findUnique({
        where: { id },
        select: { number: true, firstName: true, lastName: true },
      });
      return row ? `${row.number} · ${row.firstName} ${row.lastName}` : id;
    }
    case 'booking': {
      const row = await prisma.booking.findUnique({ where: { id }, select: { number: true } });
      return row?.number ?? id;
    }
    case 'quote': {
      const row = await prisma.quote.findUnique({
        where: { id },
        select: { number: true, title: true },
      });
      return row ? `${row.number} · ${row.title}` : id;
    }
    case 'invoice': {
      const row = await prisma.invoice.findUnique({ where: { id }, select: { number: true } });
      return row?.number ?? id;
    }
    case 'job': {
      const row = await prisma.job.findUnique({
        where: { id },
        select: { number: true, title: true },
      });
      return row ? `${row.number} · ${row.title}` : id;
    }
    case 'property': {
      const row = await prisma.property.findUnique({ where: { id }, select: { label: true } });
      return row?.label ?? id;
    }
  }
}

/**
 * Mandantenfilter je Modell.
 *
 * Sechs der sieben Modelle tragen `organizationId` selbst. `Property` nicht —
 * es hängt an einer Kundschaft und erbt die Zugehörigkeit von dort. Diese
 * Abweichung *muss* hier stehen: ein pauschales `{ organizationId }` würde bei
 * Objekten stillschweigend nichts finden, und der Endpunkt antwortete mit 404
 * statt zu löschen. Ein Fehler, der wie eine korrekt greifende Sperre aussieht.
 */
function scopeWhere(model: Recyclable, organizationId: string): Record<string, unknown> {
  if (model === 'property') return { customer: { organizationId } };
  return { organizationId };
}

const DEFINITIONS: Record<Recyclable, Definition> = {
  customer: {
    label: 'Kundschaft',
    permission: 'customer:delete',
    describe: (id) => labelOf('customer', id),
    /**
     * Offene Posten sind der einzige harte Grund. Eine bezahlte Historie
     * spricht nicht gegen das Löschen — sie bleibt ja erhalten.
     */
    block: async (id) => {
      const open = await prisma.invoice.count({
        where: {
          customerId: id,
          deletedAt: null,
          status: { in: ['ISSUED', 'SENT', 'PARTIALLY_PAID', 'OVERDUE'] },
        },
      });
      if (open > 0) {
        return `Es bestehen ${open} offene Rechnungen. Löschen Sie die Kundschaft erst, wenn die Posten ausgeglichen oder storniert sind.`;
      }

      const upcoming = await prisma.booking.count({
        where: {
          customerId: id,
          deletedAt: null,
          scheduledStart: { gte: new Date() },
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
      });
      if (upcoming > 0) {
        return `Es sind ${upcoming} Termine geplant. Sagen Sie diese zuerst ab — sonst stehen Mitarbeitende vor der Tür.`;
      }

      return null;
    },
  },

  lead: {
    label: 'Anfrage',
    permission: 'lead:delete',
    describe: (id) => labelOf('lead', id),
    block: async (id) => {
      const converted = await prisma.lead.findUnique({
        where: { id },
        select: { customerId: true, status: true },
      });
      if (converted?.customerId) {
        return 'Diese Anfrage wurde in eine Kundschaft überführt. Sie bleibt als Herkunftsnachweis erhalten.';
      }
      return null;
    },
  },

  booking: {
    label: 'Buchung',
    permission: 'booking:delete',
    describe: (id) => labelOf('booking', id),
    block: async (id) => {
      const invoiced = await prisma.invoice.count({
        where: { deletedAt: null, items: { some: { job: { bookingId: id } } } },
      });
      if (invoiced > 0) {
        return 'Zu dieser Buchung besteht eine Rechnung. Stornieren Sie zuerst die Rechnung — eine Rechnung ohne Auftrag ist buchhalterisch nicht haltbar.';
      }
      return null;
    },
  },

  quote: {
    label: 'Offerte',
    permission: 'quote:delete',
    describe: (id) => labelOf('quote', id),
    block: async (id) => {
      const quote = await prisma.quote.findUnique({ where: { id }, select: { status: true } });
      if (quote && ['ACCEPTED', 'CONVERTED'].includes(quote.status)) {
        return 'Eine angenommene Offerte ist eine vertragliche Zusage und bleibt erhalten. Sie können sie stattdessen als abgelaufen markieren.';
      }
      return null;
    },
  },

  invoice: {
    label: 'Rechnung',
    permission: 'invoice:delete',
    describe: (id) => labelOf('invoice', id),
    /**
     * Das ist die wichtigste Sperre im ganzen Modul.
     *
     * Nach Art. 957a OR muss die Rechnungsnummerierung lückenlos sein. Eine
     * ausgestellte Rechnung zu löschen risse ein Loch in die Nummernfolge, das
     * sich nicht schliessen lässt — die Buchhaltung wäre nicht mehr
     * revisionssicher. Korrigiert wird über eine Gutschrift, nie über das
     * Entfernen.
     */
    block: async (id) => {
      const invoice = await prisma.invoice.findUnique({ where: { id }, select: { status: true, number: true } });
      if (invoice && invoice.status !== 'DRAFT') {
        return `Rechnung ${invoice.number} ist ausgestellt. Nach Art. 957a OR muss die Nummerierung lückenlos bleiben — korrigieren Sie über eine Gutschrift oder eine Stornierung.`;
      }
      return null;
    },
  },

  job: {
    label: 'Einsatz',
    permission: 'job:delete',
    describe: (id) => labelOf('job', id),
    block: async (id) => {
      const job = await prisma.job.findUnique({ where: { id }, select: { status: true } });
      if (job?.status === 'COMPLETED') {
        return 'Ein abgeschlossener Einsatz ist die Grundlage der Verrechnung und der Zeiterfassung. Er bleibt erhalten.';
      }
      const tracked = await prisma.timeEntry.count({ where: { jobId: id } });
      if (tracked > 0) {
        return `Auf diesen Einsatz sind ${tracked} Zeiteinträge gestempelt. Sie sind Grundlage der Lohnabrechnung und dürfen nicht verwaisen.`;
      }
      return null;
    },
  },

  property: {
    label: 'Objekt',
    permission: 'property:delete',
    describe: (id) => labelOf('property', id),
    block: async (id) => {
      const upcoming = await prisma.job.count({
        where: { propertyId: id, deletedAt: null, scheduledStart: { gte: new Date() } },
      });
      if (upcoming > 0) {
        return `Für dieses Objekt sind ${upcoming} Einsätze geplant. Verschieben oder stornieren Sie diese zuerst.`;
      }
      return null;
    },
  },
};

/** Prisma-Delegate zum Bezeichner. Eng gehalten, damit nichts anderes trifft. */
function delegateFor(model: Recyclable) {
  switch (model) {
    case 'customer':
      return prisma.customer;
    case 'lead':
      return prisma.lead;
    case 'booking':
      return prisma.booking;
    case 'quote':
      return prisma.quote;
    case 'invoice':
      return prisma.invoice;
    case 'job':
      return prisma.job;
    case 'property':
      return prisma.property;
  }
}

/** Entitätsname für das Prüfprotokoll — dieselbe Schreibweise wie überall. */
const AUDIT_ENTITY: Record<Recyclable, string> = {
  customer: 'Customer',
  lead: 'Lead',
  booking: 'Booking',
  quote: 'Quote',
  invoice: 'Invoice',
  job: 'Job',
  property: 'Property',
};

interface Context {
  organizationId: string;
  actorId: string;
  ip?: string | null;
}

export function definitionFor(model: Recyclable): Definition {
  return DEFINITIONS[model];
}

export async function softDelete(
  model: Recyclable,
  { organizationId, actorId, ip }: Context,
  id: string,
): Promise<void> {
  const definition = DEFINITIONS[model];
  const delegate = delegateFor(model);

  // Die sieben Delegates teilen zwar die Felder, die hier gebraucht werden,
  // aber keinen gemeinsamen TypeScript-Typ — Prisma erzeugt für jedes Modell
  // eigene Signaturen. Ein Union-Typ über alle sieben wäre hier länger als
  // die Funktion selbst und brächte nichts: die verwendeten Felder sind `id`
  // und `deletedAt`, und beide sind in jedem Modell vorhanden.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = await (delegate as any).findFirst({
    where: { id, ...scopeWhere(model, organizationId) },
    select: { id: true, deletedAt: true },
  });
  if (!existing) throw new NotFoundError(definition.label);
  if (existing.deletedAt) {
    throw new BusinessRuleError('Dieser Eintrag liegt bereits im Papierkorb.');
  }

  const reason = await definition.block?.(id);
  if (reason) throw new BusinessRuleError(reason);

  const description = await definition.describe(id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (delegate as any).update({ where: { id }, data: { deletedAt: new Date() } });

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: AUDIT_ENTITY[model],
    entityId: id,
    summary: `${definition.label} ${description} in den Papierkorb gelegt`,
    ip,
  });
}

export async function restore(
  model: Recyclable,
  { organizationId, actorId, ip }: Context,
  id: string,
): Promise<void> {
  const definition = DEFINITIONS[model];
  const delegate = delegateFor(model);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = await (delegate as any).findFirst({
    where: { id, ...scopeWhere(model, organizationId) },
    select: { id: true, deletedAt: true },
  });
  if (!existing) throw new NotFoundError(definition.label);
  if (!existing.deletedAt) throw new BusinessRuleError('Dieser Eintrag liegt nicht im Papierkorb.');

  const description = await definition.describe(id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (delegate as any).update({ where: { id }, data: { deletedAt: null } });

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: AUDIT_ENTITY[model],
    entityId: id,
    summary: `${definition.label} ${description} wiederhergestellt`,
    ip,
  });
}

export interface TrashEntry {
  id: string;
  model: Recyclable;
  label: string;
  description: string;
  deletedAt: string;
}

/**
 * Alles im Papierkorb, über alle Bereiche hinweg.
 *
 * Bewusst eine gemeinsame Liste: wer etwas versehentlich gelöscht hat, weiss
 * oft nicht mehr genau *was* — nur *wann*. Deshalb ist die Sortierung nach
 * Löschzeitpunkt und nicht nach Bereich.
 */
export async function listTrash(organizationId: string, limit = 100): Promise<TrashEntry[]> {
  const models = Object.keys(DEFINITIONS) as Recyclable[];

  const results = await Promise.all(
    models.map(async (model) => {
      const delegate = delegateFor(model);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (delegate as any).findMany({
        where: { ...scopeWhere(model, organizationId), deletedAt: { not: null } },
        orderBy: { deletedAt: 'desc' },
        take: limit,
        select: { id: true, deletedAt: true },
      });

      return Promise.all(
        (rows as { id: string; deletedAt: Date }[]).map(async (row) => ({
          id: row.id,
          model,
          label: DEFINITIONS[model].label,
          description: await DEFINITIONS[model].describe(row.id),
          deletedAt: row.deletedAt.toISOString(),
        })),
      );
    }),
  );

  return results
    .flat()
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
    .slice(0, limit);
}
