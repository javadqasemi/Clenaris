# Releasebereitschaft — Waves 9 bis 25

Stand 2026-09-23. Ausgangspunkt `0d51466` (Next 15.5.26, `npm test`
1268/1267/0/1 übersprungen, Browser-Reihe 27/27). Fortgeschrieben am
2026-09-26 (§6) und 2026-09-27 (§7 an `5760e88`, 1905/1905, Browser 53/53;
§8 an `fb0202e`/`0023556`: Release-Lauf auf `0023556` grün, 2038/2038,
Browser 57/57, Stressreihe 5/5, CI 36332513820 grün). Die
Tabellen §1 und §3 tragen den heutigen Status; die Schlussprüfungen §4,
§6.4 und §7 bleiben als datierte Messungen stehen. **Jüngster Stand: §10
(Production-V2-Härtung, Feature Freeze, 2026-09-30/10-01)** auf dem
Release-Kandidaten aus §9 (2026-09-29, Prisma 7). Die Freigabe in §8 bezieht
sich auf den Stand vor Prisma 7 und ist für den heutigen Code keine Aussage
mehr.

**Kein Push, keine Auslieferung, kein Zugriff auf einen Produktionsserver**
in dieser Mission. Jede Aussage über die Produktion ist deshalb
**EXTERNAL VERIFICATION REQUIRED**.

Grundsatz der Einstufung: Ein Modell, eine Berechtigung, eine Route, eine
Oberfläche oder eine Testzahl ist noch kein Merkmal. **COMPLETE + VERIFIED**
heisst: der Weg existiert von der Oberfläche bis in die Datenbank, und eine
Prüfung belegt die Fachregel.

## 1. Stand je Wave

| Wave | Gegenstand | Status | Beleg | Offen |
|---|---|---|---|---|
| 9 | Lohn | **PARTIAL + EXTERNAL VERIFICATION REQUIRED** | `docs/PAYROLL.md`; `lohnabrechnung`, `lohnbestandteile`, `wave23-masken` | fachliche Prüfung durch Treuhand/Lohnfachperson; Quellensteuertarife werden nicht mitgeliefert. ~~Tarifimport ohne Maske~~ — die Maske gibt es inzwischen (`src/features/admin/withholding-rates-import.tsx`, Lohnseite), geprüft ist der Endpunkt über HTTP, die Maske nur über den Rauchtest der Seite. Clenaris ist **nicht** „Swiss Payroll compliant" und behauptet es nicht |
| 11 | Betrieb: QM, SLA, Reklamation, Material, Geräte | **COMPLETE + VERIFIED** | `docs/BETRIEB.md`; `betrieb.test.ts`, `wave23-masken` (Lagerentnahme) | — |
| 12 | Verkauf: Besichtigung → Berechnung → Offerte | **COMPLETE + VERIFIED** | `docs/VERKAUF.md`; `besichtigung.test.ts` | — |
| 13 | Finanzen: Unveränderlichkeit, Storno, Gutschrift | **COMPLETE + VERIFIED** | `docs/FINANZEN.md`; `finanzbelege.test.ts`; Saldofehler in Wave 24 behoben | steuerliche Korrektheit von Export/MWST: EXTERNAL |
| 14 | Kommunikation: Vorlagen, Zustellstatus | **COMPLETE** (Resend verifiziert) · Twilio **EXTERNAL** | `docs/KOMMUNIKATION.md`; `kommunikation.test.ts` | bearbeitbare DB-Vorlagen PARTIAL; echte Anbieter nicht angebunden |
| 15 | KI-Governance, Datensparsamkeit | **COMPLETE** · Freitextfunktionen PARTIAL | `docs/KI_GOVERNANCE.md`; `ki-governance.test.ts` | Namen im eingefügten Freitext; Auftragsverarbeitung mit dem Anbieter: EXTERNAL (rechtlich) |
| 16 | Mandantentrennung | **COMPLETE + VERIFIED** (einmandantiger Betrieb) | `docs/MANDANTEN.md`; `mandanten.test.ts` | `EmailLog`/`SmsLog` ohne Organisation — vor Mehrmandantenbetrieb nachrüsten |
| 17 | Globale Suche | **COMPLETE + VERIFIED** | `docs/SUCHE.md`; `suche.test.ts` | — |
| 18 | Barrierefreiheit | **PARTIAL** | `docs/BARRIEREFREIHEIT.md`; `wave18-barrierefreiheit.spec.ts`; seit 2026-09-27 `phase21-oberflaeche.spec.ts` (axe auf jedem Eintrag der Seitenleiste in fünf Rollen, Sprunglink, Umbruch in acht Fenstern, Fokus in Dialogen) | manuelle Prüfung (Tastatur, Screenreader): EXTERNAL; Einzelstand in `PREPRODUCTION_READINESS.md`, „UI/UX-Prüfmatrix" |
| 19 | Leistung | **COMPLETE** (Messung) · Produktion **EXTERNAL** | `docs/LEISTUNG.md`; `scripts/leistungsmessung.ts` | Last, grössere Bestände, Browser-Kennzahlen |
| 20 | Lieferkette | **PARTIAL** | `docs/LIEFERKETTE.md` | ~~Geheimnissuche nur in CI lauffähig~~ (seit 2026-09-27 `npm run security:secrets`, örtlich und im CI); ~~SBOM~~ (`npm run security:sbom`, CycloneDX, Stufe im CI); offen: `postcss` in Next erst mit Next 16 |
| 21 | Sicherung / Wiederherstellung | Mechanismus **COMPLETE + VERIFIED** (örtlich) · Betrieb **EXTERNAL** | `docs/BACKUP_DR.md`; `db-restore-verify.ts` | B-DR-1…3 |
| 22 | Production V2 | **PARTIAL** | `docs/PRODUCTION_V2.md`; `scripts/release-artefakt.ts`, `deploy/v2/`; `laufzeit-konfiguration.test.ts`; seit 2026-09-30 gehärtet (§10) | ~~V2-1~~ (geschlossen 2026-09-26); V2-2…V2-6 extern; Serverläufe der Aktivierung und des Rücksprungs (§10) |
| 23 | Testabschluss, Merkmalsprüfung | **COMPLETE + VERIFIED** | `docs/TESTABSCHLUSS.md`; 0 übersprungen | ~~offene Masken (Zeitfreigabe aufheben, QST-Tarife, QST-Profil ändern)~~ — alle drei haben inzwischen eine Maske (Einsatzdetail, Lohnseite); Endpunkte über HTTP geprüft, die Masken nur über den Rauchtest der Seiten, ohne Browserfall |
| 24 | Datenintegrität | **COMPLETE + VERIFIED** | `docs/DATENINTEGRITAET.md`; `datenintegritaet.test.ts` | Lauf gegen Produktion: EXTERNAL |
| 25 | Doku, Releasebereitschaft | **COMPLETE** | dieses Dokument | — |

