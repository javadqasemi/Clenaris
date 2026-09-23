# Release-Blocker — Abschlussbericht der Stabilisierung

Stand: 2026-09-23 · Ausgangspunkt `a1887e0` · Grundlage: Release-Blocker-Liste in
`docs/LAST_ENTERPRISE_MISSION_REPORT.md` §19 (RB-001 … RB-017, davon 15 mit
„Blocks Release = YES").

Kein Push, kein Deployment, kein Zugriff auf eine Produktionsumgebung. Alle
Nachweise stammen aus der Testdatenbank (`clenaris_test`) gegen einen
Produktionsbau auf Port 3001.

**Legende Status:**
- **CLOSED:** behoben, mit Test belegt.
- **PARTIAL:** der interne Teil ist behoben, ein benannter Rest bleibt.
- **EXTERNAL:** nur ausserhalb des Codes lösbar.
- **OPEN:** nicht behoben.

---

## 1. Übersicht

| Blocker | Bereich | Status | Blockiert Release weiterhin |
|---|---|---|---|
| RB-001 | Hydration | **OPEN** | **JA** |
| RB-002 | Fassungswechsel | CLOSED | nein |
| RB-003 | Doppelte Einsätze | CLOSED | nein |
| RB-004 | Reaktivierung zerstört Historie | CLOSED | nein |
| RB-005 | Annahme an storniertem Vertrag | CLOSED | nein |
| RB-006 | Signierte Fassung änderbar | CLOSED | nein |
| RB-007 | Pause/Ausnahme/Vergangenheit | CLOSED | nein |
| RB-008 | Abrechnung je Fassung, Überlappung | CLOSED | nein |
| RB-009 | Lohn | PARTIAL + EXTERNAL | **JA**, sofern Lohn im Release |
| RB-010 | Audit-Log PII | CLOSED (Code) · Bereinigung Altbestand nicht in Produktion ausgeführt | nein, nach Bereinigung |
| RB-011 | Qualität: Zugehörigkeit | CLOSED | nein |
| RB-012 | Automatisierung | CLOSED | nein |
| RB-013 | ClamAV | PARTIAL + EXTERNAL | **JA**, bis zur Abnahme gegen echten clamd |
| RB-014 | Cron-Überwachung | CLOSED (intern) · EXTERNAL (Überwachungsdienst) | **JA**, bis ein externer Dienst `/api/cron/status` abfragt |
| RB-015 | Production V2 | EXTERNAL | **JA** |
| RB-016 | Vertrags-UI | CLOSED | — (war NO) |
| RB-017 | Testaussagen | PARTIAL | — (war NO) |

**Vorher: 15 blockierend. Geschlossen: 10 (RB-002 … RB-008, RB-010, RB-011,
RB-012). Weiterhin blockierend: 5 (RB-001, RB-009, RB-013, RB-014 extern,
RB-015).**

Zusätzlich während der Stabilisierung gefunden und behoben (nicht in der
ursprünglichen Liste): **NB-1** Standardperiode der Vertragsabrechnung,
**NB-2** Objektauswahl der Vertragsmaske (§3).

---

## 2. Die Blocker einzeln

### RB-001 — Hydration (#418)

| | |
|---|---|
| **Original Finding** | `#418 args[]=HTML` sporadisch; `/portal` 1–13 % je Bau; im Audit 3 von 5 Läufen rot |
| **Root Cause** | **Nicht gefunden.** Eingegrenzt und ausgeschlossen siehe unten |
| **Fix** | Keiner am Produkt. Diagnose ausgebaut (siehe Evidence) |
| **Tests** | Gate: 10 Browserreihen in Folge, `retries: 0` — Ergebnis §4 |
| **Status** | **OPEN — Wave 9.1 bleibt FAIL** |
| **Evidence** | `docs/HYDRATION.md` §15; `scripts/hydration-messung.ts`; Befunddateien unter `hydrationsbefunde/` (nicht versioniert) |

Was diese Stabilisierung **gemessen** hat (nichts davon vermutet):

- **Der `<body>` bleibt bis zum Fehler unverändert.** Die
  MutationObserver-Mitschrift ab dem ersten Skript zeigt nach dem Parsen
  keine einzige Veränderung im Body vor dem Fehler.
- **Das DOM nach der Wiederherstellung entspricht dem ausgelieferten HTML Tag
  für Tag.** Verglichen wurde das HTML **desselben** Aufrufs; vorher schrieb
  die Diagnose das HTML eines späteren Aufrufs mit.
- **Hypothese „Webpack entfernt Chunk-Skripte aus `<head>`" widerlegt.**
  Webpack entfernt die ausgelieferten `<script async>` nach dem Laden. In
  beiden Fehlern lag das vor `load`, in sauberen Läufen danach. Ein
  Gegenexperiment entfernte die Skripte **immer** früh: 28 Entfernungen vor
  `load`, 0 Fehler in 30 Ladevorgängen.
- **Kalt, warm, mit CPU-Drosselung ÷4:** 0 Fehler in 610 isolierten
  Ladevorgängen (100 und 80 auf `/portal/einsaetze/‹id›`, 200 auf `/portal`,
  150 auf `/admin/vertraege/‹id›`, 80 warm gedrosselt). Der Fehler tritt
  **nur in der Browserreihe** auf, dort aber in fast jedem Lauf.
- **Die Glocke** (React Query) ist seit Wave 9.1 bis nach dem Einhängen
  gesperrt und damit ausgeschlossen.

- **`<head>` im Fehlermoment** (zwölf Befunde): Alle `<meta>`/`<title>` sind
  vorhanden. Es fehlen nur die Chunk-Skripte (ausgeschlossen) und in jedem
  Befund der `<link rel="preload" as="script">` der webpack-Laufzeit. Die
  Gegenprobe zu diesem Link ist der nächste Schritt (`HYDRATION.md` §15.5).

### RB-002 — Folgefassung nicht aktivierbar

| | |
|---|---|
| **Original Finding** | N+1 an laufendem Vertrag nicht in Kraft setzbar; nach der ersten Änderung keine weitere Fassung |
| **Root Cause** | Es gab keinen Übergang „Fassung wechseln"; `activate` kannte nur die Erstfassung, ein offener Entwurf blockierte alles |
| **Fix** | `activateContractVersion` (Stichtag, Sperre auf dem Vertragskopf, SUPERSEDED/ACTIVE in einer Transaktion), `discardContractVersion` (`DISCARDED`), Route `…/versions/{id}/activate`, DELETE auf dem Entwurf, Schaltflächen in der Akte |
| **Tests** | `vertraege-integritaet.test.ts` „Fassungskette V1 → V2 → V3"; E2E B, C |
| **Status** | CLOSED |
| **Evidence** | `f8c81b1`, `eeea3b4`, `20260923110000_fassung_verworfen`, `43c044f` |

### RB-003 — Doppelte Einsätze nach Fassungswechsel

| | |
|---|---|
| **Original Finding** | Nach dem Fassungswechsel plante der Planer bereits erzeugte Tage ein zweites Mal |
| **Root Cause** | Eindeutigkeit hing an `serviceScheduleId`, und die wechselte mit jeder Fassung. Abgesagte Einsätze hielten ihren Schlüssel |
| **Fix** | `seriesKey` (Kopie über Fassungen), Teilindex `jobs_serientermin_einmal (contractId, seriesKey, scheduleDate)` ohne abgesagte/gelöschte, Abgleich `einsaetzeAbgleichen` |
| **Tests** | „kein Termin doppelt über einen Fassungswechsel"; E2E B/C (`keineDoppeltenEinsaetze`) |
| **Status** | CLOSED |
| **Evidence** | `eeea3b4`, `f8c81b1` |

### RB-004 — Reaktivierung überschreibt Gültigkeiten

| | |
|---|---|
| **Original Finding** | Aktivieren aus PAUSED/NOTICE_GIVEN setzte `effectiveFrom` aller Fassungen auf `startDate` |
| **Root Cause** | Ein Endpunkt für drei Übergänge |
| **Fix** | `activateContract` nur für die Erstfassung; PAUSED → `resumeContract`, NOTICE_GIVEN → `withdrawNotice`; Trigger `contract_versions_unveraenderlich` |
| **Tests** | „Pause, Kündigung und Rücknahme verändern keine Fassung" |
| **Status** | CLOSED |
| **Evidence** | `f8c81b1`, `eeea3b4` |

### RB-005 — Annahme an storniertem/gelöschtem Vertrag

| | |
|---|---|
| **Original Finding** | Die Unterschrift schloss an einem annullierten oder gelöschten Vertrag ab |
| **Root Cause** | Stornieren/Löschen brach keine laufende Annahme ab; der Finalizer prüfte den Vertragszustand nicht |
| **Fix** | `vertragSperren` (FOR UPDATE), `ANNAHME_ZULAESSIGE_VERTRAGSZUSTAENDE` im Finalizer, `cancelAllContractAcceptancesInTx` beim Stornieren/Löschen; Vertrag mit angenommener Fassung nicht mehr stornier-/löschbar |
| **Tests** | RB-005-Reihe inkl. Gleichzeitigkeit Storno ↔ Annahme; E2E E (Storno nach Annahme 422) |
| **Status** | CLOSED |
| **Evidence** | `f8c81b1` |

### RB-006 — Signierte Fassung änderbar

| | |
|---|---|
| **Original Finding** | Einsatzpläne und `effectiveFrom` einer signierten Fassung änderbar |
| **Root Cause** | Sperre prüfte nur `status`, nicht Bindung (angenommen/in Unterzeichnung) |
| **Fix** | `nurFreierEntwurf` in allen Planpfaden, `stichtagDerFassung`; DB-Trigger auf Fassung, Leistungen, Plänen |
| **Tests** | Integritätsreihe (auch Direkt-SQL gegen die Trigger); E2E E (422, keine Maske), C (SQL-Update abgewiesen) |
| **Status** | CLOSED — Grenze: ein Superuser, der Trigger abschaltet (`VERTRAEGE.md` §10a) |
| **Evidence** | `eeea3b4`, `f8c81b1`, `43c044f` |

### RB-007 — Pause/Ausnahme ohne Wirkung, Vergangenheit geplant

| | |
|---|---|
| **Original Finding** | Pause und Ausnahmen wirkten nur auf künftige Erzeugung; Wiederaufnahme und rückdatierte Aktivierung erzeugten Einsätze in der Vergangenheit |
| **Root Cause** | Kein Abgleich bereits erzeugter Einsätze; Untergrenze war die Fortschrittsmarke, nicht heute |
| **Fix** | `einsaetzeAbgleichen` in Pause/Wiederaufnahme/Kündigung/Ende/Ausnahme; Untergrenze `zuercherHeute()`; Pausen mit Ende und automatischer Fortsetzung |
| **Tests** | RB-007-Reihe; E2E F |
| **Status** | CLOSED |
| **Evidence** | `f8c81b1`, `43c044f` (PauseDialog) |

### RB-008 — Abrechnung mit aktueller Fassung, Überlappung

| | |
|---|---|
| **Original Finding** | Jede Periode rechnete mit der aktuellen Fassung; ein Zykluswechsel liess überlappende Perioden zu |
| **Root Cause** | Kein Periodenende; Fassung nicht je Periode ermittelt |
| **Fix** | `vertragsperiode()` je Stichtag und Fassung, Schnitt am Fassungswechsel; `invoices.contractPeriodEnd` + Ausschlussbedingung `invoices_vertragsperiode_ueberlappungsfrei` |
| **Tests** | RB-008-Reihe, Rechenkern; E2E D |
| **Status** | CLOSED |
| **Evidence** | `eeea3b4`, `f8c81b1`, `9ae6a7b` (NB-1) |

### RB-009 — Lohn

| | |
|---|---|
| **Original Finding** | Sätze fachlich unbestätigt; fehlende Bestandteile; KTG-Anzeige; UTC-Monat; aktueller statt damaliger Satz |
| **Root Cause** | technisch: Monatsfenster in UTC, Satz aus dem Personalstamm statt aus der Historie, Upsert über veröffentlichte Abrechnungen |
| **Fix** | Zürcher Monatsgrenze; Satz aus der Lohnhistorie am Tag; veröffentlichte Monate gesperrt (Lauf und Zeiterfassung); KTG in der Aufstellung; falsche Versprechen (PDF, Lohnausweis) entfernt |
| **Tests** | `lohnabrechnung.test.ts`: Monatsgrenze, Veröffentlichungssperre |
| **Status** | **PARTIAL + EXTERNAL** — keine Sätze erfunden; fachliche Prüfung durch eine Treuhand/Lohnfachperson steht aus (`PAYROLL.md` §9a); Quellensteuer, 13. ML, Zulagen, Lohnausweis, PDF fehlen. Clenaris ist **nicht** „Swiss Payroll compliant" und behauptet es nicht |
| **Evidence** | `e56233e` |

### RB-010 — Lohn- und Personaldaten im Audit-Log

| | |
|---|---|
| **Original Finding** | Lohn- und Geburtsdaten im Klartext in `audit_logs.changes` |
| **Root Cause** | Schwärzung nur über eine kurze, flache Liste von Feldnamen |
| **Fix** | `src/lib/sensitive-fields.ts` (Schlüssel + Entität, verschachtelt, Listen, `toJSON`, Freitext für AHV/IBAN/JWT), angewandt in `redact`, `diff`, Zusammenfassung und Logger; `scripts/audit-bereinigung.ts` für den Altbestand (Trockenlauf Standard) |
| **Tests** | `protokoll-schwaerzung.test.ts` (8 rein + 1 HTTP) |
| **Status** | CLOSED (Code). Altbestand: Trockenlauf auf Entwicklung 21 Einträge; **in Produktion nicht ausgeführt** — Verfahren in `KEY_MANAGEMENT.md` §3.5 |
| **Evidence** | `f992c33` |

### RB-011 — Qualität: Zugehörigkeit

| | |
|---|---|
| **Original Finding** | Begehung verband Vertrag, Objekt, Einsatz und Prüfer ohne Prüfung der Zugehörigkeit |
| **Root Cause** | Nur der Vertrag wurde geprüft |
| **Fix** | `zugehoerigkeitPruefen`; Abschluss per bedingtem Update; Massstab nur aus geltenden Fassungen; Teilindex für die Nummer |
| **Tests** | RB-011-Reihe; `qualitaet.test.ts` |
| **Status** | CLOSED |
| **Evidence** | `0c6b372`, `20260923120000_cron_ueberwachung` (Nummernindex) |

### RB-012 — Automatisierung

| | |
|---|---|
| **Original Finding** | 11 von 20 Auslösern ohne Erzeuger; Ausführung ungetestet; E-Mail-Fehler als Erfolg; hängende RUNNING |
| **Root Cause** | Zeitbezogene Auslöser hatten keinen Lauf; `notify` schluckte Zustellfehler, die Automatisierung zählte jeden Empfänger als versandt; kein Rückweg aus RUNNING |
| **Fix** | `automation-zeittrigger.service.ts` (9 zeitbezogene, im stündlichen Lauf), `QUOTE_ACCEPTED`/`RECURRING_BOOKING_GENERATE` am Ereignis; `notify` liefert `Zustellung` je Kanal, Zustellfehler → Wiederholung/FAILED, unerreichbar → SKIPPED; hängende Läufe nach 30 min zurück in die Warteschlange oder FAILED |
| **Tests** | Quelltextprüfung „kein Auslöser ohne Erzeuger", TASK_DUE Ende-zu-Ende über `/api/cron/hourly`, hängende Läufe |
| **Status** | CLOSED |
| **Evidence** | `7e98365`, `fcb822a` |

### RB-013 — ClamAV

| | |
|---|---|
| **Original Finding** | Adapter nie gegen einen Dienst erprobt; Testprüfer per Umgebungsvariable einschaltbar |
| **Root Cause** | Kein Prüfstand; eine einzige Variable schaltete die Prüfung ab |
| **Fix** | Protokoll rein und prüfbar (`clamd-protokoll.ts`); Testprüfer nur mit `CLENARIS_TEST_CACHE_DIR` **und** erkennbarer Testdatenbank; Erreichbarkeit und Version im Sicherheitszentrum |
| **Tests** | `clamd-protokoll.test.ts` gegen einen nachgebauten clamd (8/8) |
| **Status** | **PARTIAL + EXTERNAL** — Abnahme gegen einen echten clamd (EICAR, Signaturstand, `StreamMaxLength`) vor der Produktion, Verfahren in `MALWARE_PROTECTION.md` |
| **Evidence** | `f5ee959` |

### RB-014 — Cron-Überwachung

| | |
|---|---|
| **Original Finding** | Kein Monitoring, kein Alarm; Cron antwortete 200 bei Fehler |
| **Root Cause** | Keine Laufprotokolle; Statuscode unabhängig vom Ergebnis |
| **Fix** | `cron_runs`, `mitUeberwachung`, 500 bei Teilausfall, Alarme CRON_FAILED/_REPEATEDLY/_SLOW/_MISSED (Sicherheitsprotokoll, Benachrichtigung, optional HTTPS-Webhook), `GET /api/cron/status` (503 bei überfällig/hängend/3× Fehler), Tafel im Sicherheitszentrum |
| **Tests** | `beobachtbarkeit.test.ts` RB-014-Reihe |
| **Status** | CLOSED (intern) · **EXTERNAL:** Ein Überwachungsdienst muss `/api/cron/status` abfragen; ohne ihn bleibt ein Ausfall **beider** Takte unbemerkt |
| **Evidence** | `357452e`, `OBSERVABILITY.md` §6a |

### RB-015 — Production V2

| | |
|---|---|
| **Original Finding** | A6–A9, B1–B11 offen; Pipeline nie grün ausgeliefert |
| **Status** | **EXTERNAL / OPEN** — in dieser Mission ausdrücklich ohne Zugriff auf Server und ohne Deployment |

### RB-016 — Vertrags-UI · RB-017 — Testaussagen

- **RB-016** CLOSED (`43c044f`): Masken für Pause (mit Ende), Kündigung,
  Verlängerung, Preisanpassung, Annullieren, Fassung in Kraft setzen,
  verwerfen, Unterzeichnung zurückziehen.
- **RB-017** PARTIAL: Die Kernaussagen sind jetzt belegt (Integritätsreihe,
  Direkt-SQL gegen Trigger, Gleichzeitigkeit, Browserwege A–F gegen die
  Datenbank). Offen: Die älteren Titel-≠-Zusicherung-Fälle in anderen
  Dateien wurden nicht systematisch nachgeschärft.

---

## 3. Während der Stabilisierung neu gefunden

| ID | Finding | Root Cause | Fix | Test | Commit |
|---|---|---|---|---|---|
| NB-1 | „Periode abrechnen" ohne Stichtag fakturierte die **laufende** Periode, nach Fassungswechsel anteilig (1200 × 23/30) | Vorgabetag „gestern" liegt nur am ersten Periodentag in der vorigen Periode | Tag vor dem Beginn der Periode, in der heute liegt; Übersicht ab dort | `vertraege.test.ts` + E2E D | `9ae6a7b` |
| NB-2 | Objektauswahl der Vertragsmaske blieb bis zum ersten Absenden leer | Abhängigkeit in `transform` verfolgt, das nur beim Senden läuft | `ResourceForm.onFieldChange` | E2E A | `48b6215` |

Beide fand die neue Browserreihe — über HTTP waren sie unsichtbar.

---

## 4. Gates

| Gate | Ergebnis |
|---|---|
| P0 geschlossen | nein — RB-001 offen |
| Contract Gate (Wege A–F) | **PASS** — 6/6 im Browser, gegen die Datenbank geprüft |
| Hydration Gate (10 Läufe in Folge, 0 × #418) | **FAIL** — siehe Tabelle |
| HTTP-Reihe | 1258 Tests, 1257 bestanden, 0 fehlgeschlagen, 1 übersprungen (datenabhängig) |

**Hydration Gate:** Produktionsbau `.next-audit4`, `retries: 0`, 26 Fälle je Lauf.

| Lauf | Beobachter | Ergebnis | Fehlschläge (alle #418) |
|---|---|---|---|
| 1 | an | rot | 1 |
| 2 | an | rot | 2 |
| 3 | an | rot | 2 |
| 4 | an | rot | 3 |
| 5 | an | rot | 1 |
| 6 | aus | rot | 2 |
| 7 | aus | **grün** 26/26 | 0 |
| 8 | aus | **grün** 26/26 | 0 |
| 9 | aus | rot | 1 |
| 10 | aus | rot | 4 |

**Stressreihe** (`e2e:stress --laeufe 5`, Bau `.next-audit5`, frischer
Server je Lauf): 5 von 5 rot. Fehlschläge 6/4/3/3/1, **alle** mit
Hydrationsbefund.

Ausser #418 ist in 15 Browserläufen (390 Fallausführungen) **kein einziger**
Fall gescheitert. Die fachlichen Aussagen der Reihe halten, das Gate scheitert
allein an RB-001.

**Folge:** Das Stabilisierungs-Gate ist nicht bestanden. Die Waves 11–25
wurden gemäss Auftrag **nicht** begonnen.

---

## 5. Commits dieser Stabilisierung

| Commit | Inhalt |
|---|---|
| `f992c33` | RB-010 Schwärzung im Prüfprotokoll |
| `eeea3b4` | Schema: Serienidentität, Periodenende, DB-Trigger |
| `f8c81b1` | RB-002…008 Verträge: Fassungswechsel, Abgleich, Annahme fail-closed, Abrechnung je Fassung |
| `43c044f` | RB-016 Vertragsmasken |
| `0c6b372` | RB-011 Qualität: Zugehörigkeit |
| `e56233e` | RB-009 Lohn (technischer Teil) |
| `7e98365` | RB-012 Erzeuger aller Auslöser |
| `f5ee959` | RB-013 clamd-Protokoll, Prüfumgebungssperre |
| `357452e` | RB-014 Cron-Überwachung |
| `9ae6a7b` | NB-1 Standardperiode der Abrechnung |
| `48b6215` | NB-2 Objektauswahl der Vertragsmaske |
| `d6c2e6c` | E2E-Wege A–F, Messwerkzeug, Diagnose |
| `fcb822a` | RB-012 Zustellung zählt, hängende Läufe |
| `edd5e57` | Diagnose: `<head>` im Fehlermoment, Beobachter auf Anforderung |
| (folgt) | Dokumentation: dieser Bericht, HYDRATION §15, VERTRAEGE §10a, PAYROLL |

---

## 6. Merkmalsprüfung (Phase K, warning-only)

`npm run audit:merkmale`: 3 halbe Merkmale (PipelineStage, Tag, Building),
5 Dienstumgehungen, 19 schreibende Endpunkte ohne Aufruf aus der Oberfläche.

Bekannte Fehlalarme, weil die Prüfung nur literale Pfade erkennt:
- **Papierkorb:** `…/restore` (7×) wird mit zusammengesetztem Pfad
  aufgerufen.
- **Upload-Helfer:** `/api/files/upload-url` und `/api/files/finalize`
  werden aus `src/lib/upload.ts` aufgerufen, nicht aus einer Komponente.
- **Stempeluhr:** `/api/time/clock-in`, `/api/time/clock-out`.

Echte Lücken ohne Oberfläche: `/api/payroll/run|publish|settings`,
`/api/time/approve|reopen`. Sie gehören zu RB-009 und bleiben dort benannt.
