# Kennzahlen, Gesundheitswert, Rechenkerne

Jede Kennzahl mit Formel auf echten Spalten des bestehenden Schemas. Wo eine
Zahl nicht berechenbar ist, steht das da — statt einer plausiblen Erfindung.

---

## 1. Gemeinsame Regeln

**Was als Umsatz zählt.** Rechnungen mit Status
`ISSUED | SENT | PARTIALLY_PAID | PAID | OVERDUE`, `deletedAt: null`.
Ausgeschlossen: `DRAFT` (noch kein Beleg), `CANCELLED` und `WRITTEN_OFF`.
Abgezogen: Gutschriften (`CreditNote`) desselben Zeitraums.

**Welches Datum den Zeitraum bestimmt.** `Invoice.issueDate` — nicht
`createdAt`, nicht `paidAt`. Nummer und Datum werden beim Ausstellen in
derselben Transaktion vergeben (Art. 957a OR, lückenlose Nummerierung); das
Ausstellungsdatum ist damit die einzige Grösse, die nachträglich nicht
wandert.

**Netto, nicht brutto.** `netTotal` überall. Die Mehrwertsteuer ist
durchlaufender Posten; eine Umsatzreihe in Bruttowerten springt bei jeder
Satzänderung.

**Perioden.** `MONTH` = Kalendermonat, `QUARTER` = Kalenderquartal,
`YEAR` = Kalenderjahr, in `Europe/Zurich` gebildet und als UTC-Grenzen
abgefragt. `resolveRange()` in `analytics.service.ts` macht das bereits —
weiterverwenden, nicht neu schreiben.

**Leerer Nenner.** Ergibt `null`, nicht `0`. Eine Quote von 0 % bei null
Offerten ist eine Falschaussage; `null` zeigt die Oberfläche als „—".
`sampleSize` auf dem Snapshot hält die Fallzahl fest, damit „100 %
Annahmequote" bei zwei Offerten als das erkennbar ist, was es ist.

**Struktur eines Rechners.**

```ts
export interface KpiComputation {
  value: number | null;
  sampleSize?: number;
  breakdown?: Record<string, unknown>;
}

export type KpiCalculator = (ctx: {
  organizationId: string;
  from: Date;
  to: Date;
}) => Promise<KpiComputation>;

export const KPI_CALCULATORS: Record<string, KpiCalculator> = { … };
```

Eine `KpiDefinition` mit `source = DERIVED` und ohne Eintrag in dieser
Registry ist ein Konfigurationsfehler. Der Nachtlauf meldet ihn und schreibt
**keinen** Snapshot — eine stillschweigende Null wäre schlimmer als eine
Lücke, weil sie im Chart wie ein Einbruch aussieht.

---

## 2. Kennzahlkatalog

### Finanzen

| Schlüssel | Formel | Einheit |
| --- | --- | --- |
| `revenue.net` | Σ `Invoice.netTotal` (gültige Status, `issueDate` in Periode) − Σ `CreditNote.netAmount` | CHF |
| `revenue.recurring` | wie oben, eingeschränkt auf Rechnungen, deren `booking.frequency != ONCE` oder `booking.recurrenceRuleId != null` | CHF |
| `revenue.recurringShare` | `revenue.recurring / revenue.net × 100` | % |
| `revenue.growthYoY` | `(revenue.net − Vorjahresperiode) / Vorjahresperiode × 100` | % |
| `margin.gross` | `(Σ Job.revenue − Σ (Job.laborCost + Job.materialCost)) / Σ Job.revenue × 100`, über Einsätze mit `status COMPLETED\|VERIFIED` und `actualEnd` in Periode | % |
| `cost.operating` | Σ `Expense.netAmount` in Periode | CHF |
| `profit.operating` | `revenue.net − cost.operating` | CHF |
| `invoice.outstanding` | Σ `Invoice.balance` bei Status `SENT \| PARTIALLY_PAID \| OVERDUE`, Stichtag = Periodenende | CHF |
| `invoice.overdue` | wie oben, nur `OVERDUE` | CHF |
| `invoice.dso` | Ø Tage `issueDate → paidAt` über in der Periode bezahlte Rechnungen | Tage |
| `cashflow.net` | Σ `Payment.amount` (`status COMPLETED`) − Σ `Expense.grossAmount` (`paid = true`) in Periode | CHF |