## 2. In den Waves gefundene Produktfehler

| Wave | Fehler | Folge ohne Behebung |
|---|---|---|
| 18 | `cn()` warf `text-primary-foreground` neben eigenen Schriftgrössen weg | jede kleine/grosse Primärschaltfläche mit Kontrast 2.9 : 1 |
| 18 | bedienbares Icon im Eingabefeld `aria-hidden` | „Passwort anzeigen" für Screenreader unsichtbar |
| 19 | Einsatzliste im Portal ohne Grenze | 1.4 MB HTML, 300 ms auf dem Telefon |
| 23 | Materialeditor übernahm neue Zeilen erst nach hartem Neuladen | Entnahme scheinbar wirkungslos |
| 23 | drei Endpunkte ohne Maske (Lohnvereinbarungen, Zeitfreigabe, Lagerentnahme) | Lohnlauf zahlte erfasste Zeiten nie aus, ohne API-Zugang |
| 24 | Zahlung und Storno bildeten den Saldo ohne Gutschriften; Zahlung las ausserhalb der Transaktion | Mahnung über gutgeschriebene Beträge; überschriebene Zahlungssumme bei Gleichzeitigkeit |
| 25 | `.gitignore` `logs/` schloss `src/app/api/communication/logs/` aus | Route fehlte im Repository; Bau aus Git ohne Zustellprotokoll-Endpunkt, `npm run docs` rot |

## 3. Release-Blocker

### Intern (im Code lösbar)

| Nr. | Punkt | Blockiert |
|---|---|---|
| ~~V2-1~~ | ~~`NEXT_PUBLIC_*` wird beim Bau eingesetzt; ein Artefakt gehört zu einer Adresse~~ — **geschlossen 2026-09-26** (Laufzeitkonfiguration, `docs/PRODUCTION_V2.md` §5) | — |

**Kein interner Blocker offen** — weder für den heutigen Auslieferungsweg
noch für Production V2. *(Stand 2026-09-23. Überholt: Die Härtung vom
2026-09-30 fand im Weg zu Production V2 interne Defekte, die diese Aussage
nicht kannte — eine Ausführer-Vorlage, die beim ersten Lauf gescheitert wäre,
eine Versionsprüfung gegen die eigene Umgebungsvariable, keinen geprüften
Rücksprung von Hand, ein Artefakt ohne `prisma.config.ts` und mit Demodaten
aus dem Prüfbau. Behoben und belegt in §10; was intern offen bleibt, steht
dort.)*

### Extern (ausserhalb des Codes)

| Nr. | Punkt | Quelle |
|---|---|---|
| RB-009 | fachliche Prüfung der Lohnabrechnung (Treuhand/Lohnfachperson), Quellensteuertarife | `PAYROLL.md`, `RELEASE_BLOCKER_CLOSURE_REPORT.md` |
| RB-013 | Abnahme gegen einen echten `clamd` | `MALWARE_PROTECTION.md` |
| RB-014 | externer Dienst, der `/api/cron/status` abfragt | `RELEASE_BLOCKER_CLOSURE_REPORT.md` |
| RB-015 / V2-2…V2-5 | Production-V2-Infrastruktur, Probeserver, Verzeichnisaufbau, CI-Ablage | `PRODUCTION_V2.md` |
| B-DR-1…3 | regelmässige Datenbanksicherung, zweiter Ort, Hetzner-Backup | `BACKUP_DR.md` |
| ~~CI~~ | ~~Geheimnissuche und die neuen Prüfstufen in GitHub Actions~~ — erfüllt: Läufe 36272635541 (2026-09-26) und 36319443611 (2026-09-27) grün | `PREPRODUCTION_READINESS.md` Nachtrag A/C |
| E-9 | Sichtbarkeit des Repositorys — Entscheid der Inhaberschaft. Schutz von `main` erledigt: Regelsatz „main schützen" (ID 24071027) aktiv seit 2026-09-27 | `GITHUB_GOVERNANCE.md` |
| E-2 / E-4 | Scanner auf echten Geräten; Überwachungsrechner (Aufbau, `shellcheck`, Probelauf) | `SCANNER_DEVICE_ACCEPTANCE.md`, `ops/security-monitor/INSTALL.md` |

