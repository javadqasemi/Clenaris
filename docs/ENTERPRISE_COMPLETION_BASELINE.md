# Enterprise Completion — Baseline

**Erstellt:** 2026-09-21 (Wave 0)
**Zweig:** `ci/production-v2-github-haertung` · **HEAD bei Beginn:** `2314730`
**Grundlage:** Quellcode im Arbeitsbaum. Dokumentation gilt nur, wo der Code sie bestätigt.

Diese Datei ist der **Ausgangspunkt** der Enterprise Completion Mission. Sie hält fest, was am 2026-09-21 nachweislich da ist — damit später unterscheidbar bleibt, was diese Mission gebaut hat und was schon vorher stand.

Der ausführliche Befund steht in [`CLENARIS_ENTERPRISE_SYSTEM_REPORT.md`](CLENARIS_ENTERPRISE_SYSTEM_REPORT.md), die Merkmalsliste in [`CLENARIS_FEATURE_MATRIX.md`](CLENARIS_FEATURE_MATRIX.md).

---

## 0. Korrekturen an der vorherigen Bestandsaufnahme

Sechs Widersprüche wurden benannt und geprüft. **Vier waren echte Fehler meines Berichts**, zwei waren Einstufungsfragen. Alle sind behoben.

| # | Widerspruch | Prüfung | Ergebnis |
|---|---|---|---|
| 1 | **Payroll-Modell** | `prisma/schema.prisma` durchsucht: kein `Payroll*`-Modell. `payslip:create`/`payslip:read_own` existieren im Rechtekatalog, `/portal/lohn` existiert als Seite. | **Bestätigt** — der Bericht führte das bereits als `NOT IMPLEMENTED`. Keine Korrektur nötig, aber als **Wave 9** eingeplant. |
| 2 | **Lohnfelder als verschlüsselt bezeichnet** | `CRYPTO_CONTEXT` kennt nur `user.twoFactorSecret`, `employee.ahvNumber`, `property.alarmCode`. `employee.service.ts:104–105, 140–141, 252–253` schreibt `hourlyRate`/`monthlySalary` **im Klartext**. | **ECHTER FEHLER.** Korrigiert in TEIL 21; neuer Matrixeintrag **SEC-021 = NOT IMPLEMENTED**. |
| 3 | **„rechtsgültig unterschreiben"** | `docs/SIGNATUR_GATE4A.md` und `CLAUDE.md` verbieten jede QES-/ZertES-Behauptung; `ceremonyMode` ≠ `assuranceLevel`. Der Bericht hatte die Formulierung in TEIL 71 trotzdem verwendet. | **ECHTER FEHLER.** Zurückgenommen auf „elektronisch unterzeichnen" samt Einordnung. |
| 4 | **Art. 957a OR als Pflicht zur lückenlosen Nummerierung** | Art. 957a OR verlangt ordnungsgemässe Buchführung (Vollständigkeit, Wahrheit, systematische Erfassung, Klarheit, Zweckmässigkeit, Nachprüfbarkeit) und einen Beleg je Vorgang — **keine** wörtliche Pflicht zu lückenlosen Rechnungsnummern. | **ECHTER FEHLER** (Überzeichnung). Jetzt als **Entwurfsziel** geführt; verbindliche Aussage an die Treuhandstelle verwiesen. |
| 5 | **CI/CD als COMPLETE** | GitHub-API: **0 von 6 Läufen erfolgreich, 0 Deployments.** | **Einstufung korrigiert.** `INF-001…004` von `C` auf **`C/EVR`** zurückgestuft. |
| 6 | **Production-Reihenfolge** | Mehrere Prüfungen (Restore gegen Produktionsgrösse, Cron-Überwachung, Cloudflare-Topologie, Lasttest) setzen eine Staging-Umgebung voraus, die es nicht gibt. | **Korrigiert.** Abschnitt *Reihenfolge* unten. |

---

## 1. Verifizierter Repository-Zustand