Zu `margin.gross`: `Job.laborCost` ist ein Schnappschuss aus der
Nachkalkulation, `TimeEntry.hourlyRate` hält den Stundensatz zum Zeitpunkt
fest. Solange die Nachkalkulation nicht durchgängig gepflegt wird, ist die
Marge nur so gut wie diese Pflege — die Oberfläche zeigt deshalb neben der
Marge, über wie viele Einsätze sie geht und wie viele davon eine
Nachkalkulation haben.

### Vertrieb

| Schlüssel | Formel | Einheit |
| --- | --- | --- |
| `quote.sent` | `count(Quote)` mit `sentAt` in Periode | Stück |
| `quote.conversion` | `count(Quote WHERE sentAt in Periode AND acceptedAt != null) / quote.sent × 100` | % |
| `quote.avgValue` | Ø `Quote.netTotal` der in der Periode gesendeten Offerten | CHF |
| `quote.timeToDecision` | Ø Tage `sentAt → acceptedAt \| rejectedAt` | Tage |
| `lead.new` | `count(Lead)` mit `createdAt` in Periode, `deletedAt: null` | Stück |
| `lead.conversion` | `count(Lead WHERE createdAt in Periode AND status = WON) / lead.new × 100` | % |
| `lead.costPerLead` | Σ `Expense.netAmount` (`category = MARKETING`) / `lead.new` | CHF |

**Kohorte, nicht Zeitfenster.** `quote.conversion` misst Offerten, die in der
Periode **gesendet** wurden, und schaut deren Ausgang zum Zeitpunkt der
Berechnung an. Die naheliegende Alternative — angenommene geteilt durch
gesendete im selben Monat — vergleicht zwei verschiedene Mengen: eine im
Januar angenommene Dezember-Offerte fiele in beide Zähler und in keinen
passenden Nenner.

Folge: die Quote eines Monats **reift** noch einige Wochen. Sie bleibt
deshalb `provisional`, bis `Quote.validUntil` aller Offerten der Kohorte
verstrichen ist. Der Snapshot hält in `breakdown` fest, wie viele Offerten
zum Zeitpunkt der Berechnung noch offen waren.

### Auftragslage

| Schlüssel | Formel | Einheit |
| --- | --- | --- |
| `booking.created` | `count(Booking)` mit `createdAt` in Periode, `deletedAt: null` | Stück |
| `booking.completed` | `count(Booking WHERE status = COMPLETED AND completedAt in Periode)` | Stück |
| `booking.cancelled` | `count(Booking WHERE status IN (CANCELLED, NO_SHOW) AND cancelledAt in Periode)` | Stück |
| `booking.cancellationRate` | `booking.cancelled / (booking.completed + booking.cancelled) × 100` | % |
| `booking.avgTicket` | Ø `Booking.netTotal` der abgeschlossenen | CHF |
| `job.backlog` | `count(Job WHERE scheduledStart > jetzt AND status NOT IN (CANCELLED, COMPLETED, VERIFIED))`, Stichtag Periodenende | Stück |

`booking.cancellationRate` hat `direction = DOWN_IS_GOOD`. Ohne das steht ein
grüner Pfeil nach oben an einer steigenden Stornoquote — genau dafür
existiert das Feld auf `KpiDefinition`.

### Kundschaft

| Schlüssel | Formel | Einheit |
| --- | --- | --- |
| `customer.active` | `count(DISTINCT Booking.customerId)` mit abgeschlossener Buchung in den letzten 12 Monaten | Stück |
| `customer.new` | `count(Customer)` mit `createdAt` in Periode, `deletedAt: null` | Stück |
| `customer.growth` | `(customer.active − Vorjahr) / Vorjahr × 100` | % |
| `customer.repeatRate` | Anteil der aktiven Kundschaft mit ≥ 2 abgeschlossenen Buchungen in 12 Monaten | % |
| `customer.satisfaction` | Ø `Review.rating` (`status = APPROVED`, `createdAt` in Periode) × 20 → 0..100 | % |
| `customer.jobRating` | Ø `Job.customerRating` (nicht null, `actualEnd` in Periode) × 20 | % |
| `response.firstReply` | Ø Minuten von der ersten Kundennachricht eines Verlaufs bis zur ersten Antwort mit `authorType != CUSTOMER` | Stunden |

