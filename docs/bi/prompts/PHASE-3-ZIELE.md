# Phase 3 — Ziele, Strategie, Roadmap

Baue die Zielführung: Strategien, Quartalsziele mit Schlüsselergebnissen und
Initiativen auf einer Zeitachse — als **ein** Modell, nicht als drei.

**Voraussetzung:** Phase 1 läuft (automatischer Fortschritt braucht
Snapshots).

**Lies zuerst** `docs/bi/01-DATENMODELL.md` Abschnitt 3,
`docs/bi/02-BERECHTIGUNGEN.md` Abschnitt 6.1, `docs/bi/03-API-UND-SEITEN.md`.

## Der tragende Gedanke

Strategie, Ziel und Initiative sind dasselbe Objekt auf drei Flughöhen:
Titel, Verantwortung, Zeitraum, Status, Fortschritt. Sie unterscheiden sich
in Reichweite und Detailgrad, nicht in Struktur. Deshalb eine Tabelle mit
`horizon` und Selbstbezug `parentId`.

**Die Roadmap ist keine eigene Entität**, sondern die Zeitachsen-Ansicht
derselben Datensätze.

Und: **Fortschritt wird gemessen, nicht gemeldet.** Ein Schlüsselergebnis
verweist wenn möglich auf eine `KpiDefinition` und rechnet daraus. Ein Feld
„Fortschritt in %", das jemand monatlich schätzt, ist der Grund, warum OKR in
kleinen Firmen nach zwei Quartalen einschläft.

## Umfang

### 1. Schema

`Objective`, `KeyResult`, `KeyResultCheckin` samt `ObjectiveHorizon`,
`ObjectiveLevel`, `ObjectiveStatus` — wörtlich aus `01-DATENMODELL.md`
Abschnitt 3. Dazu aus Abschnitt 8: Rückbeziehungen auf `Organization` und
`User`, sowie `Task.objectiveId` und der `FileScope`-Wert `OBJECTIVE`.

Die `FileScope`-Erweiterung braucht in PostgreSQL `ALTER TYPE … ADD VALUE`
in einer **eigenen** SQL-Datei vor den Spaltenanlagen — siehe
`05-MIGRATION-TESTS-BETRIEB.md` Abschnitt 1.1.

### 2. Dienst

`src/server/services/objective.service.ts`:

- **Sichtbarkeit** nach `02-BERECHTIGUNGEN.md` Abschnitt 6.1. Mit
  `objective:read` alles; mit nur `objective:read_own` die eigenen Ziele
  plus aktive Firmenziele (`level = COMPANY`, `status = ACTIVE`). Die
  Einschränkung gehört in die `where`-Klausel.
- **Fortschritt**: Mittel der Schlüsselergebnisse, gewichtet gleich.
  `Objective.progressPct` wird beim Check-in und im Nachtlauf nachgeführt —
  als Spalte, weil Liste und Zeitachse sonst je Zeile nachladen müssten.
  Bei Elternzielen das Mittel der Kinder, wenn keine eigenen
  Schlüsselergebnisse vorhanden sind.
- **Zyklusschutz**: ein Ziel darf nicht unter einen eigenen Nachfahren
  gehängt werden. `BusinessRuleError` (422), nicht 400.
- **Automatische Schlüsselergebnisse**: `currentValue` aus dem Snapshot der
  zugeordneten `KpiDefinition` und `kpiPeriod`. Fortschritt =
  `(current − start) / (target − start)`, bei `DOWN_IS_GOOD` umgekehrt, auf
  0..100 gekappt.
- **Check-in auf ein automatisches Schlüsselergebnis** → 422. Die Zahl kommt
  aus der Kennzahl; ein Handeintrag daneben wäre eine zweite Wahrheit.
- **Manuelle Schlüsselergebnisse** ohne Check-in seit 30 Tagen gelten als
  überfällig und fliessen in den Navigationszähler.

### 3. Berechtigungen

Die sechs `objective:*`-Rechte aus `02-BERECHTIGUNGEN.md`.
`MANAGER`: `read`, `update`, `checkin` — kein `create`, kein `delete`.
`EMPLOYEE`: `read_own`, `checkin`.

### 4. Endpunkte