| Grösse | Wert | Erhebung |
|---|---|---|
| Seiten (`page.tsx`) | 143 | Dateiabzählung |
| Route-Dateien | 267 | Dateiabzählung |
| API-Operationen | 401 (362 Sitzung · 37 öffentlich · 2 Cron) | erzeugte OpenAPI, gegen Routen geprüft |
| Dienste | 55 (26 975 Zeilen) | Dateiabzählung |
| Validierungsmodule | 28 | Dateiabzählung |
| Prisma-Modelle / Enums / Felder | 117 / 80 / 2 150 | Schema-Parser |
| Migrationen | 18, **kein `DROP`** | SQL-Analyse |
| Berechtigungen / Rollen | 215 / 6 | Laufzeitauswertung |
| Testdateien / Prüfungen | 41 / 883 (863 HTTP + 20 Browser) | Testlauf |
| Arbeitsvermerke (`TODO`/`FIXME`/`HACK`/`mock`) | **0** | Volltextsuche über `src/` |

**Qualitätstore am 2026-09-21, lokal ausgeführt:** Typecheck ✅ · Lint ✅ · `prisma validate` ✅ · `npm run docs` ✅ · Geheimnis-Suche ✅ (925 Dateien) · Build ✅ · `npm test` ✅ 863/861/0 · `npm run e2e` ✅ 20/20.

---

## 2. IMPLEMENTED — vorhanden und technisch nutzbar

Website (29 Seiten) · CMS mit Entwurf/Veröffentlichung/Revisionen · CRM (Leads, Kundschaft, Adressen, Kontakte, Aktivitäten, Aufgaben, Nachrichten) · Objekte mit verschlüsseltem Alarmcode · Buchungen (öffentlich und im Büro) · Offerten mit serverseitiger Berechnung · Einsätze mit Team, Material und Lohnkostenherleitung · Disposition mit Eignungsprüfung · Personal mit Lohnhistorie · Abwesenheiten · Zeiterfassung · Rechnungen mit QR und Nummernkreis · Gutschriften · Zahlungen (Stripe/TWINT/manuell) · Ausgaben · Lieferanten · Dateien mit Byteprüfung · PDF-Erzeugung und -Betrachter · Elektronische Unterzeichnung (Kern, Offertannahme, Vor-Ort-Abnahme, Gerätesperre) · Unternehmensführung (17 Teilbereiche) · Rechtesystem · Prüfprotokoll · Rate-Limiting · Papierkorb · Datenbereinigung · Automatisierung (Cron) · Sicherung mit geprobtem Rückweg · CI/CD-Code.

---

## 3. VERIFIED — zusätzlich durch benannte Tests belegt

**80 Merkmale.** Schwerpunkte:

| Bereich | Prüfungen |
|---|---|
| Unterzeichnung (Kern, Offerte, Abnahme, Sperre) | 60 HTTP + 14 Browser |
| Website-Stammdaten | 35 |
| Geschäftswege Ende-zu-Ende | 34 |
| Adressen | 28 |
| 2FA und Sitzungswiderruf | 28 |
| Unternehmensführung | 26 + 22 Rechenkerne |
| Rechtematrix | 25 |
| Auslieferungsweg und Geheimnis-Suche | 24 |
| Disposition | 22 |
| Öffentliche Zugriffstokens | 40 über 3 Dateien |
| Dateien | 24 |
| Datenbanksicherung | 19 |
| PDF | 36 |

---

## 4. PARTIAL — begonnen, nicht abgeschlossen

| Bereich | Was fehlt |
|---|---|
| Prüfprotokoll | Zuteilung, Objektänderung inkl. Alarmcode, Tokenausstellung |
| Zahlungen | Durchlauf gegen echtes Stripe, Rückerstattung, Abstimmung |
| E-Mail | DKIM/SPF/DMARC, Zustellprüfung |
| SMS | jede Prüfung, jede Ansicht |
| KI | Prüfungen; Datenschutzwiderspruch bei `suggestStaffing` |
| Mitarbeiterfähigkeiten | Schreibpfad und Maske |
| Arbeitszeiten | Bearbeitungsmaske und Endpunkt |
| Wiederkehrende Leistungen | Laufzeit, Verlängerung, Kündigung, Indexierung |
| Benachrichtigungen | Rate-Limit, Prüfungen |
| Marketing/Kampagnen | Fachmodell hinter der Seite |
| Barrierefreiheit | automatisierter Nachweis für 130 von 143 Seiten |
| Mandantentrennung | systematische Abfrageprüfung je Dienst |
| Buchhaltungsexport | Lohnbestandteile, Treuhandformat |
| Objektspeicher | Lauf gegen echten Supabase-Speicher |