`response.firstReply` braucht eine Fensterfunktion; in Prisma am ehesten als
`$queryRaw` mit `DISTINCT ON (thread_id)`. Reine Prisma-Abfragen bräuchten
hier N+1 Abfragen über alle Verläufe.

### Personal

| Schlüssel | Formel | Einheit |
| --- | --- | --- |
| `employee.utilization` | `Σ TimeEntry.minutes (approved, jobId != null) / Σ Sollminuten × 100` | % |
| `employee.headcountFte` | `Σ Employee.workloadPct / 100` bei `active = true` | Stück |
| `employee.revenuePerFte` | `revenue.net / employee.headcountFte` | CHF |
| `employee.absenceRate` | Abwesenheitstage (`Absence.status = APPROVED`) / Solltage × 100 | % |

**Sollminuten**, und dieser Punkt entscheidet, ob die Auslastung etwas
aussagt:

```
Sollminuten(Mitarbeitende, Periode)
  = Arbeitstage in Periode          (Mo–Fr, minus Feiertage aus `Holiday`)
  × 8.4 h × 60                       (42-h-Woche, Schweizer Normalfall)
  × Employee.workloadPct / 100
  − genehmigte Abwesenheiten in Minuten
```

Zwei Dinge dazu: Die 42-Stunden-Woche gehört als Feld auf `Organization`
(`weeklyHours`, Vorgabe 42), nicht als Konstante in den Code — sie ist eine
betriebliche Grösse. Und `Holiday` existiert bereits; die Auslastung ohne
Feiertagsabzug fällt im Dezember systematisch zu niedrig aus und sieht aus
wie ein Leistungsproblem.

Nur **genehmigte** Zeiteinträge (`approved = true`) zählen. Sonst hängt die
Auslastung daran, wer wann seine Stunden freigibt.

---

## 3. Nicht berechenbar

Diese Punkte stehen im Auftrag, lassen sich aus dem heutigen Datenbestand
aber nicht ermitteln. Eine Kachel mit einer erfundenen Zahl ist schlechter
als eine fehlende Kachel.

| Gewünscht | Warum nicht | Weg dorthin |
| --- | --- | --- |
| **Website Conversion Rate** | Es gibt keine Sitzungszählung. `Lead.landingPath` und die UTM-Felder sagen, *woher* jemand kam, nicht *wie viele* kamen | Analytics-Quelle anbinden (Plausible, Umami, GA4) und als `KpiDefinition` mit `source = MANUAL` oder über eine Importroute führen |
| **Marketing ROI** | `Expense.category = MARKETING` gibt die Kosten. Der zugeordnete Umsatz braucht die Kette Lead → Kundschaft → Rechnung; `Lead.utmCampaign` ist gesetzt, aber `Customer` trägt die Herkunft nicht weiter | `Customer.acquisitionSource` und `acquisitionCampaign` beim Umwandeln aus dem Lead mitschreiben. Bis dahin: Kosten je Lead zeigen, ROI weglassen |
| **Google-Bewertungsschnitt** | `Review.source` kennt `google`, aber nichts importiert von dort | Google-Business-Profile-Anbindung oder manuelle Kennzahl |
| **Mitarbeiterzufriedenheit** | Kein Datenmodell dafür | Eigene Umfrage — eigenes Vorhaben, nicht Teil dieses Moduls |

Empfehlung: `Customer.acquisitionSource` in Phase 1 mitnehmen. Ein Feld und
drei Zeilen in `crm.service.ts` beim Umwandeln — danach ist die
Marketing-Zuordnung ab dem ersten Tag richtig, statt rückwirkend unmöglich.

---

## 4. Gesundheitswert

### 4.1 Zusammensetzung

Sechs Komponenten, je eine Teilnote 0..100 und ein Gewicht. Die Gewichte
stehen auf `KpiDefinition.healthWeight` und sind änderbar — die Vorgabe
unten ist ein Vorschlag, keine Wahrheit.

