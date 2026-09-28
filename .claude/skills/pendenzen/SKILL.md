---
name: pendenzen
description: Sicheres Ändern in Clenaris — vor jeder Änderung Bestand, Verbraucher, APIs, Beziehungen, Prüfungen, Oberfläche, Folgeabläufe, Sicherheit und Migration klären; nichts still löschen; kleine fachliche Commits; vor dem Commit Löschungen und sinkende Kennzahlen prüfen; jeden gefundenen Punkt im Register docs/PENDENZEN.md führen. Laden bei jeder Umsetzung, jedem Umbau, jeder Löschung und jedem Commit.
---

# Pendenzen und sicheres Ändern

Clenaris ist gross (über 160 Seiten, über 370 Routen, über 150 Modelle). Eine
Änderung, die „nur schnell" etwas umbaut, bricht leicht einen Weg, den niemand
im Blick hatte. Dieser Skill verhindert das mit vier Gewohnheiten: vorher
suchen, nichts still löschen, klein committen, vor dem Commit nachzählen.

## 1. Vor jeder Änderung

- [ ] Bestehende Umsetzung gesucht (`Grep` über `src/server/services`,
      `src/lib`, `src/features`, `src/components`) — gibt es das schon?
- [ ] Verbraucher gesucht: Wer importiert die Funktion, die Komponente, das
      Schema, die Konstante? (Auch `scripts/`, `prisma/`, `tests/`.)
- [ ] APIs gesucht: Welche Routen rufen den Dienst? Welche Einträge in
      `scripts/openapi-routes*.ts`?
- [ ] DB-Beziehungen: Welche Modelle hängen daran (`onDelete`, Teilindizes,
      Trigger in Migrationen)?
- [ ] Prüfungen gesucht: `tests/README.md` sagt, welche Datei welches
      Merkmal abdeckt.
- [ ] Oberflächenverbraucher: Seiten und Formulare, die das Feld zeigen oder
      senden.
- [ ] Folgeablauf: Automation, PDF, E-Mail, Kennzahlen, Export, Suche,
      Scanner.
- [ ] Sicherheit: Skill `security`.
- [ ] Migration nötig? Additiv? Rückfüllung? Handgeschriebenes SQL, das
      `migrate dev` verwerfen würde? Nie `prisma migrate reset`.
- [ ] Rückwärtsverträglich? Alte Links, alte Datensätze, laufende Sitzungen,
      bereits ausgestellte Belege.

## 2. Nichts still löschen

Nicht löschen ohne Inventar, Begründung, angepasste Prüfung und geprüfte
Verträglichkeit: Dateien, Routen, Modelle, Spalten, Rechte,
Navigationseinträge, API-Felder, Enum-Werte.

Vorgehen, wenn etwas wegmuss:
1. Alle Referenzen auflisten (Code, Prüfungen, Doku, OpenAPI-Register, Seeds).
2. Grund im Commit nennen.
3. Prüfungen anpassen, **ohne** eine Zusicherung zu schwächen.
4. Bei DB: erst unbenutzt machen, dann in einer späteren Migration entfernen
   (Erweitern → Umschalten → Rückbau; `npm run migration:vertraeglichkeit`).

## 3. Kleine fachliche Commits

- Ein Commit = eine fachliche Aussage (ein Befund, ein Merkmal, ein Umbau).
- Kein Sammel-Refactor „nebenbei". Kein Suchen-und-Ersetzen über viele
  Dateien ohne anschliessende Durchsicht jedes Treffers.
- Nur ausdrücklich genannte Pfade stagen (`git add -- <pfad>`), nie `git add -A`.
  Nie mitcommitten: `CLAUDE.md`, `checklist.txt`, eigene Berichte unter
  `docs/` (siehe `.claude/rules/engineering.md`), von `next dev` umgeschriebenes
  `tsconfig.json`.
- Commit-Nachricht auf Deutsch; keine KI-Zuschreibung.

## 4. Vor dem Commit nachzählen

```powershell
git diff --cached --stat
git diff --cached --diff-filter=D --name-only   # gelöschte Dateien
```

- **Jede unerwartete Löschung: diese Änderung anhalten, Datei wiederherstellen,
  Ursache klären.** Die Mission läuft mit dem nächsten Punkt weiter.
- Kennzahlen: `npm run docs` (Routen, OpenAPI, ERD, `scripts/kennzahlen.ts`)
  und `npm run audit:merkmale`. Sinkt die Zahl der Seiten, Routen,
  API-Operationen, Modelle, Rechte oder Merkmale, braucht das eine Erklärung
  im Commit — kein „grün" ohne sie.
- Dateien mit Write/Edit schreiben, nicht per Shell-Umleitung (BOM,
  Steuerzeichen — PowerShell 5.1 `-Encoding utf8` schreibt ein BOM).

## 5. Register `docs/PENDENZEN.md`

Jeder Punkt, der in einer Arbeit auftaucht — Befund, neuer Fehler, offene
Frage —, bekommt eine Zeile: ID, Bereich, Aufgabe, Priorität, Status, Beleg,
Prüfung, Commit, externe Abhängigkeit.

Status: `OPEN` · `IN PROGRESS` · `CODE COMPLETE` · `VERIFIED` ·
`EXTERNAL EVIDENCE REQUIRED` · `CLOSED`.

**Kein Punkt verschwindet.** Ein erledigter Punkt wechselt den Status und
bekommt Beleg und Commit; gelöscht wird keine Zeile. Ein Punkt, der nicht
behoben wird, steht mit Begründung da.

## 6. Prüfungen nicht schwächen

Nie, um grün zu werden: Wiederholungen erhöhen, `skip` einfügen, Zusicherungen
entfernen, Fehler filtern, Zeitgrenzen willkürlich erhöhen, Prüfbestand so
ändern, dass der Fehler nicht mehr erreichbar ist. Eine Prüfung, die ein
falsches Verhalten festschreibt, wird mit Begründung korrigiert — die
Erwartung folgt der Geschäftsregel, nicht dem heutigen Code.
