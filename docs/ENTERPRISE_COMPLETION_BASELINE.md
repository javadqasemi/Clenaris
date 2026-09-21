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

## 12. Wave 3 — Sicherheitszentrum (Stand 2026-09-21)

Ausgangslage: **MISSING #8**, kein Security Center. Der Zustand war überall
vorhanden — `User.lockedUntil`, `User.failedLoginCount`, `RefreshToken`,
`DeviceHandoffSession`, seit Wave 2 auch `FileAsset.scanStatus` — aber an
keiner Stelle zusammengeführt, und handeln liess sich nur über Umwege
(Passwort zurücksetzen, Zweitfaktor zurücksetzen), die beide mehr tun, als man
will.

### Die eine Entscheidung, an der alles hängt

**`SecurityEvent` steht neben `AuditLog`, nicht darin.** Technisch hätte alles
hineingepasst. Drei Gründe dagegen; der dritte wiegt am schwersten:

1. **Menge** — das Prüfprotokoll nimmt jeden ändernden Geschäftsvorgang auf
   (223 Aufrufstellen). Eine Sicherheitssicht darin *findet* Fehlversuche und
   *übersieht* sie trotzdem, weil sie zwischen Rechnungsänderungen stehen.
2. **Frage** — das Prüfprotokoll sagt, wer welchen Datensatz geändert hat. Ein
   Fehlversuch ändert keinen. Ihn als „Änderung an `User`" zu führen, wäre eine
   Notlüge, die man später glaubt.
3. **Bearbeitungszustand** — ein Protokolleintrag ist fertig, sobald er
   geschrieben ist. Ein gesperrtes Konto ist *offen*, bis jemand hingesehen
   hat. `acknowledgedAt` in `AuditLog` wäre für 99 % der Zeilen bedeutungslos.

Der Strom **ersetzt** das Prüfprotokoll nicht: Eine Rollenvergabe steht in
beiden, und das ist richtig.

### Was gebaut wurde

| Teil | Ort |
|---|---|
| Modell, zwei Aufzählungstypen, vier Indizes | `prisma/schema.prisma`, Migration `20260921170000` |
| Katalog (26 Arten, Kategorie × Schwere) | `src/lib/security/events.ts` — rein, direkt prüfbar |
| Schreibweg mit derselben Redigierung wie das Prüfprotokoll | `src/lib/security/record.ts` |
| Anschluss an sechs Dienste | Anmeldung, Zweitfaktor, Sitzungserneuerung, Rollen/Status, Zugangslinks, Dateiprüfung |
| Lesesicht, Handlungen | `src/server/services/security.service.ts` |
| Vier Endpunkte | `/api/security/events`, `…/{id}/acknowledge`, `…/users/{id}/unlock`, `…/users/{id}/revoke-sessions` |
| Seite | `/admin/sicherheit` |
| Dokumentation | `docs/SECURITY_CENTER.md` |

### Drei Entwurfsentscheidungen, die man leicht andersherum trifft

**Die Art ist eine Zeichenkette, kein `enum`.** Ein `enum` wäre sauberer und
verlangte für jede neue Art eine Migration. Wer im Betrieb eine Stelle
absichert, schreibt dann kein Ereignis mit — nicht aus Nachlässigkeit, sondern
weil der Aufwand im Moment grösser ist als der Nutzen. So entstehen
Sicherheitsprotokolle mit Lücken. Die Typsicherheit wandert in den Katalog.

**Ein geratener Zugangslink erzeugt kein Ereignis.** Abgelaufen, widerrufen und
verbraucht schon. Ein Ereignis je unbekanntem Wert hiesse: Wer vierstellig oft
rät, schreibt vierstellig viele Zeilen. Ein Protokoll, das sich von aussen
füllen lässt, ist ein Verstärker. Gegen das Raten steht das Rate-Limit.

**Bestätigen löscht nicht.** Die Zeile bleibt; Zeitpunkt, Person und Notiz
kommen hinzu. Ein „erledigt"-Häkchen, das die Zeile verschwinden lässt, wäre
die bequemere Oberfläche und die schlechtere Auskunft.

### Ein Befund über die Prüfreihe selbst

Der erste Gesamtlauf nach Wave 3 meldete **drei Fehlschläge in
`addresses.test.ts`** — einer Datei, die ich nicht angefasst hatte. Ursache
war meine eigene neue Prüfreihe: Sie legte Wegwerfkonten mit der Rolle
`CUSTOMER` an, und eine Einladung als `CUSTOMER` erzeugt über
`ensureCustomerProfile` eine **Kundenakte**, die beim weichen Löschen des
Kontos stehen bleibt. `addresses.test.ts` nimmt „irgendeine fremde Akte" aus
der Kundenliste — und das war dann eine ohne Adressen.