| Komponente | Kennzahlen | Gewicht |
| --- | --- | --- |
| Liquidität | `invoice.dso`, `invoice.overdue` ins Verhältnis zum Monatsumsatz | 20 |
| Ertrag | `margin.gross`, `profit.operating` | 20 |
| Wachstum | `revenue.growthYoY`, `customer.growth` | 15 |
| Auftragslage | `job.backlog` gegen Kapazität, `booking.cancellationRate` | 15 |
| Kundschaft | `customer.satisfaction`, `customer.repeatRate` | 15 |
| Betrieb | `employee.utilization`, `quote.conversion` | 15 |

### 4.2 Von der Kennzahl zur Teilnote

```ts
/**
 * Teilnote einer Komponente, 0..100.
 *
 * Linear zwischen Warnschwelle und Zielwert, an beiden Enden gekappt. Ein
 * weicher Verlauf (Sigmoid) sähe eleganter aus, wäre aber nicht erklärbar —
 * und Erklärbarkeit ist bei dieser Zahl der ganze Punkt. Wer fragt, warum
 * die Liquidität 62 Punkte hat, soll die Rechnung in einem Satz hören.
 *
 * Kein Zielwert gesetzt = die Komponente fliesst nicht ein und ihr Gewicht
 * wird aus dem Nenner genommen. Ein erfundener Zielwert wäre die schlechtere
 * Variante: er sähe aus wie eine Vorgabe.
 */
function subScore(value: number, warn: number, target: number, direction: KpiDirection): number {
  const span = target - warn;
  if (span === 0) return value === target ? 100 : 0;
  const raw = ((value - warn) / span) * 100;
  return Math.max(0, Math.min(100, direction === 'UP_IS_GOOD' ? raw : 100 - raw));
}

const score = Math.round(
  components.reduce((sum, c) => sum + c.subScore * c.weight, 0) /
    components.reduce((sum, c) => sum + c.weight, 0),
);
```

### 4.3 Was gespeichert wird

`HealthSnapshot.components` trägt die vollständige Herleitung:

```json
[
  {
    "key": "liquiditaet",
    "label": "Liquidität",
    "subScore": 62,
    "weight": 20,
    "contribution": 12.4,
    "metrics": [
      { "key": "invoice.dso", "value": 41.2, "warn": 45, "target": 25, "unit": "DAYS" },
      { "key": "invoice.overdue", "value": 18400.0, "warn": 20000, "target": 0, "unit": "CURRENCY" }
    ]
  }
]
```

Dasselbe Muster wie `Booking.priceBreakdown`, aus demselben Grund: eine Zahl,
deren Zustandekommen man nur mit dem heutigen Datenstand nachvollziehen kann,
hält keiner Rückfrage stand — und Gewichte und Zielwerte ändern sich.

### 4.4 `topRisk`

Die Komponente mit dem grössten Abstand zwischen Gewicht und Beitrag,
formuliert mit der Kennzahl, die sie drückt:

> „Liquidität — CHF 18 400 überfällig, 41 Tage bis Zahlungseingang"

Ein Cockpit, das „73 von 100" sagt, hilft niemandem. Eines, das sagt, welche
Zahl die fehlenden 27 Punkte verursacht, löst eine Handlung aus. Diese Zeile
steht im Cockpit direkt unter dem Wert und ist der eigentliche Nutzen der
ganzen Rechnung.

---

## 5. Szenariorechner

`scenario.service.ts`, monatsweise über `horizonMonths`. Treiber aus
`ScenarioAssumption`; unbekannte Schlüssel meldet der Dienst, statt sie zu
übergehen.

| Schlüssel | Bedeutung |
| --- | --- |
| `jobsPerMonth` | Abgeschlossene Aufträge je Monat |
| `averageTicket` | Ø Nettoerlös je Auftrag |
| `laborCostPct` | Lohnkosten in % des Umsatzes |
| `materialCostPct` | Materialkosten in % des Umsatzes |
| `overheadPerMonth` | Fixkosten je Monat |
| `investmentPerMonth` | Investitionen je Monat |
| `churnPct` | Monatlicher Kundenverlust in % |
| `paymentDelayDays` | Ø Zahlungsverzug — trennt Umsatz von Liquidität |

