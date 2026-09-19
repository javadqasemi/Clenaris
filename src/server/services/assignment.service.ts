import 'server-only';

import type { Prisma } from '@prisma/client';

import type { prisma, Tx } from '@/lib/db';
import { BusinessRuleError } from '@/lib/errors';
import { toDateOnly, zurichParts } from '@/lib/bi/periods';

import { activeStaffWhere } from './profile.service';

/**
 * Darf diese Person zu dieser Zeit eingeteilt werden?
 *
 * ---------------------------------------------------------------------------
 *  Warum das eine eigene Datei ist
 * ---------------------------------------------------------------------------
 *
 * Bis hierher gab es die Frage fünfmal, und jedes Mal anders beantwortet:
 *
 *   • `assignJob`   prüfte Doppelbelegung und aktives Personal
 *   • `setJobTeam`  prüfte dasselbe — mit einer zweiten, wortgleichen Kopie
 *   • `createJob`   prüfte nur aktives Personal
 *   • `moveJob`     prüfte **nichts**, teilte beim Ziehen im Kalender aber eine
 *                   neue Person zu und verschob den Termin unter dem
 *                   bestehenden Team weg
 *   • `updateJob`   verschob den Termin ebenfalls, ohne das Team anzusehen
 *
 * **Abwesenheiten prüfte keine dieser Stellen.** Wer in den bewilligten Ferien
 * war, liess sich widerspruchslos einteilen und erfuhr es per Benachrichtigung.
 * Die Routenregistrierung (`scripts/openapi-routes.ts`) versprach die Prüfung
 * sogar ausdrücklich — „Prüft Überschneidungen und Abwesenheiten" —, und diese
 * Zusage war schlicht unwahr. Das ist dieselbe Art Fehler wie das Schemafeld,
 * das seine Verschlüsselung behauptete, ohne dass es das Modul dazu gab.
 *
 * Eine Regel, fünf Aufrufer. Wer künftig eine sechste Stelle baut, an der ein
 * Einsatz eine Person oder eine Zeit bekommt, ruft `assertAssignable` auf und
 * muss nichts wissen.
 *
 * ---------------------------------------------------------------------------
 *  Warum innerhalb der Transaktion
 * ---------------------------------------------------------------------------
 *
 * Die alten Prüfungen liefen *vor* `prisma.$transaction`: lesen, entscheiden,
 * später schreiben. Zwei gleichzeitige Zuteilungen auf überlappende Einsätze
 * sahen beide eine freie Person und schrieben beide. Deshalb nimmt jede
 * Funktion hier ein `Tx` entgegen und wird aus der Transaktion heraus
 * aufgerufen, in der auch geschrieben wird.
 *
 * Das schliesst das Fenster nicht vollständig — zwei Transaktionen, die
 * *verschiedene* Einsatzzeilen anfassen, sperren einander nicht. Vollständig
 * dicht wäre nur eine Ausschlussbedingung in der Datenbank
 * (`EXCLUDE USING gist` über Personal und Zeitraum), und die verlangt
 * `btree_gist` sowie eine materialisierte Zeitspalte am `JobAssignment`. Das
 * ist eine eigene Migration mit eigener Begründung; der Fensterschluss hier
 * deckt den Fall ab, der in der Praxis auftritt: zweimal Klicken.
 *
 * ---------------------------------------------------------------------------
 *  Was blockiert und was nur warnt
 * ---------------------------------------------------------------------------
 *
 * | Befund                | Verhalten | Begründung |
 * |---|---|---|
 * | Person nicht gefunden | blockiert | Eine erfundene ID darf nicht erst als Fremdschlüsselfehler auffallen |
 * | Personalakte inaktiv  | blockiert | Wer ausgetreten ist, steht nicht vor der Tür |
 * | Bewilligte Abwesenheit| blockiert | Der Grund, aus dem es diese Datei gibt |
 * | Überschneidung        | blockiert | Niemand ist an zwei Orten |
 * | Beantragte Abwesenheit| **warnt**  | Noch nicht entschieden. Wer disponiert, soll es sehen — aber die Planung nicht an einem unbeantworteten Gesuch scheitern |
 * | Ausserhalb der Arbeitszeit | **warnt** | `Availability` ist eine Planungshilfe, keine Zusage. Ein Sonntagseinsatz nach Absprache ist normal; ihn zu blockieren hiesse, das Büro zu zwingen, zuerst ein Stammdatum zu ändern |
 *
 * Abgelehnte und zurückgezogene Gesuche (`REJECTED`, `CANCELLED`) zählen gar
 * nicht — sie sind erledigt.
 */