Der Fehlschlag stand also in einer anderen Datei als seine Ursache. Genau die
Verschmutzung, die `tests/README.md` mit „jede Prüfung räumt vor und nach sich
auf" meint. Behoben durch die Rolle `EMPLOYEE`, die keine Akte anlegt; der
Grund steht als Kommentar an der Stelle, damit niemand ihn zurückdreht.

Zweiter Befund aus demselben Lauf: Die Gesamtreihe wuchs von **128 auf 422
Sekunden**. Ursache war der Sperrtest — das Anmeldelimit (8 je Adresse) liegt
genau auf der Kontosperre (8 Fehlversuche), also lief er unweigerlich in den
429 und der Klient sass die Fenster aus. Die Zähler werden jetzt vor jedem
Versuch geleert; geprüft wird die Kontosperre, und die zählt am Konto.
Ergebnis: **86 Sekunden** — schneller als vor der Wave.

### Offen — bewusst verschoben

| Punkt | Wohin | Warum |
|---|---|---|
| Aufbewahrungsfrist für `security_events` | Wave 24 | Gehört einheitlich mit `AuditLog` und `Notification` geregelt, nicht je Tabelle einzeln. Heute löscht nichts diese Tabelle |
| `ACCESS_DENIED` aus `defineRoute` heraus | Wave 5 | Jeder abgelehnte Zugriff als Zeile wäre dieselbe Mengenfalle wie beim geratenen Link. Das gehört als **Zähler** in die Beobachtbarkeit, nicht als Ereignis in den Strom |
| Geräteübergaben als Ereignis | Wave 6 | Die Arten stehen im Katalog; der Anschluss wartet, bis die Hintergrundaufträge da sind — dort entsteht ohnehin der Ablauf, der offene Übergaben aufräumt |