```
für jeden Monat m in 0..horizonMonths-1:
  aufträge(m)   = jobsPerMonth   × (1 + monthlyChangePct/100)^m
  bon(m)        = averageTicket  × (1 + monthlyChangePct/100)^m
  umsatz(m)     = aufträge(m) × bon(m)
  variabel(m)   = umsatz(m) × (laborCostPct + materialCostPct) / 100
  db(m)         = umsatz(m) − variabel(m)
  ergebnis(m)   = db(m) − overheadPerMonth(m)
  einzahlung(m) = umsatz(m − round(paymentDelayDays / 30))
  liquidität(m) = liquidität(m−1) + einzahlung(m) − variabel(m)
                  − overheadPerMonth(m) − investmentPerMonth(m)
```

Abgeleitet:

- **Break-even-Monat** — erster Monat mit kumuliertem `ergebnis ≥ 0`
- **Liquiditätstiefpunkt** — Minimum der Liquiditätsreihe samt Monat. Die
  eigentlich interessante Zahl: ein Szenario mit gutem Jahresergebnis kann im
  vierten Monat zahlungsunfähig sein
- **Benötigte Mitarbeitende** — `aufträge(m) × Ø Stunden je Auftrag /
  (Sollstunden je Monat × Zielauslastung)`
- **Benötigte Kundschaft** — `aufträge(m) / Ø Aufträge je Kundschaft und
  Monat`, aus den letzten zwölf Monaten

Das Ergebnis geht als `Scenario.result` in die Datenbank — mit Reihen je
Monat und den Annahmen, die zur Rechnung geführt haben. Ein Szenario, das
bei jedem Öffnen neu rechnet, zeigt andere Zahlen als die Fassung, über die
in der Sitzung gesprochen wurde.

**Vorbelegung aus dem Ist.** Beim Anlegen schlägt der Dienst die Treiber aus
den letzten zwölf Monaten vor. Ein leeres Szenarioformular mit acht
Zahlenfeldern füllt niemand aus; eines, das bei den echten Werten steht und
zum Verändern einlädt, schon.

---

## 6. Abschreibung

`investment.service.ts`, gerechnet statt gespeichert. Aus
`purchaseAmount`, `residualValue`, `usefulLifeYears`, `method` und
`commissionedOn` ergibt sich der Restwert zu jedem Stichtag eindeutig.

**Linear:**

```
jahresbetrag = (purchaseAmount − residualValue) / usefulLifeYears
restwert(t)  = purchaseAmount − jahresbetrag × jahre_seit(commissionedOn, t)
               (nicht unter residualValue)
```

**Degressiv:**

```
satz         = 1 − (residualValue / purchaseAmount)^(1 / usefulLifeYears)
restwert(t)  = purchaseAmount × (1 − satz)^jahre_seit(commissionedOn, t)
```

Pro-rata-temporis im ersten und letzten Jahr, auf Monate genau —
Anschaffungen verteilen sich nicht auf Jahresanfänge.

`method = NONE` für Dinge ohne Abnutzung (Grundstücke, Kautionen).
`usefulLifeYears` fehlt bei `STRAIGHT_LINE` oder `DECLINING` →
`BusinessRuleError`, keine stille Null.

Das Anlagenverzeichnis zeigt je Position Anschaffungswert, kumulierte
Abschreibung, Restwert und Restnutzungsdauer. Damit ist der Punkt „Asset
Management" aus dem Auftrag erledigt, ohne ein zweites Modell —
Fahrzeuge und Maschinen sind Investitionen mit Inventarnummer und Standort.

---

## 7. Budgetabweichung

`budget.service.ts`, `GET /api/bi/budgets/{id}/variance`:

```
plan(zeile)      = revisedAmount ?? plannedAmount
ist(zeile)       = Σ Expense.netAmount
                     WHERE organizationId = …
                       AND category = zeile.category
                       AND expenseDate BETWEEN period.startsOn AND min(heute, period.endsOn)
abweichung       = ist − plan_anteilig
plan_anteilig    = Σ monthlyPlan[0 .. aktueller Monat]   (oder plan × verstrichene Monate / 12)
hochrechnung     = ist / verstrichene Monate × 12
```

Der anteilige Plan ist der Punkt. Ein Vergleich des Jahresplans mit dem
Ist von vier Monaten meldet im April überall eine gewaltige Unterschreitung
und trainiert alle darauf, die Abweichungsspalte zu übersehen.

