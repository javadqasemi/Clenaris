# Phase 4 — Budget, Investitionen, Szenarien

Baue die Finanzplanung: Budget mit automatischem Ist-Vergleich, ein
Anlagenverzeichnis mit Abschreibung, und Szenarien, die aus Treibern rechnen.

**Voraussetzung:** Phase 1 läuft.

**Lies zuerst** `docs/bi/01-DATENMODELL.md` Abschnitt 4,
`docs/bi/04-KENNZAHLEN.md` Abschnitte 5 bis 7,
`docs/bi/03-API-UND-SEITEN.md`.

## Die drei tragenden Gedanken

**Budgetzeilen hängen an `ExpenseCategory`.** Die im Auftrag gewünschten
Budgets bilden das bestehende Enum bereits ab: Marketing → `MARKETING`,
Personal → `SALARY` + `SOCIAL_SECURITY`, Fahrzeuge → `VEHICLE` + `FUEL`,
Büro → `RENT`, Software → `SOFTWARE`, Versicherung → `INSURANCE`,
Schulung → `TRAINING`, Ausrüstung → `EQUIPMENT`. Damit kommt die Ist-Spalte
gratis aus `Expense`. Eine eigene Budgetkategorienlogik hiesse, jede Ausgabe
zweimal zuzuordnen — und ab der ersten falschen Zuordnung stimmen
Budgetbericht und Buchhaltung nicht mehr überein.

**Investitionen sind zugleich das Anlagenverzeichnis.** Fahrzeuge und
Maschinen fehlen im Schema vollständig; sie kommen nur als Ausgabenkategorie
vor. Diese Tabelle schliesst die Lücke und erledigt damit den Punkt „Asset
Management" aus dem Auftrag ohne ein zweites Modell.

**Szenarien speichern Treiber, nicht Ergebnisse.** Handgetippte
Ergebniszahlen sind nach der ersten Änderung einer Annahme in sich
widersprüchlich — und niemand merkt es, weil beide Zahlen plausibel aussehen.

## Umfang

### 1. Schema

`BudgetPeriod`, `BudgetLine`, `Investment`, `Scenario`,
`ScenarioAssumption` samt `BudgetStatus`, `InvestmentStatus`,
`DepreciationMethod`, `ScenarioKind` — wörtlich aus `01-DATENMODELL.md`
Abschnitt 4. Dazu aus Abschnitt 8: Rückbeziehungen auf `Organization`,
`User` (`InvestmentOwner`), `Supplier`, sowie der `FileScope`-Wert
`INVESTMENT`.

Zu `BudgetLine.monthlyPlan`: Prisma bildet `Decimal[]` auf
`numeric(12,2)[]` ab; die Länge prüft die Datenbank nicht. Genau zwölf
Einträge erzwingt das Zod-Schema, und der Dienst füllt beim Anlegen mit
`plannedAmount / 12` vor.

### 2. Budget

`src/server/services/budget.service.ts`, Abweichungsrechnung nach
`04-KENNZAHLEN.md` Abschnitt 7.

**Der anteilige Plan ist der Punkt.** Jahresplan gegen Ist von vier Monaten
zu stellen meldet im April überall eine gewaltige Unterschreitung und
trainiert alle darauf, die Abweichungsspalte zu übersehen. Verglichen wird
`Σ monthlyPlan[0..aktueller Monat]` gegen das Ist desselben Zeitraums.

Die Hochrechnung gilt erst ab drei verstrichenen Monaten; davor zeigt die
Oberfläche „—". Zwei Monate mal sechs ist Rauschen.

Genehmigen friert die Planwerte ein: danach `BusinessRuleError` (422) auf
jede Änderung an `plannedAmount`, Nachträge laufen über `revisedAmount`.
Zweimal genehmigen → 422. Die Genehmigung schreibt in den `AuditLog` — das
Einfrieren ist eine Handlung, die später jemand nachvollziehen muss.

### 3. Investitionen

`src/server/services/investment.service.ts`, Abschreibung nach
`04-KENNZAHLEN.md` Abschnitt 6.

Linear und degressiv, pro rata temporis auf Monate genau im ersten und
letzten Jahr. `method = NONE` für Dinge ohne Abnutzung. Fehlende
`usefulLifeYears` bei `STRAIGHT_LINE` oder `DECLINING` → 422, keine stille
Null.

**Gerechnet, nicht gespeichert.** Aus Anschaffungswert, Restwert,
Nutzungsdauer, Methode und Inbetriebnahme ergibt sich der Restwert zu jedem
Stichtag eindeutig. Eine Buchungstabelle wäre erst nötig, wenn die
Abschreibung ins Rechnungswesen gebucht würde — dann gehört sie dorthin.

