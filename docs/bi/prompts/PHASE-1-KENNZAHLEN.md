# Phase 1 — Kennzahlmaschine

Baue die Kennzahlmaschine des Führungsmoduls. Sie ist das Fundament für
Cockpit, Ziele und Finanzplanung; ohne sie sind Fortschrittsanzeigen und
Budgetvergleiche handgepflegte Zahlen.

**Lies zuerst** `docs/bi/00-UEBERSICHT.md`, `docs/bi/01-DATENMODELL.md`
(Abschnitte 1 und 8), `docs/bi/02-BERECHTIGUNGEN.md` und
`docs/bi/04-KENNZAHLEN.md`. Die Formeln dort sind verbindlich — sie stehen
auf echten Spalten und wurden gegen das Schema geprüft.

## Umfang

### 1. Schema

`KpiDefinition`, `KpiTarget`, `KpiSnapshot` samt Enums `KpiUnit`,
`KpiDirection`, `KpiPeriod`, `KpiSource` — wörtlich aus
`01-DATENMODELL.md` Abschnitt 1, einschliesslich der Kommentare. Dazu die
Rückbeziehungen auf `Organization` aus Abschnitt 8.1.

Zusätzlich zwei kleine Ergänzungen an bestehenden Modellen, beide begründet
in `04-KENNZAHLEN.md`:

- `Organization.weeklyHours Decimal @default(42) @db.Decimal(4,1)` —
  Sollstunden je Woche für die Auslastungsrechnung. Als Feld, nicht als
  Konstante im Code: das ist eine betriebliche Grösse.
- `Customer.acquisitionSource LeadSource?` und
  `Customer.acquisitionCampaign String?` — beim Umwandeln eines Leads in
  `crm.service.ts` mitschreiben. Ohne das ist die Marketing-Zuordnung
  rückwirkend nicht mehr herstellbar.

Migration über den Weg in `docs/bi/05-MIGRATION-TESTS-BETRIEB.md`
Abschnitt 1. **Kein `prisma migrate reset`**, auch wenn Prisma es vorschlägt.

### 2. Rechenkern

`src/server/services/kpi.service.ts` mit der Registry
`KPI_CALCULATORS: Record<string, KpiCalculator>` und je einem Rechner für
die 17 Kennzahlen aus `04-KENNZAHLEN.md` Abschnitt 9.

Halte dich an die gemeinsamen Regeln aus Abschnitt 1 dort:
gültige Rechnungsstatus, `issueDate` als Periodendatum, netto statt brutto,
`null` bei leerem Nenner, `sampleSize` mitschreiben.
`resolveRange()` aus `analytics.service.ts` weiterverwenden statt die
Periodenbildung neu zu schreiben.

Drei Rechner verdienen besondere Sorgfalt:

- **`quote.conversion`** ist eine Kohortenmessung, keine Verhältniszahl
  zweier Zeitfenster — siehe Abschnitt 2 „Vertrieb". Sie bleibt vorläufig,
  solange Offerten der Kohorte noch offen sind.
- **`employee.utilization`** braucht Sollminuten inklusive Feiertagsabzug
  über `Holiday` und `Organization.weeklyHours`. Nur genehmigte Zeiteinträge.
- **`response.firstReply`** braucht `$queryRaw` mit `DISTINCT ON
  (thread_id)`; in reinem Prisma wären es N+1 Abfragen.

Dazu `writeSnapshots({ organizationId, period, periodStart })`: rechnet alle
aktiven Definitionen, schreibt gebündelt über `createMany` mit
`skipDuplicates`, setzt `provisional` korrekt und führt den Vorjahreswert
mit. Jeder Rechner läuft in `try/catch` — ein Fehler wird protokolliert und
übersprungen, er darf den Lauf nicht abbrechen.

Eine `DERIVED`-Definition ohne Eintrag in der Registry ist ein
Konfigurationsfehler: protokollieren, **keinen** Snapshot schreiben. Eine
stille Null sieht im Chart aus wie ein Einbruch.

### 3. Berechtigungen

