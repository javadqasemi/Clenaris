# Datenmodell

Vollständige Prisma-Erweiterung, nach Phasen geordnet. Die Blöcke sind so
geschrieben, dass sie ans Ende von `prisma/schema.prisma` kopiert werden
können; die Rückbeziehungen auf `Organization`, `User` und `Task` sind in
Abschnitt 8 gesammelt, weil sie *bestehende* Modelle anfassen.

Konventionen, die überall gelten und aus dem bestehenden Schema stammen:
`cuid()`-Schlüssel, `organizationId` auf jedem mandantenbezogenen Modell,
`Decimal(12,2)` für Beträge, `@db.Timestamptz(6)` für Zeitpunkte,
`@db.Date` für Kalendertage, `@@map` auf `snake_case`-Plural,
`deletedAt` nur dort, wo der Papierkorb greifen soll.

---

## 1. Phase 1 — Kennzahlmaschine

```prisma
/// Wie eine Kennzahl gelesen wird. Entscheidet über Formatierung *und* über
/// die Richtung, in die „besser" zeigt — ohne das steht bei der Stornoquote
/// ein grüner Pfeil nach oben.
enum KpiUnit {
  CURRENCY // CHF, zwei Nachkommastellen
  PERCENT // 0..100
  COUNT // ganze Stück
  DAYS
  HOURS
  RATIO // z. B. 1.4 Aufträge je Kundschaft
}

enum KpiDirection {
  UP_IS_GOOD
  DOWN_IS_GOOD
}

enum KpiPeriod {
  DAY
  WEEK
  MONTH
  QUARTER
  YEAR
}

/// Herkunft eines Kennzahlwerts.
///
/// `DERIVED` heisst: eine Funktion in `kpi.service.ts` rechnet ihn aus dem
/// Datenbestand. `MANUAL` heisst: jemand trägt ihn ein — für Zahlen, die die
/// Anwendung nicht kennen kann (Google-Bewertungsschnitt, Website-Sitzungen).
/// Die Unterscheidung steht in der Oberfläche, damit niemand eine getippte
/// Zahl für eine gemessene hält.
enum KpiSource {
  DERIVED
  MANUAL
}

/// Definition einer Kennzahl.
///
/// Der `key` ist die Brücke zum Code: `kpi.service.ts` führt eine Registry
/// `Record<string, KpiCalculator>`, und `DERIVED`-Definitionen ohne Eintrag
/// dort sind ein Konfigurationsfehler, den der Nachtlauf meldet statt still
/// eine Null zu schreiben.
///
/// Warum die Definition in der Datenbank steht und nicht nur im Code: die
/// Administration soll Zielwerte ändern, Kennzahlen ausblenden und eigene
/// manuelle Kennzahlen anlegen können, ohne dass jemand ausliefert.
model KpiDefinition {
  id             String @id @default(cuid())
  organizationId String

  /// Technischer Schlüssel, z. B. `revenue.net`. Stabil — er steht in
  /// Snapshots und in Key Results.
  key         String
  label       String
  description String?
  group       String       @default("Finanzen")
  unit        KpiUnit      @default(CURRENCY)
  direction   KpiDirection @default(UP_IS_GOOD)
  source      KpiSource    @default(DERIVED)

  /// Perioden, für die der Nachtlauf Snapshots schreibt.
  periods KpiPeriod[] @default([MONTH])

  /// Zielwert und Warnschwelle. Beide optional: nicht jede Kennzahl hat ein
  /// Ziel, und eine erfundene Schwelle ist schlechter als keine.
  targetValue Decimal? @db.Decimal(14, 2)
  warnValue   Decimal? @db.Decimal(14, 2)

  /// Gewicht im Gesundheitswert. 0 = fliesst nicht ein.
  healthWeight Int     @default(0)
  active       Boolean @default(true)
  sortOrder    Int     @default(0)

  createdAt DateTime @default(now()) @db.Timestamptz(6)
  updatedAt DateTime @updatedAt @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  snapshots    KpiSnapshot[]
  targets      KpiTarget[]
  keyResults   KeyResult[]

  @@unique([organizationId, key])
  @@index([organizationId, active, sortOrder])
  @@map("kpi_definitions")
}

/// Zielwert für eine bestimmte Periode.
///
/// Der Zielwert auf der Definition ist der Dauerwert; hier steht die Ausnahme
/// („Q4 wegen Saison 140 000 statt 110 000"). Ohne diese Tabelle müsste man
/// den Dauerwert quartalsweise umschreiben und verlöre damit die Historie —
/// und genau die braucht man, wenn im Januar jemand fragt, ob Q4 das Ziel
/// erreicht hat.
model KpiTarget {
  id           String @id @default(cuid())
  definitionId String

  period      KpiPeriod
  periodStart DateTime  @db.Date
  targetValue Decimal   @db.Decimal(14, 2)
  note        String?

  createdAt DateTime @default(now()) @db.Timestamptz(6)

  definition KpiDefinition @relation(fields: [definitionId], references: [id], onDelete: Cascade)

  @@unique([definitionId, period, periodStart])
  @@map("kpi_targets")
}

/// Festgeschriebener Kennzahlwert einer abgeschlossenen Periode.
///
/// Architekturentscheid — der wichtigste dieses Moduls: **der Verlauf wird
/// gespeichert, nicht jedes Mal neu gerechnet.** Eine live gerechnete Kurve
/// schreibt die Vergangenheit um, sobald eine Buchung storniert, eine
/// Kundschaft zusammengeführt oder eine Gutschrift gebucht wird. Wer im März
/// 31 % Marge gemeldet hat und im Juni 28 % auf demselben Chart sieht, glaubt
/// der Zahl zu Recht nicht mehr.
///
/// `provisional` markiert die laufende Periode: sie wird bei jedem Nachtlauf
/// überschrieben und erst beim Periodenwechsel endgültig. Danach rührt sie
/// niemand mehr an — dieselbe Haltung wie bei ausgestellten Rechnungen.
///
/// `breakdown` trägt die Herleitung (Zähler, Nenner, ausgeschlossene
/// Datensätze). Damit ist eine strittige Zahl nachvollziehbar, ohne den
/// Datenbestand von damals zu rekonstruieren.
model KpiSnapshot {
  id             String @id @default(cuid())
  organizationId String
  definitionId   String

  period      KpiPeriod
  periodStart DateTime  @db.Date
  periodEnd   DateTime  @db.Date

  value       Decimal  @db.Decimal(14, 2)
  targetValue Decimal? @db.Decimal(14, 2)
  /// Wert derselben Periode des Vorjahres — beim Festschreiben mitgeführt,
  /// damit der Vorjahresvergleich keine zweite Abfrage über alte Snapshots
  /// braucht.
  previousYearValue Decimal? @db.Decimal(14, 2)
  sampleSize        Int?
  breakdown         Json?

  provisional Boolean  @default(true)
  computedAt  DateTime @default(now()) @db.Timestamptz(6)

  organization Organization  @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  definition   KpiDefinition @relation(fields: [definitionId], references: [id], onDelete: Cascade)

  @@unique([definitionId, period, periodStart])
  @@index([organizationId, period, periodStart])
  @@map("kpi_snapshots")
}
```