---

## 5. MISSING — nicht vorhanden

| # | Fehlend | Wave |
|---|---|---|
| 1 | **Lohnabrechnung** (Modell, Dienst, Endpunkt, PDF, Beitragsrechnung) | 9 |
| 2 | **Vertragsmodell** (Laufzeit, Verlängerung, Kündigung, Indexierung) | 10 |
| 3 | **Schlüsselrotation** und Zweitschlüsselpfad | 4 |
| 4 | **Verschlüsselung von Lohn- und Bankdaten** (SEC-021) | 4 |
| 5 | **Virenprüfung bei Uploads** | 2 |
| 6 | **Beobachtbarkeit** (Fehlerverfolgung, Metriken, Alarm) | 5 |
| 7 | **Hintergrundwarteschlange** | 6 |
| 8 | **Security Center** | 3 |
| 9 | **Globale Suche** | 17 |
| 10 | **Datatrans** (nur `.env.example`) | 13 |
| 11 | **Mehrsprachigkeit** (`Locale` ohne i18n) | — Entscheidung nötig |
| 12 | `AutomationRun` wird nie geschrieben | 1 |
| 13 | Tote Modelle: `LandingPage`, `Building` | 11 / Aufräumen |
| 14 | Aufbewahrungsfristen (versprochen, nicht umgesetzt) | 24 |
| 15 | Enterprise-Betrieb: Regionen, Teams, Schlüsselverwaltung, Qualität, Vorfälle, Material, Geräte | 11 |

---

## 6. EXTERNAL VERIFICATION REQUIRED

Kann in diesem Repository **grundsätzlich nicht** nachgewiesen werden:

| # | Gegenstand | Wer |
|---|---|---|
| E-1 | Erster grüner CI-Lauf auf GitHub | Betreiber |
| E-2 | Zweigschutz, Default-Branch, Actions-Rechte, Environment | Betreiber |
| E-3 | Secret- und Deploy-Key-Bestand (nur Namen) | Betreiber |
| E-4 | Stripe gegen echtes Konto (Webhook, Rückerstattung) | Betreiber |
| E-5 | Supabase-Objektspeicher (`downloadObject`) | Betreiber |
| E-6 | DKIM / SPF / DMARC | Betreiber (DNS) |
| E-7 | Twilio-SMS-Zustellung | Betreiber |
| E-8 | Cloudflare-Topologie, Firewall, Ursprungsschutz | Betreiber (V2-Server) |
| E-9 | Wiederherstellungslauf gegen Produktionsgrösse | Betreiber (V2/Staging) |
| E-10 | **Lohnrechtliche Parameter** (AHV/ALV/BVG/UVG/KTG/Quellensteuer) | **Treuhandstelle** |
| E-11 | **Lückenlose Nummerierung als Buchführungsanforderung** | **Treuhandstelle** |
| E-12 | Impressum, Datenschutzerklärung, AGB | **Rechtsberatung** |
| E-13 | Beweiswert der elektronischen Signatur im Einzelfall | **Rechtsberatung** |

**Regel für diese Mission:** Fehlt eine solche Prüfung, wird der Adapter vollständig gebaut, mit Vertrags- und Attrappenprüfungen abgesichert, konfigurationsseitig validiert — und als `PRE-PRODUCTION VERIFICATION REQUIRED` gekennzeichnet. Kein Merkmal erreicht ohne den externen Nachweis `COMPLETE + VERIFIED`.

---

## 7. PRODUCTION BLOCKER

