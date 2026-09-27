import 'server-only';

import { Prisma, type AutomationTrigger } from '@prisma/client';

import { bedingungenErfuellt, type Nutzlast } from '@/lib/automation/conditions';
import { fuelleVorlage } from '@/lib/automation/template';
import { sendeWebhook } from '@/lib/automation/webhook';
import { prisma, toNumber } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  ERLAUBTE_STATUSAENDERUNGEN,
  pruefeAktionsKonfiguration,
  type StatusZiel,
} from '@/lib/validation/automation-config';

import { ZEITREGELN } from './automation-zeittrigger.service';
import { notify } from './notification.service';

const log = logger('automation');

/**
 * Die Automatisierungsmaschine.
 *
 * ---------------------------------------------------------------------------
 *  Der Befund, der sie ausgelöst hat
 * ---------------------------------------------------------------------------
 *
 * Die Modelle `Automation`, `AutomationAction` und `AutomationRun` standen seit
 * der ersten Migration im Schema. Es gab eine Oberfläche, mit der sich Regeln
 * anlegen, aktivieren und löschen liessen, und einen Dienst, der sie
 * verwaltete. **`automation_runs` wurde von keinem Codepfad je beschrieben.**
 *
 * Das ist die schlechteste Form einer Lücke: keine fehlende Funktion, sondern
 * eine Zusage, die das System nicht einlöst. Wer eine Regel anlegt, sieht sie
 * in der Liste stehen, aktiv, mit Auslöser und Aktionen — und verlässt sich
 * darauf, dass die Erinnerung hinausgeht.
 *
 * ---------------------------------------------------------------------------
 *  Der Aufbau
 * ---------------------------------------------------------------------------
 *
 *   Auslöser  →  Bedingungen  →  Lauf anlegen  →  (Verzögerung)  →
 *   Bedingungen erneut  →  Aktionen der Reihe nach  →  Ergebnis
 *
 * **Zwei Hälften, getrennt durch die Zeit.** `emitAutomationTrigger` läuft im
 * Geschäftsvorgang mit und legt nur den Lauf an; ausgeführt wird er später
 * durch `runDueAutomations` aus dem Scheduler. Das ist nicht Bequemlichkeit,
 * sondern die einzige Bauart, die mit `delayMinutes` verträglich ist — und sie
 * hat einen zweiten Nutzen: Eine Automatisierung kann eine Buchung nicht mehr
 * scheitern lassen. Wer eine Regel mit einer unerreichbaren Gegenstelle
 * anlegt, bringt damit nicht das Buchungsformular zum Stehen.
 *
 * ---------------------------------------------------------------------------
 *  Warum der Zustand beim Ausführen neu geladen wird
 * ---------------------------------------------------------------------------
 *
 * Zwischen Auslöser und Ausführung können Tage liegen. In dieser Zeit ändert
 * sich die Welt: Die Buchung wird abgesagt, die Offerte abgelehnt, die
 * Rechnung bezahlt. Der Lauf speichert deshalb **keine Momentaufnahme**,
 * sondern lädt den Vorgang neu und prüft die Bedingungen ein zweites Mal.
 *
 * Ohne diesen zweiten Durchgang ginge die Erinnerung an einen Termin hinaus,
 * den es nicht mehr gibt — der Fehler, den die Kundschaft bemerkt und der
 * Betrieb nicht. Nebenbei bleibt so auch keine Sammlung von Personendaten in
 * einer Json-Spalte liegen, die niemand aufräumt.
 */

// ---------------------------------------------------------------------------
//  Auslöser und ihre Nutzlast
// ---------------------------------------------------------------------------

/**
 * Welche Ressourcenart zu welchem Auslöser gehört.
 *
 * Steht als Tabelle und nicht verstreut an den Aufrufstellen: Der Eintrag in
 * `AutomationRun.entity` muss zum Lader passen, sonst lädt die Ausführung den
 * falschen Datensatz — und das fiele erst auf, wenn eine Erinnerung an die
 * falsche Person geht.
 */
const TRIGGER_ENTITY: Record<AutomationTrigger, string> = {
  BOOKING_CREATED: 'Booking',
  BOOKING_CONFIRMED: 'Booking',
  BOOKING_REMINDER_24H: 'Booking',
  BOOKING_REMINDER_2H: 'Booking',
  BOOKING_COMPLETED: 'Booking',
  BOOKING_CANCELLED: 'Booking',
  RECURRING_BOOKING_GENERATE: 'Booking',
  REVIEW_REQUEST: 'Booking',
  QUOTE_SENT: 'Quote',
  QUOTE_ACCEPTED: 'Quote',
  QUOTE_EXPIRING: 'Quote',
  INVOICE_ISSUED: 'Invoice',
  INVOICE_DUE_SOON: 'Invoice',
  INVOICE_OVERDUE: 'Invoice',
  JOB_ASSIGNED: 'Job',
  JOB_COMPLETED: 'Job',
  LEAD_CREATED: 'Lead',
  LEAD_IDLE: 'Lead',
  CUSTOMER_BIRTHDAY: 'Customer',
  TASK_DUE: 'Task',
};

/**
 * Was eine Regel über den Vorgang weiss.
 *
 * **Bewusst schmal.** Die Versuchung ist, den ganzen Datensatz hineinzugeben —
 * dann kann jede Bedingung auf jedes Feld schauen. Der Preis wäre, dass
 * Personendaten in Vorlagen und Webhook-Rümpfen landen, an die beim Entwurf
 * niemand gedacht hat. Was hier nicht steht, kann eine Regel nicht
 * verschicken.
 *
 * Insbesondere fehlen: AHV-Nummer, IBAN, Alarmcode, Zugangsdaten am Objekt,
 * Notizen. Die E-Mail-Adresse steht darin, weil der Versand sie braucht —
 * aber der Versand liest sie aus dem Datensatz, nicht aus der Nutzlast, und
 * eine Vorlage, die `{{kunde.email}}` schreibt, schreibt die Adresse in die
 * Nachricht an dieselbe Adresse.
 */
export interface VorgangsNutzlast extends Nutzlast {
  entity: string;
  entityId: string;
}

type Lader = (organizationId: string, id: string) => Promise<VorgangsNutzlast | null>;

const kundeAuszug = {
  select: {
    id: true,
    type: true,
    companyName: true,
    user: { select: { firstName: true, lastName: true, email: true, id: true } },
  },
} as const;