---

## 2. Phase 2 — Gesundheitswert

```prisma
/// Gesundheitswert der Firma zu einem Stichtag.
///
/// Der Wert ist eine gewichtete Summe benannter Komponenten, und `components`
/// trägt die vollständige Herleitung: je Komponente Rohwert, Zielwert,
/// Teilnote 0..100, Gewicht und Beitrag.
///
/// Warum die Herleitung mitgespeichert wird statt bei Bedarf neu gerechnet:
/// dasselbe Argument wie bei `Booking.priceBreakdown`. Eine Zahl, deren
/// Zustandekommen man nur mit dem heutigen Datenstand nachvollziehen kann,
/// ist im Streitfall wertlos. Zusätzlich ändern sich Gewichte und Zielwerte
/// über die Zeit — ohne Snapshot wäre der Wert von März nach einer
/// Gewichtsanpassung im Juni ein anderer.
model HealthSnapshot {
  id             String @id @default(cuid())
  organizationId String

  takenOn DateTime @db.Date
  /// 0..100.
  score      Int
  /// Punkteveränderung gegenüber dem Vormonat — für den Pfeil im Cockpit.
  scoreDelta Int?
  components Json

  /// Die Komponente mit dem grössten negativen Beitrag, im Klartext.
  /// Steht im Cockpit unter der Zahl; ohne sie löst ein Wert wie „73" keine
  /// Handlung aus.
  topRisk String?

  createdAt DateTime @default(now()) @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([organizationId, takenOn])
  @@index([organizationId, takenOn])
  @@map("health_snapshots")
}
```

---

## 3. Phase 3 — Ziele

```prisma
/// Flughöhe eines Ziels.
///
/// Architekturentscheid: Strategie, Ziel und Initiative sind **dasselbe
/// Objekt** — Titel, Verantwortung, Zeitraum, Status, Fortschritt — und
/// unterscheiden sich nur in Reichweite und Detailgrad. Drei Tabellen zu
/// bauen hiesse, dieselben Felder dreimal zu pflegen und jede Abfrage über
/// die Zielhierarchie dreimal zu schreiben. Der Selbstbezug `parentId` bildet
/// die Kette Strategie → Ziel → Initiative ab.
///
/// Die Roadmap ist keine eigene Entität: sie ist die Zeitachsen-Ansicht
/// dieser Datensätze.
enum ObjectiveHorizon {
  STRATEGY // mehrjährig, z. B. „Expansion Raum Zürich"
  OBJECTIVE // Quartals- oder Jahresziel (das O in OKR)
  INITIATIVE // konkretes Vorhaben mit Start- und Enddatum (Roadmap)
}

enum ObjectiveLevel {
  COMPANY
  DEPARTMENT
  PERSONAL
}

enum ObjectiveStatus {
  DRAFT
  ACTIVE
  AT_RISK
  ACHIEVED
  MISSED
  CANCELLED
}

model Objective {
  id             String @id @default(cuid())
  organizationId String

  horizon ObjectiveHorizon @default(OBJECTIVE)
  level   ObjectiveLevel   @default(COMPANY)
  status  ObjectiveStatus  @default(DRAFT)

  title       String
  description String?
  /// Frei benannt, nicht als Enum: eine Reinigungsfirma mit sechs Leuten
  /// erfindet ihre Bereiche selbst und ändert sie, ohne dass jemand
  /// ausliefert.
  department  String?
  priority    TaskPriority @default(NORMAL)

  parentId String?
  ownerId  String?

  /// Zeitraum. Quartalsziele füllen `quarter`/`fiscalYear`, Strategien und
  /// Initiativen `startsOn`/`endsOn`. Beides zu verlangen zwänge eine
  /// Mehrjahresstrategie in ein Quartalsraster.
  fiscalYear Int?
  quarter    Int? // 1..4
  startsOn   DateTime? @db.Date
  endsOn     DateTime? @db.Date

  /// 0..100, aus den Key Results gerechnet und beim Schreiben eines
  /// Check-ins nachgeführt. Als Spalte und nicht als Berechnung bei jeder
  /// Abfrage, weil Listen und Zeitachse sonst je Zeile nachladen müssten.
  progressPct Int @default(0)

  /// Prüfzyklus. Ohne ihn verrottet das Modul still; mit ihm zählt der
  /// Nachtlauf das Überfällige und stellt die Zahl an den Menüpunkt.
  reviewIntervalDays Int?
  nextReviewAt       DateTime? @db.Date

  budgetAmount   Decimal? @db.Decimal(12, 2)
  expectedRoiPct Decimal? @db.Decimal(6, 2)

  createdById String?
  createdAt   DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt   DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt   DateTime? @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  parent       Objective?   @relation("ObjectiveTree", fields: [parentId], references: [id], onDelete: SetNull)
  children     Objective[]  @relation("ObjectiveTree")
  owner        User?        @relation("ObjectiveOwner", fields: [ownerId], references: [id], onDelete: SetNull)

  keyResults KeyResult[]
  tasks      Task[]
  files      FileAsset[]

  @@index([organizationId, status, horizon])
  @@index([organizationId, fiscalYear, quarter])
  @@index([ownerId])
  @@index([nextReviewAt])
  @@map("objectives")
}

/// Messbares Ergebnis eines Ziels.
///
/// Architekturentscheid: ein Key Result verweist wenn möglich auf eine
/// `KpiDefinition` und rechnet seinen Fortschritt daraus. Ein Feld
/// „Fortschritt in %", das jemand monatlich schätzt, ist der Grund, warum OKR
/// in kleinen Firmen nach zwei Quartalen einschläft — die Zahl wird zur
/// Selbsteinschätzung, und niemand gibt sich freiwillig 40 %.
///
/// Manuelle Key Results bleiben erlaubt (nicht alles ist messbar), sind aber
/// als manuell gekennzeichnet und gelten nach 30 Tagen ohne Check-in als
/// überfällig.
model KeyResult {
  id          String @id @default(cuid())
  objectiveId String

  title String

  /// Gesetzt = automatisch aus Snapshots. Leer = manuell.
  kpiDefinitionId String?
  /// Bei automatischen Key Results die Periode, deren Snapshot gilt.
  kpiPeriod       KpiPeriod?

  unit         KpiUnit      @default(COUNT)
  direction    KpiDirection @default(UP_IS_GOOD)
  startValue   Decimal      @default(0) @db.Decimal(14, 2)
  targetValue  Decimal      @db.Decimal(14, 2)
  currentValue Decimal      @default(0) @db.Decimal(14, 2)
  progressPct  Int          @default(0)

  lastCheckinAt DateTime? @db.Timestamptz(6)
  sortOrder     Int       @default(0)

  createdAt DateTime @default(now()) @db.Timestamptz(6)
  updatedAt DateTime @updatedAt @db.Timestamptz(6)

  objective  Objective           @relation(fields: [objectiveId], references: [id], onDelete: Cascade)
  definition KpiDefinition?      @relation(fields: [kpiDefinitionId], references: [id], onDelete: SetNull)
  checkins   KeyResultCheckin[]

  @@index([objectiveId, sortOrder])
  @@map("key_results")
}

/// Eintrag im Verlauf eines Key Results.
///
/// Auch automatische Key Results bekommen Check-ins — vom Nachtlauf. Damit
/// ist die Kurve „wie lief es über das Quartal" für beide Arten dieselbe
/// Abfrage, und ein nachträglich korrigierter Zielwert verfälscht sie nicht.
model KeyResultCheckin {
  id          String @id @default(cuid())
  keyResultId String

  value      Decimal  @db.Decimal(14, 2)
  comment    String?
  automatic  Boolean  @default(false)
  authorId   String?
  recordedAt DateTime @default(now()) @db.Timestamptz(6)

  keyResult KeyResult @relation(fields: [keyResultId], references: [id], onDelete: Cascade)
  author    User?     @relation(fields: [authorId], references: [id], onDelete: SetNull)

  @@index([keyResultId, recordedAt])
  @@map("key_result_checkins")
}
```