### Verifikation nach Wave 3

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck` | ✅ |
| `npm run lint` | ✅ (ganzes Projekt) |
| `npm run build` | ✅ |
| `prisma validate` | ✅ |
| `npm run docs` | ✅ **405 Endpunkte** (von 401), Schutz stimmt überein; `docs/DATABASE.md` 118 Modelle |
| Migration gegen die Entwicklungsdatenbank | ✅ additiv, keine Rückfüllung — ein Ereignis ist kein Zustand |
| `npm test` (frische Testdatenbank) | ✅ **945 Prüfungen, 941 bestanden, 0 Fehlschläge**, 4 übersprungen (alle bestandsabhängig und vorbestehend) |
| `npm run e2e` | ✅ **20 / 20** |

---

## 13. Wave 4 — Schlüsselverwaltung (Stand 2026-09-21)

Zwei MISSING-Punkte auf einmal: **#3 Schlüsselrotation** und **#4
Verschlüsselung von Lohn- und Bankdaten (SEC-021)**. Der zweite ist nicht so
erledigt worden, wie er formuliert war — und das ist das Ergebnis, nicht eine
Abkürzung.

### SEC-019 — Rotation

Vorher gab es keine. Der Kommentar in `crypto.ts` sagte das ehrlich, aber es
hiess: Ein einmal abgeflossener Schlüssel bleibt für immer der Schlüssel, es
sei denn, man nimmt in Kauf, dass alle zweiten Faktoren, AHV-Nummern und
Alarmcodes unlesbar werden.

| Teil | Kern |
|---|---|
| Schlüsselbund | `ENCRYPTION_KEY` aktiv (schreibt), `ENCRYPTION_KEY_PREVIOUS` nur lesend |
| Format `enc:v2:<kid>` | Acht Hexzeichen SHA-256 über die Schlüsselbytes |
| `scripts/rotate-encryption-key.ts` | `--status` und der Umschlüsselungslauf |
| `deriveSecretAll` | Bestätigungscodes und Unterzeichnungssitzungen überstehen die Rotation |

**Warum der zweite Lesepfad die ganze Sache ist.** Ohne ihn wäre eine Rotation
ein Ausfall: In dem Moment, in dem der neue Schlüssel aktiv wird, ist jeder
vorhandene Wert unlesbar. Vorher umschlüsseln geht auch nicht — dann ist der
Bestand neu und die laufende Anwendung alt. Es gibt keine Reihenfolge, die
ohne zweiten Lesepfad funktioniert.

**Warum die Schlüsselkennung dazugehört.** v1 sagt nicht, mit welchem
Schlüssel es verschlüsselt wurde. Ohne diese Auskunft lässt sich weder
beantworten, ob eine Rotation fertig ist, noch warum ein einzelner Wert nicht
aufgeht. Die Kennung ist ein Hash über den Schlüssel und darf deshalb in eine
Fehlermeldung — die Prüfreihe hält fest, dass sie weder Präfix noch Teil des
Schlüssels ist.

### SEC-021 — geprüft, und anders entschieden

Der Auftrag lautete, vor der Entscheidung Suchbarkeit, Sortierung,
Lohnrechnung, Berichte, Decimal-Verhalten, Rotation, Sicherung und Rechte je
Feld zu untersuchen — und ausdrücklich **keine** pauschale Verschlüsselung.
Das Ergebnis:

| Feld | Entscheid | Ausschlaggebend |
|---|---|---|
| `Employee.iban` | **verschlüsselt** | Eine Kennung. Wird nirgends gerechnet, sortiert, gefiltert oder aggregiert — die Verschlüsselung kostet sie nichts |
| `Employee.hourlyRate`, `monthlySalary`, `TimeEntry.hourlyRate` | **nicht verschlüsselt** | Werden **in der Datenbank** verrechnet: `_avg` in `scenario.service.ts`, zweimal SQL-`SUM` in `analytics.service.ts`. Ein Chiffrat ist eine Zeichenkette; `AVG` darüber ergibt einen Fehler, keine Zahl |
| `Organization.iban`, `qrIban` | **nicht verschlüsselt** | Stehen auf jeder Rechnung. Etwas zu verschlüsseln, das man selbst veröffentlicht, ist keine Massnahme |

Drei weitere Gründe gegen die Lohnfelder, jeder für sich hinreichend:
`Decimal(12,2)` ginge verloren und die Rundungsregeln wanderten aus der
Datenbank in die Anwendung; die Migration wäre ein `ALTER COLUMN … TYPE text`
über Produktionsdaten; und der Gewinn wäre klein, weil im selben Abzug alle
Rechnungsbeträge, alle Zeiterfassungen und die vollständige Lohnhistorie
stehen — wer den Lohn wissen will, rechnet ihn aus dem Rest aus.

**Tokenisierung** wurde geprüft und verworfen: Sie lohnt sich, wenn ein Wert
eine Systemgrenze überschreitet. Ein Lohn tut das nie, und der Tresor wäre
eine zweite Datenbank mit demselben Problem.

**Die Antwort für die Zahlenfelder ist die Ebene darunter**: verschlüsselter
Datenträger und verschlüsselte Sicherungskopien. Sie schützt denselben Angriff
— den gestohlenen Abzug —, ohne einen einzigen `AVG`-Aufruf anzufassen. Das
ist Betrieb und nicht Code, deshalb steht SEC-021 als **C/EVR**.

Die Entscheidung ist als Prüfung festgehalten, nicht nur als Text: Eine
Prüfung liest die IBAN verschlüsselt aus der Spalte, eine zweite lässt die
Aggregation über `hourlyRate` laufen. Wer es später umdreht, bricht beide.

### Ein Fehler, den der erste echte Lauf gefunden hat

`argv.indexOf('--feld')` liefert **−1**, wenn der Schalter fehlt — und
`argv[-1 + 1]` ist `argv[0]`. Ein Lauf mit `--status` hatte damit den
Feldnamen `"--status"` und übersprang **jedes** Feld: keine Fehlermeldung,
keine Zeile, am Ende „✓ Alle Werte stehen auf dem aktiven Schlüssel."

Genau so sieht ein Rotationsskript aus, das nichts tut und behauptet, fertig
zu sein. Gefunden nur, weil der Lauf gegen eine echte Datenbank ging und die
erwarteten Feldzeilen fehlten.

### Verifikation nach Wave 4

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck` | ✅ |
| `npm run lint` | ✅ (ganzes Projekt) |
| `npm run build` | ✅ |
| `npm run docs` | ✅ 405 Endpunkte, erzeugte Dateien unverändert |
| Rotationslauf gegen die Testdatenbank | ✅ **4 v1-Werte umgeschlüsselt** (3 AHV-Nummern, 1 Alarmcode), Status danach vollständig auf dem aktiven Schlüssel |
| Fehlerweg an echten Zeilen | ✅ fremder Schlüssel ⇒ je Zeile „Für diesen Wert fehlt der Schlüssel defb7c8f. Vorhanden: ce5d1d18.", **nichts geändert**, Exitcode 1; Bestand danach unverändert |
| `npm test` | ✅ **963 Prüfungen, 959 bestanden, 0 Fehlschläge**, 4 übersprungen |
| `npm run e2e` | ✅ **20 / 20** |

