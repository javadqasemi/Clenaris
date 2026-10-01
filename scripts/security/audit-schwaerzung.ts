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
 *  • **Nur mit `is_local = true`** (`set_config(…, true)`): Er gilt bis zum
 *    Ende der Transaktion und keine Anweisung länger. Auf einer Verbindung
 *    aus einem Pool bliebe ein sitzungsweiter Schalter stehen und gälte für
 *    die nächste, fremde Anfrage — genau das darf nie geschehen.
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
 * Schalter setzen und die eine Zeile schwärzen — **innerhalb** einer
 * bestehenden Transaktion. Für Aufrufer, die ohnehin in einer Transaktion
 * arbeiten, und für die Prüfreihe, die ihre Transaktion danach zurückrollt.
 */
export async function schwaerzenInTransaktion(tx: Prisma.TransactionClient, id: string, daten: Schwaerzung): Promise<void> {
  await tx.$queryRaw`SELECT set_config('clenaris.audit_schwaerzung', 'on', true)`;
  await tx.auditLog.update({
    where: { id },
    data: {
      ...(daten.changes !== undefined ? { changes: daten.changes } : {}),
      ...(daten.summary !== undefined ? { summary: daten.summary } : {}),
    },
  });
}

/** Eine Zeile schwärzen, in einer eigenen Transaktion. */
export async function zeileSchwaerzen(prisma: PrismaClient, id: string, daten: Schwaerzung): Promise<void> {
  await prisma.$transaction((tx) => schwaerzenInTransaktion(tx, id, daten));
}
