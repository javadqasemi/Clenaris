-- Kennung des Absendens einer Buchung (B-23, 2026-09-28).
--
-- Ein Doppelklick oder eine Wiederholung nach Zeitüberschreitung legte eine
-- zweite Buchung an, sobald der Termin Platz für zwei hatte. Der
-- Buchungsassistent schickt jetzt je Buchungsvorgang eine zufällige Kennung;
-- ein zweites Absenden mit derselben Kennung bekommt die erste Buchung zurück.
--
-- Additiv: neue, freiwillige Spalte; der eindeutige Index trifft nur gesetzte
-- Werte (PostgreSQL behandelt NULL als verschieden), der Bestand bleibt also
-- gültig, und die vorherige Programmfassung schreibt die Spalte schlicht nicht.
ALTER TABLE "bookings" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "bookings_organizationId_idempotencyKey_key" ON "bookings"("organizationId", "idempotencyKey");