---

## 4. Phase 4 — Finanzplanung

```prisma
enum BudgetStatus {
  DRAFT
  APPROVED
  CLOSED
}

/// Budgetperiode — in der Regel ein Geschäftsjahr.
///
/// `APPROVED` friert die Planwerte ein. Ein Budget, das man nachträglich an
/// das Ist anpassen kann, misst nichts; die Abweichung ist der einzige Grund,
/// warum es existiert. Korrekturen laufen über `revisedAmount` auf der Zeile,
/// damit Plan und Nachtrag getrennt sichtbar bleiben.
model BudgetPeriod {
  id             String @id @default(cuid())
  organizationId String

  name       String
  fiscalYear Int
  startsOn   DateTime @db.Date
  endsOn     DateTime @db.Date

  status     BudgetStatus @default(DRAFT)
  approvedAt DateTime?    @db.Timestamptz(6)
  approvedById String?
  note       String?

  createdAt DateTime @default(now()) @db.Timestamptz(6)
  updatedAt DateTime @updatedAt @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  lines        BudgetLine[]

  @@unique([organizationId, fiscalYear, name])
  @@index([organizationId, fiscalYear])
  @@map("budget_periods")
}

/// Budgetzeile.
///
/// Architekturentscheid: die Zeile hängt an der bestehenden
/// `ExpenseCategory`, nicht an einer neuen Budgetkategorien-Tabelle. Die im
/// Auftrag gewünschten Budgets bilden das Enum bereits ab — Marketing →
/// `MARKETING`, Personal → `SALARY` + `SOCIAL_SECURITY`, Fahrzeuge →
/// `VEHICLE` + `FUEL`, Büro → `RENT`, Software → `SOFTWARE`, Versicherung →
/// `INSURANCE`, Schulung → `TRAINING`, Ausrüstung → `EQUIPMENT`.
///
/// Damit kommt die Ist-Spalte gratis: Summe über `Expense` derselben
/// Kategorie im Zeitraum. Eine eigene Kategorienlogik hätte bedeutet, jede
/// Ausgabe zweimal zuzuordnen — und ab der ersten falschen Zuordnung stimmen
/// Budgetbericht und Buchhaltung nicht mehr überein.
///
/// `monthlyPlan` ist ein Array mit zwölf Werten. Als Spalte und nicht als
/// zwölf Zeilen, weil eine Budgetzeile immer als Ganzes bearbeitet wird und
/// die Jahresansicht sonst zwölf Verknüpfungen je Zeile bräuchte.
model BudgetLine {
  id       String @id @default(cuid())
  periodId String

  category    ExpenseCategory
  label       String
  plannedAmount Decimal       @db.Decimal(12, 2)
  revisedAmount Decimal?      @db.Decimal(12, 2)
  monthlyPlan   Decimal[]     @db.Decimal(12, 2)
  note          String?
  sortOrder     Int           @default(0)

  createdAt DateTime @default(now()) @db.Timestamptz(6)
  updatedAt DateTime @updatedAt @db.Timestamptz(6)

  period BudgetPeriod @relation(fields: [periodId], references: [id], onDelete: Cascade)

  @@index([periodId, category])
  @@map("budget_lines")
}

enum InvestmentStatus {
  PLANNED
  APPROVED
  ORDERED
  ACTIVE
  DISPOSED
  CANCELLED
}

enum DepreciationMethod {
  NONE
  STRAIGHT_LINE // linear
  DECLINING // degressiv
}

/// Investition — zugleich das Anlagenverzeichnis.
///
/// Fahrzeuge, Reinigungsmaschinen, IT und Mobiliar fehlten im Schema
/// vollständig; sie kamen nur als Ausgabenkategorie vor. Diese Tabelle
/// schliesst die Lücke und deckt damit auch das gewünschte Asset Management
/// ab, ohne ein zweites Modell dafür.
///
/// Der Abschreibungsplan wird **gerechnet, nicht gespeichert**: aus
/// `purchaseAmount`, `usefulLifeYears`, `method` und `commissionedOn` ergibt
/// sich der Restwert zu jedem Stichtag eindeutig. Eine Buchungstabelle wäre
/// erst nötig, wenn die Abschreibung ins Rechnungswesen gebucht würde — dann
/// gehört sie dorthin, nicht hierher.
model Investment {
  id             String @id @default(cuid())
  organizationId String

  name        String
  category    ExpenseCategory  @default(EQUIPMENT)
  status      InvestmentStatus @default(PLANNED)
  description String?
  supplierId  String?

  purchaseAmount  Decimal  @db.Decimal(12, 2)
  currency        String   @default("CHF")
  plannedOn       DateTime? @db.Date
  purchasedOn     DateTime? @db.Date
  commissionedOn  DateTime? @db.Date
  disposedOn      DateTime? @db.Date
  disposalProceeds Decimal? @db.Decimal(12, 2)

  method          DepreciationMethod @default(STRAIGHT_LINE)
  usefulLifeYears Int?
  residualValue   Decimal            @default(0) @db.Decimal(12, 2)

  /// Erwarteter jährlicher Nutzen in CHF — Grundlage der ROI-Anzeige.
  /// Optional und ausdrücklich eine Schätzung; die Oberfläche kennzeichnet
  /// sie als solche.
  expectedAnnualBenefit Decimal? @db.Decimal(12, 2)

  /// Inventarnummer. Frei vergeben, nicht über `NumberSequence`: ein
  /// Anlagenverzeichnis braucht keine lückenlose Nummerierung nach
  /// Art. 957a OR, und die Sequenzen sind den Belegarten vorbehalten.
  assetTag String?
  location String?
  ownerId  String?

  createdAt DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt DateTime? @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  supplier     Supplier?    @relation(fields: [supplierId], references: [id], onDelete: SetNull)
  owner        User?        @relation("InvestmentOwner", fields: [ownerId], references: [id], onDelete: SetNull)
  files        FileAsset[]

  @@unique([organizationId, assetTag])
  @@index([organizationId, status])
  @@index([organizationId, category])
  @@map("investments")
}

enum ScenarioKind {
  BEST
  EXPECTED
  WORST
}

/// Geschäftsszenario.
///
/// Architekturentscheid: ein Szenario speichert **Treiber, nicht Ergebnisse**.
/// Umsatz, Deckungsbeitrag, Cashflow und Break-even werden aus den Annahmen
/// gerechnet. Handgetippte Ergebniszahlen wären nach der ersten Änderung
/// einer Annahme in sich widersprüchlich — und niemand merkt es, weil beide
/// Zahlen plausibel aussehen.
///
/// `result` hält das zuletzt gerechnete Ergebnis samt Rechenweg, damit ein
/// Vergleich dreier Szenarien nicht bei jedem Seitenaufruf neu rechnet und
/// ein zur Entscheidung vorgelegtes Szenario nachvollziehbar bleibt.
model Scenario {
  id             String @id @default(cuid())
  organizationId String

  name       String
  kind       ScenarioKind @default(EXPECTED)
  fiscalYear Int
  horizonMonths Int       @default(12)
  description   String?

  /// Startliquidität. Ohne sie ist jede Break-even-Aussage eine Rechnung
  /// ohne Anfangsbestand.
  openingCash Decimal @default(0) @db.Decimal(12, 2)

  result      Json?
  computedAt  DateTime? @db.Timestamptz(6)

  createdById String?
  createdAt   DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt   DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt   DateTime? @db.Timestamptz(6)

  organization Organization         @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  assumptions  ScenarioAssumption[]

  @@index([organizationId, fiscalYear, kind])
  @@map("scenarios")
}

/// Eine Annahme eines Szenarios.
///
/// `key` ist die Brücke zum Rechenkern in `scenario.service.ts` —
/// `jobsPerMonth`, `averageTicket`, `laborCostPct`, `overheadPerMonth`,
/// `churnPct`, `headcount`, `investmentPerMonth`. Unbekannte Schlüssel meldet
/// der Dienst, statt sie stillschweigend zu ignorieren.
model ScenarioAssumption {
  id         String @id @default(cuid())
  scenarioId String

  key        String
  label      String
  value      Decimal @db.Decimal(14, 4)
  unit       KpiUnit @default(COUNT)
  /// Monatliche Veränderung in Prozent — bildet Wachstum ab, ohne zwölf
  /// Einzelwerte zu verlangen.
  monthlyChangePct Decimal @default(0) @db.Decimal(6, 2)
  note       String?
  sortOrder  Int     @default(0)

  scenario Scenario @relation(fields: [scenarioId], references: [id], onDelete: Cascade)

  @@unique([scenarioId, key])
  @@map("scenario_assumptions")
}
```