Die Hochrechnung gilt erst ab drei verstrichenen Monaten; davor ist sie
Rauschen mal zwölf, und die Oberfläche zeigt stattdessen „—".

---

## 8. Insights

`insight.service.ts` liest Snapshots und meldet Auffälligkeiten. Regelbasiert,
kein Sprachmodell — eine Regel ist erklärbar und wird nicht erfinderisch.

| Regel | Auslöser | Meldung |
| --- | --- | --- |
| Trendbruch | 3 Perioden gleiche Richtung, dann Umkehr > 15 % | „Umsatz bricht nach drei Wachstumsmonaten ein" |
| Zielverfehlung | Wert < 80 % des Ziels bei ≥ 50 % verstrichener Periode | „Quartalsumsatz liegt bei 62 % des Ziels, 70 % der Zeit sind um" |
| Saisonalität | Monat weicht > 25 % vom Vorjahresmonat ab | „Februar liegt 31 % unter dem Vorjahresfebruar" |
| Liquiditätswarnung | Überfällige Rechnungen > 25 % des Monatsumsatzes | „CHF 18 400 überfällig — 31 % eines Monatsumsatzes" |
| Klumpenrisiko | Grösste Kundschaft > 20 % des Umsatzes | „Ein Kunde macht 27 % des Umsatzes aus" |
| Auslastungslücke | Auslastung < 65 % bei gleichzeitigem Auftragsrückstand | „Auslastung 58 %, gleichzeitig 14 unzugeteilte Einsätze" |
| Fällige Prüfungen | ≥ 1 Eintrag über `nextReviewAt` | „7 Einträge warten seit über 30 Tagen auf Prüfung" |

Jede Meldung trägt einen Verweis auf die Seite, wo man etwas tun kann —
ein Insight ohne Handlungsmöglichkeit ist eine Beschwerde.

Klumpenrisiko braucht `getTopCustomers()` aus `analytics.service.ts`, das
bereits existiert.

---

## 9. Startbestückung

`prisma/seed.ts` legt die Kennzahldefinitionen an — nicht `seed-demo.ts`:
sie sind Konfiguration, kein Demodatensatz. Vorschlag für die Startmenge, mit
Gewichten für den Gesundheitswert:

```
revenue.net                MONTH QUARTER YEAR   Gewicht 0
revenue.growthYoY          MONTH QUARTER        Gewicht 8
revenue.recurringShare     MONTH                Gewicht 7
margin.gross               MONTH QUARTER        Gewicht 12
profit.operating           MONTH QUARTER YEAR   Gewicht 8
invoice.outstanding        MONTH                Gewicht 0
invoice.overdue            MONTH                Gewicht 10
invoice.dso                MONTH                Gewicht 10
quote.conversion           MONTH QUARTER        Gewicht 8
lead.new                   MONTH                Gewicht 0
booking.completed          MONTH                Gewicht 0
booking.cancellationRate   MONTH                Gewicht 7
customer.active            MONTH                Gewicht 0
customer.growth            QUARTER              Gewicht 7
customer.repeatRate        QUARTER              Gewicht 8
customer.satisfaction      MONTH QUARTER        Gewicht 7
employee.utilization       MONTH                Gewicht 8
```

Zielwerte bleiben beim Seed **leer**. Sie sind betriebliche Entscheidungen,
und erfundene Vorgaben („Ziel: 30 % Marge") sehen in der Oberfläche aus wie
eine Absprache, die es nie gab. Das Cockpit zeigt für Kennzahlen ohne
Zielwert den Verlauf ohne Note und fordert einmal auf, ein Ziel zu setzen.

### 9.1 Rückwärtsfüllung

Nach der Migration einmalig ein Skript, das Snapshots für die vergangenen
24 Monate nachrechnet und sofort `provisional = false` setzt:

```bash
npx tsx scripts/backfill-kpi.ts --months 24
```

Ohne das ist das Cockpit am ersten Tag leer, und ein Verlauf mit einem
einzigen Punkt überzeugt niemanden, das Modul weiter zu benutzen. Das Skript
gehört als `scripts/backfill-kpi.ts` ins Projekt, nicht als einmaliger
Handgriff — es wird beim nächsten Kennzahlzuwachs wieder gebraucht.
