# Unternehmensführung — Bauplan

Ausbau des Businessplan-Gedankens zu einem Führungsmodul: Kennzahlen, Ziele,
Finanzplanung, Risiko und Wissen an einem Ort, gespeist aus den Daten, die
Clenaris ohnehin schon führt.

Dieses Verzeichnis ist **Spezifikation, kein Code**. Es ist so geschrieben,
dass jede Phase als Auftrag an Claude Code lokal gegeben werden kann
(`prompts/`), und dass ein Mensch nachprüfen kann, ob das Ergebnis stimmt.

| Datei | Inhalt |
| --- | --- |
| `00-UEBERSICHT.md` | Umfang, Architekturentscheide, was bewusst *nicht* gebaut wird, Phasenplan |
| `01-DATENMODELL.md` | Vollständige Prisma-Erweiterung, einfügefertig |
| `02-BERECHTIGUNGEN.md` | Neue Rechte, Rollenzuordnung, Navigations-Einbindung |
| `03-API-UND-SEITEN.md` | Endpunkte mit Schutz, Seitenbaum, Dienste |
| `04-KENNZAHLEN.md` | Jede Kennzahl mit Formel auf echten Spalten |
| `05-MIGRATION-TESTS-BETRIEB.md` | Migrationsweg, Testsuiten, Cron, Datenschutz |
| `prompts/PHASE-*.md` | Je ein fertiger Auftrag pro Phase |

---

## 1. Ausgangslage

Die Anwendung hat heute 84 Prisma-Modelle, rund 250 Endpunkte und ein
Führungsmodul **gar nicht** — weder `Businessplan`, noch `OKR`, `KPI`,
`Strategy` oder `Risk` kommen im Schema vor. Was aufgebaut wird, wird von
Grund auf aufgebaut.

Gleichzeitig ist ein grosser Teil dessen, was im Auftrag als „neues Modul"
steht, bereits vorhanden. Das ist die wichtigste Erkenntnis dieses Bauplans
und der Grund, warum er kürzer ausfällt als der Auftrag:

| Gewünschtes Modul | Stand |
| --- | --- |
| HR Management | `Employee`, `EmployeeSkill`, `Absence`, `Payslip`, `JobPosting`, `JobApplication`, `TimeEntry` — **existiert**, braucht Auswertung, kein zweites Modul |
| Supplier & Procurement | `Supplier`, `Expense`, `MaterialUsage` — **existiert**, es fehlen Bestellungen und Lieferantenbewertung |
| Executive Cockpit | **Ist** das Company Health Dashboard. Zwei Seiten mit denselben Zahlen laufen garantiert auseinander |
| Task & Action Management | `Task` mit Priorität, Frist, Zuweisung, Erinnerung — **existiert**. Ziele erzeugen echte `Task`-Zeilen, kein Parallelsystem |
| Automated Reporting | `/api/exports/*`, `src/lib/pdf/`, `/api/cron/daily` — **Infrastruktur existiert**, es fehlt der Zeitplan |
| Document Management | `FileAsset`, `StoredFile`, `src/lib/storage/` — **Speicher existiert**, es fehlen Kategorie, Version, Zugriffsregel |
| KI-Assistent | `src/lib/ai/features.ts`, `/api/ai/*`, Recht `ai:use` — **existiert**, neue Fähigkeiten kommen dort hinein |
| Asset Management | Fehlt vollständig. Fahrzeuge und Maschinen tauchen nur als `ExpenseCategory` auf |
| Compliance / ISO 9001 / BCDR | Fehlt. `Consent` und `AuditLog` decken den Datenschutz-Teil technisch ab |

Ein „HR-Modul" oder ein „Executive Cockpit" zusätzlich zu bauen hiesse,
dieselben Daten ein zweites Mal zu modellieren. Der Bauplan erweitert
stattdessen, was da ist.

---

## 2. Die sechs Module

Die rund 25 Punkte des Auftrags zerfallen in zwei Klassen, und der
Unterschied entscheidet über den Nutzen:

**Abgeleitet** — die Zahl entsteht aus Daten, die im Tagesgeschäft ohnehin
anfallen. Niemand pflegt etwas, die Zahl ist am ersten Tag richtig.
Company Health, Kennzahlen, Insights, Budget-Ist, Szenario-Rechnung.

