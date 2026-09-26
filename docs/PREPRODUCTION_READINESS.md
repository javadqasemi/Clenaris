# Pre-Production-Bereitschaft

Stand 2026-09-26. Diese Mission hat **keine** Produktfunktion hinzugefügt,
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
bleibt als solcher stehen. Was danach geschah, steht in den zwei Nachträgen
direkt darunter.

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
| Geheimnisprüfung | `scripts/ci-secret-scan.sh` (Anbietermuster, DB-Verbindungen, `.env`, `NEXT_PUBLIC_`-Geheimnisse) | **CI ONLY** (örtlich keine Bash). Emulation derselben Ausdrücke über `git grep`: 0 Funde, Positivkontrolle trifft |
| Abhängigkeiten | `npm audit --omit=dev --json` gegen `security/akzeptierte-befunde.json` | **LOCAL VERIFIED** (0 kritisch, 4 hoch, 3 mittel — alle bewertet) · Netzabhängig: ein Lauf von vier ohne Antwort → NICHT GEPRÜFT, nie „bestanden" |
| Bewertungsablauf | Vorwarnung 30 Tage, Ablauf, Höchstfrist 183 Tage | **LOCAL VERIFIED** (`sicherheitsbewertung.test.ts`) |
| Quelltext-/Musterprüfung | 16 Regeln inkl. Rate-Limit je Route | **LOCAL VERIFIED** (43 Treffer, alle begründet) |
| Gefährliche Muster (SQL-Unsafe, Prozess, eval, TLS aus, Token im Speicher) | Teil der Musterprüfung | **LOCAL VERIFIED** |
| Migrationen/Schema/Schranken | `prisma validate`, BOM, 12 Teilindizes + 18 Trigger gegen Grundlinie; mit `--datenbank` in der DB | **LOCAL VERIFIED** (auch gegen die frisch aufgebaute Datenbank) |
| Öffentliche Endpunkte | Registry gegen `security/oeffentliche-endpunkte.json` | **LOCAL VERIFIED** |
| Repository-Integrität | verbotene Dateien, Lockfile, `.gitignore` | **LOCAL VERIFIED** |
| Erzeugte Dokumentation | `npm run docs` + Vergleich | **LOCAL VERIFIED** (bytegleich); im CI als eigene Stufe |
| RBAC-/Sicherheitsreihen | `rbac`, `ownership`, `session-refresh`, … | **LOCAL VERIFIED** über `npm test`; im Dirigenten nur mit `--mit-tests` |
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
das, was V2 ablöst.

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
`security:check --datenbank`: alle 12 Teilindizes und 18 Trigger vorhanden.
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

`docs/SECURITY_STANDARD.md` deckt alle geforderten Bereiche (C1–C20). Neu:
`.github/pull_request_template.md` verweist Punkt für Punkt darauf.
Dokumentation erzwingt nichts; erzwungen wird nur, was CI und
`security:check` prüfen.

## Externe Blocker

| Nr. | Punkt |
|---|---|
| ~~E-1~~ | ~~CI-Lauf (Geheimnisprüfung, `security:check`, gesamtes Tor)~~ — erfüllt, Lauf 36272635541 (Nachtrag A) |
| E-9 | Schutzregeln für `main` und Sichtbarkeit des Repositorys — Entscheid der Inhaberschaft (`GITHUB_GOVERNANCE.md`) |
| E-2 | Scanner auf echten Geräten (`SCANNER_DEVICE_ACCEPTANCE.md`) |
| E-3 | ClamAV-Abnahme gegen echten `clamd` (`MALWARE_PROTECTION.md` §10) |
| E-4 | Überwachungsrechner: aufsetzen, `shellcheck`, Probelauf, Alarmwege |
| E-5 | Sicherung/Wiederherstellung: BK-1…BK-7, RS-1…RS-3, MO-1…MO-3 |
| E-6 | V2-Infrastruktur: V2-2…V2-5, Firewall, Nginx, Cloudflare, Nachmessung |
| E-7 | RB-009 Lohnprüfung durch Fachperson (unverändert) |
| E-8 | RPO/RTO-Entscheid der Geschäftsleitung |