/** Maschinenlesbare Kennung eines Befunds. Siehe Tabelle oben. */
export type AssignmentConflictCode =
  | 'EMPLOYEE_NOT_FOUND'
  | 'EMPLOYEE_NOT_ACTIVE'
  | 'EMPLOYEE_ABSENT'
  | 'ABSENCE_REQUESTED'
  | 'ASSIGNMENT_OVERLAP'
  | 'OUTSIDE_AVAILABILITY';

export interface AssignmentConflict {
  code: AssignmentConflictCode;
  /** `block` verhindert die Zuteilung, `warn` wird nur gemeldet. */
  severity: 'block' | 'warn';
  employeeId: string;
  /** Vor- und Nachname, damit die Meldung ohne zweite Abfrage lesbar ist. */
  employeeName: string;
  /** Fertiger deutscher Satz für die Oberfläche. */
  message: string;
}

export interface EligibilityRequest {
  organizationId: string;
  employeeIds: string[];
  scheduledStart: Date;
  scheduledEnd: Date;
  /**
   * Einsatz, der gerade bearbeitet wird. Seine eigenen Zuteilungen zählen
   * nicht als Überschneidung — sonst verböte sich jede Änderung an einem
   * bereits eingeteilten Einsatz selbst.
   */
  ignoreJobId?: string;
}

const BLOCKING_JOB_STATUS: Prisma.JobWhereInput['status'] = {
  notIn: ['CANCELLED', 'COMPLETED', 'VERIFIED'],
};

/** „07:00" → 420. Ungültige Werte ergeben `null` statt einer falschen Zahl. */
function minutesOfDay(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number.isFinite(minutes) ? minutes : null;
}

function fullName(employee: { user: { firstName: string; lastName: string } }): string {
  return `${employee.user.firstName} ${employee.user.lastName}`;
}

/** Tag und Monat für eine Meldung — ohne Jahr, das steht im Kontext. */
function dayLabel(date: Date): string {
  const p = zurichParts(date);
  return `${String(p.day).padStart(2, '0')}.${String(p.month).padStart(2, '0')}.`;
}

/**
 * Prüft, ohne zu werfen. Gibt **alle** Befunde zurück, nicht nur den ersten:
 * Wer ein Team von vier Personen einteilt, will einmal erfahren, dass zwei
 * davon nicht können, und nicht viermal nacheinander.
 */