**Erfasst** — jemand muss es hinschreiben und aktuell halten. OKR, Strategie,
Roadmap, SWOT, PESTEL, Risiken, Wettbewerber, Marktforschung, Sitzungen,
Wissensdatenbank. Technisch einfach, betrieblich teuer: ein SWOT von 2026,
das 2028 noch unverändert dasteht, ist schlimmer als keines — es sieht
gepflegt aus.

Daraus sechs Module statt 25:

### M1 — Cockpit *(abgeleitet)*
Gesundheitswert der Firma mit nachvollziehbarer Herleitung, Kennzahlen mit
Verlauf, Insights. Fundament für alles Weitere: ohne Kennzahlmaschine ist ein
Key Result nur ein Prozentfeld, das jemand von Hand hochschraubt.

### M2 — Ziele *(erfasst, aber mit abgeleitetem Fortschritt)*
OKR, Strategie und Roadmap sind **dasselbe Objekt auf drei Flughöhen** und
bekommen deshalb eine Tabelle mit `horizon`-Feld und Selbstbezug:
Strategie → Ziel → Initiative. Ein Key Result verweist auf eine
Kennzahldefinition aus M1 und berechnet seinen Fortschritt selbst.
Die Roadmap ist eine Zeitachsen-Ansicht derselben Datensätze, keine zweite
Tabelle.

### M3 — Finanzplanung *(abgeleitet + erfasst)*
Budget, Investitionen, Szenarien. Budgetzeilen hängen an der bestehenden
`ExpenseCategory` — damit kommt die Ist-Spalte gratis aus `Expense`, ohne
zweite Kostenartenlogik. Szenarien rechnen aus Treibern (Aufträge/Monat,
Durchschnittsbon, Lohnquote), nicht aus handgetippten Ergebniszahlen.

### M4 — Risiko und Qualität *(erfasst)*
Risikoregister mit Matrix, Kontrollen/SOPs mit Prüfzyklus, Massnahmen (CAPA).
Deckt ISO 9001, Compliance und Notfallplanung mit **einem** Modell ab: alle
drei sind „eine Anforderung, ein Verantwortlicher, ein Prüfdatum".

### M5 — Wissen und Dokumente *(erfasst)*
Dokumentenablage mit Kategorie, Version und Zugriffsregel; Wissensartikel;
Wettbewerber; Marktbeobachtung; Sitzungsprotokolle, deren Pendenzen echte
`Task`-Zeilen erzeugen.

### M6 — Berichte *(abgeleitet)*
Zeitgesteuerte Berichte auf der vorhandenen PDF- und Export-Schicht.

---

## 3. Architekturentscheide

Diese sechs Punkte sind der Kern. Wer sie umgeht, baut etwas anderes.

### 3.1 Kennzahlen werden festgeschrieben, nicht jedes Mal neu gerechnet

Eine Verlaufskurve, die live aus dem aktuellen Datenbestand entsteht,
**schreibt die Vergangenheit um**: eine stornierte Buchung, eine
zusammengeführte Kundschaft oder eine Gutschrift verändert rückwirkend einen
Monat, der längst besprochen war. Wer im März eine Marge von 31 % gemeldet
hat und im Juni 28 % auf demselben Chart sieht, verliert das Vertrauen in die
Zahl — zu Recht.

Deshalb: `/api/cron/daily` schreibt je Kennzahl und Periode eine
`KpiSnapshot`-Zeile. Charts lesen Snapshots. Die **laufende** Periode wird
live gerechnet und als vorläufig gekennzeichnet. Beim Periodenwechsel wird
festgeschrieben und danach nicht mehr angefasst.