> **PRE-PRODUCTION VERIFICATION REQUIRED.** `ENCRYPTION_KEY` muss in der
> Produktion gesetzt sein — ohne ihn hängt alles an `JWT_SECRET`, und der
> abgeleitete Schlüssel lässt sich nicht als Hexwert in
> `ENCRYPTION_KEY_PREVIOUS` eintragen. **Ohne `ENCRYPTION_KEY` ist keine
> Rotation durchführbar.** Dazu: verschlüsselter Datenträger und
> verschlüsselte Sicherungskopien, eine zweite Kopie des Schlüssels an einem
> Ort, der einen Serverausfall überlebt, und ein `--status`-Lauf ohne
> Klartext-Altbestand. Die Liste steht in `docs/KEY_MANAGEMENT.md` §8.

---

## 14. Wave 5 — Beobachtbarkeit (Stand 2026-09-21)

MISSING #6. Die Ausgangslage war nicht „kein Protokoll" — `lib/logger.ts` gibt
seit Langem strukturierte, maskierte Zeilen aus. Was fehlte, war die
**Klammer** und die **Messung**.

### Die Abgrenzung, die diese Wave ehrlich macht

Was entsteht, ist die **Erhebung** an der richtigen Stelle, nicht ein
Beobachtungssystem. Kein Prometheus, kein Datadog, kein Sentry, keine
Ausleitung. Ein Kennzahlendienst ist eine Betriebsentscheidung mit Kosten,
Datenschutzfragen und einem zweiten System, das laufen muss — die gehört dem
Betrieb. INF-008 steht deshalb auf **PARTIAL** und nicht auf COMPLETE, und
`docs/OBSERVABILITY.md` §1 sagt warum, damit es später nicht als Versäumnis
gelesen wird.

### Was gebaut wurde

| Teil | Kern |
|---|---|
| `observability/context.ts` | `AsyncLocalStorage` mit Anfragekennung; `routenVorlage` |
| `observability/metrics.ts` | Registrierung je Route × Methode, Zeitklassen, Quantile — rein, direkt prüfbar |
| `mitBeobachtung` in `handler.ts` | Um **alle drei** Fabriken, auch `defineCronRoute` |
| `logger.ts` | Zieht die Kennung selbst aus dem Kontext |
| `response.ts` | Kennung im Rumpf einer 500er-Antwort |
| `GET /api/metrics` | `security:read` |

### Vier Entscheidungen, die man leicht andersherum trifft

**Eine mitgeschickte `X-Request-Id` wird nicht übernommen.** Viele Proxys
setzen sie, und es ist verlockend. Sie ist aber eine Behauptung — genau wie
`X-Forwarded-For`. Wer sie übernähme, liesse jemanden beliebig viele
Protokollzeilen unter einer Kennung seiner Wahl ablegen, etwa unter der einer
echten Anfrage, die er stören will.

**Die Kennung steht nur bei 500 im Rumpf.** Bei 401, 403 und 422 fehlt sie
absichtlich: Die brauchen keine Nachforschung, und eine Kennung an jeder
Absage lädt dazu ein, sie zu sammeln.

**Die Kennzahlen laufen über Routen-Vorlagen.** `/api/jobs/clx…/team` wird zu
`/api/jobs/:id/team`. Ohne diesen Schritt entstünde eine Reihe je Datensatz —
bei zehntausend Einsätzen zehntausend Reihen, von denen keine genug
Beobachtungen für eine Aussage hätte, und die Registrierung wüchse mit den
Daten. Eine Prüfung durchsucht die laufenden Kennzahlen nach cuids: Findet sie
eine, ist die Vorlagenbildung kaputt.

**`/api/metrics` ist angemeldet.** Die übliche Bauart ist offen, dafür nur im
internen Netz erreichbar — das setzt ein internes Netz voraus, und in dieser
Betriebsform gibt es keines. Offen wäre der Endpunkt eine Echtzeitauskunft
darüber, ob ein Angriff auffällt.

### Offen — bewusst verschoben

