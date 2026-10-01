/**
 * Eine Zeile des Prüfprotokolls schwärzen — der **einzige** Weg, eine
 * bestehende Zeile von `audit_logs` zu ändern (Produktion V2, 2026-09-30).
 *
 * ---------------------------------------------------------------------------
 *  Warum es diesen Weg gibt — und warum nur diesen
 * ---------------------------------------------------------------------------
 *
 * Seit `20260930120000_protokoll_nur_anfuegen` lässt die Datenbank das
 * Prüfprotokoll nur noch fortschreiben: Jedes `UPDATE`, `DELETE` und
 * `TRUNCATE` scheitert mit P0001. Eine Ausnahme braucht es trotzdem: Bis
 * zum 2026-09-23 standen Lohn, Geburtsdatum, Notfallkontakt und Adressen im
 * Klartext in `changes` (RB-010), und `scripts/audit-bereinigung.ts` schwärzt
 * diesen Altbestand nachträglich. Datenschutz geht hier der
 * Unveränderlichkeit vor.
 *
 * Die Ausnahme ist ein Schalter in der Datenbank,
 * `clenaris.audit_schwaerzung`, und er ist absichtlich eng:
 *
 *  • **Nur für die eine Änderung**: Gleich danach setzt diese Datei ihn
 *    wieder aus (Begründung bei `schwaerzenInTransaktion`).
 *  • **Nur mit `is_local = true`** (`set_config(…, true)`): Selbst wenn das
 *    Zurücksetzen ausbliebe, gälte er bis zum Ende der Transaktion und keine
 *    Anweisung länger. Auf einer Verbindung aus einem Pool bliebe ein
 *    sitzungsweiter Schalter stehen und gälte für die nächste, fremde
 *    Anfrage — genau das darf nie geschehen.
 *  • **Nur in einer Transaktion**: Ausserhalb einer Transaktion endete der
 *    lokale Schalter mit der `SELECT`-Anweisung selbst, und das `UPDATE`
 *    danach scheiterte — deshalb setzt diese Datei Schalter und Änderung
 *    immer gemeinsam.
 *  • **Nur `changes` und `summary`**: Der Trigger vergleicht die ganze Zeile
 *    ohne diese beiden Spalten. Wer, wann, welche Entität, welche Handlung —
 *    das bleibt auch mit Schalter unantastbar, und Löschen bleibt verboten.
 *
 * Warum eine eigene Datei statt der zwei Zeilen im Bereinigungsskript: Der
 * Schalter soll an genau **einer** Stelle im Repository gesetzt werden, damit
 * eine Suche nach `audit_schwaerzung` alle Wege findet, die das Protokoll
 * ändern können. Die Anwendung (`src/`) setzt ihn nie; sie legt Einträge nur
 * an (`src/lib/audit.ts`).
 *
 * `tests/api/protokoll-unveraenderlich.test.ts` prüft beides: dass der
 * Schalter wirkt und dass er ohne ihn nichts geht.
 */

import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Was geschwärzt wird. Fehlt ein Feld (`undefined`), bleibt es unverändert —
 * dieselbe Lesart wie bei Prisma. `summary: null` leert die Zusammenfassung;
 * `changes` wird nie geleert, sondern nur durch die geschwärzte Fassung
 * ersetzt.
 */
export interface Schwaerzung {
  changes?: Prisma.InputJsonValue;
  summary?: string | null;
}

/**
 * Schalter setzen, die eine Zeile schwärzen, Schalter wieder aus —
 * **innerhalb** einer bestehenden Transaktion. Für Aufrufer, die ohnehin in
 * einer Transaktion arbeiten, und für die Prüfreihe, die ihre Transaktion
 * danach zurückrollt.
 *
 * **Warum der Schalter danach sofort wieder aus ist (2026-10-01).** Bis
 * hierher blieb er bis zum Ende der Transaktion an. In `zeileSchwaerzen` ist
 * das gleichgültig — dort endet die Transaktion mit der Änderung. Wer diese
 * Funktion aber in einer grösseren Transaktion ruft, für den galt die
 * Ausnahme danach für **jede** weitere Änderung an `changes` und `summary`,
 * an jeder Zeile des Protokolls, bis zum Commit — genau die breite
 * Freigabe, die der Schalter vermeiden soll. Jetzt gilt er für die eine
 * Anweisung, für die er gesetzt wird.
 *
 * Zurückgesetzt wird auf `''` und nicht auf einen gemerkten Vorwert: Den
 * Schalter setzt im Repository nur diese Datei (das prüft
 * `protokoll-unveraenderlich.test.ts`), es gibt also keinen fremden Vorwert,
 * den es zu bewahren gälte — und „aus" ist der einzige Zustand, der danach
 * stimmen darf.
 *
 * Scheitert die Änderung, ist die Transaktion in Postgres abgebrochen und
 * nimmt keine Anweisung mehr an, auch das Zurücksetzen nicht. Dessen Fehler
 * würde den eigentlichen verdecken; er wird deshalb nur in diesem Fall
 * verschluckt — der Schalter ist mit der abgebrochenen Transaktion ohnehin
 * verloren, und ein `ROLLBACK TO SAVEPOINT` des Aufrufers nimmt ihn mit
 * zurück. Gelingt die Änderung, muss auch das Zurücksetzen gelingen; sein
 * Fehler geht dann an den Aufrufer.
 */
export async function schwaerzenInTransaktion(tx: Prisma.TransactionClient, id: string, daten: Schwaerzung): Promise<void> {
  const schalterAus = () => tx.$queryRaw`SELECT set_config('clenaris.audit_schwaerzung', '', true)`;
  await tx.$queryRaw`SELECT set_config('clenaris.audit_schwaerzung', 'on', true)`;
  try {
    await tx.auditLog.update({
      where: { id },
      data: {
        ...(daten.changes !== undefined ? { changes: daten.changes } : {}),
        ...(daten.summary !== undefined ? { summary: daten.summary } : {}),
      },
    });
  } catch (fehler) {
    await schalterAus().catch(() => undefined);
    throw fehler;
  }
  await schalterAus();
}

/** Eine Zeile schwärzen, in einer eigenen Transaktion. */
export async function zeileSchwaerzen(prisma: PrismaClient, id: string, daten: Schwaerzung): Promise<void> {
  await prisma.$transaction((tx) => schwaerzenInTransaktion(tx, id, daten));
}
