import 'server-only';

import type { Prisma } from '@prisma/client';

import { audit, recordAuditInTx } from '@/lib/audit';
import { zurichParts } from '@/lib/bi/periods';
import { prisma, toNumber, type Tx } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { round2 } from '@/lib/utils';

import { markiereMonateVeraltet } from './payroll-veraltet';

/**
 * Zeiterfassung — ansehen, korrigieren, freigeben.
 *
 * ---------------------------------------------------------------------------
 *  Der Befund
 * ---------------------------------------------------------------------------
 *
 * Es gab zwei Endpunkte: einstempeln und ausstempeln. Mehr nicht.
 *
 * `TimeEntry.approved`, `approvedById` und `manual` standen im Schema und
 * wurden von keinem Codepfad je geschrieben. `timetracking:approve` war an
 * Rollen vergeben und wurde von **nichts** geprüft. `timetracking:read_all`
 * nur vom Buchhaltungsexport.
 *
 * Das heisst im Betrieb: Wer das Ausstempeln vergisst, hat einen offenen
 * Eintrag, den niemand schliessen kann. Wer sich vertippt, hat eine falsche
 * Zeit, die niemand korrigieren kann. Und niemand kann eine Zeit freigeben,
 * bevor sie in die Lohnabrechnung geht — obwohl die Matrix die Zeiterfassung
 * als „Grundlage der Lohnabrechnung" führt.
 *
 * ---------------------------------------------------------------------------
 *  Die vier Regeln, die dieser Dienst durchsetzt
 * ---------------------------------------------------------------------------
 *
 * 1. **Die Dauer rechnet der Server.** Nie der Client — dieselbe Regel wie bei
 *    den Preisen. `minutes` wird bei jeder Änderung neu aus Beginn, Ende und
 *    Pause gebildet; ein mitgeschickter Wert wird ignoriert, weil er gar nicht
 *    erst entgegengenommen wird.
 *
 * 2. **Eine freigegebene Zeit ist eingefroren.** Sie ist die Grundlage einer
 *    Abrechnung. Wer sie korrigieren will, hebt zuerst die Freigabe auf — eine
 *    eigene, protokollierte Handlung. Ohne diese Schwelle wäre „freigegeben"
 *    eine Anzeige und keine Aussage.
 *
 * 3. **Keine Überschneidungen je Person.** Zwei gleichzeitige Erfassungen
 *    ergäben doppelten Lohn für dieselbe Stunde. Das ist der Fehler, der in
 *    der Lohnbuchhaltung landet und nicht in der Fehlersuche.
 *
 * 4. **Die Lohnkosten des Einsatzes wandern mit.** `clockOut` schreibt sie
 *    fort (`job.laborCost`); eine Korrektur, die das nicht nachzieht, lässt
 *    die Nachkalkulation auseinanderlaufen — und zwar still, weil niemand die
 *    beiden Zahlen nebeneinander sieht.
 */

/**
 * **5. Ein abgerechneter Monat ist abgeschlossen** (seit 2026-09-23).
 *
 * Ist die Lohnabrechnung eines Monats veröffentlicht, ändert sich an seinen
 * Zeiten nichts mehr: keine Freigabe aufheben, keine späte Freigabe, keine
 * Nacherfassung. Bis dahin liess sich eine Zeit im bezahlten Monat wieder
 * öffnen und ändern — und der veröffentlichte Beleg stimmte danach nicht mehr
 * mit der Zeiterfassung überein, ohne dass es jemand bemerkte. Was nachträglich
 * auffällt, wird im Folgemonat korrigiert; dafür ist die Korrektur da, nicht
 * das Umschreiben der Grundlage.
 *
 * Der Monat ist der **Zürcher** Kalendermonat — derselbe wie im Lohnlauf.
 */
async function lohnmonatVeroeffentlicht(employeeId: string, zeitpunkt: Date): Promise<boolean> {
  const teile = zurichParts(zeitpunkt);
  const abrechnung = await prisma.payslip.findUnique({
    where: { employeeId_year_month: { employeeId, year: teile.year, month: teile.month } },
    select: { published: true },
  });
  return abrechnung?.published === true;
}

