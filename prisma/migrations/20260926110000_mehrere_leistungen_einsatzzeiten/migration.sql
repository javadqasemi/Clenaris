-- Mehrere Leistungen je Buchung und Einsatzzeiten (Produktsprint 2026-09-26)
--
-- Nur hinzufügend. Bestehende Zeilen behalten ihre Bedeutung:
--  • `opening_hours`: ohne eigene Einsatzzeiten (beide NULL, `serviceClosed`
--    false) gelten die Öffnungszeiten weiterhin als Einsatzfenster — genau das
--    Verhalten vor dieser Migration.
--  • `booking_items.details`: NULL für alle bestehenden Buchungen; ihre
--    Angaben stehen weiterhin an der Buchung (`squareMeters`, `rooms`, …).
--    Kein Rückfüllen: Welche Angabe zu welcher Position gehörte, lässt sich
--    für eine Einzelleistung ohnehin nur von der Buchung ablesen.

-- AlterTable
ALTER TABLE "opening_hours" ADD COLUMN     "serviceClosed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "serviceClosesAt" TEXT,
ADD COLUMN     "serviceOpensAt" TEXT;

-- AlterTable
ALTER TABLE "booking_items" ADD COLUMN     "details" JSONB;
