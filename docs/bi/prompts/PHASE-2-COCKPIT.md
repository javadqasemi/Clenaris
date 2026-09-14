# Phase 2 — Cockpit und Gesundheitswert

Baue das Führungscockpit: ein Gesundheitswert mit nachvollziehbarer
Herleitung, die wichtigsten Kennzahlen auf einen Blick, und Insights, die zu
einer Handlung führen.

**Voraussetzung:** Phase 1 läuft, Snapshots sind vorhanden.

**Lies zuerst** `docs/bi/01-DATENMODELL.md` Abschnitt 2,
`docs/bi/04-KENNZAHLEN.md` Abschnitte 4 und 8, `docs/bi/03-API-UND-SEITEN.md`.

## Umfang

### 1. Schema

`HealthSnapshot` wörtlich aus `01-DATENMODELL.md` Abschnitt 2, mit
Rückbeziehung auf `Organization`.

### 2. Gesundheitswert

`src/server/services/health.service.ts` nach `04-KENNZAHLEN.md` Abschnitt 4.

Sechs Komponenten mit den dort genannten Gewichten, Teilnote über
`subScore()` — linear zwischen Warnschwelle und Zielwert, an beiden Enden
gekappt. Kein weicher Verlauf: die Rechnung muss in einem Satz erklärbar
sein, und das ist der ganze Zweck dieser Zahl.

Eine Komponente ohne gesetzten Zielwert fliesst **nicht** ein und ihr Gewicht
kommt aus dem Nenner. Erfinde keinen Zielwert, um die Komponente zu retten.

`components` als JSON speichern, vollständig: je Komponente Rohwert,
Zielwert, Warnschwelle, Teilnote, Gewicht, Beitrag. Dasselbe Muster wie
`Booking.priceBreakdown`, aus demselben Grund — Gewichte und Zielwerte
ändern sich, und ohne Snapshot wäre der Wert von März nach einer Anpassung
im Juni ein anderer.

`topRisk` ist die Komponente mit dem grössten Abstand zwischen Gewicht und
Beitrag, formuliert mit der Kennzahl, die sie drückt:
„Liquidität — CHF 18 400 überfällig, 41 Tage bis Zahlungseingang". Diese
Zeile ist der eigentliche Nutzen der Rechnung; eine Zahl ohne sie löst keine
Handlung aus.

### 3. Insights

`src/server/services/insight.service.ts` mit den sieben Regeln aus
`04-KENNZAHLEN.md` Abschnitt 8. **Regelbasiert, kein Sprachmodell** — eine
Regel ist erklärbar und wird nicht erfinderisch.

Jede Meldung trägt einen Verweis auf die Seite, wo man etwas tun kann. Ein
Insight ohne Handlungsmöglichkeit ist eine Beschwerde.

Klumpenrisiko benutzt `getTopCustomers()` aus `analytics.service.ts` — die
Funktion existiert.

### 4. Endpunkte

`/api/bi/cockpit`, `/api/bi/cockpit/health`, `/api/bi/cockpit/insights`,
alle mit `cockpit:view`.

**Der Finanzfilter greift im Dienst, nicht in der Anzeige.** Ohne
`cockpit:financials` enthält schon der JSON-Rumpf keine Marge, keine
Liquidität und keine Kostenkennzahlen. Ausgeblendetes HTML steht trotzdem auf
der Leitung — das ist die Regel aus `CLAUDE.md`, und hier ist sie nicht
theoretisch.

### 5. Seite

`/admin/fuehrung` als Cockpit:

- Gesundheitswert gross, mit Veränderung zum Vormonat und `topRisk` direkt
  darunter
- Aufklappbare Herleitung: die sechs Komponenten mit Teilnote, Gewicht und
  den Kennzahlen dahinter. Wer auf die Zahl klickt, sieht die Rechnung
- Kachelreihe mit den wichtigsten Kennzahlen, Zielabstand und Sparkline
- Insights als Liste mit Verweis
- Verlauf des Gesundheitswerts über zwölf Monate

`components/app/kpi-tile.tsx` und `charts/dashboard-charts.tsx` benutzen.
Die Kontaktkarte aus dem letzten Push bleibt unverändert und gibt die
visuelle Sprache vor.

**Leerzustand ist Pflicht.** Ohne Snapshots muss die Seite sagen, was fehlt
und wie es dorthin kommt (`backfill-kpi.ts`), nicht „Keine Daten".

**Ohne Zielwerte** zeigt die Seite die Kennzahlen ohne Gesundheitswert und
führt einmal zur Zielwertpflege. Ein Wert aus null Komponenten wird nicht
angezeigt.

### 6. Navigation

Gruppe `Unternehmensführung` in `src/app/(app)/admin/layout.tsx` nach
`docs/bi/02-BERECHTIGUNGEN.md` Abschnitt 8 — in dieser Phase nur die
Einträge, die es schon gibt: Cockpit und Kennzahlen. Neue Symbole in
`NAV_ICONS`.

`PERMISSION_ROUTES` in `rbac.ts`: `/admin/fuehrung` → `cockpit:view`.
Spezifischere Pfade kommen in späteren Phasen **davor** — der erste Treffer
gewinnt.

### 7. Nachtlauf

Schritt 3 aus `05-MIGRATION-TESTS-BETRIEB.md` Abschnitt 3: ein
`HealthSnapshot` je Tag, nach den Kennzahlschnappschüssen.

### 8. Tests

`tests/api/bi-cockpit.test.ts`:

- Gesundheitswert aus zwei Komponenten mit Gewichten 20/10 und Teilnoten
  80/50 ergibt 70 — von Hand gerechnet, nicht gegen dieselbe Funktion
  geprüft
- Komponente ohne Zielwert fällt aus Zähler **und** Nenner
- `MANAGER` bekommt 200, und im **Rumpf** stehen keine Finanzkomponenten
- `EMPLOYEE` und `CUSTOMER` bekommen 403

Der dritte Fall ist der wichtige. Ein Test, der nur den Statuscode prüft,
findet nicht, dass die Marge im JSON steht.

## Fertig, wenn

- [ ] `npm run typecheck && npm run lint && npm run docs` sauber
- [ ] `npm test` grün
- [ ] `/admin/fuehrung` zeigt einen Wert, dessen Herleitung aufklappbar ist
- [ ] `topRisk` nennt eine konkrete Zahl, keinen Bereichsnamen
- [ ] Als `MANAGER` angemeldet: keine Marge, keine Liquidität, weder auf der
      Seite noch im Netzwerk-Tab
- [ ] Leerzustand ohne Snapshots ist brauchbar

## Nicht tun

- Keine zweite Cockpit-Seite für die Geschäftsleitung. Eine Seite,
  Rollenfilter darauf — zwei Seiten mit denselben Zahlen laufen auseinander
- Keine Zielwerte erfinden, damit der Wert vollständig aussieht
- Kein Sprachmodell für Insights
- Das bestehende `/admin`-Dashboard nicht anfassen
