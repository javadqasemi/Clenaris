-- Höchstens eine laufende Zeiterfassung je Person (2026-09-27, Befund N-01).
--
-- `clockIn` prüft seit heute hinter der Sperre `zeiterfassung:<employeeId>`
-- in der Transaktion, ob schon eine Erfassung läuft. Die Sperre schützt aber
-- nur Wege, die sie nehmen; ein zweiter Anlageweg, ein Skript oder eine
-- Handkorrektur ginge an ihr vorbei. Zwei laufende Erfassungen heissen
-- doppelter Lohn für dieselbe Stunde — das soll die Datenbank selbst
-- ausschliessen, wie bei der offenen Annahme je Offerte
-- (`…_offert_annahme_eindeutig`).
--
-- Ein Teilindex, den Prisma nicht ausdrücken kann: `prisma validate` sieht
-- ihn nicht, und ein späteres `migrate dev` bietet an, ihn zu entfernen —
-- nicht annehmen. Vor dem Anlegen wird der Bestand geprüft; mehrere laufende
-- Erfassungen einer Person brechen die Migration mit einer sprechenden
-- Meldung ab, statt still eine davon zu schliessen.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "time_entries" WHERE "endedAt" IS NULL
    GROUP BY "employeeId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'time_entries: Personen mit mehreren laufenden Erfassungen — erst von Hand ausstempeln';
  END IF;
END $$;

CREATE UNIQUE INDEX "time_entries_eine_laufende_je_person"
  ON "time_entries" ("employeeId")
  WHERE "endedAt" IS NULL;