| # | Blocker | Art |
|---|---|---|
| P-1 | Repository öffentlich; privat + Zweigschutz erfordert auf GitHub Free einen Planwechsel | GitHub |
| P-2 | Default-Branch zeigt auf einen Feature-Zweig mit älterer, unsicherer Workflow-Fassung | GitHub |
| P-3 | Kein Zweigschutz auf `main` — dem Auslieferungsauslöser | GitHub |
| P-4 | Pipeline nie grün | GitHub |
| P-5 | Kein V2-Server, keine Firewall, kein Ursprungsschutz | Infrastruktur |
| P-6 | Keine Infrastruktursicherung, kein `delete_protection`/`rebuild_protection` | Infrastruktur |
| P-7 | Keine Crontab-Einträge — Erinnerungen, Mahnungen, Serienbuchungen und Führungslauf laufen still nicht | Betrieb |
| P-8 | `ENCRYPTION_KEY` muss vor dem ersten verschlüsselten Wert stehen (keine Rotation) | Sicherheit |
| P-9 | Lohn- und Bankdaten unverschlüsselt (SEC-021) | Sicherheit |
| P-10 | Keine Lohnabrechnung | Fachlich |
| P-11 | Keine Beobachtbarkeit, keine Alarmierung | Betrieb |
| P-12 | Entscheidung über den Altdatenbestand offen (Schlüsselabhängigkeit) | Daten |

---

## 8. Reihenfolge — Korrektur gegenüber dem Erstbericht

Der Erstbericht stellte einige Betriebsprüfungen vor den Aufbau der Umgebung. **Das ist nicht durchführbar.** Richtige Reihenfolge:

```
Stufe A — im Repository, ohne Infrastruktur
   Wave 0  Bestandsaufnahme und Korrekturen        ← abgeschlossen
   Wave 1  Sicherheitslücken schliessen
   Wave 2  Malware-/Dateisicherheitskette
   Wave 3  Security Center
   Wave 4  Schlüsselverwaltung und Rotation
   Wave 5  Beobachtbarkeit (Code, ohne Anbieter)
   Wave 6  Hintergrundjobs
   Wave 7–10 Personal, Zeit, Lohn, Verträge
   Wave 11–19 Betrieb, CRM, Finanzen, Kommunikation, KI,
              Mandanten, Suche, Barrierefreiheit, Leistung
   Wave 20 Lieferkette
   Wave 23–25 Tests, Datenintegrität, Dokumentation

Stufe B — braucht GitHub-Zugriff des Betreibers
   E-1 … E-3

Stufe C — braucht die V2-/Staging-Umgebung
   Wave 21 DR-Prüfung gegen echte Grössen
   Wave 22 Production-V2-Topologie
   E-4 … E-9, Lasttest, Cron-Überwachung, Ursprungsschutz
```

**Stufe C kann nicht vorgezogen werden.** Ein Wiederherstellungslauf gegen Produktionsgrösse, eine Cloudflare-Ursprungsprüfung und eine Cron-Überwachung brauchen eine laufende Umgebung. Bis dahin bleiben die zugehörigen Merkmale `C/EVR` — nicht `COMPLETE`.

---

## 9. Arbeitsregeln dieser Mission

1. **Bestehende Architektur wird erweitert, nicht ersetzt.** `defineRoute` bleibt die einzige Schreibtür; Fachlogik bleibt in `src/server/services`; Zod bleibt in `src/lib/validation`.
2. **Kein Merkmal wird `COMPLETE` genannt, weil Code existiert.** Ohne Test bleibt es `C`, ohne externen Nachweis `C/EVR`.
3. **Keine gesetzlichen Werte fest im Code.** Beitragssätze, Fristen und Steuersätze werden datiert konfigurierbar (`effective-dated`), nicht einprogrammiert.
4. **Jede sicherheitsrelevante Mutation wird protokolliert**, jede neue Route trägt Rechte, Validierung und — wo sinnvoll — ein Rate-Limit.
5. **Migrationen sind additiv.** Kein `DROP` ohne ausdrückliche Freigabe; `prisma migrate reset` bleibt verboten.
6. **Keine Behauptung ohne Beleg.** Wo etwas nicht messbar war, steht das da.

---

---

## 10. Wave 1 — Sicherheitshärtung (Stand 2026-09-21)

### Gemeldet waren sechs Punkte. Drei Befunde stimmten nicht.