`cockpit:view`, `cockpit:financials`, `kpi:read`, `kpi:manage` nach
`docs/bi/02-BERECHTIGUNGEN.md`: neue Gruppe `Unternehmensführung` in
`PERMISSION_GROUPS`, Einträge in `PERMISSIONS` und vollständige
`PERMISSION_META`-Zeilen. `MANAGER` bekommt `cockpit:view` und `kpi:read`,
nicht `cockpit:financials` und nicht `kpi:manage`.

### 4. Validierung und Endpunkte

`src/lib/validation/bi-kpi.ts`, dann die sechs Endpunkte aus
`docs/bi/03-API-UND-SEITEN.md` Abschnitt 3, Phase 1 — alle über `defineRoute`
mit `permissions` und `rateLimit`.

`POST /api/bi/kpis/{id}/value` auf eine Definition mit `source = DERIVED`
antwortet mit `BusinessRuleError` (422), nicht 400: die Eingabe war in
Ordnung, der Vorgang ist unmöglich.

### 5. Seite

`/admin/fuehrung/kennzahlen` und `/admin/fuehrung/kennzahlen/[id]`.
Liste mit Gruppierung, aktuellem Wert, Zielabstand und Sparkline;
Detailseite mit Verlauf, Zielwerten je Periode und Vorjahresvergleich.

Bestehende Bausteine benutzen: `components/app/data-list.tsx`,
`filter-bar.tsx`, `kpi-tile.tsx`, `page-parts.tsx`,
`charts/dashboard-charts.tsx`. Fehlt `kpi-tile` ein Feld, erweitere die
Komponente — baue keine zweite daneben. Die Kontaktkarte aus dem letzten
Push bleibt unverändert und ist die visuelle Richtschnur.

Vorläufige Werte sind als solche gekennzeichnet. Eine Kennzahl ohne Zielwert
zeigt den Verlauf ohne Note und fordert einmal auf, ein Ziel zu setzen.

### 6. Nachtlauf und Rückwärtsfüllung

`/api/cron/daily` um Schritt 1 aus `05-MIGRATION-TESTS-BETRIEB.md`
Abschnitt 3 erweitern — einschliesslich des Nachholens fehlender Perioden
(Abschnitt 3.2). „Alle abgeschlossenen Perioden ohne endgültigen Snapshot",
nicht „die Periode von gestern".

`scripts/backfill-kpi.ts` mit `--months N`. Ohne Rückwärtsfüllung ist das
Cockpit am ersten Tag leer, und ein Verlauf mit einem Punkt überzeugt
niemanden.

### 7. Seed

Die 17 Definitionen samt Gewichten in `prisma/seed.ts` — nicht in
`seed-demo.ts`, sie sind Konfiguration. **Zielwerte bleiben leer**:
erfundene Vorgaben sehen in der Oberfläche aus wie eine Absprache, die es
nie gab.

### 8. Doku und Tests

`scripts/openapi-routes.ts` ergänzen, `npm run docs` muss durchlaufen.
`tests/api/bi-kpi.test.ts` mit den Fällen aus
`05-MIGRATION-TESTS-BETRIEB.md` Abschnitt 2, inklusive: `MANAGER` darf
lesen, nicht verwalten; manueller Wert auf abgeleitete Kennzahl → 422;
leerer Nenner → `null`, nicht `0`.

## Fertig, wenn

- [ ] `npm run typecheck && npm run lint` sauber
- [ ] `npm run docs` läuft durch
- [ ] `npm run erd` erneuert `docs/DATABASE.md`
- [ ] `npm test` grün, neue Suite inbegriffen
- [ ] `backfill-kpi.ts --months 24` gelaufen, Verlauf sichtbar
- [ ] `/admin/fuehrung/kennzahlen` zeigt echte Zahlen aus den Demodaten
- [ ] `MANAGER` sieht die Liste, findet keine Schaltfläche zum Verwalten
- [ ] Oberfläche deutsch, `ss` statt `ß`, Kommentare erklären das Warum

## Nicht tun

- Kein Cockpit, kein Gesundheitswert — das ist Phase 2
- Keine Kennzahlen erfinden, die in `04-KENNZAHLEN.md` Abschnitt 3 als nicht
  berechenbar stehen (Website-Conversion, Marketing-ROI,
  Google-Bewertungen). Lieber keine Kachel als eine erfundene Zahl
- Kein Sprachmodell in der Berechnung
- Kein `prisma migrate reset`