function kunde(k: {
  id: string;
  type: string;
  companyName: string | null;
  user: { id: string; firstName: string; lastName: string; email: string } | null;
} | null) {
  if (!k) return null;
  return {
    id: k.id,
    typ: k.type,
    firma: k.companyName,
    vorname: k.user?.firstName ?? '',
    nachname: k.user?.lastName ?? '',
    name: k.companyName ?? `${k.user?.firstName ?? ''} ${k.user?.lastName ?? ''}`.trim(),
    email: k.user?.email ?? null,
    userId: k.user?.id ?? null,
  };
}

const LADER: Record<string, Lader> = {
  Booking: async (organizationId, id) => {
    const b = await prisma.booking.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: {
        id: true,
        number: true,
        status: true,
        scheduledStart: true,
        scheduledEnd: true,
        grossTotal: true,
        netTotal: true,
        customer: kundeAuszug,
      },
    });
    if (!b) return null;
    return {
      entity: 'Booking',
      entityId: b.id,
      nummer: b.number,
      status: b.status,
      termin: b.scheduledStart,
      terminEnde: b.scheduledEnd,
      betrag: toNumber(b.grossTotal),
      netto: toNumber(b.netTotal),
      kunde: kunde(b.customer),
    };
  },

  Quote: async (organizationId, id) => {
    const q = await prisma.quote.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: {
        id: true,
        number: true,
        status: true,
        validUntil: true,
        grossTotal: true,
        customer: kundeAuszug,
      },
    });
    if (!q) return null;
    return {
      entity: 'Quote',
      entityId: q.id,
      nummer: q.number,
      status: q.status,
      gueltigBis: q.validUntil,
      betrag: toNumber(q.grossTotal),
      kunde: kunde(q.customer),
    };
  },

  Invoice: async (organizationId, id) => {
    const r = await prisma.invoice.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: {
        id: true,
        number: true,
        status: true,
        dueDate: true,
        grossTotal: true,
        customer: kundeAuszug,
      },
    });
    if (!r) return null;
    return {
      entity: 'Invoice',
      entityId: r.id,
      nummer: r.number,
      status: r.status,
      faelligAm: r.dueDate,
      betrag: toNumber(r.grossTotal),
      kunde: kunde(r.customer),
    };
  },

  Job: async (organizationId, id) => {
    const j = await prisma.job.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: {
        id: true,
        number: true,
        status: true,
        scheduledStart: true,
        customer: kundeAuszug,
        assignments: {
          select: { employee: { select: { id: true, user: { select: { id: true } } } } },
        },
      },
    });
    if (!j) return null;
    return {
      entity: 'Job',
      entityId: j.id,
      nummer: j.number,
      status: j.status,
      beginn: j.scheduledStart,
      kunde: kunde(j.customer),
      zugeteilt: j.assignments.map((a) => ({
        employeeId: a.employee.id,
        userId: a.employee.user?.id ?? null,
      })),
    };
  },

  Lead: async (organizationId, id) => {
    const l = await prisma.lead.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: {
        id: true,
        number: true,
        status: true,
        source: true,
        firstName: true,
        lastName: true,
        company: true,
        email: true,
        createdAt: true,
      },
    });
    if (!l) return null;
    return {
      entity: 'Lead',
      entityId: l.id,
      nummer: l.number,
      status: l.status,
      quelle: l.source,
      vorname: l.firstName,
      nachname: l.lastName,
      firma: l.company,
      name: l.company ?? `${l.firstName} ${l.lastName}`.trim(),
      email: l.email,
      erstelltAm: l.createdAt,
    };
  },

  /**
   * Die Kennung kann ein Jahr tragen (`kundeId@2027`) — beim Geburtstag, der
   * jährlich wiederkehrt und je Regel und Kennung nur einen Lauf bekommt.
   */
  Customer: async (organizationId, id) => {
    const [kundenId] = id.split('@');
    const k = await prisma.customer.findFirst({
      where: { id: kundenId, organizationId, deletedAt: null },
      ...kundeAuszug,
    });
    if (!k) return null;
    return { entity: 'Customer', entityId: id, kunde: kunde(k) };
  },

  /**
   * **`Task` trägt kein `organizationId`.** Das ist eine Eigenheit des
   * bestehenden Schemas: Eine Aufgabe hängt über `customerId`, `leadId`,
   * `jobId`, `objectiveId` oder `meetingId` an einem Vorgang, und der ist
   * mandantengebunden.
   *
   * Bis 2026-09-23 lud dieser Lader deshalb **ohne** Einschränkung. Seit
   * `TASK_DUE` tatsächlich ausgelöst wird, wäre das ein Weg, über eine Regel
   * die Aufgabe einer anderen Organisation zu lesen. Eingegrenzt wird jetzt
   * über die zuständige oder die erstellende Person, die beide einer
   * Organisation angehören. Eine eigene Spalte bleibt die bessere Lösung und
   * steht als offener Punkt in `docs/AUTOMATION.md`.
   */
  Task: async (organizationId, id) => {
    const t = await prisma.task.findFirst({
      where: { id, OR: [{ assignee: { organizationId } }, { creator: { organizationId } }] },
      select: { id: true, title: true, status: true, dueAt: true, priority: true },
    });
    if (!t) return null;
    return {
      entity: 'Task',
      entityId: t.id,
      titel: t.title,
      status: t.status,
      faelligAm: t.dueAt,
      prioritaet: t.priority,
    };
  },
};

// ---------------------------------------------------------------------------
//  Auslösen
// ---------------------------------------------------------------------------

export interface AusloeseErgebnis {
  /** Wie viele aktive Regeln zu diesem Auslöser gehören. */
  geprueft: number;
  /** Wie viele Läufe entstanden sind. */
  angelegt: number;
  /** Wie viele schon existierten — derselbe Vorgang, dieselbe Regel. */
  vorhanden: number;
}

/**
 * Einen Auslöser melden.
 *
 * **Wirft nie.** Aufgerufen wird sie mitten im Geschäftsvorgang — nach dem
 * Anlegen einer Buchung, nach dem Versand einer Offerte. Eine
 * Automatisierungsregel darf keinen dieser Vorgänge scheitern lassen; das ist
 * dieselbe Regel wie beim Prüfprotokoll, und sie wiegt hier schwerer, weil
 * die Regeln von Benutzern stammen.
 *
 * **Idempotent über den Teilindex.** `@@unique([automationId, entity, entityId])`
 * sorgt dafür, dass zu einer Regel und einem Vorgang genau ein Lauf entsteht.
 * Ein doppelter Auslöser — zwei Klicks, ein wiederholter Aufruf, ein
 * Nachtlauf, der einen Vorgang erneut findet — erzeugt keine zweite E-Mail.
 * Die Entscheidung liegt damit in der Datenbank und nicht in einer Prüfung
 * davor, die zwei gleichzeitige Aufrufe beide bestünden.
 */
