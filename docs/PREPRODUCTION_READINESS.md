# Pre-Production-Bereitschaft

> **Historischer Stand.** Dieses Dokument hält die Pre-Production-Prüfung vom
> 2026-09-26/27 fest (Commits, Zahlen, CI-Läufe jener Tage) und wird nicht
> mehr fortgeschrieben. Seither: Prisma 7 statt 6.19.3, Artefakt-Auslieferung
> als einziger Weg, Release-Kandidat vom 2026-09-29 und die
> Production-V2-Härtung vom 2026-09-30/10-01 (Aktivierung nach Vertrag C3,
> Rücksprung von Hand, Identität der Instanz statt `APP_VERSION`, Prüfprotokoll
> nur fortschreibbar, Datenbanktor, Inhaltsrichtlinie ohne `'unsafe-eval'`).
> Der geltende Stand steht in `docs/RELEASEBEREITSCHAFT.md` §10, im Register
> `docs/PENDENZEN.md` (Abschnitt P2H), in `docs/PRODUCTION_V2.md` und
> `docs/DEPLOYMENT.md`. Zahlen und Wege unten sind die jener Tage — wo der
> heutige Code etwas anderes sagt, ist es angemerkt.

Stand 2026-09-26, fortgeschrieben 2026-09-27 (Nachträge C und D und
„UI/UX-Prüfmatrix" am Ende). Diese Mission hat **keine** Produktfunktion hinzugefügt,
nichts gepusht, nichts ausgeliefert, keinen Server, kein DNS, kein
Cloudflare und keine Geheimnisse angefasst und 2.29.18.45 nicht kontaktiert.
Status „READY" heisst in diesem Dokument: beschrieben, im Code getragen und —
wo angegeben — örtlich bewiesen. **Abgenommen auf echter Infrastruktur ist
davon nichts.**

## Ergebnis

```
HEAD BEFORE:  eba16bd
HEAD AFTER:   der Commit, der dieses Dokument hinzufügt; Code-Stand 0298b83
              (dieser Commit ändert nur docs/PREPRODUCTION_READINESS.md)

COMMITS:      6 — 1aa27cb, 61b74c4, 0ec3d3d, 39b4759, 0298b83 und dieses Dokument
MIGRATIONS:   keine neuen (42 im Repository, unverändert)

CLEAN RELEASE BUILD:          PASS (eba16bd und 0298b83; ein Zwischenversuch an
                              0298b83 scheiterte an einer DNS-Störung, siehe §1)
FRESH DATABASE MIGRATION:     PASS

npm test:                     1567 passed / 0 failed / 0 skipped (199 Dateien,
                              gegen die aus dem Nichts aufgebaute Datenbank)
E2E:                          42/42, retries = 0
STRESS:                       5/5 Läufe, je 42/42, neu gestarteter Server je Lauf
HYDRATION:                    0 Befunde (Hydrationsreihe aktiv in allen 6 Läufen)

SECURITY:CHECK LOCAL:         PARTIAL — 5 von 7 Prüfungen bestanden, 0 blockierend;
                              Geheimnisprüfung NICHT GEPRÜFT (keine Bash),
                              Sicherheitsreihen hier nur über npm test
SECRET SCAN:                  CI VERIFICATION REQUIRED
                              (örtliche Emulation derselben Muster über git grep: 0 Funde —
                              kein Ersatz für das massgebende Skript)
CI WORKFLOW READY:            YES (statisch geprüft, nie ausgeführt — kein Push)

REAL MOBILE SCANNER:          EXTERNAL VERIFICATION REQUIRED
CLAMAV:                       EXTERNAL VERIFICATION REQUIRED
EXTERNAL MONITOR:             NOT READY — Vorlagen vollständig und statisch gegen den
                              Vertrag geprüft, aber nie ausgeführt, kein shellcheck
BACKUP PLAN:                  READY (beschrieben, Code vorhanden; nichts abgenommen)
RESTORE PLAN:                 READY (beschrieben, Code vorhanden; nichts abgenommen)
PRODUCTION V2 ARCHITECTURE:   NOT READY — V2-1 (NEXT_PUBLIC_* beim Bau) ist ein
                              interner Blocker des Artefakts

INTERNAL CODE BLOCKERS:       V2-1 — nur für Production V2, nicht für den heutigen Weg
EXTERNAL BLOCKERS:            siehe „Externe Blocker" unten

APPLICATION CODE READY:       YES
PRE-PRODUCTION READY:         NO — externe Nachweise und V2-1 offen
PRODUCTION V2 READY:          NO

PUSH:                         NO
DEPLOYMENT:                   NO
OLD SERVER CONTACTED:         NO
```

Der Block oben ist der Stand der Pre-Production-Prüfung vom 2026-09-26 und
bleibt als solcher stehen. Was danach geschah, steht in den vier Nachträgen
direkt darunter; der jüngste Stand ist **Nachtrag D**.

## Nachtrag A — echter CI-Lauf (2026-09-26)

Zweig `ci/production-v2-github-haertung`, Pull Request #3 nach `main`
(nicht zusammengeführt), **Lauf 36272635541** am Stand `7b8bab9`
(2026-09-26 21:21 UTC):

```
Auftrag „Prüfung":            grün, jede Stufe bestanden
npm test:                     1567 / 1567, 0 übersprungen
E2E:                          42 / 42, retries = 0
SECRET SCAN:                  PASS — scripts/ci-secret-scan.sh mit echter Bash
SECURITY:CHECK:               6 von 6 Prüfungen der Stufe BESTANDEN, 0 blockierend
                              (Geheimnisse, Abhängigkeiten, Muster, Migrationen,
                              öffentliche Endpunkte, Repository). Die siebte,
                              „Sicherheitsreihen der Prüfreihe", meldet die Stufe
                              als NICHT GEPRÜFT — sie läuft dort nur mit
                              --mit-tests; im CI laufen dieselben Reihen in der
                              Stufe „Testreihe" (npm test, oben). Gesamtstatus der
                              Stufe daher NICHT_GEPRUEFT, nicht „bestanden".
HYDRATIONSKORREKTUR:          --pruefen OK
AUFTRAG „Auslieferung":       übersprungen (pull_request; DEPLOY_ENABLED nicht gesetzt)
```

Damit ist **E-1** (unten) erfüllt. Die drei vorangegangenen roten Läufe
desselben Zweigs waren **CI-Fehler, keine Produktfehler**; alle drei sind an
der Ursache behoben:

| Lauf | Ursache | Behebung |
|---|---|---|
| 36270931878 | Bau mit `NODE_ENV=development` aus der Auftragsumgebung („<Html> should not be imported …" beim Vorrendern von `/404`) | `NODE_ENV: production` für die Stufe „Build" (8ab708b), örtlich nachgestellt |
| 36271508638 | `.nvmrc` sagte Node 20; `node --test` mit Muster braucht ≥ 21 („Could not find tests/**/*.test.ts") | Node 22 überall: `.nvmrc`, `engines`, `deploy.sh` (b1a6e55) |
| 36271930469 | nacktes `next start` statt `scripts/test-server.ts` — zwölf Fälle ohne Prüfgeheimnisse (Resend-Webhook, Berichtseingang) | CI startet über `test-server.ts` (7b8bab9) |

Keine Prüfung wurde abgeschwächt, übersprungen oder mit
`continue-on-error` versehen.

## Nachtrag B — V2-1 und GitHub-Härtung (2026-09-26/27)

**V2-1 ist geschlossen.** Umgebungsabhängiges wird zur Laufzeit gelesen
(`APP_URL`, Analyse-Kennungen über `GET /api/public/runtime-config`, Maps- und
Supabase-Werte serverseitig); bewusst beim Bau bleibt nur die kanonische
Domain der statischen Website (`NEXT_PUBLIC_SITE_URL`, eine Produktkonstante
für alle Umgebungen). Bewiesen mit **einem** Bau unter zwei
Laufzeitumgebungen ohne Neubau — Einzelheiten, Bestandsaufnahme und
Begründung in `docs/PRODUCTION_V2.md` §5, Prüfung in
`tests/api/laufzeit-konfiguration.test.ts`.

**CI-Lieferkette:** alle vier fremden Aktionen auf über die API aufgelöste
Commits festgelegt, `persist-credentials: false`, keine `${{ }}`-Ausdrücke
mehr in Skripttext. Rechte, Pull-Request-Grenze, Zwischenspeicher,
Artefakte und die vorgeschlagenen (nicht angewandten) Schutzregeln für
`main`: `docs/GITHUB_GOVERNANCE.md`.

**Beifund:** drei Vertragsfälle scheiterten zwischen 00:00 und 02:00
Zürcher Zeit, weil die Prüfungen „heute" in UTC rechneten, die Dienste in
Zürich (`tests/helpers/datum.ts`). Behoben in den Prüfungen; das Produkt
rechnete richtig.

**CI-Lauf 36277284445** am Stand `7e43ccc` (2026-09-26 22:45 UTC, also
00:45 in Zürich): grün. `npm test` 1582 Fälle, 1581 bestanden,
0 fehlgeschlagen, **1 übersprungen** — `betrieb.test.ts`, „eine verstrichene
Frist ohne Reaktion ist verpasst", überspringt sich absichtlich zwischen 00:00
und 03:00 Zürcher Zeit (der Fall braucht „vor zwei Stunden" am selben Tag wie
die erste Vertragsfassung). Darunter alle Fälle aus
`laufzeit-konfiguration.test.ts`, auch „Dasselbe Artefakt" mit zwei Instanzen.
E2E 42/42, Geheimnisprüfung bestanden, `security:check` wie in Nachtrag A
(6/6, Gesamtstatus NICHT_GEPRUEFT wegen der siebten Prüfung), Auslieferung
übersprungen.

Der Lauf davor (36277056624, Stand `09bdfc4`) hielt richtig an der
Geheimnisprüfung an: Marker in der neuen Prüfung sahen wie Zugangsdaten aus.
Behoben in der Prüfung (7e43ccc), die Geheimnisprüfung blieb unverändert.

Dieser Dokumentstand selbst hat einen eigenen Lauf; die Nummer steht im
Pull Request #3.

## Nachtrag C — Freigabelauf und Härtung (2026-09-27)

```
CODE-STAND:                   5760e88
VERIFY:RELEASE:               PASS — sauberer, losgelöster git worktree des Commits,
                              frische Testdatenbank, alle Schritte grün
npm test:                     1905 / 1905, 0 übersprungen
SICHERHEITSREIHEN, STATISCH:  grün (security:secrets, security:check:static,
                              security:check:tests, npm audit --audit-level=critical)
E2E:                          53 / 53, retries = 0
STRESS:                       STRESS-ERGEBNIS: 5 von 5 grün auf 0023556 — je 57/57 Browserfälle, 0 gescheitert, 0 übersprungen, 0 Hydrationsartefakte, ohne Wiederholungen, jeder Lauf gegen einen frisch gestarteten Testserver (Bericht test-results/stress-2026-09-27T17-10-28-542Z.json)
CI:                           Lauf 36319443611 grün; Auslieferung übersprungen
TESTMATRIX:                   196 abgedeckt / 9 Lücken / 2 nicht zutreffend
SICHERHEITSMATRIX:            15 / 15 Klassen abgedeckt
UMFANG (README, kennzahlen):  166 Seiten · 373 Route-Dateien mit 538 Endpunkten ·
                              151 Datenmodelle · 84 Dienste · 94 Prüfdateien ·
                              49 Migrationen
PUSH / DEPLOYMENT:            keine Auslieferung; kein Zugriff auf die Produktion
```

**Was sich gegenüber dem Block oben geändert hat:**

- **Geheimnisprüfung örtlich:** `npm run security:secrets`
  (`scripts/security/geheimnisse.ts`) ist seit 2026-09-27 die einzige
  Umsetzung und läuft ohne Bash; `scripts/ci-secret-scan.sh` ruft sie nur
  auf. „SECRET SCAN: CI VERIFICATION REQUIRED" und „Geheimnisprüfung NICHT
  GEPRÜFT (keine Bash)" oben sind damit überholt.
- **Freigabeweg:** `npm run verify:release` baut und prüft aus einem
  losgelösten `git worktree` (nicht mehr `git archive` — ohne `.git`
  scheiterten Geheimnisprüfung und Doku-Vergleich).
- **Behobene Befunde dieses Tages**, je mit Regressionsprüfung
  (Belege in `docs/SECURITY_STANDARD.md`, „Abschlussmatrix"):
  - Mandant: Zahlungssuche, öffentliche Tokens an die Organisation der
    Installation gebunden, Einsatzrapport, öffentliche Dateien, Objektfilter
    `?customerId=` der Kundschaft, Entwürfe von Qualitätskontrollen,
    Zeitachse der Ziele.
  - Gleichzeitigkeit: Sperre der Zeiterfassung je Person, Kundenakte je
    E-Mail-Adresse auf fünf Anlagewegen, Anfrageumwandlung, Kontaktformular,
    Bewilligung von Abwesenheiten, Dokumentfassungen.
  - Prüfprotokoll: Mahnlauf, Zeitfreigabe je Eintrag, Eröffnen eines
    Nachrichtenverlaufs, Anfrageverknüpfung, CMS-Veröffentlichung je Baustein.
  - Weiteres: Zahlung von Hand höchstens bis zum offenen Saldo;
    CMS-Freigabeliste mit `Object.hasOwn`; private Dateien nicht als
    Website-Bild; Formelentschärfung in allen Excel-Ausgaben; 409 statt 500
    bei Verklemmung; P2002 ohne Feldnamen; fremder Nachrichtenverlauf 404
    (C19).
- **Übersprungene Fälle:** 0 im Freigabelauf. Der zeitabhängige Fall aus
  Nachtrag B (`betrieb.test.ts`) überspringt sich nur zwischen 00:00 und
  03:00 Zürcher Zeit; ein Lauf in diesem Fenster zeigt wieder einen
  Übersprung, und das ist dann kein Rückschritt.

**Unverändert offen:** die externen Blocker unten (E-2…E-9) und die
PARTIAL-Punkte der UI/UX-Prüfmatrix. `APPLICATION CODE READY: YES`,
`PRE-PRODUCTION READY: NO` (externe Nachweise), `PRODUCTION V2 READY: NO`
(V2-2…V2-6, extern).

## Nachtrag D — dritte Nachprüfung der Nachbesserung (2026-09-27)

Der Block in Nachtrag C ist der Stand an `5760e88` und bleibt als solcher
stehen; seine Zahlen für Testmatrix und Umfang sind durch diesen Nachtrag
überholt. Einzelheiten je Befund: `docs/FINAL_REMEDIATION_MATRIX.md`.

```
CODE-STAND:                   fb0202e
VERIFY:RELEASE 34b3484:       PASS — 1969 / 1969, 0 übersprungen, E2E 57 / 57, retries = 0
npm test (Bau 8bcc88c…fb0202e): 2033 Fälle, alle bestanden, 0 übersprungen
                              (nach Korrektur von 7 Fehlern im Testcode; die
                              betroffenen Dateien erneut: 102 / 102)
VERIFY:RELEASE fb0202e:       RELEASE-ERGEBNIS fb0202e: FAIL (2032/2033 - Standardadresse gleichzeitig, Verklemmung -> 500; behoben in 0023556). verify:release auf 0023556: PASS - saubere Worktree-Kopie, frische Datenbank, 2038/2038 Tests, 0 übersprungen, Browser 57/57 ohne Wiederholungen, 0 übersprungen, 0 wackelig; CI-Lauf 36332513820 grün, Auslieferung übersprungen
STRESS:                       STRESS-ERGEBNIS: 5 von 5 grün auf 0023556 — je 57/57 Browserfälle, 0 gescheitert, 0 übersprungen, 0 Hydrationsartefakte, ohne Wiederholungen, jeder Lauf gegen einen frisch gestarteten Testserver (Bericht test-results/stress-2026-09-27T17-10-28-542Z.json)
TESTMATRIX:                   205 abgedeckt / 0 Lücken / 2 nicht zutreffend
SICHERHEITSMATRIX:            15 / 15 Klassen abgedeckt
UMFANG (README, kennzahlen):  166 Seiten · 375 Route-Dateien mit 540 Endpunkten ·
                              151 Datenmodelle · 85 Dienste · 99 Prüfdateien ·
                              51 Migrationen
NACHBESSERUNG (F/RB):         24 GESCHLOSSEN · 5 EXTERN · 0 OFFEN
OFFEN IM REPOSITORY:          keiner (N-08 nachgezogen: Bilanz der Browserreihe geprüft)
PUSH / DEPLOYMENT:            keine Auslieferung; kein Zugriff auf die Produktion
```

**Was sich gegenüber Nachtrag C geändert hat:**

- **Zwei neue öffentliche Endpunkte:** `POST /api/public/newsletter/bestaetigen`
  und `POST /api/public/newsletter/abmelden` (eingetragen in
  `security/oeffentliche-endpunkte.json` und im OpenAPI-Register). Die Seiten
  `/newsletter/bestaetigen` und `/newsletter/abmelden` schreiben nicht mehr
  beim Aufruf — Mailfilter rufen Links vorab auf und bestätigten so
  Anmeldungen ohne die Person. Erst der Klick wirkt, mit Organisation und
  Protokollzeile (`newsletter-links.test.ts`).
- **Dateien (F-09 c):** ein geprüfter Leseweg für beide Speicher
  (`leseAblageGeprueft`), servererzeugte Uploads auch mit Supabase mit
  Ablagezeile und Prüfsumme, Downloads ohne Umleitung auf befristete
  Adressen. Geprüft gegen einen Nachbau (`ablage-vertrag.test.ts`); der Lauf
  gegen einen echten Bucket ist **EXTERNER NACHWEIS ERFORDERLICH** (E-8,
  `scripts/abnahme/supabase-ablage.ts`).
- **KI (F-15):** Nutzlastbauer für alle Funktionen mit Freitext; der
  Führungsassistent sendet nur aggregierte Bausteine (`ki-nutzlast.test.ts`).
- **Finanzen (F-04, N-05):** gescheiterte Rückerstattungen, Stripe falscher
  Bezug, Storno gegen Zahlung (`zahlungsbuch.test.ts`); Zwei-Faktor-Ersatzcode
  atomar (`two-factor.test.ts`).
- **Prüftor (N-08):** `verify.ts` wertet den JSON-Bericht der Browserreihe
  aus (übersprungen, wackelig, unerwartet, kein Bericht → Fehlschlag); das
  Lohn-Prüfpaket läuft in `verify:static`. Die Bilanz der Browserreihe ist
  die reine Funktion `browserBilanzPruefen`, geprüft in `pruefbilanz.test.ts`;
  `npm run verify:e2e` läuft über dieselbe Regel.

**Unverändert:** `APPLICATION CODE READY: YES`, `PRE-PRODUCTION READY: NO`
(externe Nachweise E-1…E-8; Release-Lauf auf `0023556` und die Stressreihe
5/5 sind grün),
`PRODUCTION V2 READY: NO`.

---

## 1. Reproduzierbarer Release-Bau

**Befund zur Dateisperre.** Die frühere Meldung „`prisma generate` hits a
file lock while the dev server runs" war ungenau. Gemessen am 2026-09-26: Es
lief **kein** Entwicklungsserver; die Sperre hielt der **eigene Testserver**
(`next start -p 3001`), der aus demselben Arbeitsbaum läuft und die Datei
`node_modules/.prisma/client/query_engine-windows.dll.node` geladen hat.
Windows verweigert das Umbenennen einer geladenen DLL; `prisma generate`
schreibt dann `index.js`/`index.d.ts` neu, scheitert aber beim Ersetzen der
Engine (EPERM). Folgen:

- **Nur der Arbeitsbaum des Entwicklers ist betroffen**, und nur unter
  Windows, und nur solange ein Prozess aus diesem Baum den Client geladen hat
  (Testserver, Entwicklungsserver, Prisma Studio). Linux sperrt beim
  Umbenennen nicht.
- Im Arbeitsbaum kann dabei ein neuer JS-Client neben einer alten Engine
  liegen. Bei gleicher Prisma-Fassung (6.19.3) ist das folgenlos; bei einem
  Prisma-Update wäre es ein Fehler. **Regel:** vor `npm run build` im
  Arbeitsbaum jeden Server aus diesem Baum beenden (CLAUDE.md sagt das
  bereits).
- **Überholt seit Prisma 7 (2026-09-29).** Mit dem Treiberadapter erzeugt
  `prisma generate` keine Engine-Bibliothek mehr: Am 2026-09-29 war
  `node_modules/.prisma/client/index.js` frisch erzeugt, die daneben liegende
  `query_engine-windows.dll.node` trug noch den Stand vom 2026-09-03 (Rest aus
  Prisma 6, nicht mehr geladen). Die EPERM-Sperre beim Bau tritt damit nicht
  mehr auf; einen laufenden `next start` aus demselben Bauverzeichnis beendet
  man trotzdem vor dem Bau, weil der Bau `.next` leert.
- **Der Release-Bau hängt davon nicht ab** — bewiesen:

| Schritt (sauberer Baum aus `git archive eba16bd`, eigenes Verzeichnis, ohne `.env`, ohne fremde `node_modules`) | Exit | Dauer |
|---|---|---|
| `npm ci --no-audit --no-fund` | 0 | 68 s |
| `node scripts/react-hydrationskorrektur.mjs --pruefen` | 0 | 1 s |
| `npx prisma generate` | 0 (kein EPERM) | 8 s |
| `npx prisma validate` | 0 | 3 s |
| `npx tsc --noEmit` | 0 | 51 s |
| `npm run lint` | 0 | 74 s |
| `npm run docs` | 0; `docs/API.md`, `DATABASE.md`, `openapi.json`, `openapi.yaml` **bytegleich** mit dem Repository | 3 s |
| `npm run build` | 0, `BUILD_ID` erzeugt | 259 s |

Umgebung: nur `DATABASE_URL`/`DIRECT_URL` (Testdatenbank, der Bau rendert
öffentliche Seiten vor) als Variablen, keine Datei ausserhalb von Git.

**Wiederholt am End-Stand `0298b83`:** alle acht Schritte Exit 0 (`npm ci`
92 s, Typen 110 s, Lint 106 s, Bau 460 s — der Rechner war zugleich mit der
Stressreihe belastet), Doku bytegleich, `BUILD_ID` vorhanden, keine
EPERM-Zeile.

**Ein Zwischenversuch an demselben Stand scheiterte — und das gehört hierher.**
`npm ci` endete mit Exit 1: `postinstall` → `prisma generate` holt die
Prüfsumme der Schema-Engine von `binaries.prisma.sh`, und die Namensauflösung
schlug fehl (`getaddrinfo ENOTFOUND`). Weil `postinstall` abbrach, lief die
Hydrationskorrektur nicht, und `--pruefen` meldete sie **richtig** als
fehlend (Exit 1). Minuten später löste der Name wieder auf; der vollständige
Neuversuch aus einem frischen Archiv bestand. Einordnung: **externe
Abhängigkeit** des Baus (npm-Registry, Prisma-Binärserver), kein Codefehler.
Das Qualitätstor ist dabei fail-closed — `npm ci` und `--pruefen` brechen den
Lauf ab. Für Production V2 empfohlen: Prisma-Engines und npm-Pakete aus
einem Zwischenspeicher der CI (bestehender `cache: npm`; für die Engines
`PRISMA_ENGINES_MIRROR` oder ein vorab befüllter Cache), damit ein
Namensauflösungsfehler bei Prisma nicht den Release blockiert. Auffällig
und festgehalten: `npm run build` wendet die Korrektur selbst erneut an —
ein Bau nach gescheitertem `postinstall` wäre also korrigiert, aber die
Stufe davor hätte den Lauf schon beendet.

## 2. Übersprungene Prüfungen

Die zwei Übersprünge (`sorting.test.ts`, „überlebt das Blättern" für
Rechnungen und Kundschaft) waren **B — nicht deterministische Fixtures**:
Sie hingen davon ab, ob die Testdatenbank zufällig mehr als 25 Zeilen hatte.
Jetzt füllt der Fall selbst auf 26 auf (Kundschaft ohne Umsatz,
Rechnungsentwürfe mit Nummern ausserhalb des Belegschemas, beides danach
entfernt) und verlangt die zweite Seite. Gleichstände bei den Sortierwerten
sind gewollt: Die Listen brechen sie über eine eindeutige Spalte
(`orderByFor`), und genau das muss beim Blättern halten. Ergebnis:
**0 übersprungen**.

## 3. `security:check` — Inventar

| Prüfung | Inhalt | Status |
|---|---|---|
| Geheimnisprüfung | `npm run security:secrets` → `scripts/security/geheimnisse.ts` (Anbietermuster, DB-Verbindungen, `.env`, `NEXT_PUBLIC_`-Geheimnisse); `scripts/ci-secret-scan.sh` ist nur noch die Hülle | ~~CI ONLY (örtlich keine Bash)~~ — seit 2026-09-27 **LOCAL VERIFIED** (eine Umsetzung in TypeScript, Teil von `verify:static`) und im CI bestanden (Nachtrag C) |
| Abhängigkeiten | `npm audit --omit=dev --json` gegen `security/akzeptierte-befunde.json` | **LOCAL VERIFIED** (Stand 2026-09-26: 0 kritisch, 4 hoch, 3 mittel — alle bewertet; die Bewertungsdatei führt am 2026-09-27 sechs Einträge, alle befristet bis 2026-12-31) · Netzabhängig: ein Lauf von vier ohne Antwort → NICHT GEPRÜFT, nie „bestanden" |
| Bewertungsablauf | Vorwarnung 30 Tage, Ablauf, Höchstfrist 183 Tage | **LOCAL VERIFIED** (`sicherheitsbewertung.test.ts`) |
| Quelltext-/Musterprüfung | 16 Regeln inkl. Rate-Limit je Route | **LOCAL VERIFIED** (43 Treffer, alle begründet) |
| Gefährliche Muster (SQL-Unsafe, Prozess, eval, TLS aus, Token im Speicher) | Teil der Musterprüfung | **LOCAL VERIFIED** |
| Migrationen/Schema/Schranken | `prisma validate`, BOM, 12 Teilindizes + 18 Trigger gegen Grundlinie; mit `--datenbank` in der DB | **LOCAL VERIFIED** (auch gegen die frisch aufgebaute Datenbank). *Heute (`security/datenbank-schranken.json`): 13 Teilindizes, 20 Trigger samt Bindung — neu `audit_logs_nur_anfuegen` und `audit_logs_kein_leeren` —, 22 Prüf- und 3 Ausschlussbedingungen, 1 Erweiterung, 19 Funktionsrümpfe; geprüft gegen die Kataloge durch `scripts/datenbank-schranken.ts`* |
| Öffentliche Endpunkte | Registry gegen `security/oeffentliche-endpunkte.json` | **LOCAL VERIFIED** |
| Repository-Integrität | verbotene Dateien, Lockfile, `.gitignore` | **LOCAL VERIFIED** |
| Erzeugte Dokumentation | `npm run docs` + Vergleich | **LOCAL VERIFIED** (bytegleich); im CI als eigene Stufe |
| RBAC-/Sicherheitsreihen | `rbac`, `ownership`, `zugriffsgrenzen`, `sicherheitsluecken`, `nebenlaeufigkeit`, `session-refresh`, … | **LOCAL VERIFIED** über `npm test` und als eigener Schritt `security:check:tests` in `verify:full`/`verify:release` (Nachtrag C) |
| Mandantentrennung | `mandanten`, `suche`, `scan` (fremde Organisation) | **LOCAL VERIFIED** über `npm test` |
| Öffentliche Tokens | `zugriffstokens`, `oeffentlicher-zugang`, `oeffentliche-links`, `signatur`, `offertannahme` | **LOCAL VERIFIED** über `npm test` |
| Dateisicherheit | `dateisicherheit`, `datei-zugriff`, `datei-integritaet`, `clamd-protokoll` (Nachbau) | **LOCAL VERIFIED**; echter `clamd` **EXTERNAL** |
| Finanz-/Fachinvarianten | `finanzbelege`, `buchung-integritaet`, `datenintegritaet`, `vertraege-integritaet` | **LOCAL VERIFIED** über `npm test` |
| Stückliste | `npm run security:sbom` (CycloneDX 1.5) | **LOCAL VERIFIED** |
| SAST mit Datenfluss (Semgrep, CodeQL) | — | **NOT IMPLEMENTED** (beschrieben, bewusst nicht installiert) |

## 4. Geheimnisprüfung im CI — statisch geprüft

`.github/workflows/deploy.yml`, Auftrag `qualitaet`:

- Auslöser `push` auf `main`, `pull_request` auf `main`, `workflow_dispatch` —
  **kein `pull_request_target`**; das Qualitätstor liest kein `secrets.*`.
- Stufe „Keine Geheimnisse im Repository": `bash scripts/ci-secret-scan.sh` —
  Pfad stimmt, Aufruf über `bash` (kein Ausführungsbit nötig),
  **kein `continue-on-error`**, Exitcode 1 bei Fund bricht den Auftrag ab.
- Das Skript gibt bei Anbietermustern und DB-Verbindungen nur **Datei:Zeile**
  aus, nie den Wert; bei `NEXT_PUBLIC_`-Namen die Zeile (nur ein Name).
- `continue-on-error` steht ausschliesslich bei der Merkmalsprüfung
  (bewusst beratend).
- ~~Nicht ausgeführt: kein Push → CI VERIFICATION REQUIRED.~~ Ausgeführt in
  Lauf 36272635541: **PASS** (Nachtrag A).

## 5. CI-Qualitätstor

In Reihenfolge, jede Stufe blockierend (ausser Merkmalsprüfung):
`npm ci` → Hydrationskorrektur `--pruefen` → `npm audit --audit-level=critical`
→ Lint → Typen → **`prisma validate` (neu)** → Geheimnisprüfung →
`security:check` → Stückliste → Doku-Abweichung → `migrate deploy` gegen
**leere** Postgres-16-Datenbank → Demo-Seed → Build → Server → `npm test` →
`npm run e2e`. Der Auftrag `auslieferung` bleibt **fail-closed**
(`github.event_name != 'pull_request' && vars.DEPLOY_ENABLED == 'true'`),
unverändert. Neu: `.github/pull_request_template.md` mit der Durchsichtsliste
aus `docs/SECURITY_STANDARD.md` — sie erinnert, erzwingt aber nichts.

~~Offen für V2: Das CI baut mit `NEXT_PUBLIC_APP_URL=http://localhost:3000`
(V2-1) — ein Artefakt aus diesem Lauf ist nicht auslieferbar.~~ Seit
Nachtrag B baut das CI mit `APP_URL` (Laufzeit) und der kanonischen
Produktdomain; derselbe Bau taugt für jede Umgebung.

## 6. Scanner auf echten Geräten

`docs/SCANNER_DEVICE_ACCEPTANCE.md`: Erwartung je Plattform vorab
festgehalten (iPhone/Safari ohne `BarcodeDetector` → Eingabe/Handscanner),
Testcodes (QR intern/extern/`javascript:`/beschädigt, QR-Rechnung, EAN-13,
EAN-8, UPC-A, Code 128, mehrere Codes, beschädigt), Bedingungen (Licht,
Abstand) und Sicherheitsfälle (keine Mutation durch den Scan, keine
Adresse geöffnet, Rechte, Mandant, unbekannter Code ohne Aktion).
**EXTERNAL VERIFICATION REQUIRED.**

## 7./8. Externe Überwachung

Deckung (Vorlage `ops/security-monitor/security_check.sh`): Erreichbarkeit,
Antwortzeit, TLS-Ablauf, Sicherheitskopfzeilen, offen erreichbare Dateien,
**neu:** geplante Läufe, ClamAV-Erreichbarkeit, Alter der letzten Sicherung
und der letzten bestandenen Wiederherstellungsprobe — über
`/api/cron/status`, das dafür jetzt auch das Überwachungstoken annimmt
(nur lesend; `/api/cron/hourly`/`daily` nicht). Der Überwachungsrechner
braucht damit **kein `CRON_SECRET`**. Entdoppelung und Entwarnung in
`alert.sh`; keine Geheimnisse in Befehlszeilen oder Protokollen.

Örtlich geprüft: `ueberwachung-vorlagen.test.ts` (Vertrag, Kennzahlen,
Tokenwege, nur lesende Anfragen, Takt) und `sicherheitsberichte.test.ts`
(Statusendpunkt). **Nicht** geprüft: Ausführung, `shellcheck` →
**EXTERNAL MONITOR: NOT READY**.

Standort: ein **eigener** Überwachungsrechner ausserhalb des
Anwendungsservers (`INSTALL.md`, „Aufbau"); die Kette
Überwachung → Cloudflare/öffentliche Adresse → Production V2 erkennt auch
einen vollständigen Serverausfall. Nur `deps_check.sh` läuft auf dem Server.

## 9. ClamAV

`docs/MALWARE_PROTECTION.md` §10, Abnahme in zwölf Schritten mit
Ergebnistabelle (neu: Prüferfehler, Wiederholung bis `SCAN_MAX_ATTEMPTS`,
Bytegleichheit Abschluss ↔ Auslieferung, Gegenprobe über alle Fehlerwege,
Überwachung). Nur EICAR, keine Schadsoftware. **EXTERNAL VERIFICATION
REQUIRED.**

## 10. Sicherung und Wiederherstellung

`docs/BACKUP_DR.md` §6: Abnahmeliste BK-1…BK-7, RS-1…RS-3, MO-1…MO-3, DT-1.
Hetzner-Serversicherung allein genügt ausdrücklich nicht. Probe monatlich
(vorher „vierteljährlich", jetzt passend zur Überwachung 35 Tage).

## 11./12. Architektur und echte Client-Adresse

Geprüft gegen `docs/DEPLOYMENT.md` 13.5: Internet → Cloudflare → Hetzner
Cloud Firewall → Nginx → Next.js auf `127.0.0.1` (`ecosystem.config.js`:
`start -H 127.0.0.1`). 80/443 nur Cloudflare-Netze, 22 nur
Verwaltungsadressen, keine Regel für 3000/5432/5433/6379/4444; Datenbank und
Redis nur lokal. Reihenfolge: Firewall → `set_real_ip_from` (frisch von
cloudflare.com) + `real_ip_header CF-Connecting-IP`, `real_ip_recursive off`
→ nachmessen (`curl --resolve` an Cloudflare vorbei läuft ins Leere) → erst
dann `TRUSTED_PROXY_MODE=CLOUDFLARE`. Nginx **setzt** `X-Real-IP` und
`X-Forwarded-For` aus `$remote_addr`, hängt nie an.

**Ergänzung dieser Prüfung:** Im Modus `CLOUDFLARE` liest die Anwendung
`CF-Connecting-IP` direkt (`src/lib/http/client-ip.ts`). Nginx sollte den
Kopf deshalb ebenfalls **überschreiben**
(`proxy_set_header CF-Connecting-IP $remote_addr;` nach `real_ip_header`) —
zweite Linie, falls die Firewall je eine Nicht-Cloudflare-Quelle durchlässt.

## 13. Release-Artefakt

Soll-Ablauf (`docs/PRODUCTION_V2.md` §2): Commit/Tag → CI → Sicherheitstor →
`npm ci` → Korrektur → `prisma generate` → Prüfungen → Bau → Artefakt mit
SHA-256 und Manifest → Aktivierung → Migration → `start:built` → Health mit
Commit. Die Aktivierung (`deploy/v2/release-aktivieren.sh`) führt **kein**
`git pull`, `npm install`, `npm run build`, `prisma generate` aus und
**patcht nichts** (Korrektur nur `--pruefen`); Migrationen nur ausdrücklich
und nach Sicherung. Blocker: ~~V2-1~~ (geschlossen, Nachtrag B), V2-2…V2-5
(extern). Der heutige Weg (`scripts/deploy.sh`) baut auf dem Server — genau
das, was V2 ablöst. *Seit 2026-09-27 abgelöst: `deploy.sh` bricht ab; seit
2026-09-30 prüft die Aktivierung statt „Health mit Commit" die Identität
(Commit, Build-ID, `belegt`) — `docs/PRODUCTION_V2.md` §2 und §7.*

## 14. Migrationssicherheit

Neu in der Aktivierung: **lesende Vorprüfung** (`migration-preflight.ts`)
**vor** der Sicherung — vorher kannte nur `deploy.sh` sie. Reihenfolge jetzt:
Vorprüfung → geprüfte Sicherung → `migrate deploy` → Umschalten → Health
(Rücksprung der Anwendung, nie des Schemas).

## 15. Datenbank aus dem Nichts

Wegwerfdatenbank `clenaris_frisch_test`: `DROP`/`CREATE`, alle **42**
Migrationen mit `prisma migrate deploy` → „All migrations have been
successfully applied", Konfigurations- und Demo-Seed ohne Eingriff.
`prisma migrate diff` Datenbank ↔ Schema: **genau** die zwei bekannten,
dokumentierten Zeilen (`updatedAt DROP DEFAULT` für `payroll_settings`,
`payslips`, Begründung in `20260922080000_vertraege`), sonst nichts.
`security:check --datenbank`: alle 12 Teilindizes und 18 Trigger vorhanden
(Stand 2026-09-27; heute 13 und 20, siehe Sicherheitstabelle oben).
Danach die vollständige Prüfreihe gegen diese Datenbank:
**1567 / 1567, 0 übersprungen**, Browser 42/42, Stressreihe 5/5 — die
Schlussprüfung dieser Mission lief vollständig auf ihr. Die Datenbank bleibt
als Wegwerfdatenbank stehen (Name schützt sie vor jedem Nicht-Test-Zugriff).

## 16. Ablauf der Risikoannahmen

`scripts/security/bewertung.ts`: ab 30 Tagen vor Ablauf Warnung, danach
blockiert `high` wieder, Höchstfrist 183 Tage. Für die heutigen Bewertungen:
Warnung ab 2026-12-01, Blockade ab 2027-01-01.

## 17. Update Center

Zeigt, informiert, gibt frei, terminiert, storniert, stellt zurück. Keine
Shell, kein SSH, kein npm, kein Prisma, kein systemd, kein Zugriff auf die
Produktion — geprüft über die Musterprüfung (`prozess`, `eval`) und die
Suche in `src/**/release*`, `src/app/api/system/**`, `…/updates/**`: nur
Kommentare und Anzeigetext. Ausführen wird später ein getrenntes,
vertrauenswürdiges Werkzeug; es existiert nicht.

## 18. Sicherheitsstandard

`docs/SECURITY_STANDARD.md` deckt alle geforderten Bereiche (C1–C20); die
Zuordnung jedes Bereichs zu Prüfungen und fehlenden externen Belegen steht
dort in der „Abschlussmatrix (2026-09-27)". Neu:
`.github/pull_request_template.md` verweist Punkt für Punkt darauf.
Dokumentation erzwingt nichts; erzwungen wird nur, was CI und
`security:check` prüfen.

## Externe Blocker

| Nr. | Punkt |
|---|---|
| ~~E-1~~ | ~~CI-Lauf (Geheimnisprüfung, `security:check`, gesamtes Tor)~~ — erfüllt, Lauf 36272635541 (Nachtrag A) |
| E-9 | Sichtbarkeit des Repositorys — Entscheid der Inhaberschaft (`GITHUB_GOVERNANCE.md`). Schutz von `main` erledigt: Regelsatz „main schützen" (ID 24071027) aktiv seit 2026-09-27 |
| E-2 | Scanner auf echten Geräten (`SCANNER_DEVICE_ACCEPTANCE.md`) |
| E-3 | ClamAV-Abnahme gegen echten `clamd` (`MALWARE_PROTECTION.md` §10) |
| E-4 | Überwachungsrechner: aufsetzen, `shellcheck`, Probelauf, Alarmwege |
| E-5 | Sicherung/Wiederherstellung: BK-1…BK-7, RS-1…RS-3, MO-1…MO-3 |
| E-6 | V2-Infrastruktur: V2-2…V2-5, Firewall, Nginx, Cloudflare, Nachmessung |
| E-7 | RB-009 Lohnprüfung durch Fachperson (unverändert) |
| E-8 | RPO/RTO-Entscheid der Geschäftsleitung |

## UI/UX-Prüfmatrix (2026-09-27)

Stand: `5760e88`, Browser-Reihe 53/53 ohne Wiederholungen, `npm test`
1905/1905 (Nachtrag C). Jeder Beleg nennt Datei und wörtlichen Testtitel;
beides ist per Suche im Repository bestätigt. **PASS** nur mit einer
automatischen Prüfung. Wo nur das Lesen des Codes eine Aussage trägt, steht
**PARTIAL** mit dem Grund. Eine Konformitätsaussage (WCAG) ist keine dieser
Zeilen — axe misst die maschinell prüfbaren Regeln, Stufe „critical" und
„serious" (`docs/BARRIEREFREIHEIT.md`).

Die Navigationszeilen beziehen sich auf den App-Rahmen
(`src/components/app/app-shell.tsx`): **SideNav** ist die Seitenleiste
`nav[aria-label="Bereichsnavigation"]`, **TopNav** die Kopfzeile (Schubfach
„Navigation öffnen", Brotkrumen, Suche, Scanner, Farbschema,
Benachrichtigungen, Kontomenü), **SubNav** die Reiter unterhalb einer Seite
(`profile-tabs.tsx`, „Kontobereich") und die Brotkrumen.

| Bereich | Status | Beleg (Datei — Testtitel) | Grund für PARTIAL / Grenze |
|---|---|---|---|
| Navigation | **PASS** | `tests/e2e/phase21-oberflaeche.spec.ts` — „Navigation ${bereich.konto}: jeder Eintrag erreichbar, aktiv markiert, axe ohne schwere Befunde" (fünf Rollen: super, admin, manager, employee, customer; jeder Eintrag der Seitenleiste); `tests/api/rbac.test.ts` — Block „Seitenschutz und Navigation"; `tests/pages/public-site.test.ts` — „führt eine überschaubare Hauptnavigation" | — |
| TopNav | **PARTIAL** | `tests/e2e/produktsprint-2026-09-26.spec.ts` — „Live-Treffer ohne Enter, veraltete Anfrage abgebrochen, Treffer öffnet die Akte", „Administration: „Einstellungen" im Kontomenü ist nicht mehr die Firmenkonfiguration"; `phase21-oberflaeche.spec.ts` — „Dialog und Suche: Fokus hinein, Escape hinaus, Fokus zurück; Pfeile bis „Alle Treffer"" (Knopf „Scannen"), „Mobile Navigation: dieselben Einträge wie die Seitenleiste, Escape schliesst, Fokus kehrt zurück" | Suche, Scanner, Kontomenü und Schubfach sind im Browser geprüft. **Nicht** geprüft: Benachrichtigungsknopf (Zähler, Panel), Farbschema-Umschalter und Brotkrumen — deren Verhalten (u. a. der `exact`-Abgleich der Brotkrumen mit der Seitenleiste vom 2026-09-27) ist nur aus dem Code gelesen |
| SideNav | **PASS** | `phase21-oberflaeche.spec.ts` — „Navigation ${bereich.konto}: …" (`aria-current="page"` genau auf dem geöffneten Eintrag), „Mobile Navigation: dieselben Einträge wie die Seitenleiste, …"; `rbac.test.ts` — „verbirgt vor der Betriebsleitung, was sie nicht darf", „zeigt der Administration die Benutzerkonten, aber nicht das Protokoll", „zeigt der Systemverantwortung alles" | — |
| SubNav | **PARTIAL** | `produktsprint-2026-09-26.spec.ts` — „Mitarbeitende: der Reiter führt zu den persönlichen Einstellungen"; `tests/api/settings.test.ts` — „das Profil verweist auf die persönlichen Einstellungen seines eigenen Bereichs" | Nur die Profilreiter sind geprüft. Die Navigationsprüfung liest ausschliesslich die Seitenleiste; Brotkrumen und Reiter anderer Seiten werden von keiner Prüfung auf Ziel und Markierung gelesen |
| Search | **PASS** | `produktsprint-2026-09-26.spec.ts` — „Live-Treffer ohne Enter, veraltete Anfrage abgebrochen, Treffer öffnet die Akte"; `phase21-oberflaeche.spec.ts` — „Dialog und Suche: …" (Strg+K, Pfeiltasten, „Alle Treffer anzeigen"); `tests/api/suche.test.ts` — „eine fremde Organisation bleibt unsichtbar", „Übersicht: zehn und ein Link auf weitere; Bereich Seite für Seite, jede genau einmal", „eine leere Trefferliste ist eine Antwort, kein Fehler" | — |
| Scanner | **PASS** | `tests/e2e/scan.spec.ts` — „Kamera → Treffer → Wareneingang → Bestand und Protokoll", „feindliche Inhalte: nichts wird geöffnet, ausgeführt oder als Markup dargestellt", „unbekannte EAN → „Neuen Artikel erfassen", vorbelegt nur mit dem Strichcode"; `phase21-oberflaeche.spec.ts` — „Dialog und Suche: …" (axe im offenen Scanner-Dialog); `tests/api/scan.test.ts` — „ein Code einer fremden Organisation löst nichts auf" | Kamera nachgebildet; echte Geräte: EXTERNER NACHWEIS (E-2) |
| Profile | **PASS** | `produktsprint-2026-09-26.spec.ts` — Block „B — Profil → Einstellungen" (zwei Fälle); `settings.test.ts` — „${role}: ${BEREICH[role]}/profil/einstellungen zeigt das eigene Konto, nicht die Firma", „über das eigene Profil lässt sich weder Rolle noch Organisation ändern" | — |
| Settings | **PASS** | `settings.test.ts` — „${role}: liest …, schreibt …" (Zugriff je Rolle), „nimmt eine Änderung an und zeigt sie danach an", „zeigt die neuen Zeiten in der Maske", „Mitarbeitende und Kundschaft erreichen die Betriebseinstellungen weder als Seite noch als Endpunkt"; `phase21-oberflaeche.spec.ts` — „Umbruch: …" (enthält `/admin/einstellungen`) | — |
| Dashboard | **PASS** | `phase21-oberflaeche.spec.ts` — „Navigation ${bereich.konto}: …" (die Startseiten `/admin` „Übersicht", `/portal` „Heute", `/konto` „Übersicht" sind Einträge der Seitenleiste); `tests/e2e/wave18-barrierefreiheit.spec.ts` — „Verwaltung", „Portal und Kundenbereich"; `tests/api/bi-fuehrung.test.ts` — „das Cockpit ist für Geschäfts- und Betriebsleitung offen, für Kundschaft nicht", „die Betriebsleitung sieht im Cockpit keine Finanzgruppe"; `tests/api/release-center.test.ts` — „das Dashboard meldet die neue Version der Systemverantwortung, sonst niemandem" | — |
| Forms | **PASS** | `tests/e2e/wave23-masken.spec.ts` — „Lohnvereinbarungen in der Personalakte setzen", „Offene Zeiten auf der Lohnseite freigeben", „Material aus dem Lager für einen Einsatz entnehmen"; `produktsprint-2026-09-26.spec.ts` — „D + F — Büro und Fenster im Fenster 18:00–22:00 buchen; die Administration sieht beide", „E — eine gewählte Uhrzeit wird verworfen, wenn eine Leistung dazukommt"; `settings.test.ts` — „zeigt ihn in der Bearbeitungsmaske", „weist eine unvollständige Adresse ab"; `tests/pages/smoke.test.ts` — „/admin/offerten/:id/bearbeiten", „/admin/leads/:id/bearbeiten" | Die Anzeige einer Serverfehlermeldung **am Feld** siehe Zeile Error |
| Tables | **PASS** | `tests/pages/tables.test.ts` — „${path} (${role})" über jede Seite hinter der Anmeldung, „liefert insgesamt Datentabellen aus (${pages.length} Seiten geprüft)"; `tests/pages/sorting.test.ts` — „setzt aria-sort am aktiven und an den übrigen Köpfen", „macht die Sortierung über echte Links bedienbar", Block „überlebt das Blättern"; `tests/api/grenzen.test.ts` — „Benutzerkonten: seitenweise mit Gesamtzahl, höchstens 100 je Seite" | — |
| Dialogs | **PASS** | `phase21-oberflaeche.spec.ts` — „Dialog und Suche: Fokus hinein, Escape hinaus, Fokus zurück; …", „Mobile Navigation: …" (Schubfach als Dialog); `produktsprint-2026-09-26.spec.ts` — „verfügbare Version → Details → freigeben → terminieren → stornieren"; `tests/e2e/wave10-vertraege.spec.ts` — „A: aus der angenommenen Offerte — Vertrag in der Maske, Plan im Dialog, Einsätze mit ihrer Fassung" | — |
| Mobile | **PASS** | `phase21-oberflaeche.spec.ts` — „Mobile Navigation: …", „öffentliche Seiten auf dem Telefon: axe ohne schwere Befunde", „Umbruch: …" (375×667, 390×844); `tests/e2e/gate4d-abnahme.spec.ts` — „bleibt die Abnahme auf einem Smartphone-Bildschirm vollständig bedienbar" | Emulierte Geräte; echte Telefone nur für den Scanner als EXTERNER NACHWEIS (E-2) gefordert |
| Responsive | **PASS** | `phase21-oberflaeche.spec.ts` — „Umbruch: kein seitliches Scrollen in sieben Fenstergrössen und bei 200 % Zoom" (375 bis 1920 px und 683×450 für 200 % Zoom; 18 Seiten öffentlich, Verwaltung, Portal, Kundenbereich); `tables.test.ts` — „${path} (${role})" (keine starren Breiten über 320 px, Tabellen mit Scrollrahmen) | — |
| Keyboard | **PASS** | `phase21-oberflaeche.spec.ts` — „Sprunglink: erster Tabstopp, springt zum Inhalt — öffentlich, im Konto und beim Unterschreiben", „Dialog und Suche: …"; `tests/e2e/gate3-pdf-viewer.spec.ts` — „lässt sich im Browser bedienen: blättern, Seite eingeben, zoomen, anpassen, herunterladen, Tastatur", „gibt jedem Bedienelement des Viewers einen zugänglichen Namen und einen Tastaturfokus"; `tests/e2e/gate4c-offertannahme.spec.ts` — „gibt der Unterzeichnungsseite Beschriftungen, Tastaturfokus und wahrnehmbare Meldungen" | Geprüft sind die benannten Wege, kein vollständiger Tastaturdurchgang jeder Seite; dieser bleibt eine manuelle Prüfung (`docs/BARRIEREFREIHEIT.md`) |
| Accessibility | **PASS** | `phase21-oberflaeche.spec.ts` — „Navigation ${bereich.konto}: …" (axe auf jedem Eintrag der Seitenleiste, fünf Rollen), „öffentliche Seiten auf dem Telefon: axe ohne schwere Befunde", „Reduzierte Bewegung: keine laufenden Übergänge über 10 ms auf der Startseite"; `wave18-barrierefreiheit.spec.ts` — „öffentliche Seiten", „Verwaltung", „Portal und Kundenbereich"; `tests/api/farbkontrast.test.ts` — „jede alte Statusfarbe ergibt ein Paar über der Schwelle", „jedes Ereignis trägt eine Schriftfarbe, die auf seiner Fläche die Schwelle hält" | Automatisch messbarer Teil; Screenreader und manuelle Prüfung bleiben EXTERNER NACHWEIS (Wave 18) |
| Loading | **PARTIAL** | `tests/e2e/hydration-wiederholung.spec.ts` — „spielt ein angehaltenes <main> während der Hydration wieder ab, ohne Abweichung" | Belegt ist nur, dass angehaltenes Rendern sauber hydriert. Die Ladeanzeige selbst (`NavigationProgress` im App-Rahmen; `loading.tsx` gibt es seit Wave 9.1 nicht mehr, `docs/HYDRATION.md`) prüft kein Test — weder, dass sie erscheint, noch, dass sie verschwindet |
| Empty | **PARTIAL** | `suche.test.ts` — „eine leere Trefferliste ist eine Antwort, kein Fehler"; `scan.spec.ts` — „unbekannte EAN → „Neuen Artikel erfassen", vorbelegt nur mit dem Strichcode" | Leere Antworten sind geprüft, ebenso ein Leerzustand mit Handlungsvorschlag im Scanner. `EmptyState` in den Listen (`page-parts.tsx`) rendert keine Prüfung mit leerer Liste — nur Code gelesen |
| Error | **PARTIAL** | `phase21-oberflaeche.spec.ts` — „Navigation ${bereich.konto}: …" (keine Seite zeigt die Fehlergrenze „Dieser Bereich lässt sich gerade nicht laden"); `gate4d-abnahme.spec.ts` — „führt die Abnahme getippt durch: Übergabe, Sperre, Unterschrift, Rückgabe, Entsperren" (abgelehntes Passwort als `form [role="alert"]`, Ablehnung vom Server); `tests/api/ownership.test.ts` — „${path} zeigt keine Platzhalterwerte" | Belegt ist die **Abwesenheit** von Fehlerzuständen und eine Fehlermeldung in einem Formular. Keine Prüfung löst die Fehlergrenzen (`src/app/error.tsx`, `admin/`, `portal/`, `konto/error.tsx`) oder `not-found.tsx` aus und liest ihren Inhalt; die Zuordnung von 422-Feldfehlern in `ResourceForm` ist nur aus dem Code gelesen |
| Notifications | **PARTIAL** | `smoke.test.ts` — „/api/notifications", „/api/notifications/count" (je Rolle); `tests/api/protokoll-und-schranken.test.ts` — „jede Route unter /api/notifications deklariert ein rateLimit", „schreibende Benachrichtigungsendpunkte nehmen das Schreibkontingent"; `ownership.test.ts` — „lässt die eigene Herkunft und Aufrufe ohne Origin durch" (`read-all` der Kundschaft); `tests/api/kommunikation.test.ts` — „zwei Tagesläufe ergeben genau eine Bitte (vorher griff die Sperre nie)" | Endpunkte, Schranken und eine Erzeugerregel sind geprüft. Das Panel in der Kopfzeile (Zähler, einzeln gelesen, Link zum Ziel) hat keine Browserprüfung, und der Empfängerschnitt steht nicht in der Eigentumsreihe |
| Consistency | **PARTIAL** | `tables.test.ts` — „${path} (${role})" (ein Tabellenmuster auf jeder Seite); `sorting.test.ts` — „setzt aria-sort am aktiven und an den übrigen Köpfen"; `farbkontrast.test.ts` — „jede alte Statusfarbe ergibt ein Paar über der Schwelle" (`STATUS_MAP`); `rbac.test.ts` — Block „Menüpunkte verschwinden, statt auszugrauen"; `phase21-oberflaeche.spec.ts` — „Navigation ${bereich.konto}: …" (genau ein aktiver Eintrag) | Messbare Teile sind belegt. Ob Seiten `PageHeader`, `DetailSection`, `ResourceForm` und `ActionButton` einheitlich verwenden und dieselben Wörter und Abstände haben, prüft keine Maschine — nur Durchsicht |
| Performance | **PARTIAL** | `grenzen.test.ts` — „Kalender: sechs Wochen ja, zehn Jahre nein", „Exporte: ein Jahr ja, mehr nein — auch der Buchhaltungsexport", „Portal: „alle Einsätze" antwortet, auch mit Grenze", „Papierkorb: die Beschriftung kommt aus der Listenabfrage, nicht aus einer Abfrage je Zeile"; Messung `scripts/leistungsmessung.ts` (`docs/LEISTUNG.md`) | Obergrenzen und eine N+1-Regel sind geprüft; kein Test setzt eine Zeitgrenze, keine Browserkennzahlen (LCP, INP), Messung nicht im CI; Last und Produktion: EXTERNER NACHWEIS. Stressreihe: STRESS-ERGEBNIS: 5 von 5 grün auf 0023556 — je 57/57 Browserfälle, 0 gescheitert, 0 übersprungen, 0 Hydrationsartefakte, ohne Wiederholungen, jeder Lauf gegen einen frisch gestarteten Testserver (Bericht test-results/stress-2026-09-27T17-10-28-542Z.json) |
| Role-aware UI | **PASS** | `rbac.test.ts` — „verbirgt vor der Betriebsleitung, was sie nicht darf", „zeigt der Administration die Benutzerkonten, aber nicht das Protokoll"; `settings.test.ts` — „zeigt der Betriebsleitung das Protokoll statt der Felder"; `bi-fuehrung.test.ts` — „die Betriebsleitung sieht im Cockpit keine Finanzgruppe"; `release-center.test.ts` — „das Dashboard meldet die neue Version der Systemverantwortung, sonst niemandem"; `phase21-oberflaeche.spec.ts` — „Navigation ${bereich.konto}: …" (fünf Rollen) | — |

**Zählung:** 15 PASS, 8 PARTIAL, 0 FAIL. Die PARTIAL-Zeilen sind Lücken in
der Prüfung, keine gemessenen Fehler: Für TopNav, SubNav, Loading, Empty,
Error und Notifications fehlt je ein Browserfall, der den Zustand herbeiführt
und liest; Consistency ist nur teilweise maschinell prüfbar; Performance hat
keine Zeitgrenze und wartet auf das Stressergebnis.