async function lohnmonatOffen(employeeId: string, zeitpunkt: Date, was: string): Promise<void> {
  if (await lohnmonatVeroeffentlicht(employeeId, zeitpunkt)) {
    const teile = zurichParts(zeitpunkt);
    throw new BusinessRuleError(
      `Die Lohnabrechnung ${String(teile.month).padStart(2, '0')}/${teile.year} ist veröffentlicht. ` +
        `In diesem Monat lässt sich ${was} nicht mehr — Abweichungen werden im Folgemonat korrigiert.`,
    );
  }
}

/** Obergrenze für eine einzelne Erfassung. */
export const MAX_MINUTEN = 24 * 60;

/**
 * Warum überhaupt eine Obergrenze.
 *
 * Nicht, weil jemand 25 Stunden arbeiten könnte, sondern wegen des
 * vergessenen Ausstempelns: Ein Eintrag von Freitagmorgen bis Montagmittag
 * ergibt 4400 Minuten, und die gehen unbemerkt in die Lohnkosten des
 * Einsatzes und in die Nachkalkulation. Die Grenze macht daraus eine Absage
 * mit einem Satz — und zwingt zur Korrektur statt zur Übernahme.
 */
export function berechneMinuten(startedAt: Date, endedAt: Date, breakMin: number): number {
  const spanne = Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000);

  if (spanne <= 0) {
    throw new BusinessRuleError('Das Ende muss nach dem Beginn liegen.');
  }
  if (breakMin >= spanne) {
    throw new BusinessRuleError(
      `Die Pause (${breakMin} Min.) ist so lang wie die erfasste Zeit oder länger.`,
    );
  }
  if (spanne > MAX_MINUTEN) {
    throw new BusinessRuleError(
      `Eine einzelne Erfassung darf höchstens ${MAX_MINUTEN / 60} Stunden umfassen. ` +
        'Wurde das Ausstempeln vergessen? Dann bitte Beginn und Ende von Hand setzen.',
    );
  }

  return spanne - breakMin;
}

/**
 * Die Transaktionssperre der Zeiterfassung einer Person — **die eine**.
 *
 * Exportiert, weil es zwei Schreibwege in die Zeiterfassung gibt: diesen
 * Dienst (Nacherfassung, Korrektur) und das Einstempeln in `job.service.ts`
 * (`clockIn`). Bis 2026-09-27 nahm nur dieser Dienst die Sperre; `clockIn`
 * prüfte die laufende Erfassung ausserhalb jeder Transaktion (N-01). Zwei
 * Stempelungen im selben Augenblick — Doppeltipp, zwei Geräte, ein
 * wiederholter Aufruf nach einem Zeitlimit — lasen beide „nichts offen" und
 * legten beide eine laufende Erfassung an: doppelter Lohn für dieselbe Zeit.
 *
 * Der Schlüssel steht nur hier. Schrieben zwei Stellen ihn je selbst hin,
 * genügte ein Tippfehler in einer davon, und die beiden Wege sperrten
 * einander nicht mehr — ohne dass es irgendwo auffiele.
 */
