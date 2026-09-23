import 'server-only';

import type { AutomationTrigger } from '@prisma/client';

import { zurichMidnight, zurichParts } from '@/lib/bi/periods';
import { prisma } from '@/lib/db';

/**
 * Die zeitbezogenen Auslöser der Automatisierung — wer sie erzeugt und wann
 * sie noch gelten.
 *
 * ---------------------------------------------------------------------------
 *  Der Befund
 * ---------------------------------------------------------------------------
 *
 * Bis 2026-09-23 bot die Oberfläche zwanzig Auslöser an, und elf davon
 * erzeugte **nichts** (RB-012). Eine Regel „24 Stunden vor dem Termin eine
 * Erinnerung schicken" liess sich anlegen, speichern und aktivieren — und
 * lief nie. Kein Fehler, keine Meldung: Die Kundschaft bekam einfach keine
 * Erinnerung, und der Betrieb glaubte, sie bekäme eine.
 *
 * Neun der elf sind **zeitbezogen**: Sie hängen nicht an einem Klick, sondern
 * an einem Zeitpunkt, der kommt. Sie entstehen hier, im stündlichen Lauf
 * (`emitZeitbezogeneAusloeser` in `automation-engine.service.ts`). Die beiden
 * übrigen (`QUOTE_ACCEPTED`, `RECURRING_BOOKING_GENERATE`) sind Ereignisse
 * und werden an der Stelle gemeldet, an der sie geschehen.
 *
 * ---------------------------------------------------------------------------
 *  Wie ein zeitbezogener Auslöser entsteht
 * ---------------------------------------------------------------------------
 *
 * Jede Regel unten nennt einen **Zeitpunkt** je Datensatz — bei der
 * Erinnerung 24 Stunden vor dem Termin, bei der überfälligen Rechnung der Tag
 * nach der Fälligkeit. Der Lauf sucht Datensätze, deren Zeitpunkt in einem
 * Fenster liegt, und meldet sie mit diesem Zeitpunkt als Bezug. Die
 * Verzögerung der Regel rechnet von dort: `delayMinutes: -1440` bei „Rechnung
 * wird bald fällig" heisst einen Tag vor dem Zeitpunkt.
 *
 * **Idempotent über den eindeutigen Index der Läufe** (Regel × Datensatz):
 * Der stündliche Lauf findet denselben Datensatz mehrmals, ein Lauf entsteht
 * trotzdem nur einmal. Beim Geburtstag trägt die Kennung das Jahr
 * (`kundeId@2027`) — sonst gratulierte der Betrieb genau einmal im Leben.
 *
 * **Geprüft wird zweimal**: beim Melden (liegt der Zeitpunkt im Fenster?) und
 * beim Ausführen (`gilt` — ist die Buchung noch bestätigt, die Rechnung noch
 * offen?). Ohne die zweite Prüfung ginge die Erinnerung an einen Termin
 * hinaus, der inzwischen storniert ist.
 */

const STUNDE = 3_600_000;
const TAG = 24 * STUNDE;

const OFFENE_RECHNUNG = ['ISSUED', 'SENT', 'PARTIALLY_PAID', 'OVERDUE'] as const;

export interface Fund {
  entityId: string;
  /** Der Zeitpunkt, auf den sich die Verzögerung der Regel bezieht. */
  zeitpunkt: Date;
}

interface Zeitregel {
  /** Datensätze, deren Zeitpunkt in `[von, bis]` liegt. */
  finde(organizationId: string, von: Date, bis: Date): Promise<Fund[]>;
  /** Gilt der Auslöser beim Ausführen noch? */
  gilt(organizationId: string, entityId: string, jetzt: Date): Promise<boolean>;
}

/** Der Tag (`@db.Date`) als Beginn in Zürich. */
function tagBeginn(tag: Date): Date {
  return zurichMidnight(tag.getUTCFullYear(), tag.getUTCMonth(), tag.getUTCDate());
}

function buchungsErinnerung(stunden: number): Zeitregel {
  return {
    async finde(organizationId, von, bis) {
      const zeilen = await prisma.booking.findMany({
        where: {
          organizationId,
          deletedAt: null,
          status: 'CONFIRMED',
          scheduledStart: { gte: new Date(von.getTime() + stunden * STUNDE), lte: new Date(bis.getTime() + stunden * STUNDE) },
        },
        select: { id: true, scheduledStart: true },
      });
      return zeilen.map((b) => ({ entityId: b.id, zeitpunkt: new Date(b.scheduledStart.getTime() - stunden * STUNDE) }));
    },
    async gilt(organizationId, entityId, jetzt) {
      const b = await prisma.booking.findFirst({
        where: { id: entityId, organizationId, deletedAt: null },
        select: { status: true, scheduledStart: true },
      });
      return !!b && b.status === 'CONFIRMED' && b.scheduledStart > jetzt;
    },
  };
}

