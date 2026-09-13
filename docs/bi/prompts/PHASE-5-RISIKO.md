# Phase 5 — Risiko, Qualität, Compliance

Baue das Risikoregister, die Kontrollen (Abläufe, Qualitätsstandards,
Compliance-Pflichten, Notfallpläne) und die Massnahmen.

**Unabhängig von den anderen Phasen.**

**Lies zuerst** `docs/bi/01-DATENMODELL.md` Abschnitt 5,
`docs/bi/03-API-UND-SEITEN.md`.

## Der tragende Gedanke

Reinigungsstandards, interne Abläufe, Compliance-Pflichten und Notfallpläne
sind strukturell **dasselbe**: eine Anforderung, ein Verantwortlicher, ein
Prüfzyklus, ein Nachweis. Vier Tabellen dafür bedeuteten vier Listen, vier
Masken und vier Prüfzyklen, die einzeln einschlafen. Das Enum `ControlKind`
trennt sie in der Ansicht; das Modell hält sie zusammen.

Damit deckt diese Phase ISO 9001, DSG/DSGVO-Compliance, Arbeitsrecht,
Vertragsfristen und Notfallplanung mit einem Modell ab.

## Umfang

### 1. Schema

`RiskEntry`, `ControlEntry`, `CorrectiveAction` samt `RiskCategory`,
`RiskStatus`, `ControlKind`, `ControlStatus`, `ActionKind` — wörtlich aus
`01-DATENMODELL.md` Abschnitt 5. Dazu aus Abschnitt 8: Rückbeziehungen auf
`Organization`, `User` (`RiskOwner`, `ControlOwner`), `Review`, `Task`,
sowie die `FileScope`-Werte `RISK` und `CONTROL`.

### 2. Dienst

`src/server/services/governance.service.ts`:

- **`severity` setzt der Dienst**, bei jedem Schreibvorgang, aus
  `probability × impact`. In **einer** Funktion, damit es keine zweite
  Rechnung geben kann. Als gespeicherte Spalte, weil Matrix und Sortierung
  nach Schwere sonst im Anwendungscode sortieren müssten — und die
  seitenweise Ausgabe wäre damit falsch.
- **Netto getrennt von brutto.** `residualSeverity` aus
  `residualProbability × residualImpact`. Die Wirkung einer Massnahme ist
  nur sichtbar, wenn danebensteht, wie es ohne sie aussähe.
- **Prüfung abschliessen** (`POST …/review`) setzt `lastReviewedAt` auf
  heute und `nextReviewAt` auf heute + `reviewIntervalDays`. Für Risiken und
  Kontrollen dieselbe Funktion, sonst driften die Zyklen auseinander.
- **Massnahme mit Aufgabe.** Wird eine `CorrectiveAction` mit Frist und
  Zuweisung angelegt, entsteht eine `Task` (`CorrectiveAction.taskId`).
  Erinnerung, Benachrichtigung und Pendenzenliste sind dort gelöst; ein
  zweites System hiesse zwei Listen, von denen eine übersehen wird.
- **Wirksamkeitsprüfung.** `effectivenessCheckedAt` ist der Schritt, der bei
  CAPA am häufigsten fehlt. Eine abgeschlossene Massnahme ohne
  Wirksamkeitsprüfung erscheint in der Liste als offen gekennzeichnet.

### 3. Berechtigungen

`risk:*` (vier), `control:*` (vier), `action:*` (drei).
`MANAGER` bekommt `control:read` und alle drei `action:*` — Massnahmen
gehören ins Tagesgeschäft. Kein Zugriff aufs Risikoregister.

`PERMISSION_ROUTES`: `/admin/fuehrung/risiken`,
`/admin/fuehrung/qualitaet` — vor dem Präfix `/admin/fuehrung`.

### 4. Endpunkte und Seiten

Die neun Endpunkte aus `03-API-UND-SEITEN.md` Abschnitt 3, Phase 5.

```
/admin/fuehrung/risiken          Register + 5×5-Matrix
/admin/fuehrung/risiken/[id]
/admin/fuehrung/qualitaet        Kontrollen, gefiltert nach Art
/admin/fuehrung/qualitaet/[id]
/admin/fuehrung/massnahmen       CAPA quer über alle Quellen
```

**Die Risikomatrix** ist ein 5×5-Raster, Eintrittswahrscheinlichkeit gegen
Auswirkung, mit der Anzahl Risiken je Feld. Ein Klick filtert das Register.
Brutto und netto umschaltbar — die Bewegung zwischen beiden ist das, was das
Bild aussagekräftig macht.

Farben: die Ampel muss auch ohne Farbsehen lesbar sein. Zusätzlich zur Farbe
die Zahl und eine Beschriftung; ein rein farbcodiertes Raster ist ein
Zugänglichkeitsfehler.

Die Massnahmenseite zeigt Massnahmen aus allen drei Quellen (Risiko,
Kontrolle, Reklamation) in einer Liste — das ist der Ort, an dem man sieht,
was tatsächlich offen ist.

### 5. Navigation

`Risiken` mit Zähler = Risiken und Kontrollen mit `nextReviewAt <= heute`.
`Qualität und Abläufe` ohne Zähler.

Der Zähler ist der Grund, warum dieses Modul nicht einschläft. Ohne ihn steht
ein Risikoregister von 2026 im Jahr 2028 unverändert da und sieht gepflegt
aus.

### 6. Nachtlauf

Schritt 4 aus `05-MIGRATION-TESTS-BETRIEB.md` Abschnitt 3: fällige
Prüfungen melden — **eine gebündelte Benachrichtigung je verantwortlicher
Person**, nicht eine je Eintrag. Sieben einzelne Meldungen am selben Morgen
sind der sicherste Weg, dass alle sieben ignoriert werden.

### 7. Tests

`tests/api/bi-governance.test.ts`:

- `probability = 4`, `impact = 5` → `severity = 20`
- Prüfung abschliessen bei `reviewIntervalDays = 90` → `nextReviewAt` liegt
  90 Tage später
- Massnahme mit Frist erzeugt eine `Task` mit derselben Frist
- Matrix zählt korrekt über alle 25 Felder
- `MANAGER` auf `/api/bi/risks` → 403
- `MANAGER` auf `/api/bi/actions` → 200

## Fertig, wenn

- [ ] `npm run typecheck && npm run lint && npm run docs` sauber
- [ ] `npm test` grün
- [ ] Matrix ist ohne Farbsehen lesbar
- [ ] Eine Massnahme erscheint in der normalen Aufgabenliste unter
      `/admin/aufgaben`
- [ ] Der Navigationszähler springt an, wenn ein `nextReviewAt` in der
      Vergangenheit liegt
- [ ] Leerzustand erklärt, wozu ein Risikoregister da ist, und nicht
      „Keine Daten"
- [ ] Deutsche Oberfläche, `ss` statt `ß`

## Nicht tun

- Keine getrennten Tabellen für SOP, Qualität, Compliance und Notfall
- Kein eigenes Aufgabensystem
- Keine automatische Schwere-Neuberechnung im Client — nur im Dienst
- Kein Sprachmodell, das ein Risiko als mitigiert markiert. Es darf Risiken
  **vorschlagen** (`bi.suggestRisks`), ein Mensch legt sie an