| Punkt | Nachprüfung am Code | Ergebnis |
|---|---|---|
| Zuteilung nicht protokolliert | `job.service.ts:479` (`moveJob`) und `:546` (`assignJob`) schreiben `audit.updated` | **Fehlbefund.** Gemessen worden war `assignment.service.ts` — das ist die *Entscheidungs*stelle (Eignungsprüfung), nicht die Mutation. Ein lesender Prüfschritt hat nichts zu protokollieren. |
| Objektänderungen nicht protokolliert | `properties/route.ts:164` (`audit.created`), `properties/[id]/route.ts:122` (`audit.updated` mit `diff`), Löschen über `trash.service` | **Fehlbefund.** Dieselbe Ursache: `property.service.ts` enthält nur Sichtbarkeitshelfer. |
| Alarmcode-Änderung nicht nachvollziehbar | `diff()` redigiert `alarmCode`; die **Tatsache** der Änderung erscheint, der Wert nicht | **Fehlbefund** — und die vorhandene Lösung ist besser als die geforderte. |
| **Ausstellung öffentlicher Zugangslinks nicht protokolliert** | `issuePublicToken` schrieb nur die Tokenzeile | **Echt. Behoben.** |
| **Benachrichtigungsendpunkte ohne Rate-Limit** | vier Routen ohne `rateLimit` | **Echt. Behoben.** |
| **KI sendet Personendaten** | `suggestStaffing` sendete Klarnamen und Datenbankkennungen | **Echt. Behoben.** |

**Lehre für diese Mission:** Eine Aussage über Protokollabdeckung darf sich nicht an der Dateiablage orientieren, sondern muss dem Aufrufpfad folgen. Die Prüfungen in `tests/api/protokoll-und-schranken.test.ts` fragen deshalb den Code, nicht die Ordnerstruktur.

### Umgesetzt

| Änderung | Datei | Wirkung |
|---|---|---|
| Rate-Limit für alle vier Benachrichtigungsendpunkte | `src/app/api/notifications/**` | `apiRead` für Lesen, `apiWrite` für Schreiben. Es waren die einzigen angemeldeten Endpunkte ohne Schranke |
| Protokolleintrag bei Ausstellung eines Zugangslinks | `access-token.service.ts` | Zweck, Ressource, Frist, Verwendungsgrenze — **ohne** rohen Token und ohne Hash |
| Kennungen der zugeteilten Personen im Protokoll | `job.service.ts` (`assignJob`) | „an 3 Person(en) zugeteilt" beantwortete nicht, *wer*; die Zuteilung wird beim Umdisponieren überschrieben |
| Pseudonymisierung im KI-Personalvorschlag | `src/lib/ai/features.ts` | Kürzel `P1…`/`A1…` je Anfrage; weder Name noch Datenbankkennung verlassen das System; unbekannte Kürzel in der Antwort werden verworfen |

### Neuer Befund, grösser als gemeldet

**Die Automatisierungs-Regelmaschine existiert nicht.** `Automation` lässt sich über `/admin/einstellungen` anlegen, ändern und löschen (`operations-admin.service.ts`), und `AutomationTrigger` kennt 20 Auslöser — aber **kein Codepfad liest die Regeln, um sie auszuführen**. `AutomationRun` wird nie geschrieben; das Modell erscheint ausschliesslich als Ziel der Datenbereinigung.

Die fest verdrahteten Cron-Aufgaben in `automation.service.ts` (Terminerinnerungen, Bewertungsanfragen, Geburtstagsgrüsse) tun Ähnliches, ignorieren die konfigurierten Regeln aber vollständig.

Damit ist „Automatisierungen" eine Oberfläche ohne Wirkung — ein **FRONTEND ONLY**-Merkmal, das eine Zusage macht, die das System nicht einlöst. Das ist eine Regelmaschine und gehört nach **Wave 6** (Hintergrundjobs), nicht in eine Sicherheitskorrektur. Bis dahin ist die Einstufung in der Matrix zu korrigieren.