Nicht blockierend, aber extern offen: manuelle Barrierefreiheitsprüfung,
Auftragsverarbeitung mit dem KI-Anbieter, steuerliche Prüfung des Exports,
Lauf der Integritätsprüfung gegen die Produktionsdatenbank.

## 4. Schlussprüfung (2026-09-23)

| Prüfung | Ergebnis |
|---|---|
| Sauberer Bau aus `git archive HEAD` (`e03521f`) in eigenem Verzeichnis: `npm ci`, Korrektur `--pruefen`, `tsc`, `lint`, `prisma validate`, `npm run docs`, `next build` | alle Exit 0; erzeugte Doku bytegleich mit dem Repository |
| — derselbe Lauf an `14cc04d` | `npm run docs` **rot**: Route fehlte im Repository (`.gitignore`), behoben in `e03521f` |
| Migrationen | 37, Entwicklungs- und Testdatenbank „up to date" |
| Modelle / API | 143 Modelle, 359 Pfade, 523 Operationen |
| `npm test` | **1414 / 1414**, 0 fehlgeschlagen, 0 übersprungen (vorher 1268/1267/0/1) |
| Browser-Reihe, 10 volle Läufe, `retries=0` | **10 / 10 grün**, je 33/33 (27 bestehende + 3 Barrierefreiheit + 3 Masken) |
| — erster Durchgang vor `61e4473` | 8 / 10 grün; zweimal das Cookie-Banner mitten im Einblenden gemessen — Reihe korrigiert, Durchgang wiederholt |
| Stressreihe, 5 Läufe mit neu gestartetem Server | **5 / 5 grün**, je 33/33, 0 Hydrationsartefakte |
| Hydrationsregression (`hydration-wiederholung.spec.ts`) | aktiv in allen 15 Läufen, grün |
| Datenintegrität (Testdatenbank) | 0 Fehler, 1 Hinweis (Nummernlücken aus Prüfreihen) |
| `npm audit` | 0 critical, 4 high, 3 moderate — alle zweite Ebene, einzeln bewertet (`LIEFERKETTE.md`) |
| Geheimnissuche | **nicht ausgeführt** (Bash fehlt örtlich) — nicht als bestanden gewertet |

## 5. Urteil

| Frage | Antwort |
|---|---|
| App Code Ready | **Ja, mit benannten PARTIAL-Punkten** — kein offener interner Blocker für den heutigen Auslieferungsweg; die PARTIAL-Punkte (§1) sind Lücken im Umfang, keine Fehler |
| External Verification Ready | **Ja** — jeder externe Punkt ist benannt, mit Verfahren und Dokument (§3) |
| Production V2 Ready | **Nein** — V2-2…V2-6 (extern) offen; ~~V2-1 (intern)~~ geschlossen 2026-09-26 |

---

## 6. Nachtrag 2026-09-26 — Stabilisierung, Scanplattform, Sicherheitsautomation

Ausgangspunkt `b5b456b`. Kein Push, keine Auslieferung, keine DNS-Änderung,
keine Produktionsmigration, kein Zugriff auf 2.29.18.45.

### 6.1 Befunde der Stabilisierung (Phase A)

| Nr. | Befund | Einordnung | Stand | Beleg |
|---|---|---|---|---|
| A1 | Rechnung aus dem Einsatz nahm nur die erste Buchungsposition — Pauschale, Zusätze, Anfahrt, Rabatte, Mindestbetrag fehlten | FEHLER | **behoben**: eine Herleitung (`rechnungsgrundlageAusBuchung`), Rechnung = Buchung | `buchung-integritaet.test.ts` |
| A2 | Abgewiesene Gastbuchung hinterliess eine Kundenakte | FEHLER | **behoben**: Akte entsteht in der Buchungstransaktion | `buchung-integritaet.test.ts` |
| A3 | Bearbeiten einer Buchung ohne Verfügbarkeitsprüfung | FEHLER | **behoben**: dieselbe Prüfung in der Transaktion hinter der Sperre; Übergehen protokolliert | `buchung-integritaet.test.ts` (inkl. Gleichzeitigkeit) |
| — | Bewegliche Feiertage als jährlich wiederkehrend gespeichert | FEHLER | **behoben**: Seed + Datenmigration | `buchung-integritaet.test.ts` |
| — | Erneuter Versand setzte eine angenommene Offerte auf SENT zurück (gefunden im Regressionslauf von `datenintegritaet`) | FEHLER | **behoben**: Versand nur aus DRAFT/SENT/VIEWED, sonst 422 | `offertannahme.test.ts` |
| A4 | Einsatzfenster über Mitternacht | DEFINIERTE PRODUKTGRENZE | abgelehnt, begründet | `docs/VERFUEGBARKEIT.md` |
| — | Fähigkeiten (Skills) bei der Zuteilung | FEHLENDE FUNKTION | **behoben** 2026-09-27: Zuteilung weist ohne gültige Qualifikation ab; Kalender und Buchung schliessen Tage ohne genug Qualifizierte | `dispatch.test.ts`, `buchung-integritaet.test.ts` (A7) |
| — | Kapazität als Pool statt je Person | TECHNISCHE SCHULD | offen, zeitlich konservativ | `docs/VERFUEGBARKEIT.md` |
| — | Rechnungsbeträge als `number` mit `round2` statt Decimal-Rechnung | TECHNISCHE SCHULD | **behoben** 2026-09-27: Rechnung, Gutschrift, Preis-Engine, Auftragssummen und Lohn dezimal | `geldrechnung.test.ts`, `buchung-integritaet.test.ts` |

### 6.2 Neu

