-- Zwei-Faktor-Anmeldung: Wiederherstellungscodes und Bestätigungszeitpunkt
--
-- `twoFactorEnabled` und `twoFactorSecret` gab es bereits, ausgewertet wurden
-- sie nie. Was fehlte, war der Weg zurück: ohne Wiederherstellungscodes sperrt
-- ein verlorenes Telefon eine Person dauerhaft aus, und der einzige Ausweg
-- wäre ein Eingriff in die Datenbank. Genau das soll ein zweiter Faktor nicht
-- nötig machen.
--
-- Die Codes werden gehasht abgelegt (Argon2id, wie Passwörter). Im Klartext
-- wären sie zehn Ersatzpasswörter in derselben Zeile wie der zweite Faktor —
-- wer die Zeile liest, käme an beidem vorbei.

ALTER TABLE "users"
  ADD COLUMN "twoFactorRecoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "twoFactorConfirmedAt" TIMESTAMPTZ(6);