Das Verzeichnis zeigt je Position Anschaffungswert, kumulierte Abschreibung,
Restwert und Restnutzungsdauer.

### 4. Szenarien

`src/server/services/scenario.service.ts` nach `04-KENNZAHLEN.md`
Abschnitt 5. Monatsweise über `horizonMonths`, acht Treiber.

Abgeleitet: Break-even-Monat, **Liquiditätstiefpunkt samt Monat**, benötigte
Mitarbeitende, benötigte Kundschaft. Der Tiefpunkt ist die eigentlich
interessante Zahl — ein Szenario mit gutem Jahresergebnis kann im vierten
Monat zahlungsunfähig sein.

Unbekannter Annahmeschlüssel → Fehler, nicht stillschweigend übergehen.
Szenario ohne Annahmen rechnen → 422.

Das Ergebnis geht mit Rechenweg als `Scenario.result` in die Datenbank. Ein
Szenario, das bei jedem Öffnen neu rechnet, zeigt andere Zahlen als die
Fassung, über die in der Sitzung gesprochen wurde.

**Vorbelegung aus dem Ist**: beim Anlegen schlägt der Dienst die Treiber aus
den letzten zwölf Monaten vor. Ein leeres Formular mit acht Zahlenfeldern
füllt niemand aus.

### 5. Berechtigungen

`budget:*` (fünf), `investment:*` (vier), `scenario:*` (zwei) aus
`02-BERECHTIGUNGEN.md`. **`MANAGER` bekommt keines davon** — Budget,
Investitionen und Szenarien sind Geschäftsleitungsentscheidungen, dieselbe
Linie wie bei Preisen und Website.

`PERMISSION_ROUTES` ergänzen: `/admin/fuehrung/budget`,
`/admin/fuehrung/investitionen`, `/admin/fuehrung/szenarien` — **vor** dem
Präfix `/admin/fuehrung`, der erste Treffer gewinnt.

### 6. Endpunkte und Seiten

Die vierzehn Endpunkte aus `03-API-UND-SEITEN.md` Abschnitt 3, Phase 4.

```
/admin/fuehrung/budget              Perioden
/admin/fuehrung/budget/[id]         Zeilen, Plan / Ist / Abweichung / Hochrechnung
/admin/fuehrung/investitionen
/admin/fuehrung/investitionen/[id]  inkl. Abschreibungsplan
/admin/fuehrung/szenarien           Vergleich Best / Erwartet / Schlecht
/admin/fuehrung/szenarien/[id]      Annahmen und Rechnung
```

Auf der Szenarioseite rechnet die Änderung einer Annahme sofort neu — das
ist der eine Ort in diesem Modul, an dem React Query richtig ist (es ändert
sich etwas, während jemand zuschaut). Alles andere liest im Server
Component.

Die Vergleichsseite stellt die drei Szenarien nebeneinander: Umsatz,
Ergebnis, Liquiditätsverlauf, Break-even, Tiefpunkt.

### 7. Tests

`tests/api/bi-budget.test.ts`, `bi-investments.test.ts`,
`bi-scenarios.test.ts` mit den handgerechneten Prüffällen aus
`05-MIGRATION-TESTS-BETRIEB.md` Abschnitt 2.1:

- linear: 24 000 / 4 Jahre / Restwert 0 → nach 18 Monaten 15 000
- degressiv: 20 000, Restwert 2 000, 5 Jahre → Satz 36.9 %, nach 1 Jahr 12 620
- Break-even: Fixkosten 8 000, DB-Quote 45 %, Umsatz 15 000/Mt → Monat 2
- Abweichung: Plan 12 000/Jahr, Ist 5 200 nach 4 Monaten → +1 200 (30 %)
- `MANAGER` auf `/api/bi/budgets` → 403
- Änderung an genehmigtem Budget → 422

## Fertig, wenn

- [ ] `npm run typecheck && npm run lint && npm run docs` sauber
- [ ] `npm test` grün
- [ ] Budget zeigt Ist-Werte aus den Demo-`Expense`-Datensätzen, ohne dass
      jemand etwas zugeordnet hat
- [ ] Abweichung vergleicht anteilig, nicht Jahresplan gegen Teiljahr
- [ ] Abschreibungsplan stimmt gegen die Handrechnung
- [ ] Szenariovergleich zeigt Liquiditätstiefpunkt mit Monat
- [ ] `MANAGER` sieht keinen der drei Menüpunkte
- [ ] Deutsche Oberfläche, `ss` statt `ß`

## Nicht tun

- Keine eigene Budgetkategorien-Tabelle
- Keine Abschreibungsbuchungen speichern
- Keine handgetippten Szenarioergebnisse
- Kein Sprachmodell für die Umsatzprognose — plausibel ist hier das
  Gefährliche
- Kein `prisma migrate reset`