| Bereich | Status | Beleg | Offen |
|---|---|---|---|
| Scanplattform (Kopfzeile, Kamera/Bild/Eingabe, Auflösen im Leserecht, Schnellaktionen über bestehende Endpunkte, unbekannte EAN → Artikel, Etiketten, Suche) | **COMPLETE + VERIFIED** (Einordnung, HTTP, Browser mit nachgebildeter Kamera) | `docs/SCANNER.md`, `docs/SECURITY_THREAT_MODEL_SCANNER.md`; `scan-kennung`, `scan`, `scan.spec.ts` | echte Kameraerkennung auf Geräten: **EXTERNAL** (Browserfunktion); Code-128-Etiketten, Nachbestellen, GS1-Elementstrings: FEHLENDE FUNKTION |
| Sicherheitsstandard | **COMPLETE** | `docs/SECURITY_STANDARD.md` | — |
| `npm run security:check`, `security:sbom`, `security:secrets`, CI-Schritt | **COMPLETE + VERIFIED** (örtlich und im CI; die Geheimnisprüfung läuft seit 2026-09-27 ohne Bash) | `docs/SECURITY_AUTOMATION.md` | ~~Lauf im CI: EXTERNAL (kein Push)~~ — erfüllt, CI-Läufe 36272635541 und 36319443611 |
| Berichtseingang und Anzeige in der Sicherheitszentrale | **COMPLETE + VERIFIED** | `sicherheitsberichte.test.ts` | — |
| Sicherheitsupdates im Update Center | **COMPLETE + VERIFIED** | `release-center.test.ts` | — |
| Vorlagen externe Überwachung `ops/security-monitor/` | **PARTIAL** — geschrieben, **nicht ausgeführt, nicht syntaxgeprüft** (keine Bash örtlich) | `ops/security-monitor/INSTALL.md` | Überwachungsrechner, `shellcheck`, Probelauf: **EXTERNAL** |

### 6.3 Von der Sicherheitsautomation gefunden und behoben

`GET /api/auth/session`, `POST /api/auth/logout`, `GET /api/handoff`,
`GET /api/content/preview` ohne Kontingent; Namensprüfung vor
`DROP DATABASE` in `setup-test-db.ts`. Details: `docs/SECURITY_AUTOMATION.md`.

### 6.4 Schlussprüfung (2026-09-26)

| Prüfung | Ergebnis |
|---|---|
| `tsc --noEmit`, `npm run lint`, `prisma validate` | Exit 0 |
| `npm run docs` | 534 Endpunkte, Schutz übereinstimmend; 148 Modelle; keine Abweichung zum Repository |
| Bau (`next build`, eigenes `NEXT_DIST_DIR` gegen die Testdatenbank) | erfolgreich. `prisma generate` meldet örtlich EPERM auf die DLL, solange der Entwicklungsserver läuft; Typen und Client werden trotzdem erzeugt |
| Migrationen | 42; Entwicklungs- und Testdatenbank „up to date" (die neuen additiv über `db execute` + `resolve`; die Entwicklungsdatenbank bekam dabei auch die beiden Migrationen des Produktsprints) |
| `npm test` | **1545 / 1547**, 0 fehlgeschlagen, 2 übersprungen (Blätterung ohne zweite Seite, datenabhängig, vorbestehend) |
| — erster Regressionslauf | 1 fehlgeschlagen: `datenintegritaet` fand eine zurückgesetzte angenommene Offerte → Produktfehler, behoben (6.1) |
| Browser-Reihe (`retries=0`) | **42 / 42** |
| Stressreihe, 5 Läufe mit neu gestartetem Server | **5 / 5 grün**, je 42/42, 0 Hydrationsartefakte (auch vor Phase B: 5/5, je 39/39) |
| Hydrationsregression | aktiv in Browser- und Stressreihe |
| `npm run security:check` | 5 bestanden, 0 blockierend; Geheimnisprüfung und Sicherheitsreihen **NICHT GEPRÜFT** (keine Bash örtlich; Reihen laufen im vollen `npm test` mit) |
| `npm audit --omit=dev` | 0 critical, 4 high, 3 moderate — alle bewertet bis 2026-12-31 |
| `ops/security-monitor/*.sh` | **nicht ausgeführt, nicht syntaxgeprüft** |

### 6.5 Urteil

| Frage | Antwort |
|---|---|
| Interne Blocker aus dieser Mission (A1–A3) | **behoben und belegt** |
| App Code Ready | **Ja, mit benannten PARTIAL-Punkten** (6.1 offene Schuld/Funktion, 6.2) |
| External Verification Ready | **Ja** — CI-Lauf der Sicherheitsprüfung, Überwachungsrechner, Kameraerkennung auf Geräten und die Punkte aus §3 sind benannt |
| Production V2 Ready | **Nein** — unverändert (§3) |