| Punkt | Wohin |
|---|---|
| Ausleitung an einen Sammler, Alarmierung, Zeitreihe | Betriebsentscheidung |
| Kennzahlen der Dateiprüfung (`ERROR`-Quote, Verweildauer in `SCANNING`) | Wave 6 — sie hängen an einem wiederkehrenden Lauf |
| `ACCESS_DENIED` als Zähler je Konto | Wave 6 — gehört als Zähler hierher, nicht als Zeile in den Sicherheitsstrom |
| Ablaufverfolgung über Dienstgrenzen | entfällt — es gibt nur einen Dienst |

### Verifikation nach Wave 5

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck` | ✅ |
| `npm run lint` | ✅ (ganzes Projekt) |
| `npm run build` | ✅ |
| `npm run docs` | ✅ **406 Endpunkte** (von 405), Schutz stimmt überein |
| `npm test` | ✅ **986 Prüfungen, 982 bestanden, 0 Fehlschläge**, 4 übersprungen |
| `npm run e2e` | ✅ **20 / 20** |

> Die Gesamtreihe misst sich seit dieser Wave selbst mit: Jede der 986
> Prüfungen läuft durch `mitBeobachtung`. Dass die Laufzeit gegenüber Wave 4
> unverändert bei rund 90 Sekunden liegt, ist der Nachweis, dass die Messung
> nichts kostet.

---

## 15. Wave 6 — Hintergrundarbeit und Automatisierungsmaschine (Stand 2026-09-21)

Zwei MISSING-Punkte: **#7 Hintergrundwarteschlange** und **#12
`AutomationRun` wird nie geschrieben**. Der zweite war der ernstere, und er ist
in Abschnitt 10 dieser Datei als „Oberfläche ohne Wirkung" festgehalten worden.

### Der Befund, noch einmal

`Automation`, `AutomationAction` und `AutomationRun` standen seit der ersten
Migration im Schema. Es gab eine Oberfläche zum Anlegen von Regeln und einen
Dienst, der sie verwaltete. **`automation_runs` wurde von keinem Codepfad je
beschrieben.**

Die schlechteste Form einer Lücke: keine fehlende Funktion, sondern eine
Zusage, die das System nicht einlöst. Wer eine Regel anlegt, sieht sie aktiv in
der Liste und verlässt sich darauf, dass die Erinnerung hinausgeht.

### Was gebaut wurde

| Teil | Kern |
|---|---|
| `automation/conditions.ts` | Tabelle aus Feldnamen und Vergleichen — keine Ausdruckssprache, kein `regex`, kein „oder" |
| `automation/template.ts` | Platzhalter ersetzen, nicht auswerten; HTML maskiert |
| `automation/webhook.ts` | SSRF-Prüfung über die **aufgelöste** Adresse |
| `validation/automation-config.ts` | Schema je Aktionsart, Erlaubnisliste der Statuswerte |
| `automation-engine.service.ts` | Auslöser, Lader je Ressourcenart, Lauf, sieben Aktionen |
| Neun Auslöser in fünf Diensten | Buchung, Offerte, Rechnung, Einsatz, Anfrage |
| `/api/cron/hourly` + `daily` | Fällige Läufe in beiden Takten |
| Migration `…_versuche` | `attempts` — additiv |

### Fünf Entscheidungen

**Zwei Hälften, getrennt durch die Zeit.** Der Auslöser legt nur den Lauf an;
ausgeführt wird er aus dem Scheduler. Die einzige Bauart, die mit
`delayMinutes` verträglich ist — und sie sorgt nebenbei dafür, dass **eine
Automatisierung keinen Geschäftsvorgang scheitern lassen kann**.

**Der Zustand wird beim Ausführen neu geladen.** Zwischen Auslöser und
Ausführung können Tage liegen; ohne die zweite Bedingungsprüfung ginge die
Erinnerung an einen abgesagten Termin hinaus. Nebenbei liegt so keine Sammlung
von Personendaten in einer Json-Spalte.

**Die Nutzlast ist bewusst schmal.** Was dort nicht steht, kann eine Regel
nicht verschicken — und beim Webhook ist die Nutzlast der Rumpf.

**`UPDATE_STATUS` hat eine Erlaubnisliste, und nichts Finanzielles steht
darin.** Ohne sie hiesse die Aktion „schreibe in ein beliebiges Feld eines
beliebigen Datensatzes einen beliebigen Wert". Zusätzlich darf eine Regel nur
den Datensatz ändern, der sie ausgelöst hat.

**`AI_GENERATE` ist ausdrücklich nicht umgesetzt.** Ein Maschinentext, der
ungelesen an die Kundschaft geht, ist genau das, was `docs/bi/` für den
Assistenten ausschliesst. Der Weg dahin führt über eine Aufgabe, die jemand
liest — und den gibt es als `CREATE_TASK`.

### Die SSRF-Lücke, die bleibt

Zwischen der Adressprüfung und der Auflösung, die `fetch` selbst vornimmt,
liegt ein Moment. Wer den DNS-Eintrag in diesem Moment ändert, umgeht die
Prüfung. Vollständig schliessen liesse sich das nur, indem die geprüfte Adresse
direkt angewählt wird — dann passt der Name im TLS-Handschlag nicht mehr.

**Benannt statt verschwiegen** (`docs/AUTOMATION.md` §7). Davor liegen
`automation:update`, nur `https`, keine Weiterleitungen, Zeitlimit und
Grössengrenze; wer es enger will, setzt `AUTOMATION_WEBHOOK_HOSTS`.

### Zwei Fehler, die diese Wave gefunden hat

**Ein Produktfehler in der Buchung.** `createAddress` setzte `isDefault` und
`isBilling` bedingungslos auf `true`. Wer dreimal mit einer neuen Adresse
buchte, hatte danach **drei** Standard- und drei Rechnungsadressen — während
die Adressverwaltung genau eine erzwingt. Das ist nicht nur Unordnung:
`invoice.service.ts` holt die Rechnungsadresse mit `take: 1` **ohne
Sortierung**, der Rechnungsempfänger wäre also von Lauf zu Lauf ein anderer
gewesen. Aufgefallen, weil die neue Prüfreihe Buchungen mit Adresse erfasst und
`addresses.test.ts` danach drei Standardadressen fand.

**Ein Auskunftsfehler im Tageslauf.** Aufgaben und Bezeichnungen standen in
zwei Feldern, die über den Index zusammenfanden — elf Läufe, zehn
Bezeichnungen. Der letzte (`runSignatureNightly`) landete unter dem Schlüssel
`undefined`; wäre er gescheitert, hätte die Antwort eine fehlgeschlagene
Aufgabe namens „undefined" gemeldet. Der Fehler machte nichts kaputt, er nahm
nur die Auskunft weg — ausgerechnet über den Lauf, der Vorgänge abschliesst.

### Und zwei eigene Prüfungen, die zu schwach waren

Zwei Fälle in `sicherheitszentrum.test.ts` zählten Treffer **innerhalb einer
Seite** von 200 Einträgen und verglichen vorher/nachher. Das ging gut, solange
der Strom kürzer als eine Seite war, und schlug fehl, sobald er darüber
hinauswuchs: Der neue Eintrag steht vorn, verdrängt aber den ältesten — und war
der auch ein Fehlversuch, bleibt die Zahl gleich.

Eine Prüfung, die von der Länge des Bestands abhängt, misst den Bestand und
nicht die Sache. Jetzt über `gesamt` (ein `count` über die ganze Abfrage) und
über den `userId`-Filter.

### Offen — bewusst verschoben

| Punkt | Wohin | Warum |
|---|---|---|
| Zeitbezogene Auslöser als Regeln (`*_REMINDER_*`, `QUOTE_EXPIRING`, `CUSTOMER_BIRTHDAY`) | später | Sie bezeichnen keinen Zustandsübergang, sondern einen Zeitpunkt. Für die häufigsten gibt es die festen Läufe; sie durch Regeln zu ersetzen ist eine eigene Änderung mit eigenem Nachweis |
| Ansicht der Läufe in der Oberfläche | später | Der Schreibpfad ist die Zusage, die fehlte. Die Ansicht ist eine Bequemlichkeit |
| Minutengenauigkeit | Betriebsentscheidung | Verlangt einen eigenen Arbeitsprozess |
| `ACCESS_DENIED` als Zähler je Konto | **entfällt** | Aus Wave 3/5 übernommen und hier entschieden: Ein Zähler je Konto ist dieselbe Mengenfalle wie eine Zeile je geratenem Zugangslink. Die 4xx-Quote je Route (Wave 5) beantwortet die betriebliche Hälfte; die personenbezogene wird nicht gebaut |

### Verifikation nach Wave 6

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck` | ✅ |
| `npm run lint` | ✅ (ganzes Projekt) |
| `npm run build` | ✅ |
| `npm run docs` | ✅ 406 Endpunkte, Schutz stimmt überein |
| Migration | ✅ additiv (`attempts`), keine Rückfüllung nötig — es gab keine Zeilen |
| `npm test` (auf **frischer** Testdatenbank) | ✅ **1021 Prüfungen, 1018 bestanden, 0 Fehlschläge**, 3 übersprungen |
| `npm run e2e` | ✅ **20 / 20** |

