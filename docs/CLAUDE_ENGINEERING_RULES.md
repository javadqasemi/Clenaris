# Arbeitsregeln für Claude Code in diesem Repository

> Stand: 27. September 2026. Ergänzt `CLAUDE.md`, ersetzt es nicht.
> `CLAUDE.md` beschreibt das Projekt; diese Datei beschreibt, **wie** eine
> Änderung daran entsteht. Sie ist eine eigene, eingecheckte Datei, weil
> `CLAUDE.md` örtliche Änderungen trägt, die nicht überschrieben werden
> dürfen.
>
> **Wie sie wirkt:** Die Kurzfassung steht in `.claude/rules/engineering.md`.
> Claude Code lädt jede Datei unter `.claude/rules/` ohne `paths`-Angabe bei
> jedem Sitzungsbeginn — zusätzlich zu `CLAUDE.md`, ohne sie anzufassen.

## Für jede Umsetzung — ohne Ausnahme

1. **`docs/ENGINEERING_DEFINITION_OF_DONE.md` lesen.** Die Checklisten A–G
   sind der Massstab; „fertig" heisst: jeder zutreffende Punkt mit Nachweis.
2. **Zuerst die bestehende Architektur ansehen.** Nach einer vorhandenen
   Umsetzung suchen, bevor eine zweite entsteht; die Quelle der Wahrheit
   bestimmen (Preis, Saldo, Zuteilung, Kalendertag, Rechte).
3. **Den ganzen Geschäftsablauf umsetzen** — Modell, Dienst, Route, Schema,
   Oberfläche, Rechte, Prüfprotokoll, nachgelagerte Abläufe. Eine Seite oder
   ein Knopf ohne Schreibweg ist keine Funktion.
4. **Die zutreffenden Sicherheitsprüfungen laufen lassen** — Checkliste D;
   Mandant, Rechte, Eigentum in der Abfrage, Nebenläufigkeit, Idempotenz.
5. **Die Oberfläche prüfen** — Checkliste E; Rolle, Navigation, Telefon,
   Tastatur, Lade-, Leer-, Fehler- und Erfolgszustand.
6. **Regressionsprüfungen hinzufügen** — für jeden behobenen Fehler eine, die
   gegen den alten Stand scheitert (Fehlerregel in der Definition of Done).
7. **`npm run verify:full` ausführen** — oder, wo der Rahmen fehlt, die
   einzelnen Schritte daraus, und sagen, welche ausgelassen wurden.
8. **Nie „fertig" ohne Nachweis melden.** Ein grüner Typcheck ist kein
   Nachweis für eine Geschäftsregel; eine Prüfung, die nicht gelaufen ist,
   ist nicht grün.
9. **Unbelegte externe Nachweise getrennt melden** — als „EXTERNER NACHWEIS
   ERFORDERLICH", mit dem genauen fehlenden Beleg. Nie als geprüft.

## Was dabei nie geschieht

- Keine Prüfung abschwächen, keinen erwarteten Wert an einen Fehler
  anpassen, keine Prüfung überspringen, weil der Zeitpunkt ungünstig ist.
- Keine Änderung an nutzereigenen, nicht eingecheckten Dateien
  (`CLAUDE.md`, `checklist.txt`, eigene Berichte unter `docs/`).
- Kein `prisma migrate reset`, kein Push auf `main`, kein erzwungener Push,
  keine Auslieferung ohne ausdrücklichen Auftrag.
- Keine KI-Zuschreibung in Commits oder Pull Requests.