Keine dieser Prüfungen beweist Fehlerfreiheit oder Sicherheit im absoluten
Sinn; sie belegen die benannten Regeln (`docs/SECURITY_AUTOMATION.md`,
„Was die Automatik nicht leistet").

---

## 7. Nachtrag 2026-09-27 — Freigabelauf an `5760e88`

Kein Push nach `main`, keine Auslieferung, kein Zugriff auf die Produktion.

### 7.1 Schlussprüfung

| Prüfung | Ergebnis |
|---|---|
| `npm run verify:release` (sauberer, losgelöster `git worktree` von `5760e88`, `npm ci`, frische Testdatenbank) | **grün**, jeder Schritt |
| `npm test` | **1905 / 1905**, 0 fehlgeschlagen, 0 übersprungen |
| Sicherheitsreihen und statische Prüfungen (`security:secrets`, `security:check:static`, `security:check:tests`, `npm audit --audit-level=critical`, Lint, Typen, `prisma validate`, Doku ohne Abweichung) | grün |
| Browser-Reihe (`retries=0`) | **53 / 53** |
| Stressreihe | STRESS-ERGEBNIS: 5 von 5 grün auf 0023556 — je 57/57 Browserfälle, 0 gescheitert, 0 übersprungen, 0 Hydrationsartefakte, ohne Wiederholungen, jeder Lauf gegen einen frisch gestarteten Testserver (Bericht test-results/stress-2026-09-27T17-10-28-542Z.json) |
| CI | Lauf **36319443611** grün, Auslieferungsauftrag übersprungen |
| Abdeckungsmatrizen | Testmatrix 196 abgedeckt / 9 Lücken / 2 nicht zutreffend; Sicherheitsmatrix 15 / 15 |
| Umfang (README, `scripts/kennzahlen.ts`) | 166 Seiten, 373 Route-Dateien mit 538 Endpunkten, 151 Datenmodelle, 84 Dienste, 94 Prüfdateien, 49 Migrationen |

### 7.2 Behobene Befunde (je mit Regressionsprüfung)

| Bereich | Befund | Beleg |
|---|---|---|
| Mandant | Zahlungssuche: der Suchbegriff trug den Organisationsschnitt nicht mit | `mandanten.test.ts` |
| Mandant | öffentliche Tokens, öffentliche Dateien und der Einsatzrapport sind jetzt an die Organisation der Installation gebunden | `mandanten.test.ts` („Öffentliche Links …", „öffentliche Datei …", „der Rapport eines fremden Einsatzes …") |
| Mandant / Eigentum | `?customerId=` bei Objekten, Entwürfe von Qualitätskontrollen, Zeitachse der Ziele | `sicherheitsluecken.test.ts` (IDOR) |
| Gleichzeitigkeit | Zeiterfassung je Person, Kundenakte je E-Mail-Adresse (fünf Anlagewege), Anfrageumwandlung, Kontaktformular, Bewilligung von Abwesenheiten, Dokumentfassungen | `nebenlaeufigkeit.test.ts` |
| Prüfprotokoll | Mahnlauf, Zeitfreigabe je Eintrag, Eröffnen eines Nachrichtenverlaufs, Anfrageverknüpfung, CMS-Veröffentlichung je Baustein | `protokollpflicht.test.ts` |
| Finanzen | Zahlung von Hand über dem offenen Saldo | `sicherheitsluecken.test.ts` |
| Eingabe | CMS-Freigabeliste liess Namen aus der Prototypenkette durch (jetzt `Object.hasOwn`) | `sicherheitsluecken.test.ts` |
| Dateien | Adresse eines privaten Anhangs konnte Website-Bild werden | `sicherheitsluecken.test.ts` |
| Export | Formelanfänge in Excel-Ausgaben | `sicherheitsluecken.test.ts` (Kundschaft); alle XLSX-Wege über `mappeSchreiben` |
| Fehler | Verklemmung ergab 500 statt 409; P2002 nannte interne Feldnamen; ein fremder Nachrichtenverlauf antwortet jetzt 404 wie „nicht vorhanden" (C19) | `nebenlaeufigkeit.test.ts`, `zugriffsgrenzen.test.ts` |
| Werkzeug | `verify:release` über `git worktree` statt `git archive`; Geheimnisprüfung ohne Bash | `docs/ENGINEERING_DEFINITION_OF_DONE.md`, „Automatisiert" |

### 7.3 Matrizen

- Sicherheit: `docs/SECURITY_STANDARD.md`, „Abschlussmatrix (2026-09-27)" —
  22 Bereiche, CODE 22 PASS / 0 FAIL, externer Nachweis offen in 9.
- Oberfläche: `docs/PREPRODUCTION_READINESS.md`, „UI/UX-Prüfmatrix
  (2026-09-27)" — 15 PASS, 8 PARTIAL, 0 FAIL.

### 7.4 Urteil

| Frage | Antwort |
|---|---|
| App Code Ready | **Ja, mit benannten PARTIAL-Punkten** (§1, UI/UX-Prüfmatrix) — kein offener interner Blocker |
| External Verification Ready | **Ja** — jeder offene externe Punkt steht mit Beleg in §3 und in der Abschlussmatrix |
| Production V2 Ready | **Nein** — V2-2…V2-6 extern |
| Stressreihe | STRESS-ERGEBNIS: 5 von 5 grün auf 0023556 — je 57/57 Browserfälle, 0 gescheitert, 0 übersprungen, 0 Hydrationsartefakte, ohne Wiederholungen, jeder Lauf gegen einen frisch gestarteten Testserver (Bericht test-results/stress-2026-09-27T17-10-28-542Z.json) — das Urteil gilt vorbehaltlich dieses Laufs |

§7 beschreibt den Stand an `5760e88` und bleibt als solcher stehen. Die
Zahlen darin (Testmatrix 196 / 9 / 2, 538 Endpunkte, 9 Bereiche mit
externem Nachweis) sind durch §8 überholt.

---

## 8. Nachtrag 2026-09-27 — dritte Nachprüfung an `fb0202e`

Kein Push nach `main`, keine Auslieferung, kein Zugriff auf die Produktion.
Einzelheiten je Befund: `docs/FINAL_REMEDIATION_MATRIX.md` und
`docs/FINAL_REMEDIATION_REPORT.md`.

### 8.1 Läufe

| Prüfung | Ergebnis |
|---|---|
| `verify:release` an `34b3484` | RELEASE-ERGEBNIS 34b3484: PASS — 1969/1969, 0 übersprungen, Browserreihe 57/57, Wiederholungen 0 |
| HTTP-Reihe auf dem Bau von `8bcc88c` … `fb0202e` | **2033** Fälle, alle bestanden, 0 übersprungen — nach Korrektur von 7 Fehlern im Testcode (die betroffenen Dateien erneut: 102 / 102) |
| `verify:release` an `fb0202e` | RELEASE-ERGEBNIS fb0202e: FAIL (2032/2033 - Standardadresse gleichzeitig, Verklemmung -> 500; behoben in 0023556). verify:release auf 0023556: PASS - saubere Worktree-Kopie, frische Datenbank, 2038/2038 Tests, 0 übersprungen, Browser 57/57 ohne Wiederholungen, 0 übersprungen, 0 wackelig; CI-Lauf 36332513820 grün, Auslieferung übersprungen |
| Stressreihe (5×) | STRESS-ERGEBNIS: 5 von 5 grün auf 0023556 — je 57/57 Browserfälle, 0 gescheitert, 0 übersprungen, 0 Hydrationsartefakte, ohne Wiederholungen, jeder Lauf gegen einen frisch gestarteten Testserver (Bericht test-results/stress-2026-09-27T17-10-28-542Z.json) |
| Abdeckungsmatrizen | Testmatrix **205 abgedeckt / 0 Lücken / 2 nicht zutreffend**; Sicherheitsmatrix 15 / 15; `scripts/testmatrix-pruefen.ts` besteht (an diesem Stand; ab `a9810a6`, 2026-09-28, zitierten zwei Belege einen umbenannten Titel, und am Basisstand der Härtung `9fd662b` waren drei Belege kaputt — ohne dass es auffiel, weil die Prüfung in keinem Tor lief. Seit P2H-45 ist sie Schritt von `verify:static`) |
| Umfang (README-Marker, `scripts/kennzahlen.ts`) | 166 Seiten, 375 Route-Dateien mit **540 Endpunkten**, 151 Datenmodelle, 85 Dienste, 99 Prüfdateien, 51 Migrationen |

### 8.2 Behobene Befunde seit `34b3484` (je mit Regressionsprüfung)

| Bereich | Befund | Beleg |
|---|---|---|
| Finanzen | Eine bei Stripe gescheiterte Rückerstattung liess den Saldo gesenkt (F-04) | `zahlungsbuch.test.ts` |
| Finanzen | Stripe-Zahlung zu einer fremden Rechnung: 404 und drei Tage Wiederholung ohne Meldung; EUR wurde als CHF gebucht; abweichender Betrag still | `zahlungsbuch.test.ts` |
| Anmeldung | Derselbe Zwei-Faktor-Ersatzcode gleichzeitig eingelöst ergab mehrere Sitzungen | `two-factor.test.ts` |
| CRM | Die umgewandelte Anfrage einer Kundschaft liess sich an die Offerte einer anderen hängen | `flows.test.ts` |
| Nachrichten | Antwort in einen gleichzeitig abgeschlossenen Verlauf; `lastMessageAt` konnte zurückgehen | `flows.test.ts` |
| CMS | Freigabe ohne Änderung schrieb eine Fassung; gleichzeitige Freigaben und Entwürfe | `cms.test.ts` |
| Öffentlich | Newsletter-Bestätigung und -Abmeldung schrieben beim blossen Seitenaufruf (Mailfilter), ohne Organisation und Protokoll; jetzt nur per POST an zwei neue öffentliche Endpunkte | `newsletter-links.test.ts` |
| Prüfprotokoll | Bewerbung, Newsletter-Anmeldung, Offertanfrage (mit Adresse) ohne bzw. mit unvollständiger Zeile | `protokollpflicht.test.ts` |
| Dateien | Private Supabase-Dateien ohne berechtigten Leseweg, servererzeugte ohne Prüfsumme (F-09 c) | `ablage-vertrag.test.ts` (Nachbau); echter Bucket E-8 |
| KI | Der Führungsassistent schickte den Namen der grössten Kundschaft hinaus; E-Mail, Einsatzbericht und Bewertungsantwort nur mit Musterfilter (F-15) | `ki-nutzlast.test.ts` |
| Werkzeug | Browserreihe nur am Exitcode gemessen; Lohn-Prüfpaket nicht im Prüfweg | `verify.ts` + `browserBilanzPruefen` (geprüft in `pruefbilanz.test.ts`, N-08); `verify:e2e` über dieselbe Regel |

### 8.3 Urteil

| Frage | Antwort |
|---|---|
| App Code Ready | **Ja, mit benannten PARTIAL-Punkten** — alle 29 nummerierten Befunde GESCHLOSSEN (24) oder EXTERN (5); offen im Repository nichts (N-08 nachgezogen) |
| External Verification Ready | **Ja** — E-1 … E-8 mit genauem fehlendem Beleg in `docs/FINAL_REMEDIATION_REPORT.md` §8; neu: Supabase-Bucket (E-8) und die am Stripe-Endpunkt abonnierten Rückerstattungsereignisse (E-5) |
| Production V2 Ready | **Nein** — V2-2…V2-6 extern |
| Freigabe | **nicht getroffen** — setzt RELEASE-ERGEBNIS fb0202e und STRESS-ERGEBNIS voraus |

## 9. Release-Kandidat 2026-09-29 (Prisma 7, Feature Freeze)

Zweig `release/2026-09-29-rc` ab `main` `7daaf71`, abschliessend `e9cae98`,
zusammengeführt als `main` `67a25f2` (Pull Request #9). Befunde, Korrekturen und
Belege je Punkt stehen im Register `docs/PENDENZEN.md`, Abschnitt **RC**
(RC-01 … RC-21; RC-21 offen); die Laufzahlen des abschliessenden `verify:release` und der
CI-Lauf stehen im Pull Request und im Abschlussbericht — hier nicht, weil
jeder Nachtrag hier den geprüften Stand wieder verändern würde.

**Im Feature Freeze gefundene und behobene Produktfehler:**

| Nr. | Fehler | Folge ohne Behebung |
|---|---|---|
| RC-01 | Neueres `charge.refunded` mit kleinerem Stand senkte den erstatteten Betrag; das folgende `refund.failed` zog dieselbe Teilerstattung ein zweites Mal ab | offener Posten und Kundenwert um eine Rückerstattung falsch |
| RC-06 | Nachrichtenliste zeigte bei Ladefehler den Leerzustand; Verlauf blieb im Skelett; Netzfehler der Preisberechnung unsichtbar; Beitragssätze ohne Leerzustand | falsche Auskunft („keine Nachrichten"), endloses Laden, stiller Preisfehler |
| RC-15 | Abmelden landete je nach Wettlauf auf „Sitzung abgelaufen" oder „abgemeldet" statt auf der Startseite | irreführende Meldung nach gewollter Abmeldung |

**Neue Tore im Prüfweg:** strukturelle Grundlinie (Endpunkte 544,
Berechtigungen 246, Migrationen 55, Navigationsziele — Wegfall blockiert),
`--datenbank` ohne Adresse = NICHT GEPRÜFT, unverfolgte Dokumentation,
HTML-Budget je Seite, `verify:release` nur mit Stressreihe 5/5,
angemeldetes WebKit über HTTPS, axe über 26 Seiten.

| Frage | Antwort |
|---|---|
| App Code Ready | am Release-Kandidaten zu entscheiden — Beleg im Abschlussbericht |
| Production V2 Ready | **Nein** — V2-2…V2-6 extern, Aktivierung nie auf einem echten Server ausgeführt |
| Firefox-Bildbefund (D-01) | Code: Regression abgedeckt · Produktion: Abnahme erforderlich |
| Freigabe | durch die Inhaberschaft nach dem Abschlussbericht |

## 10. Production-V2-Härtung (Feature Freeze)

> **Feature Freeze ab dem Release-Kandidaten dieser Härtung — nur noch
> Production-V2-Vorfälle/P0/P1; jede Änderung verlangt neuen
> `verify:release`, neue CI und eine neue RC-SHA.**

Zweig `haertung/production-v2` ab `main` `67a25f2` (Baum gleich `e9cae98`,
§9). Grundlage war ein Audit des Wegs **vom geprüften Bau bis zur laufenden
Instanz**: Der Code des Release-Kandidaten war geprüft, der Weg in die
Produktion nur beschrieben. Neun Härtungsströme auf einem gemeinsamen
Vertragscommit (`9fd662b`); Befund, Korrektur, Prüfung und Commit je Punkt
im Register `docs/PENDENZEN.md`, Abschnitt **P2H** (P2H-01 … P2H-75). Wie in
§9 stehen die Laufzahlen des abschliessenden `verify:release` und der CI hier
nicht, sondern im Pull Request und im Abschlussbericht.

### 10.1 Was gehärtet ist

| Bereich | Stand | Register |
|---|---|---|
| Artefakt | Vertrag `RELEASE.json` Format 2 (`src/lib/release/manifest.ts`) für alle vier Leser; auslieferbar nur aus der CI auf `main` (Push oder Handstart), vollständig, sauber, aus `.next`; verankerte Ausschlüsse, Vollständigkeitsabgleich, `prisma.config.ts` im Archiv; Demo-Stolperdraht und Verweigerung jedes Baus, auf dem ein Server lief; GNU tar normalisiert, Bauvergleich | P2H-01 … P2H-08 |
| Identität | Die Instanz belegt Commit, Build-ID und Version aus `RELEASE.json` und `<distDir>/BUILD_ID`; `/api/health` meldet `version` (nur belegt), `buildId`, `release`, `identitaet`. `APP_VERSION` und `CLENARIS_VERSION` zählen nicht mehr | P2H-09, P2H-10 |
| Release Center | Das Ergebnis entscheidet der Server: SUCCEEDED nur bei belegter Ziel-Identität, ROLLED_BACK nur belegt; Übernahme mit Commit und Zielversion; eine Ausführung je Umgebung; verwaiste Aufträge schliesst der Stundenlauf | P2H-11 … P2H-13 |
| Aktivierung | Vertrag C3 (`deploy/v2/release-aktivieren.sh`): Sperre, erwartete Summe als Pflicht, frisch entpackt, Identitätsprüfung für neue und vorherige Fassung, Ausgänge 0/10/11/20/30, `aktivierungen.jsonl`, Archive in `archiv/` | P2H-16 |
| Rücksprung | Von Hand aus dem aufbewahrten, erneut gemessenen Archiv (`deploy/v2/release-ruecksprung.sh`), mit Schema-Einstufung; nie bauen, nie `npm`, nie `git`, nie zurückmigrieren | P2H-17 |
| Wege in die Produktion | Beide bleiben (Entscheid der Betreiberin): Auftrag `auslieferung` (`DEPLOY_ENABLED`) und Release-Ausführer (`RELEASE_EXECUTOR_ENABLED`) — derselbe Vertrag, dieselbe Nebenläufigkeitsgruppe; die Vorlage des Ausführers ist berichtigt, `workflow-ergaenzung.yml` gelöscht. **Der direkte Weg umgeht die Freigabe im Release Center** | P2H-14, P2H-15, P2H-19 |
| CI | Migration → Datenbanktor → Konfigurations-Seed → Bau ohne Zwischenspeicher → Packen vor jedem Serverstart → Demo-Seed → Prüfreihen → Ablage nur auf `main`; Auftrag `reproduzierbarkeit` von Hand | P2H-18 |
| Inhaltsrichtlinie | kein `'unsafe-eval'` im Produktionsbau (die Next-Phase entscheidet), `'wasm-unsafe-eval'` für PDF.js, ungenutzte Fremdquellen entfernt | P2H-26, P2H-27 |
| Prüfprotokoll | `audit_logs` in der Datenbank nur fortschreibbar (Trigger), Schwärzung nur über einen transaktionslokalen Schalter | P2H-35, P2H-36 |
| Datenbanktor | Register aller handgeschriebenen Schranken (Teilindizes, Trigger samt Bindung, CHECK, EXCLUDE, Erweiterung, Funktionsrümpfe) gegen Migrationen und Kataloge; Exit 0/1/2; in CI und vollem Prüfweg | P2H-37 … P2H-40 |
| Prüfweg | Testmatrix nur mit ausgeführten Titeln, Teilwege des Release-Wegs enden mit Exit 3 „TEILPRÜFUNG BESTANDEN — KEIN RELEASE-NACHWEIS", nur `verify:release` schreibt den Release-Nachweis; Bilanz je Engine | P2H-45 … P2H-47 |
| Sitzung | Leerlauf über HTTP und im Browser bewiesen | P2H-50, P2H-51 |
| Diagnose | W-11 und RC-21 hinterlassen bei jedem Auftreten einen Abzug bzw. Lebenslauf — Ursachen weiter unbelegt | P2H-55, P2H-56 |
| Besuchsmessung | Schalter `CLENARIS_BESUCHSMESSUNG` (Vorgabe aus), 13 Monate überall, GA-Cookie 13 Monate, Widerruf im Browser | P2H-59, P2H-60, TA-03 |
| Website, KI | Alternativtext der Vergleichsbilder, Galerie und Stellen erneuern ihre Detailseiten, KI-Kontingent belegt | P2H-61 … P2H-63 |

### 10.2 Intern offen (im Code lösbar, nicht im Freeze)

Keiner dieser Punkte ist ein P0/P1 im Sinn des Freeze; jeder steht mit
Begründung im Register:

- **P2H-64** Widerrufsknopf verschwindet, sobald Datenschutz- und
  Cookie-Erklärung in `/admin` gepflegt sind — dringlich mit dem ersten
  gepflegten Rechtstext.
- **P2H-25** Das Datenbanktor läuft auf dem Server nach der Migration nicht.
- **P2H-57** Datenbankpool ohne Verbindungs- und Abfragefrist (Produktentscheid).
- **P2H-43** Ein leerer Offline-Bericht von `npm audit` gilt als bestanden.
- **P2H-28/29/30** `'unsafe-inline'`, kein Meldeziel der Richtlinie, GA4-
  und Meta-Endpunkte nicht erlaubt.
- **P2H-48** ISR-Seiten ohne Demobestand im Prüflauf — im Volllauf beobachten.
- **P2H-52 … 54** drei Sitzungsbeobachtungen (nur durch Lesen belegt).
- **P2H-66 … 70**, **P2H-22 … 24**, **P2H-41**, **P2H-44**, **P2H-49**,
  **P2H-58**, **P2H-71**, **P2H-75** Pflege und dokumentierte Grenzen.

### 10.3 Extern offen

| Nr. | Fehlender Beleg |
|---|---|
| P2H-20 / V2-3 | Aktivierung, Rücksprung und Ausführer auf einem Linux-Probeserver (Symlink, pm2-Verzeichniswechsel, `flock`, Ausgänge, Aufbewahrung) und `/api/health` mit `identitaet=belegt` auf Production V2 |
| P2H-21 | erster Lauf des Auftrags `reproduzierbarkeit` mit abgelegtem `bau-vergleich.json` |
| P2H-34 | Drucken aus dem PDF-Viewer über den `blob:`-Rahmen in einem Browser mit PDF-Renderer |
| P2H-42 | getrennte Eigentümerrolle für Migrationen, `log_statement = 'ddl'`, aufbewahrte Sicherungen |
| P2H-65 | Datenaufbewahrung der GA4-Property passend zur Erklärung (13 Monate) |
| TA-02 | Rechtsprüfung der Datenschutzerklärung vor `CLENARIS_BESUCHSMESSUNG=an` |
| V2-2, V2-4 … V2-6 | Node 22 auf dem Server, Verzeichnisaufbau, Grösse und Aufbewahrung der CI-Ablage, Sicherungs-Blocker B-DR-1 … 3 (`PRODUCTION_V2.md` §3) |
| §3 | RB-009, RB-013, RB-014, E-2/E-4, E-9 unverändert |

### 10.4 Urteil

| Frage | Antwort |
|---|---|
| App Code Ready | am Härtungskandidaten zu entscheiden — nach grünem `verify:release` (Kern und Stress 5/5) und grüner CI auf genau dieser SHA; bis dahin sind die P2H-Zeilen CODE COMPLETE, nicht VERIFIED |
| Production V2 Ready | **Nein** — der Weg ist im Code vollständig und geprüft, aber nie auf einem echten Server gelaufen (P2H-20) und V2-2 … V2-6 sind extern offen |
| Freeze | jede weitere Änderung nur für Production-V2-Vorfälle, P0 oder P1 — und sie macht den Kandidaten ungültig: neuer `verify:release`, neue CI, neue RC-SHA |
| Freigabe | durch die Inhaberschaft nach dem Abschlussbericht |
