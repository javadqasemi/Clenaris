# Releasebereitschaft — Waves 9 bis 25

Stand 2026-09-23. Ausgangspunkt `0d51466` (Next 15.5.26, `npm test`
1268/1267/0/1 übersprungen, Browser-Reihe 27/27).

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
| 9 | Lohn | **PARTIAL + EXTERNAL VERIFICATION REQUIRED** | `docs/PAYROLL.md`; `lohnabrechnung`, `lohnbestandteile`, `wave23-masken` | fachliche Prüfung durch Treuhand/Lohnfachperson; Quellensteuertarife werden nicht mitgeliefert; Tarifimport ohne Maske. Clenaris ist **nicht** „Swiss Payroll compliant" und behauptet es nicht |
| 11 | Betrieb: QM, SLA, Reklamation, Material, Geräte | **COMPLETE + VERIFIED** | `docs/BETRIEB.md`; `betrieb.test.ts`, `wave23-masken` (Lagerentnahme) | — |
| 12 | Verkauf: Besichtigung → Berechnung → Offerte | **COMPLETE + VERIFIED** | `docs/VERKAUF.md`; `besichtigung.test.ts` | — |
| 13 | Finanzen: Unveränderlichkeit, Storno, Gutschrift | **COMPLETE + VERIFIED** | `docs/FINANZEN.md`; `finanzbelege.test.ts`; Saldofehler in Wave 24 behoben | steuerliche Korrektheit von Export/MWST: EXTERNAL |
| 14 | Kommunikation: Vorlagen, Zustellstatus | **COMPLETE** (Resend verifiziert) · Twilio **EXTERNAL** | `docs/KOMMUNIKATION.md`; `kommunikation.test.ts` | bearbeitbare DB-Vorlagen PARTIAL; echte Anbieter nicht angebunden |
| 15 | KI-Governance, Datensparsamkeit | **COMPLETE** · Freitextfunktionen PARTIAL | `docs/KI_GOVERNANCE.md`; `ki-governance.test.ts` | Namen im eingefügten Freitext; Auftragsverarbeitung mit dem Anbieter: EXTERNAL (rechtlich) |
| 16 | Mandantentrennung | **COMPLETE + VERIFIED** (einmandantiger Betrieb) | `docs/MANDANTEN.md`; `mandanten.test.ts` | `EmailLog`/`SmsLog` ohne Organisation — vor Mehrmandantenbetrieb nachrüsten |
| 17 | Globale Suche | **COMPLETE + VERIFIED** | `docs/SUCHE.md`; `suche.test.ts` | — |
| 18 | Barrierefreiheit | **PARTIAL** | `docs/BARRIEREFREIHEIT.md`; `wave18-barrierefreiheit.spec.ts` | manuelle Prüfung (Tastatur, Screenreader): EXTERNAL |
| 19 | Leistung | **COMPLETE** (Messung) · Produktion **EXTERNAL** | `docs/LEISTUNG.md`; `scripts/leistungsmessung.ts` | Last, grössere Bestände, Browser-Kennzahlen |
| 20 | Lieferkette | **PARTIAL** | `docs/LIEFERKETTE.md` | Geheimnissuche nur in CI lauffähig; SBOM; `postcss` in Next erst mit Next 16 |
| 21 | Sicherung / Wiederherstellung | Mechanismus **COMPLETE + VERIFIED** (örtlich) · Betrieb **EXTERNAL** | `docs/BACKUP_DR.md`; `db-restore-verify.ts` | B-DR-1…3 |
| 22 | Production V2 | **PARTIAL** | `docs/PRODUCTION_V2.md`; `scripts/release-artefakt.ts`, `deploy/v2/` | V2-1…V2-6 |
| 23 | Testabschluss, Merkmalsprüfung | **COMPLETE + VERIFIED** | `docs/TESTABSCHLUSS.md`; 0 übersprungen | offene Masken (Zeitfreigabe aufheben, QST-Tarife, QST-Profil ändern) PARTIAL |
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
| V2-1 | `NEXT_PUBLIC_*` wird beim Bau eingesetzt; ein Artefakt gehört zu einer Adresse | nur Production V2 (der heutige Weg baut auf dem Server) |

Für den heutigen Auslieferungsweg: **kein interner Blocker offen.**

### Extern (ausserhalb des Codes)

| Nr. | Punkt | Quelle |
|---|---|---|
| RB-009 | fachliche Prüfung der Lohnabrechnung (Treuhand/Lohnfachperson), Quellensteuertarife | `PAYROLL.md`, `RELEASE_BLOCKER_CLOSURE_REPORT.md` |
| RB-013 | Abnahme gegen einen echten `clamd` | `MALWARE_PROTECTION.md` |
| RB-014 | externer Dienst, der `/api/cron/status` abfragt | `RELEASE_BLOCKER_CLOSURE_REPORT.md` |
| RB-015 / V2-2…V2-5 | Production-V2-Infrastruktur, Probeserver, Verzeichnisaufbau, CI-Ablage | `PRODUCTION_V2.md` |
| B-DR-1…3 | regelmässige Datenbanksicherung, zweiter Ort, Hetzner-Backup | `BACKUP_DR.md` |
| CI | Geheimnissuche (`ci-secret-scan.sh`) und die neuen Prüfstufen in GitHub Actions | `LIEFERKETTE.md` |

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
| Production V2 Ready | **Nein** — V2-1 (intern) und V2-2…V2-6 (extern) offen |