export async function emitAutomationTrigger(params: {
  organizationId: string;
  trigger: AutomationTrigger;
  entityId: string;
  /**
   * Der Zeitpunkt, von dem die Verzögerung der Regel rechnet. Ohne Angabe:
   * jetzt. Zeitbezogene Auslöser geben ihren Anlass an — bei der Erinnerung
   * „24 Stunden vor dem Termin" genau diesen Zeitpunkt —, damit
   * `delayMinutes: -60` eine Stunde davor bedeutet und nicht eine Stunde vor
   * dem Suchlauf.
   */
  bezugszeit?: Date;
}): Promise<AusloeseErgebnis> {
  try {
    return await ausloesen(params);
  } catch (fehler) {
    log.error('Auslöser konnte nicht verarbeitet werden', {
      trigger: params.trigger,
      error: fehler,
    });
    return { geprueft: 0, angelegt: 0, vorhanden: 0 };
  }
}

// ---------------------------------------------------------------------------
//  Ereignisse in der Transaktion (Transactional Outbox, 2026-09-27)
// ---------------------------------------------------------------------------

/**
 * Ein fachliches Ereignis vermerken — **in der Transaktion des Vorgangs**.
 *
 * Bis 2026-09-27 meldeten die Dienste ihre Auslöser nach dem Festschreiben,
 * bestmöglich über `emitAutomationTrigger`. Starb der Prozess zwischen Commit
 * und Meldung, oder scheiterte die Meldung, war das Ereignis verloren — die
 * Buchung stand, die Regel lief nie, und niemand erfuhr es (die Meldung
 * „wirft nie"). Jetzt entsteht der Vermerk mit dem Vorgang oder gar nicht.
 * Verarbeitet wird er gleich danach (`automationEreignisseAbarbeiten`) und,
 * falls das ausbleibt, im stündlichen Lauf.
 */
export async function automationEreignisVormerken(
  tx: Prisma.TransactionClient,
  params: { organizationId: string; trigger: AutomationTrigger; entityId: string; bezugszeit?: Date },
): Promise<void> {
  await tx.automationEvent.create({
    data: {
      organizationId: params.organizationId,
      trigger: params.trigger,
      entityId: params.entityId,
      bezugszeit: params.bezugszeit ?? null,
    },
  });
}

/** Wie oft ein Ereignis versucht wird, bevor es liegen bleibt (sichtbar). */
const EREIGNIS_MAX_VERSUCHE = 5;

/**
 * Offene Ereignisse zu Läufen machen. Aufgerufen direkt nach dem Vorgang,
 * der sie vermerkt hat, und stündlich als Rückfall.
 *
 * **Wirft nie** — wie `emitAutomationTrigger` darf eine Regel keinen
 * Geschäftsvorgang scheitern lassen. Ein gescheitertes Ereignis bleibt offen
 * (mit gezähltem Versuch) und wird beim nächsten Takt wiederholt. Doppelte
 * Verarbeitung — zwei Aufrufe gleichzeitig — ist unschädlich: Der eindeutige
 * Index der Läufe lässt je Regel und Vorgang genau einen entstehen.
 */