export async function zeiterfassungSperren(tx: Tx, employeeId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`zeiterfassung:${employeeId}`}))`;
}

/**
 * Überschneidet sich dieser Zeitraum mit einer anderen Erfassung derselben
 * Person?
 *
 * Der laufende Eintrag (`endedAt: null`) zählt mit: Wer noch eingestempelt
 * ist, kann nicht gleichzeitig irgendwo anders gearbeitet haben. Sein Ende ist
 * unbekannt, also wird es als „jetzt" gelesen — die vorsichtige Auslegung.
 */
async function pruefeUeberschneidung(
  tx: Tx,
  employeeId: string,
  startedAt: Date,
  endedAt: Date,
  ausserId?: string,
): Promise<void> {
  /*
    Erst die Sperre je Person, dann lesen (2026-09-27). Ohne sie lasen
    parallele Erfassungen unter READ COMMITTED alle „frei" und schrieben alle —
    sechs gleichzeitige, sich überlappende Zeiten ergaben sechs Einträge und
    sechsfachen Lohn für dieselbe Stunde. Eine Datenbankbedingung (EXCLUDE
    über einen Zeitbereich) ginge auch, verlangte aber `btree_gist` und liest
    den laufenden Eintrag (`endedAt: null`) nicht als „bis jetzt". Dieselbe
    Bauart wie die Zuteilung (`assignment.service.ts`): eine
    Transaktionssperre, die mit dem Commit endet — der Aufrufer muss also in
    einer Transaktion sein, und alle sind es.
  */
  await zeiterfassungSperren(tx, employeeId);
  const andere = await tx.timeEntry.findMany({
    where: {
      employeeId,
      ...(ausserId ? { id: { not: ausserId } } : {}),
      startedAt: { lt: endedAt },
    },
    select: { id: true, startedAt: true, endedAt: true },
    orderBy: { startedAt: 'desc' },
    take: 50,
  });

  for (const eintrag of andere) {
    const ende = eintrag.endedAt ?? new Date();
    if (eintrag.startedAt < endedAt && startedAt < ende) {
      throw new BusinessRuleError(
        `Überschneidet sich mit einer Erfassung ab ${eintrag.startedAt.toISOString().slice(0, 16).replace('T', ' ')}. ` +
          'Zwei gleichzeitige Zeiten ergäben doppelten Lohn für dieselbe Stunde.',
      );
    }
  }
}

/**
 * Die Lohnkosten des Einsatzes um die Differenz anpassen.
 *
 * `increment` mit einer Differenz statt Neusetzen: Ein Einsatz hat mehrere
 * Erfassungen von mehreren Personen, und der Gesamtwert neu zu berechnen
 * hiesse, alle zu laden — und bei zwei gleichzeitigen Korrekturen verlöre eine
 * die andere. Die Differenz ist wettlauffrei.
 */
async function passeLohnkostenAn(
  tx: Tx,
  jobId: string | null,
  minutenDelta: number,
  stundensatz: number,
): Promise<void> {
  if (!jobId || minutenDelta === 0 || stundensatz <= 0) return;

  await tx.job.update({
    where: { id: jobId },
    data: { laborCost: { increment: round2((minutenDelta / 60) * stundensatz) } },
  });
}

/** Der Eintrag samt Mandantenprüfung — über die Personalakte. */
async function ladeEintrag(organizationId: string, id: string) {
  const eintrag = await prisma.timeEntry.findFirst({
    /**
     * `TimeEntry` trägt kein `organizationId`; die Zugehörigkeit hängt an der
     * Personalakte. Der Filter steht deshalb in der **Beziehung** und nicht
     * hinter der Abfrage — ein Eintrag einer fremden Organisation wird gar
     * nicht erst gefunden, statt gefunden und danach abgelehnt zu werden.
     */
    where: { id, employee: { organizationId } },
    include: {
      employee: { select: { id: true, employeeNumber: true } },
      job: { select: { id: true, number: true } },
    },
  });
  if (!eintrag) throw new NotFoundError('Zeiterfassung');
  return eintrag;
}

// ---------------------------------------------------------------------------
//  Lesen
// ---------------------------------------------------------------------------

export interface TimeEntryFilter {
  organizationId: string;
  /** Ohne Angabe: alle. Mit: nur diese Person. */
  employeeId?: string;
  jobId?: string;
  from?: Date;
  to?: Date;
  /** `true` = nur freigegebene, `false` = nur offene, `undefined` = alle. */
  approved?: boolean;
  /** Nur noch laufende Erfassungen — der Fall „Ausstempeln vergessen". */
  nurOffen?: boolean;
  page?: number;
  pageSize?: number;
}

export async function listTimeEntries(filter: TimeEntryFilter) {
  const pageSize = Math.min(filter.pageSize ?? 50, 200);
  const page = Math.max(filter.page ?? 1, 1);

  const where: Prisma.TimeEntryWhereInput = {
    employee: { organizationId: filter.organizationId },
    ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
    ...(filter.jobId ? { jobId: filter.jobId } : {}),
    ...(filter.approved !== undefined ? { approved: filter.approved } : {}),
    ...(filter.nurOffen ? { endedAt: null } : {}),
    ...(filter.from || filter.to
      ? {
          startedAt: {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lt: filter.to } : {}),
          },
        }
      : {}),
  };

  const [eintraege, gesamt, summe] = await prisma.$transaction([
    prisma.timeEntry.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        startedAt: true,
        endedAt: true,
        breakMin: true,
        minutes: true,
        note: true,
        manual: true,
        approved: true,
        employee: {
          select: {
            id: true,
            employeeNumber: true,
            user: { select: { firstName: true, lastName: true } },
          },
        },
        job: { select: { id: true, number: true } },
      },
    }),
    prisma.timeEntry.count({ where }),
    /**
     * Die Summe über **alle** Treffer, nicht über die angezeigte Seite.
     *
     * Eine Seitensumme wäre die häufigste Fehlerquelle einer solchen Ansicht:
     * Sie sieht aus wie die Monatssumme und ist es nicht, und niemand merkt
     * es, solange der Monat auf eine Seite passt.
     */
    prisma.timeEntry.aggregate({ where, _sum: { minutes: true } }),
  ]);

  return {
    eintraege,
    gesamt,
    page,
    pageSize,
    summeMinuten: summe._sum.minutes ?? 0,
  };
}

// ---------------------------------------------------------------------------
//  Erfassen und korrigieren
// ---------------------------------------------------------------------------

export interface ManuelleZeitInput {
  employeeId: string;
  jobId?: string | null;
  startedAt: Date;
  endedAt: Date;
  breakMin: number;
  note?: string | null;
}

/**
 * Eine Zeit von Hand erfassen.
 *
 * Der Fall: Jemand hat das Stempeln vergessen, war ohne Empfang unterwegs oder
 * die Erfassung ist bei einem Gerätewechsel verlorengegangen. Ohne diesen Weg
 * bliebe nur, die Stunde nicht zu bezahlen oder sie neben dem System zu
 * führen — und beides passiert dann auch.
 *
 * `manual: true` hält fest, dass die Zeit nicht gestempelt wurde. Das ist
 * keine Verdächtigung, sondern die Auskunft, die eine Lohnkontrolle braucht:
 * Eine gestempelte Zeit hat einen Zeitpunkt und einen Ort, eine erfasste hat
 * eine Person, die sie eingetragen hat.
 */
export async function createManualTimeEntry(params: {
  organizationId: string;
  actorId: string;
  ip?: string | null;
  input: ManuelleZeitInput;
}) {
  const employee = await prisma.employee.findFirst({
    where: { id: params.input.employeeId, organizationId: params.organizationId },
    select: { id: true, employeeNumber: true, hourlyRate: true, monthlySalary: true },
  });
  if (!employee) throw new NotFoundError('Mitarbeitende/r');
  await lohnmonatOffen(employee.id, params.input.startedAt, 'keine Zeit mehr nacherfassen');

  const minutes = berechneMinuten(
    params.input.startedAt,
    params.input.endedAt,
    params.input.breakMin,
  );

  if (params.input.jobId) {
    const job = await prisma.job.findFirst({
      where: { id: params.input.jobId, organizationId: params.organizationId },
      select: { id: true },
    });
    if (!job) throw new NotFoundError('Einsatz');
  }

  /**
   * Der Stundenansatz wird als Momentaufnahme mitgeschrieben — genau wie beim
   * Einstempeln (`clockIn`). Eine spätere Lohnerhöhung soll vergangene
   * Einsätze nicht rückwirkend verteuern.
   */
  const stundensatz = toNumber(employee.hourlyRate);

  const eintrag = await prisma.$transaction(async (tx) => {
    await pruefeUeberschneidung(
      tx,
      employee.id,
      params.input.startedAt,
      params.input.endedAt,
    );

    const erstellt = await tx.timeEntry.create({
      data: {
        employeeId: employee.id,
        jobId: params.input.jobId ?? null,
        startedAt: params.input.startedAt,
        endedAt: params.input.endedAt,
        breakMin: params.input.breakMin,
        minutes,
        note: params.input.note ?? null,
        manual: true,
        hourlyRate: stundensatz > 0 ? stundensatz : null,
      },
      select: { id: true },
    });

    await passeLohnkostenAn(tx, params.input.jobId ?? null, minutes, stundensatz);
    return erstellt;
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'TimeEntry',
    entityId: eintrag.id,
    summary:
      `Zeit von Hand erfasst für ${employee.employeeNumber}: ` +
      `${params.input.startedAt.toISOString().slice(0, 16).replace('T', ' ')}, ${minutes} Min.`,
    ip: params.ip,
  });

  return { id: eintrag.id, minutes };
}

/**
 * Eine Erfassung korrigieren.
 *
 * **Eine freigegebene Zeit lässt sich nicht ändern.** Sie ist die Grundlage
 * einer Abrechnung; wer sie korrigieren will, hebt zuerst die Freigabe auf.
 * Das ist eine eigene Handlung mit eigenem Protokolleintrag — und genau diese
 * Schwelle macht aus „freigegeben" eine Aussage statt einer Anzeige.
 */
export async function updateTimeEntry(params: {
  organizationId: string;
  entryId: string;
  actorId: string;
  ip?: string | null;
  input: { startedAt?: Date; endedAt?: Date | null; breakMin?: number; note?: string | null };
}) {
  const eintrag = await ladeEintrag(params.organizationId, params.entryId);

  if (eintrag.approved) {
    throw new BusinessRuleError(
      'Diese Zeit ist freigegeben und damit Grundlage einer Abrechnung. ' +
        'Zum Korrigieren zuerst die Freigabe aufheben.',
    );
  }

  const startedAt = params.input.startedAt ?? eintrag.startedAt;
  const endedAt =
    params.input.endedAt === undefined ? eintrag.endedAt : params.input.endedAt;
  const breakMin = params.input.breakMin ?? eintrag.breakMin;

  /**
   * Ein Eintrag ohne Ende ist eine **laufende** Erfassung. Er darf so bleiben
   * (jemand ist gerade eingestempelt), und dann gibt es keine Dauer zu
   * rechnen — `minutes` bleibt 0, bis ausgestempelt oder ein Ende gesetzt
   * wird.
   */
  const minutes = endedAt ? berechneMinuten(startedAt, endedAt, breakMin) : 0;
  const delta = minutes - eintrag.minutes;
  const stundensatz = toNumber(eintrag.hourlyRate);

  await prisma.$transaction(async (tx) => {
    if (endedAt) {
      await pruefeUeberschneidung(tx, eintrag.employeeId, startedAt, endedAt, eintrag.id);
    }

    await tx.timeEntry.update({
      where: { id: eintrag.id },
      data: {
        startedAt,
        endedAt,
        breakMin,
        minutes,
        note: params.input.note === undefined ? eintrag.note : params.input.note,
        /**
         * Eine korrigierte Zeit gilt als von Hand erfasst — auch wenn sie
         * gestempelt begann. Der Stempel belegt sie nicht mehr; was zählt,
         * ist die Person, die korrigiert hat, und die steht im Protokoll.
         */
        manual: true,
      },
    });

    await passeLohnkostenAn(tx, eintrag.jobId, delta, stundensatz);
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'TimeEntry',
    entityId: eintrag.id,
    summary: `Zeit von ${eintrag.employee.employeeNumber} korrigiert (${eintrag.minutes} → ${minutes} Min.)`,
    changes: {
      startedAt: { from: eintrag.startedAt, to: startedAt },
      endedAt: { from: eintrag.endedAt, to: endedAt },
      breakMin: { from: eintrag.breakMin, to: breakMin },
      minutes: { from: eintrag.minutes, to: minutes },
    },
    ip: params.ip,
  });

  return { id: eintrag.id, minutes };
}

/**
 * Eine Erfassung löschen.
 *
 * Nur, solange sie nicht freigegeben ist — aus demselben Grund wie beim
 * Korrigieren. Ein Doppeleintrag (zweimal eingestempelt, einmal vergessen
 * auszustempeln) lässt sich sonst nicht aus der Welt schaffen, und ihn auf
 * null Minuten zu korrigieren wäre eine Zeile, die aussieht wie Arbeit ohne
 * Dauer.
 */
export async function deleteTimeEntry(params: {
  organizationId: string;
  entryId: string;
  actorId: string;
  ip?: string | null;
}) {
  const eintrag = await ladeEintrag(params.organizationId, params.entryId);

  if (eintrag.approved) {
    throw new BusinessRuleError(
      'Eine freigegebene Zeit wird nicht gelöscht. Zuerst die Freigabe aufheben.',
    );
  }

  const stundensatz = toNumber(eintrag.hourlyRate);

  await prisma.$transaction(async (tx) => {
    await tx.timeEntry.delete({ where: { id: eintrag.id } });
    await passeLohnkostenAn(tx, eintrag.jobId, -eintrag.minutes, stundensatz);
  });

  await audit.deleted({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'TimeEntry',
    entityId: eintrag.id,
    summary:
      `Zeit von ${eintrag.employee.employeeNumber} gelöscht ` +
      `(${eintrag.startedAt.toISOString().slice(0, 16).replace('T', ' ')}, ${eintrag.minutes} Min.)`,
    ip: params.ip,
  });

  return { id: eintrag.id };
}

// ---------------------------------------------------------------------------
//  Freigeben
// ---------------------------------------------------------------------------

/**
 * Zeiten freigeben.
 *
 * Mehrere auf einmal, weil das der Arbeitsablauf ist: Am Monatsende geht
 * jemand die Liste durch und gibt frei, was stimmt. Ein Endpunkt je Zeile
 * hiesse dreissig Aufrufe für einen Monat.
 *
 * **Eine laufende Erfassung wird nicht freigegeben.** Ohne Ende gibt es keine
 * Dauer, und eine Freigabe von null Minuten wäre eine Zusage über etwas, das
 * noch nicht feststeht.
 */
export async function approveTimeEntries(params: {
  organizationId: string;
  entryIds: string[];
  actorId: string;
  ip?: string | null;
}): Promise<{ freigegeben: number; uebersprungen: number }> {
  const eintraege = await prisma.timeEntry.findMany({
    where: {
      id: { in: params.entryIds },
      employee: { organizationId: params.organizationId },
    },
    select: { id: true, endedAt: true, approved: true, employeeId: true, startedAt: true },
  });

  // Eine Zeit in einem Monat mit veröffentlichter Abrechnung wird nicht mehr
  // nachträglich freigegeben — sie gehört in eine Korrektur des Folgemonats.
  // Eine Abfrage für alle Monate der Auswahl (Phase 23, 2026-09-27); vorher
  // eine je Erfassung, bis zu 200 für einen Klick.
  const monatVon = (e: { employeeId: string; startedAt: Date }) => {
    const t = zurichParts(e.startedAt);
    return { employeeId: e.employeeId, year: t.year, month: t.month };
  };
  const monate = [...new Map(eintraege.map((e) => { const m = monatVon(e); return [`${m.employeeId}:${m.year}:${m.month}`, m] as const; })).values()];
  const veroeffentlicht = monate.length
    ? new Set(
        (
          await prisma.payslip.findMany({
            where: { published: true, OR: monate },
            select: { employeeId: true, year: true, month: true },
          })
        ).map((p) => `${p.employeeId}:${p.year}:${p.month}`),
      )
    : new Set<string>();
  const gesperrt = new Set(
    eintraege.filter((e) => { const m = monatVon(e); return veroeffentlicht.has(`${m.employeeId}:${m.year}:${m.month}`); }).map((e) => e.id),
  );
  const geeignet = eintraege
    .filter((e) => e.endedAt !== null && !e.approved && !gesperrt.has(e.id))
    .map((e) => e.id);

  if (geeignet.length === 0) {
    return { freigegeben: 0, uebersprungen: eintraege.length };
  }

  /**
   * Freigabe und Protokoll in **einer** Transaktion (F-14, 2026-09-27).
   *
   * Vorher schrieb die Freigabe zuerst und protokollierte danach mit
   * `audit.updated` — nach bestem Bemühen, Fehler verschluckt. Klemmte das
   * Protokoll, stand eine Zeit als freigegeben in der Lohngrundlage, ohne
   * dass sich je feststellen liess, wer sie freigegeben hat. Eine Freigabe
   * ist genau der Vorgang, den es ohne Eintrag nicht geben darf (siehe
   * `recordAuditInTx` in `lib/audit.ts`): Jetzt scheitert sie mit dem Eintrag,
   * und ein zurückgerollter Versuch hinterlässt auch keine Zeile, die eine
   * nie geschehene Freigabe bezeugt.
   *
   * **Welche Zeilen tatsächlich freigegeben wurden, entscheidet die
   * Zeilensperre.** `FOR UPDATE` mit der Bedingung in der `WHERE`-Klausel: Hat
   * eine gleichzeitige Freigabe eine Zeile gerade gesperrt, wartet diese
   * Abfrage, prüft die Bedingung danach auf dem *neuen* Stand der Zeile
   * erneut (READ COMMITTED) und lässt sie weg. Die zurückgegebenen Kennungen
   * sind also genau die, die dieser Aufruf freigibt — nicht die, die er beim
   * Lesen oben für freigebbar hielt. Vorher wurden die Protokollzeilen danach
   * über `approvedById` zusammengesucht; zwei gleichzeitige Freigaben
   * derselben Person hätten dabei die Zeilen der jeweils anderen mitgezählt.
   * Weder Zeitpunkt noch Person einer früheren Freigabe werden überschrieben.
   */
  const freigegebeneIds = await prisma.$transaction(async (tx) => {
    const gesperrt = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM time_entries
      WHERE id = ANY(${geeignet}::text[]) AND approved = false AND "endedAt" IS NOT NULL
      FOR UPDATE`;
    const ids = gesperrt.map((zeile) => zeile.id);
    if (ids.length === 0) return ids;

    await tx.timeEntry.updateMany({
      where: { id: { in: ids } },
      data: { approved: true, approvedById: params.actorId },
    });

    /*
      Eine Zeile je Erfassung (2026-09-27). Vorher stand die ganze Freigabe
      in einer Zeile ohne `entityId`, die Kennungen nur im Änderungsfeld: Die
      Frage „wer hat diese Zeit freigegeben?" liess sich im Protokoll einer
      Erfassung nicht beantworten, weil sie dort gar nicht auftauchte.
      Geschrieben über `recordAuditInTx` — derselbe Weg mit derselben
      Schwärzung (`auditDaten`) wie jeder andere Eintrag, nur in der
      Transaktion.
    */
    for (const id of ids) {
      await recordAuditInTx(tx, {
        organizationId: params.organizationId,
        userId: params.actorId,
        action: 'UPDATE',
        entity: 'TimeEntry',
        entityId: id,
        summary: 'Zeiterfassung freigegeben',
        changes: { approved: true },
        ip: params.ip,
      });
    }
    return ids;
  });

  /*
    Eine späte Freigabe in einem berechneten, noch offenen Monat ändert dessen
    Stundenlohn. Nach dem Festschreiben und nur für die tatsächlich
    freigegebenen Zeilen: Die Markierung ist ein Hinweis zum Neuberechnen,
    kein Beleg — sie darf die Freigabe nicht zurückrollen, und ein Monat,
    dessen Zeiten ein anderer Aufruf freigegeben hat, markiert jener.
  */
  const freigegebenSet = new Set(freigegebeneIds);
  await markiereMonateVeraltet(
    eintraege
      .filter((e) => freigegebenSet.has(e.id))
      .map((e) => {
        const p = zurichParts(e.startedAt);
        return { employeeId: e.employeeId, year: p.year, month: p.month };
      }),
    'Zeiten freigegeben',
  );

  return {
    freigegeben: freigegebeneIds.length,
    uebersprungen: eintraege.length - freigegebeneIds.length,
  };
}

