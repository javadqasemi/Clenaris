-- Widerrufszeitpunkt für Zugangstoken.
--
-- Ein Widerruf löschte bisher nur die Refresh-Token. Das Zugangstoken ist ein
-- signiertes JWT und lässt sich nicht löschen — eine gesperrte, herabgestufte
-- oder übernommene Sitzung lief deshalb noch bis zu fünfzehn Minuten weiter.
-- Ab diesem Zeitstempel gelten alle früher ausgestellten Token als ungültig.
--
-- Bestehende Konten bleiben NULL: für sie gab es nie einen Widerruf, und ein
-- Wert von `now()` würde beim Aufspielen der Migration jede offene Sitzung
-- beenden — ein Vorgang, den niemand angeordnet hat.

ALTER TABLE "users" ADD COLUMN "sessionsRevokedAt" TIMESTAMPTZ(6);