export async function automationEreignisseAbarbeiten(params: { organizationId?: string; limit?: number } = {}): Promise<number> {
  let verarbeitet = 0;
  try {
    const offen = await prisma.automationEvent.findMany({
      where: {
        processedAt: null,
        attempts: { lt: EREIGNIS_MAX_VERSUCHE },
        ...(params.organizationId ? { organizationId: params.organizationId } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: params.limit ?? 100,
    });
    for (const ereignis of offen) {
      try {
        await ausloesen({
          organizationId: ereignis.organizationId,
          trigger: ereignis.trigger,
          entityId: ereignis.entityId,
          bezugszeit: ereignis.bezugszeit ?? undefined,
        });
        await prisma.automationEvent.updateMany({ where: { id: ereignis.id, processedAt: null }, data: { processedAt: new Date() } });
        verarbeitet += 1;
      } catch (fehler) {
        await prisma.automationEvent.update({ where: { id: ereignis.id }, data: { attempts: { increment: 1 } } });
        log.error('Ereignis konnte nicht verarbeitet werden — bleibt offen', { trigger: ereignis.trigger, error: fehler });
      }
    }
  } catch (fehler) {
    log.error('Ereignisse konnten nicht gelesen werden', { error: fehler });
  }
  return verarbeitet;
}

/** Der Kern von `emitAutomationTrigger` — wirft, damit die Ereignisverarbeitung einen Fehlschlag erkennt. */
async function ausloesen(params: {
  organizationId: string;
  trigger: AutomationTrigger;
  entityId: string;
  bezugszeit?: Date;
}): Promise<AusloeseErgebnis> {
  const leer: AusloeseErgebnis = { geprueft: 0, angelegt: 0, vorhanden: 0 };
  {
    const regeln = await prisma.automation.findMany({
      where: { organizationId: params.organizationId, trigger: params.trigger, active: true },
      select: { id: true, name: true, conditions: true, delayMinutes: true },
    });

    if (regeln.length === 0) return leer;

    const entity = TRIGGER_ENTITY[params.trigger];
    const laden = LADER[entity];
    if (!laden) {
      log.warn('Kein Lader für diese Ressourcenart', { trigger: params.trigger, entity });
      return leer;
    }

    const nutzlast = await laden(params.organizationId, params.entityId);
    if (!nutzlast) return leer;

    let angelegt = 0;
    let vorhanden = 0;

    for (const regel of regeln) {
      const bedingungen = (regel.conditions ?? {}) as Record<string, unknown>;
      if (!bedingungenErfuellt(bedingungen, nutzlast)) continue;

      // Nie vor jetzt: Ein Anlass, dessen „davor" schon vorbei ist, läuft
      // sofort und nicht gar nicht.
      const bezug = (params.bezugszeit ?? new Date()).getTime();
      const faellig = new Date(Math.max(Date.now(), bezug + regel.delayMinutes * 60_000));

      try {
        await prisma.automationRun.create({
          data: {
            automationId: regel.id,
            entity,
            entityId: params.entityId,
            status: 'PENDING',
            scheduledFor: faellig,
          },
        });
        angelegt += 1;
      } catch (fehler) {
        if (
          fehler instanceof Prisma.PrismaClientKnownRequestError &&
          fehler.code === 'P2002'
        ) {
          vorhanden += 1;
          continue;
        }
        throw fehler;
      }
    }

    return { geprueft: regeln.length, angelegt, vorhanden };
  }
}

/**
 * Die zeitbezogenen Auslöser melden — stündlich aus dem Scheduler.
 *
 * Bis 2026-09-23 gab es diesen Lauf nicht, und neun Auslöser, die die
 * Oberfläche anbot, entstanden nie (RB-012). Die Regeln, *welcher* Datensatz
 * *wann* einen Anlass hat, stehen in `automation-zeittrigger.service.ts`.
 *
 * **Das Fenster.** Rückwärts 26 Stunden, damit ein ausgefallener Stundenlauf
 * nichts verliert — der eindeutige Index der Läufe verhindert, dass ein
 * Datensatz, der zweimal gefunden wird, zweimal läuft. Vorwärts so weit, wie
 * die früheste Regel vorausgreift (`delayMinutes` negativ), plus eine Stunde
 * bis zum nächsten Lauf.
 *
 * Gesucht wird nur für Auslöser, zu denen eine aktive Regel existiert: Ohne
 * Regel wäre jede Abfrage verschwendet.
 */
export async function emitZeitbezogeneAusloeser(params: {
  organizationId: string;
  jetzt?: Date;
}): Promise<Record<string, AusloeseErgebnis & { funde: number }>> {
  const jetzt = params.jetzt ?? new Date();
  const ergebnis: Record<string, AusloeseErgebnis & { funde: number }> = {};

  const regeln = await prisma.automation.findMany({
    where: { organizationId: params.organizationId, active: true, trigger: { in: Object.keys(ZEITREGELN) as AutomationTrigger[] } },
    select: { trigger: true, delayMinutes: true },
  });

  const vorgriff = new Map<AutomationTrigger, number>();
  for (const r of regeln) {
    vorgriff.set(r.trigger, Math.max(vorgriff.get(r.trigger) ?? 0, -Math.min(r.delayMinutes, 0)));
  }

  for (const [trigger, minuten] of vorgriff) {
    const regel = ZEITREGELN[trigger]!;
    const von = new Date(jetzt.getTime() - 26 * 3_600_000);
    const bis = new Date(jetzt.getTime() + (minuten + 60) * 60_000);
    const summe: AusloeseErgebnis & { funde: number } = { geprueft: 0, angelegt: 0, vorhanden: 0, funde: 0 };
    try {
      const funde = await regel.finde(params.organizationId, von, bis);
      summe.funde = funde.length;
      for (const fund of funde) {
        const e = await emitAutomationTrigger({
          organizationId: params.organizationId,
          trigger,
          entityId: fund.entityId,
          bezugszeit: fund.zeitpunkt,
        });
        summe.geprueft = e.geprueft;
        summe.angelegt += e.angelegt;
        summe.vorhanden += e.vorhanden;
      }
    } catch (fehler) {
      // Ein Auslöser, der scheitert, hält die anderen nicht auf.
      log.error('Zeitbezogener Auslöser konnte nicht gemeldet werden', { trigger, error: fehler });
    }
    ergebnis[trigger] = summe;
  }

  return ergebnis;
}

// ---------------------------------------------------------------------------
//  Ausführen
// ---------------------------------------------------------------------------

/**
 * Wie oft ein Lauf versucht wird, und mit welchem Abstand.
 *
 * Drei Versuche mit wachsendem Abstand. Der erste Wiederholungsversuch nach
 * fünf Minuten fängt die kurze Störung (Mailversand klemmt); der letzte nach
 * einer Stunde fängt die mittlere (Gegenstelle wird gewartet). Was danach
 * noch scheitert, scheitert dauerhaft und soll sichtbar stehen bleiben.
 */
export const MAX_VERSUCHE = 3;
const BACKOFF_MINUTEN = [5, 60];

export interface LaufErgebnis {
  gepruefte: number;
  erfolgreich: number;
  uebersprungen: number;
  gescheitert: number;
  wiederholen: number;
}

/**
 * Fällige Läufe abarbeiten.
 *
 * Wird vom Scheduler aufgerufen (stündlich). `limit` begrenzt, was ein
 * einzelner Lauf anfasst — ein Rückstau von zehntausend Läufen soll den
 * Scheduler nicht über sein Zeitlimit tragen, sondern über mehrere Takte
 * abgebaut werden.
 */
export async function runDueAutomations(params: {
  organizationId: string;
  limit?: number;
}): Promise<LaufErgebnis> {
  const limit = Math.min(params.limit ?? 100, 500);
  const ergebnis: LaufErgebnis = {
    gepruefte: 0,
    erfolgreich: 0,
    uebersprungen: 0,
    gescheitert: 0,
    wiederholen: 0,
  };

  await haengendeLaeufeFreigeben(params.organizationId);

  const faellige = await prisma.automationRun.findMany({
    where: {
      status: 'PENDING',
      scheduledFor: { lte: new Date() },
      automation: { organizationId: params.organizationId, active: true },
    },
    orderBy: { scheduledFor: 'asc' },
    take: limit,
    select: { id: true },
  });

  for (const { id } of faellige) {
    ergebnis.gepruefte += 1;
    const ausgang = await fuehreLaufAus(params.organizationId, id);
    ergebnis[ausgang] += 1;
  }

  return ergebnis;
}

/**
 * Ab wann ein RUNNING als abgebrochen gilt. Ein Lauf braucht Sekunden; der
 * Scheduler selbst hat zwei Minuten (`maxDuration` der stündlichen Route).
 * Dreissig Minuten sind damit sicher jenseits jedes lebenden Laufs.
 */
const HAENGT_NACH_MINUTEN = 30;

/**
 * Hängende Läufe wieder aufnehmen.
 *
 * Bricht der Prozess mitten in einem Lauf ab (Neustart, Speicher, Zeitlimit
 * der Plattform), bleibt die Zeile auf RUNNING — und `runDueAutomations`
 * sucht nur PENDING. Bis 2026-09-23 blieb ein solcher Lauf für immer liegen,
 * ohne Fehler und ohne Wiederholung (RB-012). Jetzt kommt er zurück in die
 * Warteschlange, solange Versuche übrig sind; sonst endet er als FAILED mit
 * Grund. Über `updateMany` mit Bedingung, damit zwei gleichzeitige
 * Scheduler denselben Lauf nicht zweimal freigeben.
 */
async function haengendeLaeufeFreigeben(organizationId: string): Promise<void> {
  const grenze = new Date(Date.now() - HAENGT_NACH_MINUTEN * 60_000);
  const bereich = { status: 'RUNNING' as const, startedAt: { lt: grenze }, automation: { organizationId } };
  await prisma.automationRun.updateMany({
    where: { ...bereich, attempts: { lt: MAX_VERSUCHE } },
    data: { status: 'PENDING', scheduledFor: new Date(), error: 'Abgebrochen — Lauf wurde nicht beendet, neuer Versuch' },
  });
  await prisma.automationRun.updateMany({
    where: { ...bereich, attempts: { gte: MAX_VERSUCHE } },
    data: { status: 'FAILED', finishedAt: new Date(), error: 'Abgebrochen — keine Versuche mehr übrig' },
  });
}

type Ausgang = 'erfolgreich' | 'uebersprungen' | 'gescheitert' | 'wiederholen';

async function fuehreLaufAus(organizationId: string, runId: string): Promise<Ausgang> {
  /**
   * Beanspruchen über die `where`-Klausel, nicht über einen vorher gelesenen
   * Wert. Damit gewinnt bei zwei gleichzeitigen Scheduler-Aufrufen genau
   * einer, und zwar in der Datenbank entschieden — dieselbe Bauart wie bei
   * der Dateiprüfung in Wave 2.
   */
  const beansprucht = await prisma.automationRun.updateMany({
    where: { id: runId, status: 'PENDING' },
    data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 } },
  });
  if (beansprucht.count === 0) return 'uebersprungen';

  const lauf = await prisma.automationRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      entity: true,
      entityId: true,
      attempts: true,
      automation: {
        select: {
          id: true,
          name: true,
          trigger: true,
          conditions: true,
          organizationId: true,
          actions: { orderBy: { position: 'asc' }, select: { type: true, config: true } },
        },
      },
    },
  });

  if (!lauf || lauf.automation.organizationId !== organizationId) {
    await abschliessen(runId, 'SKIPPED', { grund: 'Regel gehört zu einer anderen Organisation.' });
    return 'uebersprungen';
  }

  const laden = LADER[lauf.entity];
  const nutzlast = laden ? await laden(organizationId, lauf.entityId) : null;

  /**
   * Der Vorgang ist weg — gelöscht, in den Papierkorb gelegt, nie vorhanden.
   * Das ist kein Fehlschlag: Es gibt nichts mehr zu tun, und ein erneuter
   * Versuch änderte daran nichts.
   */
  if (!nutzlast) {
    await abschliessen(runId, 'SKIPPED', { grund: 'Der Vorgang existiert nicht mehr.' });
    return 'uebersprungen';
  }

  /**
   * Die zweite Bedingungsprüfung — der Grund, warum dieser Entwurf den
   * Zustand neu lädt. Zwischen Auslöser und Ausführung können Tage liegen.
   */
  const bedingungen = (lauf.automation.conditions ?? {}) as Record<string, unknown>;
  if (!bedingungenErfuellt(bedingungen, nutzlast)) {
    await abschliessen(runId, 'SKIPPED', {
      grund: 'Die Bedingungen treffen zum Ausführungszeitpunkt nicht mehr zu.',
    });
    return 'uebersprungen';
  }

  /**
   * Zeitbezogene Auslöser prüfen ihren **Anlass** noch einmal: Ist die
   * Buchung noch bestätigt, die Rechnung noch offen, die Anfrage noch
   * unbearbeitet? Eine Regel ohne Bedingungen würde sonst an einen stornierten
   * Termin erinnern.
   */
  const zeitregel = ZEITREGELN[lauf.automation.trigger];
  if (zeitregel && !(await zeitregel.gilt(organizationId, lauf.entityId, new Date()))) {
    await abschliessen(runId, 'SKIPPED', { grund: 'Der Anlass besteht zum Ausführungszeitpunkt nicht mehr.' });
    return 'uebersprungen';
  }

  const protokoll: unknown[] = [];
  let gescheitertMit: string | null = null;
  let endgueltig = false;

  /**
   * Jede Aktion mit eigenem Stand (`AutomationActionRun`, 2026-09-27).
   *
   * Die Reihe bricht beim ersten Fehler ab — richtig, solange die Aktionen
   * aufeinander aufbauen („Aufgabe anlegen, dann benachrichtigen"). Bis
   * hierher wurde danach der **ganze** Lauf wiederholt, und eine bereits
   * ausgeführte Aktion lief erneut; hier stand, ein zweiter Versand sei
   * „ärgerlich, aber nicht falsch". Eine doppelte Aufgabe, eine doppelte
   * Gutschrift-Erinnerung, ein zweiter Webhook an ein Buchhaltungssystem sind
   * falsch. Jetzt:
   *
   *  • erledigte Aktionen (SUCCEEDED, SKIPPED) bleiben erledigt;
   *  • eine gescheiterte wird fortgesetzt — beim Versand ohne die bereits
   *    Erreichten (`result.zugestellt`);
   *  • eine Aktion, die noch auf RUNNING steht, hat einen Absturz mitten in
   *    der Ausführung hinter sich. Hat sie Aussenwirkung, ist ungewiss, ob
   *    sie gewirkt hat; sie wird **nicht** blind wiederholt, der Lauf endet
   *    sichtbar mit diesem Grund. Lieber eine Nachfrage als eine zweite
   *    Wirkung. Zielzustände (Statusänderung) sind wiederholbar.
   */
  for (const [position, aktion] of lauf.automation.actions.entries()) {
    const vorher = await prisma.automationActionRun.findUnique({ where: { runId_position: { runId, position } } });
    if (vorher && (vorher.status === 'SUCCEEDED' || vorher.status === 'SKIPPED')) {
      protokoll.push({ aktion: aktion.type, ergebnis: 'bereits erledigt' });
      continue;
    }
    if (vorher?.status === 'RUNNING' && !WIEDERHOLBAR.has(aktion.type)) {
      const grund = 'Abgebrochen während der Ausführung — Wirkung ungewiss, nicht wiederholt. Bitte prüfen.';
      await prisma.automationActionRun.update({ where: { id: vorher.id }, data: { status: 'FAILED', error: grund, finishedAt: new Date() } });
      protokoll.push({ aktion: aktion.type, ergebnis: 'fehler', grund });
      gescheitertMit = grund;
      endgueltig = true;
      break;
    }

    const befund = pruefeAktionsKonfiguration(aktion.type, aktion.config);
    if (!befund.ok) {
      /**
       * Eine unverstandene Konfiguration wird **übersprungen**, nicht
       * ausgeführt und nicht wiederholt. Sie stammt aus der Zeit vor der
       * Konfigurationsprüfung; ein erneuter Versuch brächte dasselbe Ergebnis,
       * und ein Ausführen mit geratenen Werten wäre die schlechtere
       * Alternative.
       */
      await aktionsstandSetzen(runId, position, aktion.type, 'SKIPPED', { grund: befund.grund });
      protokoll.push({ aktion: aktion.type, ergebnis: 'uebersprungen', grund: befund.grund });
      continue;
    }

    // Vor der Wirkung auf RUNNING — damit ein Absturz mittendrin erkennbar bleibt.
    await prisma.automationActionRun.upsert({
      where: { runId_position: { runId, position } },
      create: { runId, position, type: aktion.type, status: 'RUNNING', attempts: 1, startedAt: new Date() },
      update: { status: 'RUNNING', attempts: { increment: 1 }, startedAt: new Date(), error: null },
    });

    try {
      const bereitsZugestellt = ((vorher?.result ?? {}) as { zugestellt?: string[] }).zugestellt ?? [];
      const teilErgebnis = await fuehreAktionAus({
        organizationId,
        art: aktion.type,
        config: (aktion.config ?? {}) as Record<string, unknown>,
        nutzlast,
        bereitsZugestellt,
        idempotenzSchluessel: `${runId}:${position}`,
      });
      protokoll.push({ aktion: aktion.type, ...teilErgebnis });
      const stand = teilErgebnis.ergebnis === 'ok' ? 'SUCCEEDED' : teilErgebnis.ergebnis === 'uebersprungen' ? 'SKIPPED' : 'FAILED';
      await aktionsstandSetzen(runId, position, aktion.type, stand, teilErgebnis, stand === 'FAILED' ? teilErgebnis.grund : undefined);
      if (teilErgebnis.ergebnis === 'fehler') {
        gescheitertMit = teilErgebnis.grund ?? 'Unbekannter Fehler';
        break;
      }
    } catch (fehler) {
      const meldung = fehler instanceof Error ? fehler.message : String(fehler);
      await aktionsstandSetzen(runId, position, aktion.type, 'FAILED', vorher?.result ?? null, meldung);
      protokoll.push({ aktion: aktion.type, ergebnis: 'fehler', grund: meldung });
      gescheitertMit = meldung;
      break;
    }
  }

  if (!gescheitertMit) {
    await abschliessen(runId, 'SUCCESS', { aktionen: protokoll });
    return 'erfolgreich';
  }

  if (!endgueltig && lauf.attempts < MAX_VERSUCHE) {
    const minuten = BACKOFF_MINUTEN[Math.min(lauf.attempts - 1, BACKOFF_MINUTEN.length - 1)];
    await prisma.automationRun.update({
      where: { id: runId },
      data: {
        status: 'PENDING',
        scheduledFor: new Date(Date.now() + minuten * 60_000),
        error: gescheitertMit.slice(0, 500),
        result: { aktionen: protokoll } as Prisma.InputJsonValue,
      },
    });
    return 'wiederholen';
  }

  await abschliessen(runId, 'FAILED', { aktionen: protokoll }, gescheitertMit);
  log.warn('Automatisierung endgültig gescheitert', {
    runId,
    regel: lauf.automation.name,
    versuche: lauf.attempts,
  });
  return 'gescheitert';
}