---

## 5. Phase 5 — Risiko und Qualität

```prisma
enum RiskCategory {
  FINANCIAL
  OPERATIONAL
  PERSONNEL
  LEGAL
  DATA_PROTECTION
  IT_SECURITY
  REPUTATION
  MARKET
  ENVIRONMENT
}

enum RiskStatus {
  IDENTIFIED
  ASSESSED
  MITIGATING
  ACCEPTED
  CLOSED
}

/// Risikoeintrag.
///
/// `severity` ist eine gespeicherte Spalte, nicht eine Berechnung bei jeder
/// Abfrage: die Risikomatrix und jede Sortierung „nach Schwere" bräuchten
/// sonst eine Sortierung im Anwendungscode statt in der Datenbank, und die
/// Seitenweise Ausgabe wäre damit falsch. Der Dienst setzt sie bei jedem
/// Schreibvorgang aus `probability × impact` — in *einer* Funktion, damit es
/// keine zweite Rechnung geben kann.
///
/// Brutto und netto getrennt: die Wirkung einer Massnahme ist nur sichtbar,
/// wenn danebensteht, wie es ohne sie aussähe.
model RiskEntry {
  id             String @id @default(cuid())
  organizationId String

  title       String
  description String?
  category    RiskCategory @default(OPERATIONAL)
  status      RiskStatus   @default(IDENTIFIED)

  /// 1..5.
  probability Int @default(3)
  impact      Int @default(3)
  /// probability × impact, 1..25 — vom Dienst gesetzt.
  severity    Int @default(9)

  residualProbability Int?
  residualImpact      Int?
  residualSeverity    Int?

  /// Finanzielle Auswirkung im Eintrittsfall, wenn bezifferbar.
  potentialLoss Decimal? @db.Decimal(12, 2)

  mitigationPlan String?
  ownerId        String?

  reviewIntervalDays Int       @default(90)
  nextReviewAt       DateTime? @db.Date
  lastReviewedAt     DateTime? @db.Date
  closedAt           DateTime? @db.Timestamptz(6)

  createdById String?
  createdAt   DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt   DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt   DateTime? @db.Timestamptz(6)

  organization Organization       @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  owner        User?              @relation("RiskOwner", fields: [ownerId], references: [id], onDelete: SetNull)
  actions      CorrectiveAction[]
  files        FileAsset[]

  @@index([organizationId, status, severity])
  @@index([nextReviewAt])
  @@map("risk_entries")
}

/// Art einer Kontrolle.
///
/// Architekturentscheid: Reinigungsstandards, interne Abläufe,
/// Compliance-Pflichten und Notfallpläne sind strukturell **dasselbe** — eine
/// Anforderung, ein Verantwortlicher, ein Prüfzyklus, ein Nachweis. Vier
/// Tabellen dafür bedeuteten vier Listen, vier Masken und vier Prüfzyklen,
/// die einzeln einschlafen. Das Enum trennt sie in der Ansicht; das Modell
/// hält sie zusammen.
enum ControlKind {
  SOP // interner Ablauf, Reinigungsstandard
  QUALITY_STANDARD // ISO 9001, Qualitätsziel
  COMPLIANCE // DSG/nDSG, DSGVO, Arbeitsrecht, Vertragsfrist
  CONTINUITY // Notfall, Backup, Wiederanlauf
}

enum ControlStatus {
  DRAFT
  ACTIVE
  DUE
  NON_COMPLIANT
  RETIRED
}

model ControlEntry {
  id             String @id @default(cuid())
  organizationId String

  kind        ControlKind   @default(SOP)
  status      ControlStatus @default(DRAFT)
  reference   String? // z. B. „ISO 9001:2015 8.5.1" oder „nDSG Art. 7"
  title       String
  description String?
  /// Was als Nachweis gilt. Klartext, weil sich das je Kontrolle
  /// unterscheidet und ein Enum hier nur stören würde.
  evidenceNote String?

  ownerId            String?
  reviewIntervalDays Int       @default(180)
  nextReviewAt       DateTime? @db.Date
  lastReviewedAt     DateTime? @db.Date

  createdAt DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt DateTime? @db.Timestamptz(6)

  organization Organization       @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  owner        User?              @relation("ControlOwner", fields: [ownerId], references: [id], onDelete: SetNull)
  actions      CorrectiveAction[]
  files        FileAsset[]

  @@index([organizationId, kind, status])
  @@index([nextReviewAt])
  @@map("control_entries")
}

enum ActionKind {
  CORRECTIVE // behebt die Ursache
  PREVENTIVE // verhindert das Wiederauftreten
  IMPROVEMENT // kontinuierliche Verbesserung
}

/// Massnahme (CAPA).
///
/// Hängt wahlweise an einem Risiko, einer Kontrolle oder einer Bewertung —
/// eine Kundenreklamation ist in dieser Anwendung eine `Review` oder ein
/// `MessageThread`, kein neues Objekt.
///
/// Die Durchführung selbst läuft über `Task`: Frist, Zuweisung, Erinnerung
/// und Benachrichtigung sind dort gelöst. Ein zweites Aufgabensystem hätte
/// zwei Pendenzenlisten bedeutet, von denen eine immer übersehen wird.
model CorrectiveAction {
  id             String @id @default(cuid())
  organizationId String

  kind        ActionKind @default(CORRECTIVE)
  title       String
  rootCause   String?
  description String?

  riskId    String?
  controlId String?
  reviewId  String?
  taskId    String? @unique

  dueOn       DateTime? @db.Date
  completedAt DateTime? @db.Timestamptz(6)
  /// Wirksamkeitsprüfung — der Schritt, der bei CAPA am häufigsten fehlt.
  effectivenessCheckedAt DateTime? @db.Date
  effectivenessNote      String?

  createdById String?
  createdAt   DateTime @default(now()) @db.Timestamptz(6)
  updatedAt   DateTime @updatedAt @db.Timestamptz(6)

  organization Organization  @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  risk         RiskEntry?    @relation(fields: [riskId], references: [id], onDelete: SetNull)
  control      ControlEntry? @relation(fields: [controlId], references: [id], onDelete: SetNull)
  review       Review?       @relation(fields: [reviewId], references: [id], onDelete: SetNull)
  task         Task?         @relation(fields: [taskId], references: [id], onDelete: SetNull)

  @@index([organizationId, completedAt])
  @@map("corrective_actions")
}
```