### Verifikation nach Wave 1

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck` | ✅ |
| `npm run lint` | ✅ |
| `npm run build` | ✅ |
| `npm run docs` | ✅ 401 Endpunkte, Schutz stimmt überein, erzeugte Dateien unverändert |
| `npm test` | ✅ **878 Prüfungen, 876 bestanden, 0 Fehlschläge**, 2 übersprungen |
| `npm run e2e` | ✅ **20 / 20** |
| CI-Reihenfolge (`npm test` → `npm run e2e`, ein Server) | ✅ nachgestellt und grün |

> **Ein Zwischenbefund, der festgehalten gehört:** Ein erster E2E-Lauf meldete 19/20 mit einem Hydrationsfehler. Ursache war **nicht** die Änderung, sondern erschöpfte Rate-Limit-Zähler aus einem zusätzlichen Zwischenlauf gegen denselben Server. Mit frisch gestartetem Server und in der exakten CI-Reihenfolge läuft alles grün. Die Zähler liegen als Dateien in `CLENARIS_TEST_CACHE_DIR` und werden beim Serverstart geleert — wer zwei volle Reihen gegen denselben Prozess fährt, muss damit rechnen.

---

## 11. Wave 2 — Schadsoftware- und Dateisicherheit (Stand 2026-09-21)

Ausgangslage: **SEC-020 = NOT IMPLEMENTED**, keine Codestelle. Uploads wurden
byteweise gegen die Signatur geprüft (`verifyBytes`, Gate 2), aber niemand sah
sich an, *was* in diesen Bytes steht — und der Dateiname wurde überhaupt nicht
betrachtet.

### Was gebaut wurde

| Teil | Ort | Kern |
|---|---|---|
| Zustände und Schnittstelle | `src/lib/security/malware/scanner.ts` | Genau ein auslieferbarer Zustand; `ERROR` ist das Gegenteil von `CLEAN`, nicht dessen Sonderfall |
| ClamAV | `…/clamav.ts` | `zINSTREAM` über TCP, eigener Zeitgeber statt Socket-Timeout, Fehlercodes statt Prüfertext |
| Testprüfer | `…/test-scanner.ts` | Nur EICAR; wirft beim Erzeugen, wenn er in der Produktion landen würde |
| Auslieferungstor | `…/auslieferung.ts` | Zustand × Herkunft, fail closed |
| Dateipolitik | `src/lib/storage/dateipolitik.ts` | Endung gegen nachgewiesenen Typ, Verbotsliste über den **ganzen** Namen |
| Durchsetzung | `src/server/services/file.service.ts` | `scanFileAsset`, Einbindung in `finalizeUpload` und `authorizeStoredFile` |
| Nachlauf | `scripts/scan-backfill.ts` | Altbestand und liegengebliebene Fälle |
| Dokumentation | `docs/MALWARE_PROTECTION.md` | Reihenfolge der Tore, `clamd.conf`-Abgleich, Betriebs-Checkliste |

### Drei Entscheidungen, die den Unterschied machen

1. **`AUSLIEFERBAR` ist eine Erlaubnisliste mit einem Eintrag.** Eine Liste der
   gesperrten Zustände hätte bei jedem neuen Zustand erweitert werden müssen,
   und wer sie vergisst, hat einen neuen Zustand erfunden, der ausgeliefert
   wird. So ist ein neuer Zustand automatisch gesperrt.
2. **Das Tor sitzt bei jedem Abruf, nicht einmalig beim Abschluss.** Eine
   Datei, die ein Nachlauf morgen in Quarantäne schickt, ist ab diesem Moment
   nicht mehr abrufbar, ohne dass irgendwo ein Zwischenspeicher zu leeren wäre.
3. **Die Migration stuft jede Altdatei als `LEGACY_UNSCANNED`/`PENDING` ein,
   keine als `CLEAN`.** Gegen die Entwicklungsdatenbank belegt: 15 Zeilen,
   keine automatisch als sauber. Der Bestand ist damit zunächst gesperrt; der
   Weg heraus ist der Nachlauf, nicht eine Behauptung.

### Zwei Befunde, die erst die Prüfreihe hervorgebracht hat

**Gemischte Schreibweise bei den gefährlichen MIME-Typen.** Der Eingabewert
wurde gesenkt, die Menge stand gemischt — durchgelassen wurden genau die drei
makrofähigen Office-Typen, also die einzigen in der Liste, auf die es fachlich
wirklich ankommt. Gefunden von `dateisicherheit.test.ts`, nicht von einem
Review.

**Eine öffentliche Leseadresse im Upload-Ticket.** `createSignedUpload` gab
neben der Schreibadresse die öffentliche Objektadresse zurück, und
`POST /api/files/upload-url` reichte das Ticket unverändert an den Client
weiter. Beim Supabase-Treiber war das ein Zeiger auf Bytes, die zu diesem
Zeitpunkt weder byteweise geprüft noch gegen die Dateipolitik gehalten noch auf
Schadsoftware untersucht sind — und zu denen es noch gar kein `FileAsset` gibt,
an dem sich eine Berechtigung prüfen liesse. Ob der Umweg tatsächlich trägt,
hing an der Sichtbarkeit des Buckets, also an einer Einstellung ausserhalb
dieses Codes; eine Sicherheitseigenschaft, die daran hängt, ist keine. Das Feld
ist entfallen — gebraucht hat es nie jemand, `UploadZiel` in `lib/upload.ts`
kennt es nicht einmal.

### Offen — bewusst in spätere Waves verschoben

| Punkt | Wohin | Warum |
|---|---|---|
| Eigene `SecurityEvent`-Ereignisse (`FILE_SCAN_*`, `FILE_QUARANTINED`) | Wave 3 | Sie gehören in das Sicherheitszentrum, das es noch nicht gibt. Heute steht der Befund als Auditeintrag und am Datensatz |
| Geplanter Nachlauf statt Skript von Hand | Wave 6 | Ein wiederkehrender Auftrag gehört in die Hintergrundaufträge und nicht in `file.service.ts` |
| Kennzahlen (`ERROR`-Quote, Verweildauer in `SCANNING`) | Wave 5 | Ohne Beobachtbarkeit gibt es keinen Ort, an dem sie landen |

### Verifikation nach Wave 2

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck` | ✅ |
| `npm run lint` | ✅ |
| `npm run build` | ✅ |
| `prisma validate` | ✅ |
| `npm run docs` | ✅ 401 Endpunkte, Schutz stimmt überein; `docs/DATABASE.md` um die neuen Aufzählungstypen und Felder ergänzt |
| Migration gegen die Entwicklungsdatenbank | ✅ additiv, 15 Altzeilen auf `LEGACY_UNSCANNED`/`PENDING`, keine auf `CLEAN` |
| `scripts/scan-backfill.ts` (echter Lauf) | ✅ 3 `CLEAN`, 12 `ERROR` (`NO_BYTES` — Altzeilen ohne physische Ablage) |
| `npm test` | ✅ **919 Prüfungen, 917 bestanden, 0 Fehlschläge**, 2 übersprungen (von 878) |
| `npm run e2e` | ✅ **20 / 20** |

