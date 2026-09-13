# Phase 7 — Zeitgesteuerte Berichte und KI-Fähigkeiten

Baue die Berichtserzeugung auf der vorhandenen PDF- und Export-Schicht, und
ergänze die KI-Fähigkeiten für das Führungsmodul.

**Voraussetzung:** Phasen 1 bis 4 laufen — ohne Kennzahlen, Ziele und Budget
hat ein Bericht nichts zu berichten.

**Lies zuerst** `docs/bi/01-DATENMODELL.md` Abschnitt 7,
`docs/bi/03-API-UND-SEITEN.md` Abschnitt „KI-Fähigkeiten",
`docs/bi/05-MIGRATION-TESTS-BETRIEB.md` Abschnitt 4.4.

## Umfang

### 1. Schema

`ReportSchedule`, `ReportRun` samt `ReportKind`, `ReportCadence`,
`ReportFormat` — wörtlich aus `01-DATENMODELL.md` Abschnitt 7, mit
Rückbeziehungen auf `Organization` und `FileAsset` sowie dem
`FileScope`-Wert `REPORT`.

### 2. Berichtserzeugung

`src/server/services/bi-report.service.ts`.

**Auf dem Vorhandenen aufbauen, nichts Neues erfinden:**

- PDF über `src/lib/pdf/render.ts` und `documents.tsx` — dieselbe Schicht,
  die Offerten und Rechnungen erzeugt, damit Berichte wie die übrigen
  Dokumente der Firma aussehen
- Excel über die Bausteine aus `src/server/services/export.service.ts`
- Versand über `src/lib/email/client.ts` und `templates.ts`

Je `ReportKind` eine Zusammenstellung aus Snapshots, Zielen,
Budgetabweichung und Insights des Zeitraums. Kein neuer Rechenkern: die
Zahlen stehen in den Snapshots, und ein Bericht, der eigene Zahlen rechnet,
weicht vom Cockpit ab.

**Die Datei bleibt liegen** (`ReportRun.fileAssetId`). Ein Bericht, der bei
jedem Öffnen neu gerechnet wird, zeigt andere Zahlen als die Fassung, die
verschickt wurde — und die verschickte ist die, über die gesprochen wird.

DOCX nur, wenn ohne neue Abhängigkeit machbar; sonst PDF und XLSX und die
Word-Option später. Ein Format, das nicht verlässlich erzeugt wird, ist
schlimmer als eines weniger.

### 3. Zeitplan

`nextRunAt` aus `cadence` und `runOnDay` berechnen. Fälligkeit prüft
Schritt 6 des Nachtlaufs (`05-MIGRATION-TESTS-BETRIEB.md` Abschnitt 3) —
**kein eigener Scheduler**: eine zweite Zeitquelle hätte eigene
Ausfallarten, und `/api/cron/daily` ist über `defineCronRoute` und
`CRON_SECRET` bereits abgesichert.

Eine fehlgeschlagene Erzeugung setzt `status = FAILED` mit Fehlertext und
blockiert den nächsten Lauf nicht.

### 4. KI-Fähigkeiten

**Kein neuer Endpunktbaum.** Die sieben Fähigkeiten aus
`03-API-UND-SEITEN.md` kommen in `src/lib/ai/features.ts` und laufen über
`/api/ai/*` mit dem bestehenden Recht `ai:use`.

Alle liefern **Entwürfe**. Keine schreibt in `Objective`, `RiskEntry`,
`BudgetLine` oder `AnalysisBoard`. Die Anwendung zieht dieses Muster schon
durch — `quote-draft`, `blog-draft`, `reply-draft`, `report/draft`. Ein
Modell, das ein Risiko selbst als mitigiert markiert, ist eine
Auditfeststellung, keine Funktion.

Zwei harte Regeln aus dem Datenschutzteil:

- **Keine Personaldaten in Modellaufrufen.** `bi.quarterlyReview` bekommt
  aggregierte Kennzahlen, keine Namen. `bi.meetingMinutes` bekommt die
  Notizen, die jemand bewusst eingibt.
- **Umsatzprognose und Risikovorhersage laufen nicht über ein
  Sprachmodell.** Sie kommen aus `scenario.service.ts` und dem Trend über
  Snapshots. Ein Modell nennt eine plausible Zahl — und plausibel ist hier
  das Gefährliche.

Ohne `ANTHROPIC_API_KEY` ist die Funktion abgeschaltet, nicht fehlerhaft —
so verhalten sich alle optionalen Dienste in dieser Anwendung.

### 5. Endpunkte und Seite

Die vier Endpunkte aus `03-API-UND-SEITEN.md` Abschnitt 3, Phase 7.

`/admin/fuehrung/berichte`: Zeitpläne oben, erzeugte Berichte darunter mit
Zeitraum, Format, Status und Download. Schaltfläche für einen
ausserplanmässigen Bericht.

Der Download prüft `bireport:read` **und** lädt über den Dienst, nicht über
den Speicherpfad — ein Führungsbericht enthält Zahlen, die nicht alle sehen
sollen.

### 6. Tests

`tests/api/bi-reports.test.ts`:

- Zeitplan `MONTHLY`, `runOnDay = 1` → `nextRunAt` ist der Erste des
  Folgemonats
- Ausserplanmässige Erzeugung liefert einen `ReportRun` mit
  `status = READY` und einer Datei
- Fehlgeschlagene Erzeugung setzt `FAILED` mit Text und blockiert nicht
- `MANAGER` auf `/api/bi/reports` → 403
- Download ohne `bireport:read` → 403

## Fertig, wenn

- [ ] `npm run typecheck && npm run lint && npm run docs` sauber
- [ ] `npm test` grün
- [ ] Ein Monatsbericht als PDF sieht aus wie die übrigen Dokumente der Firma
- [ ] Die Zahlen im Bericht stimmen mit dem Cockpit überein
- [ ] Der Nachtlauf erzeugt einen fälligen Bericht ohne Handgriff
- [ ] Ohne `ANTHROPIC_API_KEY` ist die KI-Funktion abgeschaltet, nicht kaputt
- [ ] Deutsche Oberfläche, `ss` statt `ß`

## Nicht tun

- Kein eigener Scheduler
- Keine eigene Rechenlogik im Bericht — Snapshots lesen
- Kein Bericht, der bei jedem Öffnen neu rechnet
- Keine Namen von Mitarbeitenden in Modellaufrufen
- Keine Prognose aus einem Sprachmodell