---

## 6. Phase 6 — Wissen, Dokumente, Markt

```prisma
enum DocumentCategory {
  BUSINESS_PLAN
  CONTRACT
  INSURANCE
  EMPLOYEE
  CERTIFICATE
  LICENSE
  SUPPLIER
  TAX
  LEGAL
  POLICY
  OTHER
}

/// Wer ein Dokument sehen darf.
///
/// **Die heikelste Entscheidung dieses Bauplans.** Die Ablage nimmt Verträge,
/// Policen, Personaldokumente und Steuerunterlagen auf; ein Fehler hier ist
/// sofort ein Datenschutzvorfall, kein Anzeigefehler.
///
/// Regel aus `CLAUDE.md`, hier zwingend: die Sichtbarkeit wirkt in der
/// Prisma-`where`-Klausel, nicht im Rendering. Verstecktes HTML steht
/// trotzdem auf der Leitung.
///
/// `EMPLOYEE_PRIVATE` bedeutet: nur die Geschäftsleitung und die betroffene
/// Person (`subjectEmployeeId`). Nicht „alle Mitarbeitenden".
enum DocumentVisibility {
  MANAGEMENT // ADMIN, SUPER_ADMIN
  OPERATIONS // zusätzlich MANAGER
  STAFF // zusätzlich EMPLOYEE
  EMPLOYEE_PRIVATE // Geschäftsleitung + betroffene Person
}

/// Dokument in der Ablage.
///
/// Der Datensatz ist die Akte, die Datei ist die Fassung: `currentVersionId`
/// zeigt auf die geltende `DocumentVersion`. So bleibt ein Verweis aus einer
/// Massnahme oder einem Ziel gültig, wenn jemand eine neue Fassung hochlädt —
/// beim Zeigen auf `FileAsset` zeigte er auf die veraltete Datei.
model ManagedDocument {
  id             String @id @default(cuid())
  organizationId String

  title       String
  category    DocumentCategory   @default(OTHER)
  visibility  DocumentVisibility @default(MANAGEMENT)
  description String?
  tags        String[]           @default([])

  /// Nur bei `category = EMPLOYEE` bzw. `visibility = EMPLOYEE_PRIVATE`.
  subjectEmployeeId String?
  supplierId        String?

  /// Fristen: Ablauf eines Vertrags, einer Police, eines Zertifikats.
  /// Der Nachtlauf warnt vor `expiresOn`; das ist der eigentliche Nutzen
  /// einer Vertragsablage gegenüber einem Ordner auf dem Laufwerk.
  validFrom DateTime? @db.Date
  expiresOn DateTime? @db.Date
  reminderDaysBefore Int @default(30)

  currentVersionId String? @unique

  createdById String?
  createdAt   DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt   DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt   DateTime? @db.Timestamptz(6)

  organization    Organization      @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  subjectEmployee Employee?         @relation(fields: [subjectEmployeeId], references: [id], onDelete: SetNull)
  supplier        Supplier?         @relation(fields: [supplierId], references: [id], onDelete: SetNull)
  currentVersion  DocumentVersion?  @relation("CurrentVersion", fields: [currentVersionId], references: [id], onDelete: SetNull)
  versions        DocumentVersion[] @relation("AllVersions")

  @@index([organizationId, category, visibility])
  @@index([organizationId, expiresOn])
  @@map("managed_documents")
}

model DocumentVersion {
  id         String @id @default(cuid())
  documentId String

  version     Int
  fileAssetId String
  changeNote  String?
  uploadedById String?
  createdAt    DateTime @default(now()) @db.Timestamptz(6)

  document ManagedDocument  @relation("AllVersions", fields: [documentId], references: [id], onDelete: Cascade)
  current  ManagedDocument? @relation("CurrentVersion")
  file     FileAsset        @relation(fields: [fileAssetId], references: [id], onDelete: Cascade)

  @@unique([documentId, version])
  @@map("document_versions")
}

enum ArticleStatus {
  DRAFT
  PUBLISHED
  ARCHIVED
}

/// Wissensartikel — Abläufe, Schulungsunterlagen, Richtlinien, FAQ.
///
/// Bewusst getrennt von `BlogPost` (öffentlich, SEO, Kategorien) und von
/// `Faq` (öffentliche Website). Der Inhalt richtet sich nach innen und
/// unterliegt einer anderen Sichtbarkeit; eine gemeinsame Tabelle hätte
/// bedeutet, dass ein Fehler im Statusfeld internes Material veröffentlicht.
///
/// Videos werden verlinkt, nicht gespeichert: eigenes Hosting heisst
/// Transcodierung, Bandbreite und Kosten für einen Nutzen, den ein Link
/// erfüllt.
model KnowledgeArticle {
  id             String @id @default(cuid())
  organizationId String

  slug     String
  title    String
  summary  String?
  body     String
  category String             @default("Allgemein")
  tags     String[]           @default([])
  status   ArticleStatus      @default(DRAFT)
  visibility DocumentVisibility @default(STAFF)

  videoUrl String?

  reviewIntervalDays Int?
  nextReviewAt       DateTime? @db.Date
  publishedAt        DateTime? @db.Timestamptz(6)

  authorId  String?
  createdAt DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt DateTime? @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  author       User?        @relation("ArticleAuthor", fields: [authorId], references: [id], onDelete: SetNull)
  files        FileAsset[]

  @@unique([organizationId, slug])
  @@index([organizationId, status, category])
  @@index([nextReviewAt])
  @@map("knowledge_articles")
}

/// Wettbewerber.
///
/// Eigene Tabelle statt eines generischen Eintrags: die Felder sind
/// tatsächlich andere (Preisniveau, Marktposition, Bewertungsschnitt), und
/// eine Preisbeobachtung gehört neben den Namen, nicht in ein Freitextfeld.
model Competitor {
  id             String @id @default(cuid())
  organizationId String

  name     String
  website  String?
  region   String?
  services String[] @default([])

  /// Beobachtetes Preisniveau. Als Spanne, weil ein Einzelpreis ohne Umfang
  /// nichts aussagt.
  priceFrom Decimal? @db.Decimal(12, 2)
  priceTo   Decimal? @db.Decimal(12, 2)
  priceNote String?

  strengths     String?
  weaknesses    String?
  marketPosition String?
  reviewScore   Decimal? @db.Decimal(3, 2)
  reviewCount   Int?
  notes         String?

  reviewIntervalDays Int       @default(180)
  nextReviewAt       DateTime? @db.Date
  lastReviewedAt     DateTime? @db.Date

  createdAt DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt DateTime? @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, nextReviewAt])
  @@map("competitors")
}

enum InsightKind {
  INDUSTRY
  CUSTOMER
  COMPETITOR
  TECHNOLOGY
  ECONOMY
  LEGAL
  ENVIRONMENT
}

/// Marktbeobachtung — eine Feststellung mit Quelle und Verfallsdatum.
///
/// `nextReviewAt` ist hier nicht Zierde: eine Markteinschätzung von vor drei
/// Jahren, die unmarkiert in der Liste steht, ist gefährlicher als eine
/// fehlende.
model MarketInsight {
  id             String @id @default(cuid())
  organizationId String

  kind        InsightKind @default(INDUSTRY)
  title       String
  body        String
  sourceUrl   String?
  sourceName  String?
  observedOn  DateTime    @db.Date
  impactNote  String?

  reviewIntervalDays Int       @default(365)
  nextReviewAt       DateTime? @db.Date

  createdById String?
  createdAt   DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt   DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt   DateTime? @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, kind, observedOn])
  @@index([nextReviewAt])
  @@map("market_insights")
}

enum AnalysisKind {
  SWOT
  PESTEL
}

/// Feld einer SWOT- oder PESTEL-Analyse.
///
/// Ein gemeinsames Enum für beide, weil die Tabelle sonst zweimal identisch
/// dastünde. Die Maske zeigt je nach `kind` der Tafel nur die passenden
/// Felder.
enum AnalysisBucket {
  STRENGTH
  WEAKNESS
  OPPORTUNITY
  THREAT
  POLITICAL
  ECONOMIC
  SOCIAL
  TECHNOLOGICAL
  ENVIRONMENTAL
  LEGAL
}

/// Analysetafel mit Stichtag.
///
/// Architekturentscheid: eine Tafel ist eine **Fassung**, keine laufend
/// überschriebene Liste. Wer die SWOT von 2026 mit der von 2028 vergleichen
/// will, braucht beide; und eine Analyse, die man unbemerkt umschreiben kann,
/// hält keiner Besprechung stand. `supersededById` verkettet die Fassungen.
model AnalysisBoard {
  id             String @id @default(cuid())
  organizationId String

  kind      AnalysisKind
  title     String
  preparedOn DateTime    @db.Date
  summary   String?

  supersededById String? @unique

  reviewIntervalDays Int       @default(365)
  nextReviewAt       DateTime? @db.Date

  createdById String?
  createdAt   DateTime @default(now()) @db.Timestamptz(6)
  updatedAt   DateTime @updatedAt @db.Timestamptz(6)

  organization Organization    @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  supersededBy AnalysisBoard?  @relation("BoardChain", fields: [supersededById], references: [id], onDelete: SetNull)
  supersedes   AnalysisBoard?  @relation("BoardChain")
  entries      AnalysisEntry[]

  @@index([organizationId, kind, preparedOn])
  @@map("analysis_boards")
}

model AnalysisEntry {
  id      String @id @default(cuid())
  boardId String

  bucket    AnalysisBucket
  title     String
  detail    String?
  /// 1..5 — erlaubt eine Reihung innerhalb eines Felds. Eine SWOT mit zwölf
  /// gleichrangigen Punkten je Quadrant hilft niemandem.
  weight    Int            @default(3)
  sortOrder Int            @default(0)

  board AnalysisBoard @relation(fields: [boardId], references: [id], onDelete: Cascade)

  @@index([boardId, bucket, sortOrder])
  @@map("analysis_entries")
}

/// Sitzung.
///
/// Pendenzen werden als echte `Task`-Zeilen angelegt, nicht als eigene
/// Unterliste: sonst gäbe es zwei Pendenzenlisten, und die im Protokoll wird
/// nach der Sitzung nie wieder geöffnet.
model Meeting {
  id             String @id @default(cuid())
  organizationId String

  title      String
  heldAt     DateTime @db.Timestamptz(6)
  location   String?
  agenda     String?
  minutes    String?
  decisions  String?
  /// Teilnehmende als Benutzerverweise, wo vorhanden; Gäste als Freitext.
  /// Ein reines Freitextfeld verlöre die Verknüpfung, eine reine
  /// Benutzerliste könnte keine externen Teilnehmenden abbilden.
  guestNames String[] @default([])

  objectiveId String?

  createdById String?
  createdAt   DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt   DateTime  @updatedAt @db.Timestamptz(6)
  deletedAt   DateTime? @db.Timestamptz(6)

  organization Organization         @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  participants MeetingParticipant[]
  tasks        Task[]
  files        FileAsset[]

  @@index([organizationId, heldAt])
  @@map("meetings")
}

model MeetingParticipant {
  id        String @id @default(cuid())
  meetingId String
  userId    String

  attended Boolean @default(true)

  meeting Meeting @relation(fields: [meetingId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([meetingId, userId])
  @@map("meeting_participants")
}
```

