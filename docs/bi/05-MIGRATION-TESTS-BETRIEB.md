# Migration, Tests, Betrieb, Datenschutz

---

## 1. Migrationen

`CLAUDE.md` ist an dieser Stelle unmissverständlich: **kein
`prisma migrate reset`.** Frühere Migrationen sind von Hand nachbearbeitet;
Prisma schlägt deshalb gern einen destruktiven Neuaufbau vor. Der Vorschlag
ist abzulehnen — auch und gerade, wenn er wie der einfachere Weg aussieht.

Der nicht zerstörende Weg, je Phase einmal:

```bash
# 1. Server stoppen. Ein laufender `next start` hält die Prisma-Query-Engine
#    offen; der nächste Build scheitert sonst mit EPERM beim Umbenennen der
#    DLL. Das sieht aus wie ein Prisma-Fehler und ist eine Dateisperre.

# 2. Unterschied zwischen Migrationsstand und Schema als SQL erzeugen
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --script > prisma/migrations/20260913_fuehrung_phase1/migration.sql

# 3. SQL LESEN. Jedes DROP, jedes NOT NULL ohne DEFAULT auf einer gefüllten
#    Tabelle, jedes Umbenennen, das in Wahrheit ein Löschen und Anlegen ist.

# 4. Anwenden
npx prisma db execute \
  --file prisma/migrations/20260913_fuehrung_phase1/migration.sql \
  --schema prisma/schema.prisma

# 5. Als angewandt eintragen
npx prisma migrate resolve \
  --applied 20260913_fuehrung_phase1

# 6. Client und Doku
npx prisma generate
npm run erd
```

### 1.1 Worauf in diesem Vorhaben besonders zu achten ist

**`FileScope` bekommt neue Werte.** In PostgreSQL ist das
`ALTER TYPE … ADD VALUE`, und das läuft in älteren Versionen nicht in einer
Transaktion mit anderen Anweisungen. Die Enum-Erweiterung gehört in eine
eigene SQL-Datei **vor** der Migration, die die neuen Spalten anlegt.

**`Decimal[]` auf `BudgetLine.monthlyPlan`.** Prisma bildet das auf
`numeric(12,2)[]` ab. Die Länge prüft die Datenbank nicht — genau zwölf
Einträge erzwingt das Zod-Schema, und der Dienst füllt beim Anlegen mit
`plannedAmount / 12` vor.

**`ManagedDocument.currentVersionId` ↔ `DocumentVersion.documentId`** ist ein
Zirkelbezug. Prisma kommt damit zurecht (`@unique` auf der einen Seite,
`onDelete: SetNull`), aber das Anlegen braucht zwei Schritte in einer
Transaktion: erst Dokument, dann Fassung, dann Dokument aktualisieren.

**Eindeutigkeit auf `Investment.assetTag`** ist `@@unique([organizationId,
assetTag])` bei nullbarem Feld. PostgreSQL behandelt `NULL` als
verschieden — mehrere Investitionen ohne Inventarnummer sind damit erlaubt,
und das ist die Absicht.

### 1.2 Rückbau

Jede Phase ist rein additiv: neue Tabellen, neue Enum-Werte, neue optionale
Spalten auf bestehenden Modellen. Keine bestehende Spalte wird geändert oder
entfernt. Eine Phase lässt sich damit zurückrollen, indem ihre Tabellen
gelöscht werden — der übrige Betrieb merkt nichts davon.

Die einzige Ausnahme ist die `FileScope`-Erweiterung: Enum-Werte lassen sich
in PostgreSQL nicht entfernen. Das ist folgenlos, aber es ist der eine Punkt,
der bleibt.

---

## 2. Tests

Die Suite fährt die laufende Anwendung über echtes HTTP an; Dienste werden
absichtlich nicht einzeln getestet (`tests/README.md`). Neue Dateien folgen
dem.

```
tests/api/
  bi-kpi.test.ts           Snapshots, Serie, manuelle Werte, 422-Fälle
  bi-cockpit.test.ts       Gesundheitswert, Finanzfilter je Rolle
  bi-objectives.test.ts    CRUD, Fortschritt, Check-in, Zyklusschutz
  bi-budget.test.ts        Zeilen, Abweichung, Genehmigung, 422 nach Genehmigung
  bi-investments.test.ts   Abschreibung linear und degressiv
  bi-scenarios.test.ts     Rechnung, Break-even, Liquiditätstiefpunkt
  bi-governance.test.ts    Risiko, Schwere, Prüfzyklus, Massnahme
  bi-documents.test.ts     Sichtbarkeit, Fassungen, Download
tests/pages/
  bi-pages.test.ts         Jede neue Seite antwortet je Rolle korrekt
```

`tests/api/ownership.test.ts` bekommt Fälle dazu — die Datei ist der Ort,
an dem datensatzbezogener Zugriff bewiesen wird:

| Fall | Erwartung |
| --- | --- |
| `EMPLOYEE` liest fremdes Ziel über `/api/bi/objectives/{id}` | 404 (nicht 403 — der Datensatz existiert für diese Sitzung nicht) |
| `EMPLOYEE` listet Ziele | nur eigene und aktive Firmenziele |
| `EMPLOYEE` lädt fremdes Personaldokument | 404 |
| `EMPLOYEE` lädt das eigene Personaldokument | 200 |
| `MANAGER` listet Dokumente | kein `MANAGEMENT`- oder `EMPLOYEE_PRIVATE`-Eintrag |
| `MANAGER` ruft `/api/bi/budgets` | 403 |
| `MANAGER` ruft `/api/bi/cockpit` | 200, ohne Finanzkomponenten im Rumpf |
| `CUSTOMER` ruft irgendeinen `/api/bi/*`-Endpunkt | 403 |

**Der Rumpf wird geprüft, nicht nur der Statuscode.** Ein Test, der bei
`MANAGER` auf dem Cockpit 200 sieht und zufrieden ist, findet nicht, dass die
Marge im JSON steht. Genau diese Prüfung fehlte in der Vergangenheit und hat
zur Regel in `CLAUDE.md` geführt.

### 2.1 Rechnungen prüfen

Für die vier Rechenkerne gilt: die Prüfung geht über feste Eingaben mit
handgerechnetem Ergebnis, nicht über einen Vergleich mit derselben Funktion.

| Kern | Prüffall |
| --- | --- |
| Abschreibung linear | 24 000 / 4 Jahre / Restwert 0 → nach 18 Monaten Restwert 15 000 |
| Abschreibung degressiv | 20 000, Restwert 2 000, 5 Jahre → Satz 36.9 %, nach 1 Jahr 12 620 |
| Gesundheitswert | zwei Komponenten, Gewichte 20/10, Teilnoten 80/50 → 70 |
| Break-even | Fixkosten 8 000, DB-Quote 45 %, Umsatz 15 000/Mt → Monat 2 |
| Budgetabweichung | Plan 12 000/Jahr, Ist 5 200 nach 4 Monaten → +1 200 (30 %) |

### 2.2 Ablauf

```bash
npm run db:deploy && npm run db:seed:demo
npm run build && npm run start:built
npm test
```

Serieller Lauf (`--test-concurrency=1`) ist Absicht: eine Datenbank, fünf
Demokonten. Parallelität erzeugt Falschmeldungen, keine Geschwindigkeit.
Ein 429 mitten im Lauf ist erwartetes Verhalten.

`seed-demo.ts` bekommt Beispieldaten für die neuen Modelle — ohne sie testen
die Seitentests nur Leerzustände. Genug für eine sichtbare Kurve: zwei
Ziele mit Schlüsselergebnissen, ein Budget mit acht Zeilen, drei
Investitionen, drei Szenarien, fünf Risiken, drei Kontrollen, vier
Dokumente über alle Sichtbarkeitsstufen.

---

## 3. Nachtlauf

`/api/cron/daily` bekommt dazu, in dieser Reihenfolge — jeder Schritt baut
auf dem vorigen auf:

```
1. Kennzahlschnappschüsse
   • laufende Periode neu rechnen (provisional = true)
   • abgeschlossene Perioden festschreiben (provisional = false),
     wenn noch nicht geschehen
   • Vorjahreswert mitschreiben

2. Automatische Schlüsselergebnisse
   • currentValue aus dem Snapshot der zugeordneten Kennzahl
   • KeyResultCheckin mit automatic = true
   • Objective.progressPct neu berechnen

3. Gesundheitswert
   • HealthSnapshot für heute, inkl. Komponenten und topRisk

4. Fällige Prüfungen
   • Risiken, Kontrollen, Ziele, Artikel, Wettbewerber, Analysen mit
     nextReviewAt <= heute
   • eine gebündelte Benachrichtigung je verantwortlicher Person,
     nicht eine je Eintrag

5. Ablaufende Dokumente
   • expiresOn innerhalb reminderDaysBefore → Benachrichtigung

6. Fällige Berichte
   • ReportSchedule mit nextRunAt <= jetzt → ReportRun anlegen und erzeugen
```

### 3.1 Laufzeit

Die Route läuft auf Vercel mit begrenzter Ausführungszeit. Bei 17
Kennzahlen × 3 Periodenarten sind das rund 50 Berechnungen, jede mit ein
bis drei Abfragen. Das passt, aber nicht mit Reserve.

Zwei Vorkehrungen, beide von Anfang an:

**Ein Schritt darf den Lauf nicht abbrechen.** Jeder Rechner läuft in
`try/catch`; ein Fehler wird protokolliert und übersprungen. Sonst kostet
eine defekte Kennzahl den Gesundheitswert und alle Check-ins gleich mit.

**Gebündelt schreiben.** Snapshots über `createMany` mit
`skipDuplicates`, danach ein `updateMany` für die vorläufigen. 50
Einzelschreibungen in einer Schleife sind der naheliegende und der falsche
Weg.