---

## 16. Wave 7 — Personalstammdaten (Stand 2026-09-21)

Zwei PARTIAL-Punkte aus Abschnitt 4: „Mitarbeiterfähigkeiten — Schreibpfad und
Maske" und „Arbeitszeiten — Bearbeitungsmaske und Endpunkt".

### Der Befund

Beide Listen wurden **gelesen** — die Personalakte zeigt sie, die
Eignungsprüfung beim Zuteilen wertet die Arbeitszeit aus, der
Personalvorschlag die Qualifikationen — und **keine der beiden liess sich
ändern**. Die Arbeitszeit entstand beim Anlegen als Montag bis Freitag
07:00–17:00 und blieb das für immer.

Für einen Betrieb mit Teilzeit, Schichten und Samstagsdiensten ist das keine
Vorgabe, sondern eine Behauptung — und die Warnung beim Zuteilen entsprechend
falsch. **Eine Angabe, die niemand pflegen kann, ist schlechter als keine: Sie
sieht aus wie eine Aussage.**

### Was gebaut wurde

`PUT /api/employees/{id}/skills` und `…/availability`, beide `employee:update`,
beide ersetzen die Liste als Ganzes. Dazu zwei Dialoge in der Personalakte und
13 Prüfungen.

### Vier Entscheidungen