---

## 7. Phase 7 — Berichte

```prisma
enum ReportKind {
  BUSINESS_PERFORMANCE
  FINANCIAL
  MARKETING
  SALES
  EMPLOYEE
  CUSTOMER
  QUARTERLY_REVIEW
}

enum ReportCadence {
  WEEKLY
  MONTHLY
  QUARTERLY
  YEARLY
}

enum ReportFormat {
  PDF
  XLSX
  DOCX
}

/// Zeitplan eines wiederkehrenden Berichts.
///
/// Läuft über den bestehenden `/api/cron/daily`, der prüft, welche Zeitpläne
/// fällig sind. Ein eigener Scheduler wäre eine zweite Zeitquelle mit
/// eigenen Ausfallarten; die Vercel-Cron-Route ist bereits abgesichert
/// (`defineCronRoute`, Bearer `CRON_SECRET`).
model ReportSchedule {
  id             String @id @default(cuid())
  organizationId String

  name      String
  kind      ReportKind    @default(BUSINESS_PERFORMANCE)
  cadence   ReportCadence @default(MONTHLY)
  format    ReportFormat  @default(PDF)
  /// Tag im Monat bzw. Wochentag, an dem erzeugt wird.
  runOnDay  Int           @default(1)
  recipients String[]     @default([])
  active    Boolean       @default(true)

  lastRunAt DateTime? @db.Timestamptz(6)
  nextRunAt DateTime? @db.Timestamptz(6)

  createdAt DateTime @default(now()) @db.Timestamptz(6)
  updatedAt DateTime @updatedAt @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  runs         ReportRun[]

  @@index([organizationId, active, nextRunAt])
  @@map("report_schedules")
}

/// Ein erzeugter Bericht.
///
/// Die Datei bleibt liegen. Ein Bericht, der bei jedem Öffnen neu gerechnet
/// wird, zeigt andere Zahlen als die Fassung, die verschickt wurde — und die
/// verschickte ist die, über die gesprochen wird.
model ReportRun {
  id         String @id @default(cuid())
  scheduleId String?
  organizationId String

  kind        ReportKind
  format      ReportFormat
  periodStart DateTime     @db.Date
  periodEnd   DateTime     @db.Date

  fileAssetId String?
  status      String   @default("PENDING") // PENDING | READY | FAILED
  error       String?
  createdById String?
  createdAt   DateTime @default(now()) @db.Timestamptz(6)
  finishedAt  DateTime? @db.Timestamptz(6)

  organization Organization    @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  schedule     ReportSchedule? @relation(fields: [scheduleId], references: [id], onDelete: SetNull)
  file         FileAsset?      @relation(fields: [fileAssetId], references: [id], onDelete: SetNull)

  @@index([organizationId, kind, periodStart])
  @@map("report_runs")
}
```