/**
 * Eine Freigabe aufheben.
 *
 * Der Gegenweg zum Korrigieren. Bewusst **einzeln** und nicht als Stapel: Eine
 * Freigabe zurückzunehmen ist der seltene Fall und soll sich nicht versehentlich
 * auf einen ganzen Monat anwenden lassen.
 */
export async function reopenTimeEntry(params: {
  organizationId: string;
  entryId: string;
  actorId: string;
  ip?: string | null;
}) {
  const eintrag = await ladeEintrag(params.organizationId, params.entryId);

  if (!eintrag.approved) {
    throw new BusinessRuleError('Diese Zeit ist nicht freigegeben.');
  }
  await lohnmonatOffen(eintrag.employeeId, eintrag.startedAt, 'die Freigabe aufheben');

  await prisma.timeEntry.update({
    where: { id: eintrag.id },
    data: { approved: false, approvedById: null },
  });
  const teile = zurichParts(eintrag.startedAt);
  await markiereMonateVeraltet([{ employeeId: eintrag.employeeId, year: teile.year, month: teile.month }], 'Freigabe aufgehoben');

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'TimeEntry',
    entityId: eintrag.id,
    summary: `Freigabe der Zeit von ${eintrag.employee.employeeNumber} aufgehoben`,
    ip: params.ip,
  });

  return { id: eintrag.id, approved: false };
}