/**
 * Aktionen, deren Wiederholung nach einem Absturz unschädlich ist: Sie setzen
 * einen Zielzustand, keinen Übergang, und haben keine Aussenwirkung.
 */
const WIEDERHOLBAR = new Set(['UPDATE_STATUS', 'AI_GENERATE']);

async function aktionsstandSetzen(
  runId: string,
  position: number,
  type: string,
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED',
  result: unknown,
  fehler?: string,
): Promise<void> {
  await prisma.automationActionRun.upsert({
    where: { runId_position: { runId, position } },
    create: { runId, position, type, status, attempts: 1, result: (result ?? undefined) as Prisma.InputJsonValue, error: fehler?.slice(0, 500) ?? null, finishedAt: new Date() },
    update: { status, result: (result ?? undefined) as Prisma.InputJsonValue, error: fehler?.slice(0, 500) ?? null, finishedAt: new Date() },
  });
}

async function abschliessen(
  runId: string,
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED',
  result: unknown,
  fehler?: string,
): Promise<void> {
  await prisma.automationRun.update({
    where: { id: runId },
    data: {
      status,
      finishedAt: new Date(),
      result: result as Prisma.InputJsonValue,
      error: fehler?.slice(0, 500) ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
//  Die Aktionen
// ---------------------------------------------------------------------------

interface AktionsErgebnis {
  ergebnis: 'ok' | 'uebersprungen' | 'fehler';
  grund?: string;
  [key: string]: unknown;
}

async function fuehreAktionAus(params: {
  organizationId: string;
  art: string;
  config: Record<string, unknown>;
  nutzlast: VorgangsNutzlast;
  /** Beim Versand: Konten, die ein früherer Versuch dieser Aktion schon erreicht hat. */
  bereitsZugestellt?: string[];
  /** Lauf und Stelle der Aktion — für Gegenstellen, die Wiederholungen erkennen. */
  idempotenzSchluessel?: string;
}): Promise<AktionsErgebnis> {
  switch (params.art) {
    case 'SEND_EMAIL':
    case 'SEND_SMS':
      return sendeNachricht(params);
    case 'CREATE_TASK':
      return legeAufgabeAn(params);
    case 'CREATE_NOTIFICATION':
      return legeMeldungAn(params);
    case 'UPDATE_STATUS':
      return aendereStatus(params);
    case 'WEBHOOK':
      return rufeAuf(params);
    case 'AI_GENERATE':
      /**
       * Bewusst nicht umgesetzt, und das ist eine Aussage und keine Lücke:
       * Ein Text, den eine Maschine erzeugt und der ohne Ansehen an die
       * Kundschaft geht, ist genau das, was `docs/bi/` für den Assistenten
       * ausschliesst („der Assistent entwirft nur"). Der Weg dahin führt über
       * eine Aufgabe, die jemand liest — und den gibt es bereits als
       * `CREATE_TASK`.
       */
      return {
        ergebnis: 'uebersprungen',
        grund:
          'KI-Texte gehen nicht ungelesen hinaus. Eine Aufgabe anlegen und den Entwurf dort prüfen.',
      };
    default:
      return { ergebnis: 'uebersprungen', grund: `Unbekannte Aktionsart „${params.art}".` };
  }
}

/** Wer laut Konfiguration angesprochen wird — als Benutzerkennungen. */
async function empfaengerKonten(
  organizationId: string,
  empfaenger: string,
  nutzlast: VorgangsNutzlast,
): Promise<string[]> {
  if (empfaenger === 'CUSTOMER') {
    const userId = (nutzlast.kunde as { userId?: string | null } | null)?.userId;
    return userId ? [userId] : [];
  }

  if (empfaenger === 'ASSIGNED_EMPLOYEE') {
    const zugeteilt = (nutzlast.zugeteilt ?? []) as { userId?: string | null }[];
    return zugeteilt.map((z) => z.userId).filter((id): id is string => Boolean(id));
  }

  // MANAGEMENT
  const leitung = await prisma.user.findMany({
    where: {
      organizationId,
      deletedAt: null,
      status: 'ACTIVE',
      role: { in: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] },
    },
    select: { id: true },
  });
  return leitung.map((u) => u.id);
}

async function sendeNachricht(params: {
  organizationId: string;
  art: string;
  config: Record<string, unknown>;
  nutzlast: VorgangsNutzlast;
  bereitsZugestellt?: string[];
}): Promise<AktionsErgebnis> {
  const perMail = params.art === 'SEND_EMAIL';
  const templateKey = String(params.config.templateKey ?? '');
  const empfaenger = String(params.config.empfaenger ?? 'CUSTOMER');

  const vorlage = perMail
    ? await prisma.emailTemplate.findFirst({
        where: { organizationId: params.organizationId, key: templateKey, active: true },
        select: { subject: true, bodyHtml: true, bodyText: true },
      })
    : await prisma.smsTemplate.findFirst({
        where: { organizationId: params.organizationId, key: templateKey, active: true },
        select: { body: true },
      });

  /**
   * Eine fehlende Vorlage wird **übersprungen**, nicht wiederholt. Sie kommt
   * nicht von selbst zurück; drei Versuche im Abstand von einer Stunde
   * änderten daran nichts und verdeckten die eigentliche Auskunft, nämlich
   * dass die Vorlage fehlt.
   */
  if (!vorlage) {
    return {
      ergebnis: 'uebersprungen',
      grund: `Vorlage „${templateKey}" fehlt oder ist abgeschaltet.`,
    };
  }

  const konten = await empfaengerKonten(params.organizationId, empfaenger, params.nutzlast);
  if (konten.length === 0) {
    return { ergebnis: 'uebersprungen', grund: 'Kein Empfänger mit Benutzerkonto.' };
  }

  /**
   * Gezählt wird, was **tatsächlich** hinausging. Bis 2026-09-23 zählte jeder
   * Empfänger als versandt — auch bei abgelehnter Zustellung, abbestellten
   * E-Mails oder fehlender Adresse —, und der Lauf stand als SUCCESS im
   * Protokoll (RB-012). Jetzt:
   *
   *  • ein Zustellfehler macht die Aktion zum Fehler → Wiederholung nach der
   *    Wartezeit, nach drei Versuchen FAILED;
   *  • ist niemand erreichbar (keine Adresse, abbestellt), wird
   *    übersprungen — ein erneuter Versuch änderte daran nichts.
   */
  let versandt = 0;
  let nichtErreichbar = 0;
  const zustellfehler: string[] = [];
  const fehlend = new Set<string>();
  /**
   * Wer schon erreicht wurde — aus einem früheren Versuch dieser Aktion und
   * aus diesem. Steht im Ergebnis und damit im Aktionsstand, auch wenn die
   * Aktion scheitert: Ein Wiederholungsversuch schreibt nur noch denen, die
   * fehlen (2026-09-27). Vorher bekam, wer beim ersten Versuch erreicht
   * wurde, dieselbe Nachricht bei jedem weiteren Versuch erneut.
   */
  const zugestellt = [...(params.bereitsZugestellt ?? [])];

  for (const userId of konten) {
    if (zugestellt.includes(userId)) continue;
    if (perMail) {
      const v = vorlage as { subject: string; bodyHtml: string; bodyText: string | null };
      const betreff = fuelleVorlage(v.subject, params.nutzlast);
      const html = fuelleVorlage(v.bodyHtml, params.nutzlast, { html: true });
      const text = v.bodyText ? fuelleVorlage(v.bodyText, params.nutzlast) : null;

      betreff.fehlendePlatzhalter.forEach((p) => fehlend.add(p));
      html.fehlendePlatzhalter.forEach((p) => fehlend.add(p));

      const zustellung = await notify({
        userId,
        channels: ['EMAIL'],
        title: betreff.text,
        body: text?.text ?? '',
        emailContent: { subject: betreff.text, html: html.text },
        entity: params.nutzlast.entity,
        entityId: params.nutzlast.entityId,
      });
      if (!zustellung.email) nichtErreichbar += 1;
      else if (zustellung.email.ok) {
        versandt += 1;
        zugestellt.push(userId);
      } else zustellfehler.push(zustellung.email.fehler ?? 'E-Mail nicht zugestellt');
    } else {
      const v = vorlage as { body: string };
      const sms = fuelleVorlage(v.body, params.nutzlast);
      sms.fehlendePlatzhalter.forEach((p) => fehlend.add(p));

      const zustellung = await notify({
        userId,
        channels: ['SMS'],
        title: '',
        body: sms.text,
        smsBody: sms.text,
        entity: params.nutzlast.entity,
        entityId: params.nutzlast.entityId,
      });
      if (!zustellung.sms) nichtErreichbar += 1;
      else if (zustellung.sms.ok) {
        versandt += 1;
        zugestellt.push(userId);
      } else zustellfehler.push(zustellung.sms.fehler ?? 'SMS nicht zugestellt');
    }
  }

  if (zustellfehler.length > 0) {
    // Die Meldung des Anbieters, gekürzt — keine Adresse, kein Inhalt.
    return {
      ergebnis: 'fehler',
      grund: `${zustellfehler.length} von ${konten.length} Nachrichten nicht zugestellt: ${zustellfehler[0]!.slice(0, 200)}`,
      versandt,
      zugestellt,
    };
  }
  if (zugestellt.length === 0) {
    return {
      ergebnis: 'uebersprungen',
      grund: `Kein Empfänger erreichbar (${nichtErreichbar} ohne Adresse oder abbestellt).`,
    };
  }

  return {
    ergebnis: 'ok',
    versandt,
    zugestellt,
    ...(nichtErreichbar > 0 ? { nichtErreichbar } : {}),
    // Für die Vorlagenpflege sichtbar, bevor es der Kundschaft auffällt.
    ...(fehlend.size > 0 ? { fehlendePlatzhalter: [...fehlend] } : {}),
  };
}

async function legeAufgabeAn(params: {
  organizationId: string;
  config: Record<string, unknown>;
  nutzlast: VorgangsNutzlast;
}): Promise<AktionsErgebnis> {
  const titel = fuelleVorlage(String(params.config.titel ?? ''), params.nutzlast).text;
  const beschreibung = params.config.beschreibung
    ? fuelleVorlage(String(params.config.beschreibung), params.nutzlast).text
    : null;
  const tage = Number(params.config.faelligInTagen ?? 0);

  /**
   * Die Aufgabe wird an den auslösenden Vorgang gehängt — über die Spalte,
   * die zu seiner Art gehört. `Task` hat keine allgemeine
   * `relatedType`/`relatedId`-Spalte, sondern je eine Verknüpfung; das ist
   * die bessere Bauart (der Fremdschlüssel hält), verlangt aber diese
   * Zuordnung.
   *
   * Für Vorgänge ohne passende Spalte (Offerte, Rechnung) entsteht die
   * Aufgabe ohne Verknüpfung, dafür mit der Nummer im Titel. Eine erfundene
   * Verknüpfung wäre schlechter als keine.
   */
  const verknuepfung =
    params.nutzlast.entity === 'Booking' || params.nutzlast.entity === 'Job'
      ? { jobId: params.nutzlast.entity === 'Job' ? params.nutzlast.entityId : undefined }
      : params.nutzlast.entity === 'Lead'
        ? { leadId: params.nutzlast.entityId }
        : params.nutzlast.entity === 'Customer'
          ? { customerId: params.nutzlast.entityId }
          : {};

  const kundeId = (params.nutzlast.kunde as { id?: string } | null)?.id;

  const aufgabe = await prisma.task.create({
    data: {
      title: titel.slice(0, 200),
      description: beschreibung,
      priority: String(params.config.prioritaet ?? 'NORMAL') as
        | 'LOW'
        | 'NORMAL'
        | 'HIGH'
        | 'URGENT',
      dueAt: new Date(Date.now() + tage * 24 * 60 * 60 * 1000),
      // Der Kunde als zweite Verknüpfung, wo es ihn gibt — die Aufgabe steht
      // dann auch in der Kundenakte und nicht nur am Einzelvorgang.
      ...(kundeId && !('customerId' in verknuepfung) ? { customerId: kundeId } : {}),
      ...verknuepfung,
    },
    select: { id: true },
  });

  return { ergebnis: 'ok', taskId: aufgabe.id };
}

async function legeMeldungAn(params: {
  organizationId: string;
  config: Record<string, unknown>;
  nutzlast: VorgangsNutzlast;
}): Promise<AktionsErgebnis> {
  const titel = fuelleVorlage(String(params.config.titel ?? ''), params.nutzlast).text;
  const text = params.config.text
    ? fuelleVorlage(String(params.config.text), params.nutzlast).text
    : '';

  const konten = await empfaengerKonten(
    params.organizationId,
    String(params.config.empfaenger ?? 'MANAGEMENT'),
    params.nutzlast,
  );
  if (konten.length === 0) {
    return { ergebnis: 'uebersprungen', grund: 'Kein Empfänger mit Benutzerkonto.' };
  }

  for (const userId of konten) {
    await notify({
      userId,
      channels: ['IN_APP'],
      title: titel.slice(0, 200),
      body: text,
      entity: params.nutzlast.entity,
      entityId: params.nutzlast.entityId,
    });
  }

  return { ergebnis: 'ok', empfaenger: konten.length };
}

async function aendereStatus(params: {
  organizationId: string;
  config: Record<string, unknown>;
  nutzlast: VorgangsNutzlast;
}): Promise<AktionsErgebnis> {
  const ziel = String(params.config.ziel ?? '') as StatusZiel;
  const status = String(params.config.status ?? '');

  const erlaubt = ERLAUBTE_STATUSAENDERUNGEN[ziel] as readonly string[] | undefined;
  if (!erlaubt || !erlaubt.includes(status)) {
    return { ergebnis: 'uebersprungen', grund: 'Diese Statusänderung ist nicht zugelassen.' };
  }

  /**
   * Die Regel darf nur den Datensatz ändern, der sie ausgelöst hat.
   *
   * Ohne diese Prüfung wäre `UPDATE_STATUS` ein Weg, aus einem Auslöser
   * heraus einen **anderen** Datensatz zu ändern — und über eine Kette von
   * Regeln beliebig viele.
   */
  const erwartetesEntity = { lead: 'Lead', booking: 'Booking', job: 'Job' }[ziel];
  if (params.nutzlast.entity !== erwartetesEntity) {
    return {
      ergebnis: 'uebersprungen',
      grund: `Diese Regel läuft auf „${params.nutzlast.entity}" und kann kein „${ziel}" ändern.`,
    };
  }

  const wo = { id: params.nutzlast.entityId, organizationId: params.organizationId };

  const treffer =
    ziel === 'lead'
      ? await prisma.lead.updateMany({ where: wo, data: { status: status as never } })
      : ziel === 'booking'
        ? await prisma.booking.updateMany({ where: wo, data: { status: status as never } })
        : await prisma.job.updateMany({ where: wo, data: { status: status as never } });

  return treffer.count > 0
    ? { ergebnis: 'ok', ziel, status }
    : { ergebnis: 'uebersprungen', grund: 'Der Datensatz wurde nicht gefunden.' };
}

async function rufeAuf(params: {
  config: Record<string, unknown>;
  nutzlast: VorgangsNutzlast;
  idempotenzSchluessel?: string;
}): Promise<AktionsErgebnis> {
  const url = String(params.config.url ?? '');
  const secret = params.config.secret ? String(params.config.secret) : undefined;

  const antwort = await sendeWebhook({
    url,
    secret,
    idempotenzSchluessel: params.idempotenzSchluessel,
    /**
     * Der Rumpf ist die Nutzlast — also genau das, was oben als „bewusst
     * schmal" festgelegt wurde. Er geht an eine fremde Gegenstelle, und
     * deshalb ist dies die Stelle, an der sich die Enge der Nutzlast
     * auszahlt: Was dort nicht steht, kann hier nicht hinausgehen.
     */
    rumpf: { ereignis: params.nutzlast.entity, vorgang: params.nutzlast },
  });

  if (antwort.ok) {
    return { ergebnis: 'ok', status: antwort.status, dauerMs: antwort.dauerMs };
  }

  /**
   * Ein abgewiesenes Ziel (privat, falsches Schema, nicht erlaubt) wird
   * **übersprungen** und nicht wiederholt: Die Adresse wird beim dritten
   * Versuch dieselbe sein. Netzwerkfehler und Zeitlimits dagegen sind
   * vorübergehend und dürfen wiederholt werden.
   */
  const dauerhaft = ['SCHEMA', 'NICHT_ERLAUBT', 'PRIVATE_ADRESSE'].includes(antwort.fehler ?? '');
  return dauerhaft
    ? { ergebnis: 'uebersprungen', grund: antwort.grund, fehler: antwort.fehler }
    : { ergebnis: 'fehler', grund: antwort.grund, fehler: antwort.fehler };
}