Die acht aus `03-API-UND-SEITEN.md` Abschnitt 3, Phase 3.

`GET`-Routen mit `permissions: ['objective:read', 'objective:read_own']` und
`anyPermission: true` — die Route lässt herein, der Dienst schränkt ein.

`POST /api/bi/objectives/{id}/tasks` verlangt **beide** Rechte
(`objective:update` **und** `task:create`), also ohne `anyPermission`. Wer
ein Ziel bearbeiten darf, darf deswegen noch keine Aufgaben anlegen. Die
erzeugte Aufgabe ist eine normale `Task` mit `objectiveId` — kein zweites
Aufgabensystem.

### 5. Seiten

```
/admin/fuehrung/ziele            Baum: Strategie → Ziel → Initiative
/admin/fuehrung/ziele/[id]       Detail, Schlüsselergebnisse, Check-in-Verlauf
/admin/fuehrung/ziele/neu
/admin/fuehrung/ziele/roadmap    Zeitachse / Kanban / Kalender / Quartal
/portal/ziele                    Die eigenen Ziele (objective:read_own)
```

Auf der Baumseite Filter nach Quartal, Ebene, Bereich, Status und
Verantwortung.

**Die Ansichtswahl der Roadmap gehört in die URL** (`?ansicht=zeitachse`),
nicht in den Komponentenzustand: sonst ist ein Link auf „die Roadmap" nicht
teilbar und der Zurück-Knopf verliert die Ansicht.

Ein automatisches Schlüsselergebnis zeigt sichtbar, aus welcher Kennzahl es
rechnet und wann zuletzt. Ein manuelles ist als manuell gekennzeichnet — wer
die beiden nicht unterscheiden kann, hält eine Schätzung für eine Messung.

`/portal/ziele` ist der einzige Teil dieses Moduls, der Mitarbeitende
erreicht. Entsprechend schlicht: die eigenen Ziele, der eigene Fortschritt,
die Möglichkeit zum Check-in.

### 6. Navigation

Eintrag `Ziele und Strategie` mit `objective:read`. Zähler = Ziele mit
`nextReviewAt <= heute` plus manuelle Schlüsselergebnisse ohne Check-in seit
30 Tagen. Ohne den Zähler verrottet das Modul still.

### 7. Nachtlauf

Schritt 2 aus `05-MIGRATION-TESTS-BETRIEB.md` Abschnitt 3: automatische
Schlüsselergebnisse aktualisieren, `KeyResultCheckin` mit
`automatic = true` schreiben, `progressPct` nachführen.

### 8. Tests

`tests/api/bi-objectives.test.ts` und Fälle in
`tests/api/ownership.test.ts`:

| Fall | Erwartung |
| --- | --- |
| `EMPLOYEE` liest fremdes Ziel | 404, nicht 403 |
| `EMPLOYEE` listet Ziele | nur eigene und aktive Firmenziele |
| Ziel unter eigenen Nachfahren hängen | 422 |
| Check-in auf automatisches Schlüsselergebnis | 422 |
| Fortschritt aus zwei Schlüsselergebnissen (40 % / 80 %) | Ziel steht auf 60 % |
| `MANAGER` legt Ziel an | 403 |

404 statt 403 bei fremden Datensätzen ist Absicht: ein 403 bestätigt, dass
der Datensatz existiert.

## Fertig, wenn

- [ ] `npm run typecheck && npm run lint && npm run docs` sauber
- [ ] `npm test` grün
- [ ] Ein Ziel mit automatischem Schlüsselergebnis zeigt nach dem Nachtlauf
      den Wert aus dem Snapshot
- [ ] Roadmap in allen vier Ansichten, Ansicht steht in der URL
- [ ] `/portal/ziele` zeigt einem Mitarbeitenden nur die eigenen und die
      Firmenziele
- [ ] Deutsche Oberfläche, `ss` statt `ß`

## Nicht tun

- Keine getrennten Tabellen für Strategie, OKR und Roadmap
- Kein eigenes Aufgabensystem — `Task` benutzen
- Kein frei editierbares Prozentfeld auf automatischen Schlüsselergebnissen
- Kein Sprachmodell, das Ziele selbst anlegt oder als erreicht markiert