> **PRE-PRODUCTION VERIFICATION REQUIRED.** In der vertrauenswürdigen
> Entwicklungsumgebung läuft kein `clamd`. Der ClamAV-Adapter ist vollständig
> und gegen das Protokoll gebaut, aber nicht gegen einen echten Dienst
> gelaufen. Vor dem Produktivgang: `clamd` erreichbar, `clamd.conf` gegen die
> Tabelle in `docs/MALWARE_PROTECTION.md` abgeglichen (`StreamMaxLength`
> **grösser** als `SCAN_MAX_BYTES`), `freshclam` aktiv, Ablage-Bucket nicht
> öffentlich, Nachlauf gefahren, `CLENARIS_LEGACY_FILES` danach entfernt.

> **Eine Falle beim Prüflauf, die Zeit gekostet hat:** Ein mit `Start-Job`
> gestarteter Testserver stirbt mit der PowerShell-Sitzung. Der Folgeaufruf
> lief gegen einen toten Server und meldete 483 statt 919 Prüfungen — 74
> Reihen „not ok" bei `# fail 0`, was wie ein Flächenbrand aussieht und keiner
> war. Der Server gehört losgelöst gestartet (`Start-Process … -WindowStyle
> Hidden`), wie es `CLAUDE.md` für `next start` ohnehin schon festhält.

---

*Diese Datei wird nach jeder Wave fortgeschrieben.*
