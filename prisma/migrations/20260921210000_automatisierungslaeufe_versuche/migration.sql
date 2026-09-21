-- Automatisierungsmaschine (Wave 6): Versuchszähler
--
-- Rein additiv: eine Spalte mit Vorgabewert. Kein DROP, kein verlustbehaftetes
-- ALTER, keine Rückfüllung nötig — vorhandene Zeilen bekommen 0, und das ist
-- die richtige Aussage: Sie wurden nie versucht.
--
-- (Genauer: Es *gibt* keine vorhandenen Zeilen. `automation_runs` wurde bis
-- Wave 6 von keinem Codepfad beschrieben — das war der Befund, der diese Wave
-- ausgelöst hat: eine Oberfläche, die Regeln anlegt, und eine Tabelle, in der
-- nie etwas landet.)
--
-- Wozu der Zähler: Ohne ihn gäbe es nur zwei Möglichkeiten für einen
-- fehlgeschlagenen Lauf, und beide sind falsch. Endgültig zu scheitern hiesse,
-- dass jede Erinnerung ausfällt, während der Mailversand eine Minute lang
-- klemmt. Ewig zu wiederholen hiesse, dass eine dauerhaft unerreichbare
-- Gegenstelle eine Schleife erzeugt, die mit jedem Vorgang länger wird.

-- AlterTable
ALTER TABLE "automation_runs" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;