Das ist dieselbe Haltung, die im Rechnungswesen bereits gilt („Financial
records are append-only", `AccountingExport`), nur eine Ebene höher.

### 3.2 Der Gesundheitswert trägt seine Herleitung mit sich

Eine einzelne Zahl zwischen 0 und 100, die niemand erklären kann, ist
schlechter als keine Zahl: sie wird geglaubt, bis sie einmal falsch ist, und
danach nie wieder.

Der Wert ist deshalb eine **gewichtete Summe benannter Komponenten**, und
jeder Snapshot speichert die vollständige Herleitung als JSON —
Rohwert, Zielwert, Teilnote, Gewicht, Beitrag je Komponente.

Das Muster existiert im Haus: `Booking.priceBreakdown` speichert die
vollständige Preisherleitung aus genau demselben Grund. Der Gesundheitswert
folgt ihm.

Die Oberfläche zeigt nie nur die Zahl, sondern immer die Komponente, die
sie am stärksten drückt. Ein Cockpit, das sagt „73 von 100", hilft niemandem;
eines, das sagt „73 — gedrückt von CHF 18 400 offenen Rechnungen über
60 Tagen", löst eine Handlung aus.

### 3.3 Fortschritt wird gemessen, nicht gemeldet

Jedes Key Result verweist entweder auf eine `KpiDefinition` (Fortschritt wird
aus dem Snapshot gerechnet) oder ist ausdrücklich manuell. Ein Feld
„Fortschritt in %", das jemand monatlich schätzt, ist der Grund, warum OKR in
kleinen Firmen nach zwei Quartalen einschläft.

Manuelle Key Results bleiben möglich — aber sie sind in der Oberfläche
sichtbar als manuell gekennzeichnet, und wenn sie 30 Tage nicht angefasst
wurden, gelten sie als überfällig.

### 3.4 Geführte Einträge haben einen Prüfzyklus oder sie verfallen

Jeder erfasste Datensatz in M2, M4 und M5 trägt `reviewIntervalDays` und
`nextReviewAt`. Der Nachtlauf zählt, was überfällig ist, und das ist die
**Zahl am Menüpunkt** — dieselbe Logik wie bei offenen Buchungen und
überfälligen Rechnungen heute.

Ohne das verrottet das Modul still. Mit dem Zähler verrottet es sichtbar,
und das ist der entscheidende Unterschied.

### 3.5 Der KI-Assistent schlägt vor, er speichert nicht

Die Anwendung hat dieses Muster bereits durchgezogen: `quote-draft`,
`blog-draft`, `reply-draft`, `report/draft` — die KI erzeugt einen Entwurf,
ein Mensch prüft und speichert. Die BI-Fähigkeiten kommen in
`src/lib/ai/features.ts` dazu und folgen derselben Regel. Keine Route, bei
der ein Modell direkt in `Objective`, `RiskEntry` oder `BudgetLine` schreibt.

Ein Modell, das ein Risiko selbst als „mitigiert" markiert, ist eine
Auditfeststellung, keine Funktion.

### 3.6 Die Dokumentenablage ist die heikelste neue Fläche

Sie soll Verträge, Versicherungspolicen, Personaldokumente und Steuerunterlagen
aufnehmen. Damit ist sie die einzige neue Tabelle, bei der ein Fehler in der
Zugriffsprüfung sofort ein Datenschutzvorfall ist.

Regel aus `CLAUDE.md`, hier besonders scharf: **die Sichtbarkeit steht in der
Prisma-`where`-Klausel, nicht im Rendering.** Jedes Dokument trägt
`visibility` und optional `subjectEmployeeId`; der Dienst filtert, bevor
irgendetwas geladen wird. `tests/api/ownership.test.ts` bekommt Fälle dafür
— eine Prüfung, die nur den Statuscode ansieht, findet ein Leck nicht.

---

## 4. Was bewusst nicht gebaut wird

| Nicht bauen | Grund |
| --- | --- |
| Eigenes Executive Cockpit neben Company Health | Dieselben Zahlen an zwei Orten laufen auseinander. Eine Seite, Rollenfilter darauf |
| Eigenes HR-Modul | `Employee` & Co. existieren. Was fehlt, sind Auswertungen — die gehören in M1 |
| Eigenes Task-System für Ziele | `Task` existiert, inklusive Erinnerung und Benachrichtigung. Ziele erzeugen `Task`-Zeilen |
| Eigenes Lieferantenmodul | `Supplier` existiert. Bestellwesen ist ein *eigenes* Projekt, nicht Teil der Unternehmensführung |
| Multi-Tenant-SaaS / Franchise | Die Anwendung ist bewusst „single tenant, multi-tenant schema". Der Umbau ist ein Projekt für sich und muss vor der Produktivsetzung entschieden werden, nicht nebenbei |
| Video-Hosting in der Wissensdatenbank | Videos werden verlinkt, nicht gespeichert. Eigenes Hosting bedeutet Transcodierung, Bandbreite und Kosten für einen Nutzen, den ein Link erfüllt |
| Website-Conversion-Rate | Nicht berechenbar. Es gibt keine Sitzungszählung — nur `Lead.landingPath` und UTM-Felder. Ohne Analytics-Quelle wäre jede Zahl erfunden. Siehe `04-KENNZAHLEN.md`, Abschnitt „Nicht berechenbar" |
| Google-Bewertungsschnitt | `Review.source` kennt `google`, aber niemand importiert von dort. Entweder Anbindung bauen oder Feld weglassen |

Ein Modul weniger, das stimmt, schlägt fünf, die niemand pflegt.

---

## 5. Phasenplan

Jede Phase ist für sich lauffähig, hat eine eigene Migration und lässt sich
einzeln ausliefern. Reihenfolge ist nicht beliebig: M1 ist Voraussetzung für
den automatischen Fortschritt in M2 und für die Ist-Werte in M3.

| Phase | Inhalt | Neue Modelle | Neue Endpunkte | Abhängig von |
| --- | --- | --- | --- | --- |
| **1** | Kennzahlmaschine, Snapshots, Nachtlauf | 3 | 4 | — |
| **2** | Cockpit-Seite, Gesundheitswert, Insights | 1 | 3 | 1 |
| **3** | Ziele: Strategie / OKR / Roadmap | 4 | 9 | 1 |
| **4** | Finanzplanung: Budget, Investitionen, Szenarien | 5 | 11 | 1 |
| **5** | Risiko, Kontrollen, Massnahmen | 3 | 9 | — |
| **6** | Dokumente, Wissen, Wettbewerb, Sitzungen | 6 | 14 | — |
| **7** | Zeitgesteuerte Berichte | 2 | 4 | 1–4 |

Realistischer Aufwand mit Claude Code, inklusive Migration, Tests und
Durchsehen: Phase 1–2 zusammen etwa ein Arbeitstag, Phasen 3–6 je ein bis
zwei. Phase 7 ein halber, weil die PDF-Schicht steht.

**Empfehlung:** Phasen 1, 2 und 4 zuerst. Sie liefern am ersten Tag richtige
Zahlen, weil sie nichts erfasst brauchen. Danach entscheiden, ob 3, 5 und 6
wirklich gepflegt werden — an dem Punkt sieht man am Cockpit, was fehlt.

---

## 6. Regeln, die für jede Phase gelten

Aus `CLAUDE.md` und `docs/ARCHITECTURE.md`, hier als Prüfliste, weil jeder
einzelne Punkt schon einmal jemanden gekostet hat:

1. **Deutsch.** Oberfläche, Fehlermeldungen, Kommentare, Commit-Nachrichten.
   Schweizer Orthografie: `ss`, nie `ß`.
2. **Lesen im Server Component, schreiben über Route Handler.** Keine Server
   Actions für Mutationen.
3. **Jeder Endpunkt über `defineRoute`**, mit `permissions`, Schemas und
   `rateLimit`. Es gibt keinen Weg, eine Route ohne Schutz zu schreiben.
4. **Alle Zod-Schemas in `src/lib/validation/`**, nie inline in der Route.
5. **Fachlogik in `src/server/services/`.** Route Handler übersetzen HTTP in
   Dienstaufrufe.
6. **`organizationId` in jeder `where`-Klausel.**
7. **`Decimal(12,2)` für Beträge**, `toNumber()` erst an der Anzeigekante.
   `timestamptz` in UTC, Anzeige Europe/Zurich.
8. **`BusinessRuleError` ist 422**, nicht 400.
9. **`scripts/openapi-routes.ts` mitpflegen** — `npm run docs` schlägt sonst
   fehl, und zwar absichtlich.
10. **Keine `prisma migrate reset`.** Der Weg steht in
    `05-MIGRATION-TESTS-BETRIEB.md`.
11. **Server stoppen vor `npm run build`** (Prisma-DLL-Sperre unter Windows).
12. **Dateien mit Write/Edit schreiben, nicht mit PowerShell-Umleitung** —
    zweimal hat das Dateien mit BOM zerschossen.