---

## 8. Änderungen an bestehenden Modellen

Diese Blöcke werden **in** bestehende Modelle eingefügt. Prisma meldet eine
fehlende Gegenseite einer Beziehung als Fehler — alle vier Punkte gehören
zur selben Migration wie die neuen Tabellen.

### 8.1 `Organization`

Rückbeziehungen für jedes neue mandantenbezogene Modell:

```prisma
  kpiDefinitions   KpiDefinition[]
  kpiSnapshots     KpiSnapshot[]
  healthSnapshots  HealthSnapshot[]
  objectives       Objective[]
  budgetPeriods    BudgetPeriod[]
  investments      Investment[]
  scenarios        Scenario[]
  riskEntries      RiskEntry[]
  controlEntries   ControlEntry[]
  correctiveActions CorrectiveAction[]
  managedDocuments ManagedDocument[]
  knowledgeArticles KnowledgeArticle[]
  competitors      Competitor[]
  marketInsights   MarketInsight[]
  analysisBoards   AnalysisBoard[]
  meetings         Meeting[]
  reportSchedules  ReportSchedule[]
  reportRuns       ReportRun[]
```

### 8.2 `User`

Benannte Beziehungen, weil `User` mehrfach vorkommt:

```prisma
  ownedObjectives   Objective[]          @relation("ObjectiveOwner")
  keyResultCheckins KeyResultCheckin[]
  ownedInvestments  Investment[]         @relation("InvestmentOwner")
  ownedRisks        RiskEntry[]          @relation("RiskOwner")
  ownedControls     ControlEntry[]       @relation("ControlOwner")
  authoredArticles  KnowledgeArticle[]   @relation("ArticleAuthor")
  meetingSeats      MeetingParticipant[]
```

