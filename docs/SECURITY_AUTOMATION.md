# Sicherheitsautomation

Stand 2026-09-26. Wie die Regeln aus `docs/SECURITY_STANDARD.md` automatisch
geprüft werden — und wo die Automatik endet.

## Kurz

```bash
npm run security:check                  # alle Prüfungen, Bericht nach security-reports/
npm run security:check -- --streng      # „nicht geprüft" zählt als Fehler
npm run security:check -- --datenbank   # Schranken auch in der Datenbank (DATABASE_URL)
npm run security:check -- --mit-tests   # Sicherheitsreihen gegen TEST_BASE_URL
npm run security:check -- --melden      # Bericht an die Sicherheitszentrale senden
npm run security:sbom                   # Stückliste CycloneDX nach security-reports/
```

Exitcode 1 bei einem **blockierenden** Befund oder wenn ein Werkzeug selbst
scheitert. Im CI läuft der Dirigent nach der Geheimnisprüfung
(`.github/workflows/deploy.yml`, Schritt „Sicherheitsprüfung"); Bericht und
Stückliste werden als Artefakt `sicherheitsbericht` 90 Tage aufbewahrt.

## Die vier Ausgänge

| Ausgang | Bedeutung |
|---|---|
| BESTANDEN | geprüft, nichts ausser Hinweisen |
| BEFUND | geprüft, mindestens eine Warnung oder ein blockierender Befund |
| **NICHT GEPRÜFT** | konnte hier nicht laufen. **Kein Bestehen.** Der Gesamtstatus ist dann höchstens „NICHT_GEPRUEFT", nie „OK" |
| FEHLER | das Werkzeug ist gescheitert — blockiert |

„Nicht geprüft" als „bestanden" zu zählen ist der Fehler, den dieser Aufbau
verhindern soll. Beispiel: Unter Windows ohne lauffähige Bash (WSL ohne
Distribution) läuft die Geheimnisprüfung nicht — dann steht dort
NICHT GEPRÜFT, und massgebend bleibt das CI. Ebenso, wenn die npm-Registry
nicht antwortet (beobachtet am 2026-09-26: einer von vier Läufen).

## Die Prüfungen

| Prüfung | Werkzeug | Blockiert bei | Findet nicht |
|---|---|---|---|
| Geheimnisse | `scripts/ci-secret-scan.sh` (massgebend, Bash) | jedem Treffer | selbst ausgedachte Passwörter, Geheimnisse in der Historie (einmalig geprüft, siehe Kopf des Skripts) |
| Abhängigkeiten | `npm audit --omit=dev --json`, eingeordnet gegen `security/akzeptierte-befunde.json` | `critical` immer; `high` ohne gültige, unabgelaufene Bewertung | unbekannte Lücken, Lücken in Entwicklungswerkzeugen (nur Hinweis), bösartige Pakete ohne Advisory |
| Musterprüfung | `scripts/security/muster.ts` | Regeln der Stufe „blockierend" ohne Unterdrückung; Unterdrückung ohne Begründung; veraltete Unterdrückung | Logikfehler, fehlende `organizationId`, falsche Rechte |
| Migrationen | `prisma validate`, BOM/Steuerzeichen, datenverlierende Anweisungen (Hinweis), handgeschriebene Schranken gegen `security/datenbank-schranken.json` | ungültigem Schema, BOM, fehlender Schranke | ob eine Migration fachlich richtig ist |
| Schnittstellen | OpenAPI-Registry gegen `security/oeffentliche-endpunkte.json` | neuem öffentlichen oder Cron-Endpunkt ohne Durchsicht | ob die Begründung stimmt |
| Repository | `git ls-files` (sonst Arbeitsbaum) | `.env`, Schlüsseldateien, fehlendem Lockfile, `.env` nicht ignoriert | Geheimnisse *in* Dateien (dafür die Geheimnisprüfung) |
| Prüfreihe | die Sicherheitsreihen (`rbac`, `ownership`, `mandanten`, `zugriffstokens`, `oeffentlicher-zugang`, `oeffentliche-links`, `dateisicherheit`, `datei-zugriff`, `auslieferung-absicherung`, `protokoll-*`, `session-refresh`, `scan*`, `suche`, `sicherheitszentrum`) | einem gescheiterten Fall | alles, wofür es keinen Fall gibt |

### Regeln der Musterprüfung

| Regel | Stufe | Standard | Frage an die Durchsicht |
|---|---|---|---|
| `sql-unsafe` | blockierend | C5 | Ist der SQL-Text vollständig konstant? |
| `prozess` | blockierend | C5 | Startet Anwendungscode einen Prozess? |
| `eval` | blockierend | C5 | Code aus Text? |
| `oeffentliches-geheimnis` | blockierend | C10 | Heisst ein Geheimnis `NEXT_PUBLIC_…`? |
| `tls-aus` | blockierend | C8 | Zertifikatsprüfung abgeschaltet? |
| `speicher-token` | blockierend | C1 | Token im Browserspeicher? |
| `route-ohne-factory` | blockierend | C2 | Endpunkt ohne `define*Route`? |
| `html-roh` | Warnung | C6 | `dangerouslySetInnerHTML` — maskiert? |
| `dom-html` | Warnung | C6 | `innerHTML`, `insertAdjacentHTML`, `document.write`? |
| `zufall` | Warnung | C13 | `Math.random` für ein Token? |
| `cors-alles` | Warnung | C7 | CORS `*`? |
| `klartext-http` | Warnung | C8 | ausgehend ohne TLS? |
| `protokoll-geheimnis` | Warnung | C10 | Geheimnis in der Konsole? |
| `rate-limit-fehlt` | Warnung | C9 | Endpunkt ohne Kontingent? |
| `weiterleitung-frei` | Warnung | C6 | Weiterleitung auf einen Anfragewert? |

Ein Treffer ist ein **Anlass zur Durchsicht**, kein Nachweis einer Lücke.

### Unterdrückungen

`security/unterdrueckungen.json`: je Regel und Datei, mit **erwarteter
Anzahl** und Begründung (mindestens 20 Zeichen). Kommt in derselben Datei ein
weiterer Treffer derselben Regel dazu, gilt die Unterdrückung nicht mehr, und
die Datei muss neu durchgesehen werden. Eine Unterdrückung ohne Treffer ist
veraltet und blockiert, bis sie entfernt ist. So kann eine Liste nicht still
wachsen, ohne dass jemand hinsieht.

Grundlinie am 2026-09-26: 43 Treffer, alle durchgesehen — 13 × JSON-LD (7)
bzw. maskierter Markdown (6), 5 Routen ohne Factory (Webhooks mit Signatur über den
Rohtext, Binärtransfer mit Ticket, Vorschauschalter), 6 × öffentlicher
Maps-Browserschlüssel (Referrer-beschränkt), 15 × konstantes oder
parametrisiertes SQL in Skripten und im Löschlauf, 4 Kontingente ausserhalb
der Routendatei bzw. bewusst keines bei signierten Webhooks.

### Was die erste Durchsicht gefunden und behoben hat

| Befund | Einordnung | Behoben |
|---|---|---|
| `scripts/setup-test-db.ts`: Anführungszeichenprüfung stand nach `DROP DATABASE` | FEHLER (gering: Name aus eigener `DATABASE_URL`) | Prüfung vor beide Anweisungen gezogen |
| `GET /api/auth/session` ohne Kontingent, liest die Datenbank | FEHLER | `apiRead` |
| `POST /api/auth/logout` ohne Kontingent, schreibt | FEHLER | `apiWrite` |
| `GET /api/handoff` ohne Kontingent | FEHLER | `apiRead` |
| `GET /api/content/preview` ohne Kontingent | FEHLER | `enforceRateLimit('apiWrite')` |

## Abhängigkeitsbefunde (Stand 2026-09-26)

`npm audit --omit=dev`: 0 kritisch, 4 hoch, 3 mittel (eindeutige Advisories:
3 hoch, 3 mittel). Alle bewertet, befristet bis 2026-12-31, gleichlautend mit
`docs/LIEFERKETTE.md`:

| Advisory | Paket | Einordnung |
|---|---|---|
| GHSA-ggr8-5vv4-36mx (high) | deepmerge-ts ← @prisma/config ← prisma | EXTERNE ABHÄNGIGKEIT: nur Werkzeug, eigene Konfiguration; Behebung = Prisma 7 |
| GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849 (high); GHSA-qx2v-qp2m-jg93, GHSA-fxqj-rqcc-2cmp (moderate) | postcss ← next | EXTERNE ABHÄNGIGKEIT: nur eigenes CSS beim Bau; Behebung = Next 16 |
| GHSA-w5hq-g745-h8pq (moderate) | uuid ← exceljs | nicht betroffen (nur `uuidv4()` ohne Puffer) |

Nach Ablauf blockiert jeder dieser Befunde wieder, bis jemand neu bewertet
oder behoben hat. Behebungen, die eine Hauptversion verlangen, sind eigene
Vorhaben mit eigener Prüfung — nie `npm audit fix --force` im Vorbeigehen.

## Stückliste

`npm run security:sbom` schreibt mit dem in npm eingebauten `npm sbom`
(keine neue Abhängigkeit) eine CycloneDX-Stückliste der
Laufzeitabhängigkeiten (am 2026-09-26: CycloneDX 1.5, 380 Komponenten). Sie
gehört als Artefakt zur Freigabe, nicht ins Repository.

## Melden an die Sicherheitszentrale

Mit `--melden` geht der Bericht als `POST` an `SECURITY_REPORT_URL`
(`https://…/api/cron/security-report`) mit `Authorization: Bearer
$SECURITY_REPORT_TOKEN`. Die Anwendung prüft das Token zeitkonstant,
validiert den Bericht (`src/lib/validation/security-report.ts`, alle Längen
begrenzt), speichert ihn und zeigt ihn in `/admin/sicherheit`. Sie **führt
nichts aus**: keine Prüfung, keine Shell, kein Dateizugriff. Dieselbe Tür
benutzen die Vorlagen des externen Überwachungsrechners
(`ops/security-monitor/`).

`SECURITY_REPORT_TOKEN` ist ein eigenes Geheimnis — nicht `CRON_SECRET`:
Wer Berichte senden darf, soll keine geplanten Läufe auslösen können.

## Sicherheitsupdates im Update Center

`/admin/updates` zeigt oben den Abschnitt „Sicherheitsupdates":

* **Clenaris-Versionen mit Sicherheitskorrekturen** (`kind = SECURITY` oder
  gesetzte `securitySeverity`), die noch nicht installiert sind — mit Link
  auf die Detailseite, wo wie bei jeder Version **freigegeben, terminiert,
  verschoben oder zurückgestellt** wird. Ausgeführt wird nichts (siehe
  `release.service.ts`).
* **Abhängigkeitsbefunde** (GHSA) aus dem letzten `security:check`-Bericht,
  mit Bewertung und Behebungsweg — nur Einsicht. Eine behobene Abhängigkeit
  kommt mit der nächsten Version.
* **Betriebssystem-Sicherheitsupdates** aus `deps_check.sh` — nur Einsicht;
  eingespielt vom Betrieb (unattended-upgrades).

Im Abschnitt gibt es weder Formular noch Knopf (`release-center.test.ts`
prüft das).

## Werkzeuge von Dritten — beschrieben, nicht installiert

Keines davon ist eingerichtet. Jedes wäre eine Ergänzung mit eigenem
Pflegeaufwand und gehört nach Bewertung in `docs/LIEFERKETTE.md`.

| Werkzeug | Wofür | Warum (noch) nicht |
|---|---|---|
| Semgrep (Community-Regeln) | Datenflussbewusste Musterprüfung (TypeScript, React) | Regelwerk will gepflegt werden; die eigene Musterprüfung deckt die bekannten Muster ab. Empfehlung: als nicht blockierender CI-Schritt erproben |
| GitHub CodeQL | Datenflussanalyse, Injection-Pfade | Braucht GitHub Advanced Security bzw. öffentliches Repository |
| gitleaks / trufflehog | Geheimnisse inkl. Historie, Entropie | `ci-secret-scan.sh` deckt Anbietermuster ab; Historie wurde einmalig geprüft |
| OSV-Scanner | Advisories aus OSV zusätzlich zu npm | Doppelt zu `npm audit` bis auf Ökosystemgrenzen |
| Trivy | Container-/Dateisystemscan des Servers | Gehört auf den Server bzw. in `ops/security-monitor/deps_check.sh` |
| OWASP ZAP (Baseline, passiv) | Kopfzeilen, Cookies, offensichtliche Fehlkonfiguration von aussen | Vorlage `ops/security-monitor/zap_baseline.sh`; läuft vom Überwachungsrechner, nie aktiv gegen Produktion |
| eslint-plugin-security | Lint-Regeln | Viele Fehlalarme (`detect-object-injection`); die gezielten Regeln stehen in der Musterprüfung |

## Was die Automatik nicht leistet

Sie behauptet nicht, dass Clenaris frei von Lücken ist. Sie findet bekannte
Muster, bekannte Advisories, bekannte Geheimnisformate, ungeprüfte
öffentliche Endpunkte und verschwundene Datenbankschranken. Fehlende
Mandanten- oder Eigentümerbedingungen, falsche Rechte, Logikfehler,
Rennbedingungen ohne Datenbankschranke und unbekannte Lücken findet sie
nicht — dafür gibt es die Prüfreihe mit den Pflichtfällen aus C20 und die
Durchsicht nach `docs/SECURITY_STANDARD.md`.