export const ZEITREGELN: Partial<Record<AutomationTrigger, Zeitregel>> = {
  BOOKING_REMINDER_24H: buchungsErinnerung(24),
  BOOKING_REMINDER_2H: buchungsErinnerung(2),

  /** Drei Tage vor Ablauf der Gültigkeit einer versandten Offerte. */
  QUOTE_EXPIRING: {
    async finde(organizationId, von, bis) {
      const zeilen = await prisma.quote.findMany({
        where: {
          organizationId,
          deletedAt: null,
          status: { in: ['SENT', 'VIEWED'] },
          validUntil: { gte: new Date(von.getTime() + 2 * TAG), lte: new Date(bis.getTime() + 4 * TAG) },
        },
        select: { id: true, validUntil: true },
      });
      return zeilen.map((q) => ({ entityId: q.id, zeitpunkt: new Date(tagBeginn(q.validUntil).getTime() - 3 * TAG) }));
    },
    async gilt(organizationId, entityId, jetzt) {
      const q = await prisma.quote.findFirst({
        where: { id: entityId, organizationId, deletedAt: null },
        select: { status: true, validUntil: true },
      });
      return !!q && ['SENT', 'VIEWED'].includes(q.status) && tagBeginn(q.validUntil).getTime() + TAG > jetzt.getTime();
    },
  },

  /** Drei Tage vor der Fälligkeit einer offenen Rechnung. */
  INVOICE_DUE_SOON: {
    async finde(organizationId, von, bis) {
      const zeilen = await prisma.invoice.findMany({
        where: {
          organizationId,
          deletedAt: null,
          status: { in: [...OFFENE_RECHNUNG] },
          dueDate: { gte: new Date(von.getTime() + 2 * TAG), lte: new Date(bis.getTime() + 4 * TAG) },
        },
        select: { id: true, dueDate: true },
      });
      return zeilen.map((r) => ({ entityId: r.id, zeitpunkt: new Date(tagBeginn(r.dueDate).getTime() - 3 * TAG) }));
    },
    async gilt(organizationId, entityId, jetzt) {
      const r = await prisma.invoice.findFirst({
        where: { id: entityId, organizationId, deletedAt: null },
        select: { status: true, dueDate: true },
      });
      return !!r && (OFFENE_RECHNUNG as readonly string[]).includes(r.status) && tagBeginn(r.dueDate).getTime() + TAG > jetzt.getTime();
    },
  },

  /** Am Tag nach der Fälligkeit, solange die Rechnung offen ist. */
  INVOICE_OVERDUE: {
    async finde(organizationId, von, bis) {
      const zeilen = await prisma.invoice.findMany({
        where: {
          organizationId,
          deletedAt: null,
          status: { in: [...OFFENE_RECHNUNG] },
          dueDate: { gte: new Date(von.getTime() - 2 * TAG), lte: new Date(bis.getTime()) },
        },
        select: { id: true, dueDate: true },
      });
      return zeilen.map((r) => ({ entityId: r.id, zeitpunkt: new Date(tagBeginn(r.dueDate).getTime() + TAG) }));
    },
    async gilt(organizationId, entityId, jetzt) {
      const r = await prisma.invoice.findFirst({
        where: { id: entityId, organizationId, deletedAt: null },
        select: { status: true, dueDate: true },
      });
      return !!r && (OFFENE_RECHNUNG as readonly string[]).includes(r.status) && tagBeginn(r.dueDate).getTime() + TAG <= jetzt.getTime();
    },
  },

  /** 48 Stunden nach Eingang, wenn noch niemand die Anfrage bearbeitet hat. */
  LEAD_IDLE: {
    async finde(organizationId, von, bis) {
      const zeilen = await prisma.lead.findMany({
        where: {
          organizationId,
          deletedAt: null,
          status: 'NEW',
          createdAt: { gte: new Date(von.getTime() - 48 * STUNDE), lte: new Date(bis.getTime() - 48 * STUNDE) },
        },
        select: { id: true, createdAt: true },
      });
      return zeilen.map((l) => ({ entityId: l.id, zeitpunkt: new Date(l.createdAt.getTime() + 48 * STUNDE) }));
    },
    async gilt(organizationId, entityId) {
      const l = await prisma.lead.findFirst({ where: { id: entityId, organizationId, deletedAt: null }, select: { status: true } });
      return l?.status === 'NEW';
    },
  },

  /**
   * Zur Fälligkeit einer offenen Aufgabe. `Task` hat keine eigene
   * `organizationId`; eingegrenzt wird über die zuständige oder die
   * erstellende Person.
   */
  TASK_DUE: {
    async finde(organizationId, von, bis) {
      const zeilen = await prisma.task.findMany({
        where: {
          status: { in: ['OPEN', 'IN_PROGRESS'] },
          dueAt: { gte: von, lte: bis },
          OR: [{ assignee: { organizationId } }, { creator: { organizationId } }],
        },
        select: { id: true, dueAt: true },
      });
      return zeilen.filter((t) => t.dueAt).map((t) => ({ entityId: t.id, zeitpunkt: t.dueAt! }));
    },
    async gilt(organizationId, entityId) {
      const t = await prisma.task.findFirst({
        where: { id: entityId, OR: [{ assignee: { organizationId } }, { creator: { organizationId } }] },
        select: { status: true },
      });
      return !!t && ['OPEN', 'IN_PROGRESS'].includes(t.status);
    },
  },

  /** 24 Stunden nach einer abgeschlossenen Buchung, solange keine Bewertung dazu da ist. */
  REVIEW_REQUEST: {
    async finde(organizationId, von, bis) {
      const zeilen = await prisma.booking.findMany({
        where: {
          organizationId,
          deletedAt: null,
          status: 'COMPLETED',
          completedAt: { gte: new Date(von.getTime() - 24 * STUNDE), lte: new Date(bis.getTime() - 24 * STUNDE) },
          reviews: { none: {} },
        },
        select: { id: true, completedAt: true },
      });
      return zeilen
        .filter((b) => b.completedAt)
        .map((b) => ({ entityId: b.id, zeitpunkt: new Date(b.completedAt!.getTime() + 24 * STUNDE) }));
    },
    async gilt(organizationId, entityId) {
      const b = await prisma.booking.findFirst({
        where: { id: entityId, organizationId, deletedAt: null },
        select: { status: true, _count: { select: { reviews: true } } },
      });
      return !!b && b.status === 'COMPLETED' && b._count.reviews === 0;
    },
  },

  /**
   * Am Geburtstag, 00:00 in Zürich. Die Kennung trägt das Jahr
   * (`kundeId@2027`): Der Lauf entsteht je Regel und Kennung genau einmal —
   * ohne das Jahr gäbe es einen Glückwunsch im Leben.
   */
  CUSTOMER_BIRTHDAY: {
    async finde(organizationId, von, bis) {
      const zeilen = await prisma.customer.findMany({
        where: { organizationId, deletedAt: null, birthday: { not: null } },
        select: { id: true, birthday: true },
      });
      const funde: Fund[] = [];
      const jahre = new Set([zurichParts(von).year, zurichParts(bis).year]);
      for (const k of zeilen) {
        for (const jahr of jahre) {
          const b = k.birthday!;
          // Am 29. Februar geborene feiern in anderen Jahren am 28.
          const letzter = new Date(Date.UTC(jahr, b.getUTCMonth() + 1, 0)).getUTCDate();
          const zeitpunkt = zurichMidnight(jahr, b.getUTCMonth(), Math.min(b.getUTCDate(), letzter));
          if (zeitpunkt >= von && zeitpunkt <= bis) funde.push({ entityId: `${k.id}@${jahr}`, zeitpunkt });
        }
      }
      return funde;
    },
    async gilt(organizationId, entityId) {
      const [kundeId] = entityId.split('@');
      const k = await prisma.customer.findFirst({
        where: { id: kundeId, organizationId, deletedAt: null },
        select: { birthday: true },
      });
      return !!k?.birthday;
    },
  },
};

