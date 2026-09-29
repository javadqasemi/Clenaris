# Arbeitsweise — gilt für jede Umsetzung

Diese Regel lädt Claude Code bei jedem Sitzungsbeginn (`.claude/rules/`). Sie
steht hier und nicht in `CLAUDE.md`, weil jene Datei örtliche Änderungen
trägt, die nicht überschrieben werden dürfen. Ausführlich:
`docs/CLAUDE_ENGINEERING_RULES.md`.

Für **jede** Umsetzung:

1. `docs/ENGINEERING_DEFINITION_OF_DONE.md` lesen — die Checklisten A–G sind der Massstab.
2. Zuerst die bestehende Architektur ansehen; nach einer vorhandenen Umsetzung suchen, bevor eine zweite entsteht.
3. Den ganzen Geschäftsablauf umsetzen — keine Seite, kein Knopf, keine Route ohne Schreibweg.
4. Die zutreffenden Sicherheitsprüfungen laufen lassen (Checkliste D).
5. Die Oberfläche prüfen (Checkliste E).
6. Für jeden behobenen Fehler eine Regressionsprüfung, die gegen den alten Stand scheitert.
7. `npm run verify:full` ausführen — oder sagen, welche Schritte daraus ausgelassen wurden und warum.
8. Nie „fertig" ohne Nachweis melden.
9. Unbelegte externe Nachweise getrennt melden: „EXTERNER NACHWEIS ERFORDERLICH", mit dem fehlenden Beleg.

Dazu die drei Skills unter `.claude/skills/` (seit 2026-09-28) — laden, bevor
die Arbeit beginnt:

- `security` — bei jeder Route, jedem Dienst, jeder Abfrage, Datei, jedem Token, Geld, Personendaten.
- `ui-ux` — bei jeder Änderung an Seiten, Formularen, Dialogen, Navigation, Website.
- `pendenzen` — bei jeder Umsetzung, jedem Umbau, jeder Löschung und vor jedem Commit; Register `docs/PENDENZEN.md`.

Nutzereigene, nicht eingecheckte Dateien (`CLAUDE.md`, `checklist.txt`,
eigene Berichte unter `docs/`) werden weder geändert noch eingecheckt.