export async function checkAssignmentEligibility(
  tx: Tx | typeof prisma,
  request: EligibilityRequest,
): Promise<AssignmentConflict[]> {
  const { organizationId, employeeIds, scheduledStart, scheduledEnd } = request;
  if (employeeIds.length === 0) return [];

  const unique = [...new Set(employeeIds)];
  const conflicts: AssignmentConflict[] = [];

  // --- 1) Existiert die Person, gehört sie zum Mandanten, ist sie aktiv? ----
  /**
   * Zwei Abfragen statt einer, und der Grund ist die Definition von „aktiv".
   *
   * Was als Personal gilt, steht an genau einer Stelle: `activeStaffWhere` in
   * `profile.service.ts` — aktive Personalakte **und** Personalrolle, wobei
   * ein *gesperrtes* Konto bewusst weiter zählt (Sperren ist ein
   * vorübergehender Zugangsentzug, kein Austritt). Diese Regel hier
   * nachzubauen hiesse, sie zu verdoppeln und beim nächsten Mal auseinander
   * laufen zu lassen. Also fragt die erste Abfrage nach allen genannten
   * Personen des Mandanten — für Namen und Arbeitszeiten —, die zweite nach
   * denen, die das Fragment durchlässt.
   */
  const employees = await tx.employee.findMany({
    where: { id: { in: unique }, organizationId },
    select: {
      id: true,
      user: { select: { firstName: true, lastName: true } },
      availability: { select: { weekday: true, startTime: true, endTime: true } },
    },
  });

  const byId = new Map(employees.map((employee) => [employee.id, employee]));

  const aktiveZeilen = await tx.employee.findMany({
    where: { id: { in: unique }, ...activeStaffWhere(organizationId) },
    select: { id: true },
  });
  const aktiveIdSet = new Set(aktiveZeilen.map((zeile) => zeile.id));

  for (const employeeId of unique) {
    const employee = byId.get(employeeId);

    if (!employee) {
      conflicts.push({
        code: 'EMPLOYEE_NOT_FOUND',
        severity: 'block',
        employeeId,
        employeeName: 'Unbekannt',
        /**
         * Bewusst dieselbe Formulierung für „gibt es nicht" und „gehört zu
         * einem anderen Mandanten". Eine Meldung, die den Unterschied verrät,
         * beantwortet die Frage, ob eine fremde ID existiert.
         */
        message: 'Mindestens eine der gewählten Personen gehört nicht zum aktiven Personal.',
      });
      continue;
    }

    if (!aktiveIdSet.has(employeeId)) {
      conflicts.push({
        code: 'EMPLOYEE_NOT_ACTIVE',
        severity: 'block',
        employeeId,
        employeeName: fullName(employee),
        message: `${fullName(employee)} gehört nicht zum aktiven Personal.`,
      });
    }
  }

  const aktive = employees.filter((employee) => aktiveIdSet.has(employee.id));
  if (aktive.length === 0) return conflicts;
  const aktiveIds = aktive.map((employee) => employee.id);

  // --- 2) Abwesenheiten ----------------------------------------------------
  /**
   * `Absence.startDate` und `.endDate` sind Kalendertage (`@db.Date`), der
   * Einsatz ist ein Zeitstempel. Verglichen wird deshalb auf Tagesebene, und
   * zwar nach **Zürcher** Kalender: Ein Einsatz am 3. um 00:30 Uhr Ortszeit
   * liegt in UTC noch am 2., und eine Ferienwoche, die am 3. beginnt, würde
   * ihn sonst nicht erfassen.
   */
  const jobFirstDay = toDateOnly(scheduledStart);
  const jobLastDay = toDateOnly(scheduledEnd);

  const absences = await tx.absence.findMany({
    where: {
      employeeId: { in: aktiveIds },
      status: { in: ['APPROVED', 'REQUESTED'] },
      startDate: { lte: jobLastDay },
      endDate: { gte: jobFirstDay },
    },
    select: { employeeId: true, status: true, type: true, startDate: true, endDate: true },
  });

  const ABSENCE_LABEL: Record<string, string> = {
    VACATION: 'Ferien',
    SICK: 'Krankheit',
    ACCIDENT: 'Unfall',
    MILITARY: 'Militärdienst',
    MATERNITY: 'Mutterschaft',
    PATERNITY: 'Vaterschaft',
    UNPAID: 'unbezahlter Urlaub',
    TRAINING: 'Weiterbildung',
    PUBLIC_HOLIDAY: 'Feiertag',
    OTHER: 'Abwesenheit',
  };

  for (const absence of absences) {
    const employee = byId.get(absence.employeeId)!;
    const zeitraum = `${dayLabel(absence.startDate)}–${dayLabel(absence.endDate)}`;
    const grund = ABSENCE_LABEL[absence.type] ?? 'Abwesenheit';

    conflicts.push(
      absence.status === 'APPROVED'
        ? {
            code: 'EMPLOYEE_ABSENT',
            severity: 'block',
            employeeId: absence.employeeId,
            employeeName: fullName(employee),
            message: `${fullName(employee)} ist vom ${zeitraum} abwesend (${grund}, bewilligt).`,
          }
        : {
            code: 'ABSENCE_REQUESTED',
            severity: 'warn',
            employeeId: absence.employeeId,
            employeeName: fullName(employee),
            message: `${fullName(employee)} hat für ${zeitraum} ${grund} beantragt — noch nicht entschieden.`,
          },
    );
  }

  // --- 3) Überschneidende Einsätze -----------------------------------------
  const overlaps = await tx.jobAssignment.findMany({
    where: {
      employeeId: { in: aktiveIds },
      ...(request.ignoreJobId ? { jobId: { not: request.ignoreJobId } } : {}),
      job: {
        organizationId,
        deletedAt: null,
        status: BLOCKING_JOB_STATUS,
        // Halboffene Intervalle: Ein Einsatz von 08–11 und einer von 11–13
        // berühren sich, überschneiden sich aber nicht.
        scheduledStart: { lt: scheduledEnd },
        scheduledEnd: { gt: scheduledStart },
      },
    },
    select: {
      employeeId: true,
      job: { select: { number: true, scheduledStart: true, scheduledEnd: true } },
    },
  });

  for (const overlap of overlaps) {
    const employee = byId.get(overlap.employeeId)!;
    conflicts.push({
      code: 'ASSIGNMENT_OVERLAP',
      severity: 'block',
      employeeId: overlap.employeeId,
      employeeName: fullName(employee),
      message: `${fullName(employee)} ist zur selben Zeit für ${overlap.job.number} eingeteilt.`,
    });
  }

  // --- 4) Hinterlegte Arbeitszeit ------------------------------------------
  /**
   * Nur geprüft, wenn der Einsatz an einem einzigen Kalendertag liegt. Über
   * Mitternacht hinweg müsste die Regel zwei Wochentage zusammensetzen, und
   * das Ergebnis wäre für eine blosse Warnung zu aufwendig — Nachteinsätze
   * sind ohnehin Absprachesache.
   */
  if (jobFirstDay.getTime() === jobLastDay.getTime()) {
    const start = zurichParts(scheduledStart);
    const end = zurichParts(scheduledEnd);
    const weekday = new Date(
      Date.UTC(start.year, start.month - 1, start.day),
    ).getUTCDay();
    const startMinute = start.hour * 60 + start.minute;
    const endMinute = end.hour * 60 + end.minute;

    for (const employee of aktive) {
      const fenster = employee.availability.filter((slot) => slot.weekday === weekday);
      if (fenster.length === 0) {
        conflicts.push({
          code: 'OUTSIDE_AVAILABILITY',
          severity: 'warn',
          employeeId: employee.id,
          employeeName: fullName(employee),
          message: `Für ${fullName(employee)} ist an diesem Wochentag keine Arbeitszeit hinterlegt.`,
        });
        continue;
      }

      const passt = fenster.some((slot) => {
        const von = minutesOfDay(slot.startTime);
        const bis = minutesOfDay(slot.endTime);
        return von !== null && bis !== null && startMinute >= von && endMinute <= bis;
      });

      if (!passt) {
        conflicts.push({
          code: 'OUTSIDE_AVAILABILITY',
          severity: 'warn',
          employeeId: employee.id,
          employeeName: fullName(employee),
          message: `Der Einsatz liegt ausserhalb der hinterlegten Arbeitszeit von ${fullName(employee)}.`,
        });
      }
    }
  }

  return conflicts;
}