**`PUT`, nicht `PATCH`.** Keine Formsache: `PATCH` verspricht eine
Teiländerung, und wer das erwartet, schickt eine Qualifikation und verliert die
anderen.

**Ersetzen, nicht abgleichen.** Der feinere Weg hätte einen Zweck, wenn an den
Zeilen etwas hinge, das ihre Kennung braucht — eine Historie, ein
Fremdschlüssel, ein Prüfpfad. Nichts davon ist der Fall. Ohne diesen Zweck ist
der Abgleich nur eine zweite Stelle, an der etwas falsch sein kann. Und
Ersetzen ist wettlauffrei.

**Eine freie Fensterliste statt sieben Wochentagszeilen.** Sieben Zeilen wären
übersichtlicher und liessen den **geteilten Dienst** nicht zu (morgens
Treppenhaus, abends Büroreinigung) — häufig in diesem Gewerbe. Der Endpunkt
kann zwei Fenster am selben Tag; eine Maske, die es nicht kann, würde das
zweite beim nächsten Speichern stillschweigend löschen.

**Zwei Prüfungen, die der eindeutige Index nicht leisten kann.** Doppelte Namen
fängt er ab, aber als 409 über eine Datenbankeinschränkung; das Schema sagt,
*welcher* Name doppelt ist. Überlappende Zeitfenster fängt er gar nicht — er
deckt nur `(employee, weekday, startTime)` ab, also gingen 07:00–12:00 und
09:00–17:00 glatt durch.

### Was bewusst nicht dazukam

**Qualifikationen fliessen weiterhin nur in den Personalvorschlag ein, nicht in
die Eignungsprüfung.** Eine echte Prüfregel wäre eine fachliche Entscheidung —
„darf jemand ohne Staplerschein diesen Einsatz übernehmen: Warnung oder
Sperre?" — und gehört nicht als Nebenwirkung einer Pflegemaske hinein.
JOB-011 bleibt deshalb **PARTIAL** mit genau dieser offenen Frage.

**Die Arbeitszeit bleibt eine Planungshilfe.** Die Eignungsprüfung warnt bei
einem Einsatz ausserhalb und blockiert ihn nicht; das steht so in
`assignment.service.ts`. Daraus folgt das Gegenstück: Wer die Zeiten
einschränkt, wirft keine bereits geplanten Einsätze um.