/**
 * Auslöser, die an einem Ereignis hängen und dort gemeldet werden — mit der
 * Stelle, an der das geschieht. Die Prüfreihe liest diese Tabelle und sucht
 * die Aufrufe im Quelltext: Ein Auslöser ohne Erzeuger ist ein Fehler, keine
 * Möglichkeit.
 */
export const EREIGNIS_AUSLOESER: Readonly<Record<string, string>> = {
  BOOKING_CREATED: 'src/server/services/booking.service.ts',
  BOOKING_CONFIRMED: 'src/server/services/booking.service.ts',
  BOOKING_CANCELLED: 'src/server/services/booking.service.ts',
  BOOKING_COMPLETED: 'src/server/services/job.service.ts',
  QUOTE_SENT: 'src/server/services/quote.service.ts',
  QUOTE_ACCEPTED: 'src/server/services/quote-acceptance.service.ts',
  INVOICE_ISSUED: 'src/server/services/invoice.service.ts',
  JOB_ASSIGNED: 'src/server/services/job.service.ts',
  JOB_COMPLETED: 'src/server/services/job.service.ts',
  LEAD_CREATED: 'src/server/services/crm.service.ts',
  RECURRING_BOOKING_GENERATE: 'src/server/services/booking.service.ts',
};

/** Hat dieser Auslöser einen Erzeuger? Die Oberfläche bietet nur solche an. */
export function hatErzeuger(trigger: string): boolean {
  return trigger in EREIGNIS_AUSLOESER || trigger in ZEITREGELN;
}
