-- Bewegliche Feiertage sind nicht „jedes Jahr am selben Kalendertag"
-- (2026-09-26).
--
-- Der Seed legte Karfreitag, Ostermontag, Auffahrt und Pfingstmontag mit
-- `recurring = true` an. Seit die Verfügbarkeit wiederkehrende Feiertage auch
-- in Folgejahren sperrt (Produktsprint 2026-09-26), sperrte der Pfingstmontag
-- 2026 jeden 25. Mai — 2027 einen gewöhnlichen Dienstag. Diese vier hängen an
-- Ostern und gelten nur im Jahr ihres Datums; der Seed rechnet sie jetzt je
-- Jahr.
--
-- Nur Datenkorrektur, keine Schemaänderung. Trifft ausschliesslich die vier
-- Namen der Osterfeiertage; von Hand angelegte Feiertage mit anderen Namen
-- bleiben unberührt.
UPDATE "holidays"
   SET "recurring" = false
 WHERE "recurring" = true
   AND "name" IN ('Karfreitag', 'Ostermontag', 'Auffahrt', 'Pfingstmontag');