Wenn es eng wird: `/api/cron/kpi` als eigene Route mit eigenem Zeitplan.
Dann aber gleich — nicht, wenn der Lauf zum ersten Mal in die Zeitgrenze
läuft und niemand weiss, welche Zahlen des Vortags fehlen.

### 3.2 Nachholen

Läuft der Nachtlauf nicht (Ausfall, Fehler), fehlt ein Tag. Der nächste Lauf
muss das merken und die Lücke füllen: „alle abgeschlossenen Perioden ohne
endgültigen Snapshot" statt „die Periode von gestern". Sonst hat der Verlauf
nach dem ersten Ausfall ein dauerhaftes Loch.

---

## 4. Datenschutz — DSG und DSGVO

Dieses Modul legt erstmals Daten ab, die über den Geschäftsvorfall
hinausgehen: Personaldokumente, Leistungskennzahlen je Mitarbeitenden,
Sitzungsprotokolle mit Namen.

### 4.1 Leistungsdaten je Person

`employee.utilization` und `employee.revenuePerFte` sind im Cockpit
**aggregiert** — als Betriebskennzahl über alle Mitarbeitenden.

Eine Auswertung je Person ist in der Schweiz nicht verboten, aber sie ist
eine Verhaltensüberwachung im Sinne von Art. 26 ArGV 3: zulässig zur
Leistungskontrolle, unzulässig zur dauernden Überwachung, und
informationspflichtig. Praktisch heisst das:

- Die Auswertung je Person gehört hinter `employee:read` und bleibt der
  Geschäftsleitung vorbehalten.
- Mitarbeitende sehen ihre eigenen Zahlen (`/portal/ziele`) — das ist
  ohnehin die bessere Wirkung.
- Eine Rangliste über alle Mitarbeitenden wird **nicht** gebaut. Sie ist
  technisch trivial und arbeitsrechtlich der heikelste Punkt des ganzen
  Moduls.

### 4.2 Personaldokumente

- `visibility = EMPLOYEE_PRIVATE` mit gesetztem `subjectEmployeeId` ist die
  Vorgabe für alles mit `category = EMPLOYEE`. Der Dienst setzt das, nicht
  das Formular — ein Standardwert, den man im Formular übersehen kann, wird
  übersehen.
- Jeder Download schreibt in den `AuditLog` (`AuditAction.EXPORT`, Entität
  `ManagedDocument`). Wer eine Personalakte öffnet, ist nachvollziehbar.
- Aufbewahrung: Personaldossiers fünf Jahre nach Austritt (Art. 962 OR
  sinngemäss, ArG für Zeitdaten). Das Feld `expiresOn` nimmt das auf, aber
  **automatisch gelöscht wird nichts** — die Frist meldet, ein Mensch
  entscheidet.

### 4.3 Auskunft und Löschung

Die bestehende Auskunftsfunktion muss die neuen Tabellen mit abdecken. Wo
heute Kundendaten zusammengetragen werden, kommen dazu:
`ManagedDocument` (als Betroffene), `MeetingParticipant`,
`KeyResultCheckin`, `Objective.ownerId`, `RiskEntry.ownerId`.

Das ist der Punkt, der bei solchen Erweiterungen regelmässig vergessen wird
und bei dem ersten Auskunftsbegehren auffällt.

### 4.4 KI

Die Fähigkeiten aus `03-API-UND-SEITEN.md` senden Geschäftsdaten an einen
externen Anbieter. Zwei Regeln:

- **Keine Personaldaten in Modellaufrufen.** `bi.quarterlyReview` bekommt
  aggregierte Kennzahlen, keine Namen. `bi.meetingMinutes` bekommt die
  Notizen, die jemand bewusst eingibt.
- Die bestehende `Consent`-Verwaltung und die Datenschutzerklärung nennen
  die Bearbeitung durch KI. Beim Ausbau der Nutzung gehört der Text geprüft.

---

## 5. Prüfliste je Phase

- [ ] Schema erweitert, inklusive der Rückbeziehungen aus `01-DATENMODELL.md`
      Abschnitt 8
- [ ] Migration über `diff` → `execute` → `resolve`, SQL vorher gelesen
- [ ] `npm run erd`
- [ ] Rechte in `permissions.ts`, `PERMISSION_META` vollständig
- [ ] Rollen in `rbac.ts`, `PERMISSION_ROUTES` ergänzt
- [ ] Zod-Schemas in `src/lib/validation/`
- [ ] Dienste in `src/server/services/`, `organizationId` in jeder
      `where`-Klausel
- [ ] Routen über `defineRoute`, mit `permissions` und `rateLimit`
- [ ] `scripts/openapi-routes.ts` ergänzt, `npm run docs` grün
- [ ] Seiten mit Lade-, Fehler- und Leerzustand
- [ ] Navigation und Symbole
- [ ] Tests inklusive Fälle in `ownership.test.ts`
- [ ] `npm run typecheck && npm run lint`
- [ ] Server gestoppt, `npm run build`, `npm run start:built`, `npm test`
- [ ] Deutsche Oberfläche, `ss` statt `ß`, Kommentare erklären das Warum