/**
 * Prüft und wirft, wenn etwas blockiert.
 *
 * Die Warnungen wandern in `details.warnings` mit — die Oberfläche kann sie
 * anzeigen, sie halten aber nichts auf. Geworfen wird ein
 * `BusinessRuleError` (422): Die Eingabe ist wohlgeformt, nur der Zustand
 * lässt die Zuteilung nicht zu, und eine Wiederholung mit denselben Daten
 * hätte dasselbe Ergebnis.
 *
 * `details.conflicts` trägt die maschinenlesbaren Kennungen. Sie verraten
 * nichts, was die Meldung nicht ohnehin sagt — Namen von Personen, die das
 * Büro gerade selbst ausgewählt hat, und Einsatznummern desselben Mandanten.
 */
export async function assertAssignable(
  tx: Tx | typeof prisma,
  request: EligibilityRequest,
): Promise<AssignmentConflict[]> {
  const conflicts = await checkAssignmentEligibility(tx, request);
  const blocking = conflicts.filter((conflict) => conflict.severity === 'block');

  if (blocking.length > 0) {
    // Gleiche Meldung mehrfach (zwei überschneidende Einsätze derselben
    // Person) ergibt einen Satz, nicht zwei.
    const saetze = [...new Set(blocking.map((conflict) => conflict.message))];
    throw new BusinessRuleError(saetze.join(' '), {
      conflicts: blocking,
      warnings: conflicts.filter((conflict) => conflict.severity === 'warn'),
    });
  }

  return conflicts;
}