### 8.3 `Task`

Zwei optionale Verknüpfungen. Damit werden Zielmassnahmen und
Sitzungspendenzen zu normalen Aufgaben — mit Frist, Erinnerung und
Benachrichtigung, die es alle schon gibt:

```prisma
  objectiveId String?
  meetingId   String?

  objective Objective? @relation(fields: [objectiveId], references: [id], onDelete: SetNull)
  meeting   Meeting?   @relation(fields: [meetingId], references: [id], onDelete: SetNull)
  action    CorrectiveAction?

  @@index([objectiveId])
```

### 8.4 `FileAsset` und `FileScope`

Neue Bereiche und die dazugehörigen optionalen Fremdschlüssel:

```prisma
enum FileScope {
  // … bestehende Werte unverändert …
  OBJECTIVE
  INVESTMENT
  RISK
  CONTROL
  DOCUMENT
  ARTICLE
  MEETING
  REPORT
}
```

```prisma
  objectiveId String?
  investmentId String?
  riskId      String?
  controlId   String?
  articleId   String?
  meetingId   String?

  objective  Objective?        @relation(fields: [objectiveId], references: [id], onDelete: Cascade)
  investment Investment?       @relation(fields: [investmentId], references: [id], onDelete: Cascade)
  risk       RiskEntry?        @relation(fields: [riskId], references: [id], onDelete: Cascade)
  control    ControlEntry?     @relation(fields: [controlId], references: [id], onDelete: Cascade)
  article    KnowledgeArticle? @relation(fields: [articleId], references: [id], onDelete: Cascade)
  meeting    Meeting?          @relation(fields: [meetingId], references: [id], onDelete: Cascade)
  versions   DocumentVersion[]
  reportRuns ReportRun[]
```

### 8.5 `Supplier` und `Review`

Je eine Rückbeziehung:

```prisma
// Supplier
  investments Investment[]
  documents   ManagedDocument[]

// Review
  correctiveActions CorrectiveAction[]

// Employee
  documents ManagedDocument[]
```

---

## 9. Zusammenfassung

| Phase | Neue Modelle | Neue Enums |
| --- | --- | --- |
| 1 | 3 | 4 |
| 2 | 1 | — |
| 3 | 3 | 3 |
| 4 | 5 | 4 |
| 5 | 3 | 6 |
| 6 | 8 | 6 |
| 7 | 2 | 3 |
| **Summe** | **25** | **26** |

Das Schema wächst von 84 auf 109 Modelle. Zum Vergleich: der wörtlich
umgesetzte Auftrag käme auf über 60 neue Modelle — der Unterschied sind die
Zusammenlegungen aus `00-UEBERSICHT.md`, Abschnitt 2 und 4.

Nach jeder Phase:

```bash
npm run db:migrate   # Weg siehe 05-MIGRATION-TESTS-BETRIEB.md
npm run erd          # docs/DATABASE.md neu erzeugen
npm run typecheck
```