### Verifikation nach Wave 7

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck`, `npm run lint`, `npm run build` | ✅ |
| `npm run docs` | ✅ **408 Endpunkte** (von 406) |
| `npm test` | ✅ **1034 Prüfungen, 1031 bestanden, 0 Fehlschläge**, 3 übersprungen |
| `npm run e2e` | ✅ **20 / 20** |

> **BACKEND ONLY ist damit leer.** Das war die kleinste Kategorie der Matrix
> und die ärgerlichste: Logik, die es gibt und die niemand bedienen kann.

---

## 17. Wave 8 — Zeiterfassung (Stand 2026-09-21)

Risikoliste Platz 9: „Zeiterfassung prüfen — C, ungeprüft — **Grundlage der
Lohnabrechnung**". Die Prüfung ergab, dass mehr fehlte als Prüfungen.

### Der Befund

Es gab zwei Endpunkte: einstempeln und ausstempeln.

`TimeEntry.approved`, `approvedById` und `manual` standen im Schema und wurden
von **keinem Codepfad je geschrieben**. `timetracking:approve` war an Rollen
vergeben und wurde von **nichts** geprüft. `timetracking:read_all` nur vom
Buchhaltungsexport — es gab keinen Weg, die Zeiten *anzusehen*, ohne sie zu
exportieren.

Im Betrieb: Wer das Ausstempeln vergisst, hat einen offenen Eintrag, den
niemand schliessen kann. Wer sich vertippt, hat eine falsche Zeit, die niemand
korrigieren kann. Und niemand kann eine Zeit freigeben, bevor sie in die
Lohnabrechnung geht.

Damit war es dasselbe Muster wie bei den Automatisierungen in Wave 6: nicht
eine fehlende Funktion, sondern Felder und Berechtigungen, die eine Zusage
machen, die das System nicht einlöst.

### Die vier Regeln

| Regel | Was sie verhindert |
|---|---|
| **Die Dauer rechnet der Server** | `minutes` kommt in keinem Schema vor. Ein Feld, in das der Client eine Minutenzahl schreiben könnte, wäre ein Feld, in das jemand eine Lohnsumme schreiben kann — dieselbe Regel wie bei den Preisen |
| **Eine freigegebene Zeit ist eingefroren** | Ohne diese Schwelle wäre „freigegeben" eine Anzeige und keine Aussage. Korrigieren verlangt ein ausdrückliches Aufheben, und das steht im Protokoll |
| **Keine Überschneidungen je Person** | Zwei gleichzeitige Erfassungen ergäben doppelten Lohn für dieselbe Stunde |
| **Die Lohnkosten wandern mit** | `clockOut` schreibt `job.laborCost` fort. Eine Korrektur, die das nicht nachzieht, lässt die Nachkalkulation auseinanderlaufen — still, weil niemand die beiden Zahlen nebeneinander sieht |

Dazu eine Obergrenze von 24 Stunden je Erfassung. Nicht, weil jemand 25
Stunden arbeiten könnte, sondern wegen des vergessenen Ausstempelns: Ein
Eintrag von Freitagmorgen bis Montagmittag ergibt 4400 Minuten, und die gehen
unbemerkt in die Lohnkosten.

### Zwei Entwurfsentscheidungen

**Freigeben als Stapel, Zurücknehmen einzeln.** Die Asymmetrie ist Absicht: Der
häufige Weg (Monatsende, Liste durchgehen) ist bequem, der seltene ist einzeln
und lässt sich nicht versehentlich auf einen ganzen Monat anwenden. Eine
*laufende* Erfassung wird beim Stapel übersprungen und nicht abgewiesen — wer
dreissig Zeilen markiert und eine laufende dabei hat, soll die neunundzwanzig
freigeben können.

**Die Summe über alle Treffer, nicht über die Seite.** Eine Seitensumme wäre
die häufigste Fehlerquelle einer solchen Ansicht: Sie sieht aus wie die
Monatssumme und ist es nicht, und niemand merkt es, solange der Monat auf eine
Seite passt. (Dieselbe Falle wie bei den Sicherheitsereignissen in Wave 6, dort
in meinen eigenen Prüfungen.)

### Warum EMP-015 auf `C` steht und nicht auf `C+V`

22 Prüfungen stehen dahinter, und trotzdem: Es fehlt die **Ansicht in der
Verwaltung**. Ohne sie ist der Vorgang für den Betrieb nicht abgeschlossen —
eine Schnittstelle bedient niemand. Die Regel aus Abschnitt 9 („kein Merkmal
wird COMPLETE genannt, weil Code existiert") gilt in beide Richtungen.

### Verifikation nach Wave 8

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck`, `npm run lint`, `npm run build` | ✅ |
| `npm run docs` | ✅ **414 Endpunkte** (von 408) |
| `npm test` | ✅ **1056 Prüfungen, 1053 bestanden, 0 Fehlschläge**, 3 übersprungen |
| `npm run e2e` | ✅ **20 / 20** |

---

*Diese Datei wird nach jeder Wave fortgeschrieben.*
