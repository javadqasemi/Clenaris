# Notfall-Wiederherstellung — Production V2 statt Reparatur

> Stand: 27. September 2026. Anlass: Notfallauftrag „Emergency Production
> Security Recovery". Dieses Dokument ist die **Arbeitsanleitung** für den
> Weg vom nicht vertrauenswürdigen alten Server zu einer sauberen Production
> V2. Es steht in einem öffentlichen Repository und enthält deshalb keine
> Geheimnisse, keine Beweisdetails und keine Werte — nur Verfahren.
>
> Grundsatz: **eindämmen → rotieren → sauber neu aufbauen → Daten prüfen →
> V2 ausliefern → umschalten.** Nicht: den alten Server so lange flicken, bis
> er gesund aussieht.

---

## 0. Der alte Server

`2.29.18.45` ist **Beweismaterial eines Vorfalls** und gilt als nicht
vertrauenswürdig. Für ihn gilt ohne Ausnahme:

- kein SSH, kein SCP, kein rsync, kein Befehl, kein Neustart;
- nichts aufräumen, nichts löschen, keine verdächtige Datei öffnen;
- keine Migration, keine Auslieferung, kein Hotfix;
- nichts, was dort gebaut wurde (`node_modules`, `.next`, Binärdateien), ist
  je ein Release-Artefakt;
- Eindämmung seiner Netzexposition **nur** über die Steuerflächen der Anbieter
  (Hetzner Cloud Console/API, Cloudflare) — nie durch Anmelden am Host.

Die Auslieferung auf ihn ist im Code verschlossen: `scripts/deploy.sh`
verweigert den Dienst, der Workflow-Auftrag `auslieferung` läuft nur mit
`DEPLOY_ENABLED=true` und aktiviert ausschliesslich ein in CI gebautes
Artefakt (`deploy/v2/release-aktivieren.sh`). **`DEPLOY_ENABLED` bleibt
ungesetzt, bis die Secrets `SERVER_HOST`, `SERVER_SSH_KEY` und
`SERVER_SSH_KNOWN_HOSTS` auf den V2-Server zeigen** — heute zeigen sie auf den
alten.

---

## 1. Befund P0: Demozugänge in der Produktion — Ursache und Behebung

**Befund.** Mit den Zugangsdaten aus `README.md` war die Verwaltung der
Produktion anmeldbar.

**Ursache — drei Wege, die einander nicht kannten:**

| Weg | Fehler |
|---|---|
| `prisma/seed.ts` (der Seed für ein echtes System) | legte Betriebsleitung und fünf Mitarbeitende mit `Demo#2026Clenaris` an und setzte das Passwort bei **jedem** Lauf zurück; setzte auch das Verwaltungspasswort bei jedem Lauf neu |
| Produktionsschranke des Seeds | prüfte nur die **Länge** von `SEED_ADMIN_PASSWORD` (der Wert aus `.env.example` hat 18 Zeichen) und nur `process.env.NODE_ENV` — auf dem Server stand der Wert in `.env`, nicht im Prozess |
| Anmeldung | kannte die veröffentlichten Passwörter nicht |

Dazu gab der Seed das gesetzte Startpasswort im Klartext ins
Auslieferungsprotokoll aus.

**Behebung (Code, dieser Stand):**

- `src/lib/auth/oeffentliche-zugangsdaten.ts` — die **eine** Liste der
  veröffentlichten Passwörter und die Regel, wo sie gelten dürfen: in der
  Entwicklung, und in einem Produktionsbau **nur** mit
  `CLENARIS_UMGEBUNG=test|preview` **und** einer Wegwerf-Datenbank. Beides
  setzen ausschliesslich `scripts/test-server.ts` und `scripts/preview-server.ts`.
- **Anmeldung** (`auth.service.ts`): richtiges, aber veröffentlichtes Passwort
  → dieselbe Antwort wie „falsch", Ereignis `LOGIN_BLOCKED` im
  Sicherheitszentrum, kein Fehlversuch im Zähler. Wirkt sofort auf jedes
  bestehende Konto, ohne Datenbankänderung.
- **Jedes neue Passwort** (`hashPassword`): Registrierung, Zurücksetzen,
  Wechsel, Einladung weisen die Liste ab (422 am Feld `password`).
- **Seeds**: „produktiv" liest jetzt auch `.env` (`NODE_ENV`,
  `CLENARIS_UMGEBUNG`). Ausserhalb eines Wegwerf-Systems entsteht **kein**
  Demo-Team, bestehende Verwaltungskonten werden nicht mehr zurückgesetzt,
  Startpasswörter müssen gesetzt, ≥ 12 Zeichen und nicht veröffentlicht sein,
  und kein Passwort wird ausgegeben. Der Demo-Seed bricht auf einem
  produktiven System ab — auch mit `ALLOW_DEMO_SEED=ja`.
- `scripts/create-admin.ts` weist veröffentlichte Passwörter ab.
- `README.md`, `.env.example`, `tests/README.md` nennen keine Passwörter mehr.
- `npm run production:preflight` prüft **jedes aktive Konto** mit Argon2 gegen
  die Liste und verlangt eine abgeschlossene Ersteinrichtung (ein Konto der
  Systemverantwortung mit eigenem Passwort).

**Was der Code nicht kann:** Ein Passwort, das bereits bekannt war, bleibt in
der Git-Geschichte und in jeder Kopie des Repositories. Es ist verbrannt —
geschützt wird dadurch, dass es in der Produktion nie mehr ein Konto öffnet,
nicht durch Geheimhaltung. Die committete Fassung von `checklist.txt` enthält
ebenfalls Demozugänge; die Datei gehört der Betreiberin und wird hier nicht
geändert.

Belege: `tests/api/produktions-vorpruefung.test.ts` (u. a. eine eigens
gestartete Produktionsinstanz ohne Prüfkennzeichen: Demopasswort → 401 und
Ereignis; derselbe Versuch am Prüfserver → 200).

---

## 2. Erzwungener Sitzungswiderruf (auf V2, nie auf dem alten Server)

Werkzeug: `scripts/sitzungen-widerrufen.ts`.

```
npx tsx scripts/sitzungen-widerrufen.ts --seit 2026-08-31            # Bestandsaufnahme
npx tsx scripts/sitzungen-widerrufen.ts --ausfuehren --bestaetigen <datenbankname>
```

| Was | Wie | Wirkung |
|---|---|---|
| Zugangstoken (JWT, 15 min) | `User.sessionsRevokedAt = jetzt` für alle | jedes vorher ausgestellte Token wird sofort abgewiesen (`kontoPruefen`) |
| Refresh-Token (bis 30 Tage) | `revokedAt = jetzt` | kein stilles Erneuern |
| Einmal-Links (Passwort, Einladung, Magic Link, E-Mail) | `usedAt = jetzt` | ein selbst geschickter Rücksetzlink verfällt |
| Unterzeichnungscodes | `invalidatedAt = jetzt` | |
| Kundenlinks (`public_access_tokens`) | nur mit `--oeffentliche-links` | Betriebsentscheidung — trifft die Kundschaft |
| Zwischenschein 2FA (`clenaris_mfa`, 5 min) | über den neuen `JWT_SECRET` | kryptografisch entwertet |
| Zweiter Faktor | **Liste** der im Verdachtszeitraum bestätigten Konten; Rücksetzen je Konto im Sicherheitszentrum nach Rücksprache | ein eingeschleustes TOTP-Geheimnis überlebt jeden Sitzungswiderruf |
| Gemerkte Geräte | gibt es nicht (`rememberMe` wird am Server nicht ausgewertet) | — |

Reihenfolge am Umschalttag: neuer `JWT_SECRET` in `shared/.env` → Widerruf
ausführen → Zweitfaktor-Liste klären → Passwörter aller Verwaltungskonten
neu setzen lassen (Link über „Passwort vergessen").

---

## 3. Geheimnisse: Rotationsmatrix

Annahme: **Jeder Wert, der je in der `.env` des alten Servers stand, ist
kompromittiert.** Kein Wert wird auf V2 übernommen, ausser wo die Datenmigration
ihn ausdrücklich braucht (nur `ENCRYPTION_KEY`, übergangsweise, siehe 3.1).

| Variable | Einstufung | Vorgehen |
|---|---|---|
| `JWT_SECRET` | ROTATE | neu (`openssl rand -base64 48`); entwertet alle Token. **Vorher 3.1 prüfen** — lief die Produktion ohne `ENCRYPTION_KEY`, hängen die verschlüsselten Felder daran |
| `CRON_SECRET` | ROTATE | neu; Scheduler auf V2 mit neuem Wert |
| `DATABASE_URL`, `DIRECT_URL` | RECREATE | neue Datenbank, neue Rolle, neues Passwort auf V2; die alte Rolle stirbt mit dem alten Server |
| `REDIS_URL` | RECREATE | neue Instanz, neues Passwort, nur Loopback/privates Netz |
| `SUPABASE_SERVICE_ROLE_KEY` | ROTATE | JWT-Geheimnis des Supabase-Projekts rotieren → neue Schlüssel (rotiert zugleich den Anon-Schlüssel) |
| `STRIPE_SECRET_KEY` | REVOKE + neu | im Dashboard rollen; eingeschränkten Schlüssel erwägen |
| `STRIPE_WEBHOOK_SECRET` | RECREATE | neuer Endpunkt für V2 → neues `whsec_`; alten Endpunkt löschen |
| `ANTHROPIC_API_KEY` | REVOKE + neu | alten Schlüssel in der Konsole widerrufen |
| `RESEND_API_KEY` | REVOKE + neu | |
| `RESEND_WEBHOOK_SECRET` | RECREATE | neuer Webhook für V2 |
| `TWILIO_AUTH_TOKEN` | ROTATE | Sekundärtoken anlegen, befördern, altes löschen |
| `TWILIO_ACCOUNT_SID` | PUBLIC/NON-SECRET | Kennung, kein Geheimnis — nichts zu tun |
| `GOOGLE_MAPS_SERVER_KEY` | ROTATE | neu, auf die IP von V2 beschränken |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | PUBLIC/NON-SECRET | Browserschlüssel, öffentlich by design; Referrer-Beschränkung prüfen, bei Zweifel neu |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | PUBLIC/NON-SECRET | im Code nicht mehr verwendet (V2-1); wird durch die Supabase-Rotation ohnehin ersetzt |
| `SEED_ADMIN_PASSWORD`, `SEED_SUPERADMIN_PASSWORD` | REVOKE | nie auf V2 setzen; erstes Konto über `scripts/create-admin.ts`, danach Konten per Einladung |
| `SECURITY_REPORT_TOKEN` | RECREATE | neu, ≥ 32 Zeichen; bis dahin bleibt der Eingang zu (fail-closed) |
| `RELEASE_EXECUTOR_TOKEN`, `RELEASE_EXECUTOR_SIGNING_KEY` | RECREATE | neu, je ≥ 32 Zeichen, verschieden; bleiben bis zur V2-Abnahme leer |
| `ENCRYPTION_KEY` | SPECIAL MIGRATION REQUIRED | siehe 3.1 |
| `SERVER_SSH_KEY` (GitHub) | REVOKE | Secret löschen; neues Schlüsselpaar nur für V2 |
| `SERVER_SSH_KNOWN_HOSTS`, `SERVER_HOST`, `SERVER_USER`, `APP_DIRECTORY` | RECREATE | Wirtsschlüssel von V2 **über die Hetzner-Konsole** lesen, nie per `ssh-keyscan` |
| Anwendungsgeheimnisse als GitHub-Secrets (`DATABASE_URL`, `JWT_SECRET`, `CRON_SECRET`, `ENCRYPTION_KEY`, `DIRECT_URL`) | REVOKE | löschen — der Workflow liest sie nicht mehr; sie liegen nur in `shared/.env` auf V2 |
| `ALERT_WEBHOOK_URL` | ROTATE | Webhook-Adressen tragen ihr Geheimnis im Pfad |
| Hetzner-/Cloudflare-API-Token, falls je auf dem Host | REVOKE + neu | |

### 3.1 `ENCRYPTION_KEY` — nie blind rotieren

Verschlüsselt: `User.twoFactorSecret`, `Employee.ahvNumber`, `Employee.iban`,
`Property.alarmCode` (AES-256-GCM, `enc:v1` ohne / `enc:v2:<kid>` mit
Schlüsselkennung). Der Schlüsselbund (`ENCRYPTION_KEY` + `ENCRYPTION_KEY_PREVIOUS`)
und `scripts/rotate-encryption-key.ts` bestehen (`docs/KEY_MANAGEMENT.md`).

Auf der **isolierten Prüfkopie**, dann auf V2:

```
1. Welcher Schlüssel schrieb?     npx tsx scripts/rotate-encryption-key.ts --status
   – war ENCRYPTION_KEY gesetzt:  alter Wert → ENCRYPTION_KEY_PREVIOUS
   – war er es nicht:             ALT_JWT_SECRET=<alt> npx tsx scripts/schluessel-aus-jwt-ableiten.ts alt.hex
                                  Inhalt von alt.hex → ENCRYPTION_KEY_PREVIOUS
2. Neuer Schlüssel                openssl rand -hex 32 → ENCRYPTION_KEY
3. Umschlüsseln                   npx tsx scripts/rotate-encryption-key.ts
4. Prüfen                         --status, bis jeder Wert die neue Kennung trägt; Stichprobe
                                  (2FA-Anmeldung, AHV-Anzeige, Alarmcode im Einsatz)
5. Ausmustern                     ENCRYPTION_KEY_PREVIOUS entfernen, alt.hex löschen, Neustart
```

Der alte Schlüssel verlässt die Prüfumgebung nie und wird nach Schritt 5
vernichtet. Erst danach ist `JWT_SECRET` frei zu rotieren.

---

## 4. Ursprung eindämmen (Steuerfläche, nicht Host)

Ziel: Internet → Cloudflare → Hetzner Cloud Firewall → Nginx →
Clenaris auf `127.0.0.1:3000`.

| Port | Quelle | Bemerkung |
|---|---|---|
| 80, 443 | **nur** Cloudflare-Bereiche (IPv4 und IPv6) | Liste zur Zeit der Einrichtung von `https://www.cloudflare.com/ips-v4` und `/ips-v6` holen, nicht aus einem Dokument abschreiben |
| 22 | nur der kontrollierte Verwaltungsweg (feste Adresse oder Hetzner-Konsole) | nie `0.0.0.0/0` |
| 3000, 5432, 5433, 6379, 4444 | **nie** öffentlich | — |

Die vorhandene `Zentra-Firewall` öffnet gefährliche Ports gegen
`0.0.0.0/0` und wird **nicht** angehängt.

Für den **alten** Server (nur Eindämmung, vom Arbeitsplatz aus über die
Hetzner-API): eine eigene Firewall ohne eingehende Regeln bzw. nur
Cloudflare → 80/443, angehängt über `hcloud firewall apply-to-resource`. Das
schliesst den Umweg an Cloudflare vorbei, ohne den Host zu berühren. Ob der
alte Server bis zur Umschaltung weiter ausliefern soll (dann Cloudflare-only)
oder sofort vom Netz geht (dann keine eingehenden Regeln, Snapshot vorher),
entscheidet die Betreiberin.

### 4.1 Reihenfolge für `TRUSTED_PROXY_MODE=CLOUDFLARE`

1. Cloudflare-Bereiche geholt und geprüft
2. Hetzner-Firewall beschränkt 80/443 auf diese Bereiche
3. **von aussen** geprüft: `curl -k https://<ursprungs-ip>` läuft ins Leere
4. Nginx: `set_real_ip_from` für dieselben Bereiche, `real_ip_header CF-Connecting-IP`,
   eingehende `X-Forwarded-*`/`CF-Connecting-IP` von Nicht-Cloudflare verworfen
5. erst dann `TRUSTED_PROXY_MODE=CLOUDFLARE` **und**
   `CLENARIS_URSPRUNG_NUR_CLOUDFLARE=bestaetigt`

Die Produktionsvorprüfung weist `CLOUDFLARE` ohne Schritt 5 ab. Vorher gilt
`SINGLE_REVERSE_PROXY` (Nginx setzt `X-Real-IP`).

---

## 5. Kein Wiederaufbau am Ort

Der alte Server wird nicht gereinigt und nicht weiterbetrieben. Ziel ist ein
**neuer** Server. Der alte bleibt Beweismaterial bis zur geordneten
Stilllegung (nach Sicherung des Beweises, siehe 6).

## 6. Forensischer Beweis

Aus den vertrauenswürdigen örtlichen Aufzeichnungen (Repository,
Arbeitsnotizen, Arbeitsplatz) ist **nicht** belegt, dass das Beweisarchiv
vom Host kopiert und seine Prüfsumme unabhängig bestätigt wurde, noch dass ein
Hetzner-Snapshot existiert (`backup_window` war nicht gesetzt).

**Stand: OFF-HOST FORENSIC EVIDENCE NOT VERIFIED.**

Vorschlag (Betreiberin, über die Steuerfläche): vor jeder Stilllegung einen
Hetzner-**Snapshot** des alten Servers anlegen (Konsole/API, ohne Anmeldung am
Host), Lösch- und Neuaufbauschutz einschalten, und das Archiv über die
Rettungskonsole bzw. einen eingehängten Snapshot auf ein getrenntes Medium
sichern — mit Prüfsumme, Zeitpunkt und Person protokolliert.

## 7. Datenbank: Sicherung gültig ≠ Daten vertrauenswürdig

- **Strukturelle Gültigkeit**: `scripts/db-restore-verify.ts` (Wiederherstellung,
  Zeilenzahlen, `pg_restore` fehlerfrei).
- **Datenvertrauen**: `scripts/datenbank-vertrauenspruefung.ts` — nur lesend
  (Verbindung mit `default_transaction_read_only`), nur auf einer Kopie
  (Name mit `restore`/`wiederherstellung`/`pruef`/`validierung`/`forensik`).

```
npx tsx scripts/datenbank-vertrauenspruefung.ts --seit 2026-08-31 --bericht vertrauen.json
```

Geprüft wird: Organisationen, jedes Konto mit Verwaltungsrolle (angelegt im
Verdachtszeitraum, 2FA dort eingerichtet, Demoadresse, veröffentlichtes
Passwort), Rechte- und Rollenwechsel, Anmeldungen der Verwaltung nach
Adresse, ausgestellte Kunden- und Einmal-Links, Erstattungen/manuelle/
rechnungslose Zahlungen, ungewöhnliche Dateien und ungeprüfte Bestände,
Automationen mit Webhook-Zielen ausserhalb `AUTOMATION_WEBHOOK_HOSTS`,
Aktualisierungsaufträge, Löschungen und Lücken im Prüfprotokoll,
Datenbankrollen, Erweiterungen, fremde Trigger und Ereignistrigger. Jeder
Abschnitt AUFFÄLLIG ist vor der Übernahme zu klären; PRÜFEN verlangt eine
Durchsicht durch eine Person. Das Skript entscheidet nichts.

## 8. Auslieferung: Artefakt statt Bau am Server

```
CI (vertrauenswürdig)                                   V2-Server
npm ci → Hydrationskorrektur → prisma generate →
Prüfungen, Sicherheit, Geheimnisse → Build →
Testreihe + Browser gegen genau diesen Bau →
release-artefakt.ts (Archiv + Manifest + SHA-256) ──►  Summe prüfen → entpacken
                                                        production:preflight --phase vor-migration
                                                        migration-preflight → geprüfte Sicherung
                                                        prisma migrate deploy
                                                        production:preflight (keine offene Migration)
                                                        Verweis umschalten → start:built → Health
                                                        (sonst Rücksprung)
```

Der Server führt **nie** `git pull`, `npm install`/`npm ci`, `npm run build`
oder Entwicklungswerkzeuge aus. `NODE_OPTIONS=--max-old-space-size=…` ist
keine Anforderung an den Produktionsserver mehr: Gebaut wird im CI-Läufer
(`ubuntu-latest`, 16 GB). Die Anwendungsgeheimnisse reisen nicht durch die
Pipeline; der Auftrag kennt nur, was er zum Verbinden braucht.

Offen (V2-3): `release-aktivieren.sh` ist auf keinem Server gelaufen — auf dem
V2-Probeserver durchspielen (Erstinstallation, zweites Release, kaputtes
Release, falsche Summe, fehlendes `APP_URL`, `auslieferbar=false`).

## 9. Reihenfolge von Schema und Programm

**Invariante:** Nie migrieren, bevor das Artefakt, das zu diesem Schema passt,
geprüft und startbereit auf dem Server liegt. Die letzte Auslieferung auf den
alten Server migrierte zuerst und baute danach rund zehn Minuten — so lange lief
die alte Fassung gegen das neue Schema.

Für nicht rückwärtsverträgliche Änderungen: **Erweitern → Rückfüllen →
Umschalten → Rückbau** in getrennten Releases, oder ein angekündigtes
Wartungsfenster (`CLENARIS_WARTUNGSFENSTER=ja` bei der Aktivierung).

## 10. Verträglichkeit der Migrationen

`npm run migration:vertraeglichkeit` (auch Teil von `security:check`,
blockierend) stuft jede Migration heuristisch ein und hält sie gegen die
durchgesehene Einstufung in `security/migrations-vertraeglichkeit.json`.
Stand der 51 Migrationen: 27 rückwärtsverträglich, 6 Rückfüllung,
17 Programmwechsel, 1 brechend (`20260927170000_buchungslink_hash` entfernt
`bookings.confirmationToken`, das die alte Fassung bei jeder Buchungsabfrage
liest). Eine neue Migration ohne Eintrag hält das Tor an.

## 11. Schadsoftwareprüfung

Altbestände ohne Prüfung (`LEGACY_UNSCANNED`) bleiben gesperrt — ohne echten
Scanner wird nichts als sauber markiert und `scripts/scan-backfill.ts` nicht
ausgeführt. Die Produktionsvorprüfung verlangt `CLAMAV_HOST` und ein `PONG`.

Abnahme auf V2 (`scripts/abnahme/clamd.ts`, `docs/MALWARE_PROTECTION.md` §10):
saubere Probe → CLEAN; EICAR → INFECTED; Scanner nicht erreichbar → ERROR;
Zeitüberschreitung → ERROR; Scannerfehler → ERROR; Wiederholung; Quarantäne
nicht auslieferbar; ERROR ≠ CLEAN; Prüfsumme stimmt. **Erst danach**
`scan-backfill` für die Altbestände.

## 12. Sicherheitsmeldungen

`SECURITY_REPORT_TOKEN` fehlt → Eingang geschlossen. Das ist richtig und
bleibt so, bis V2 einen **neuen** Wert (≥ 32 Zeichen) und eine externe
Überwachung hat (`ops/security-monitor/`, nicht auf dem alten Server). Nie
einen Wert vom alten Host übernehmen.

## 13. Release-Ausführer

Bleibt abgeschaltet (keine Zugangsdaten → 401/503). Für V2 neue
`RELEASE_EXECUTOR_*` und ausschliesslich der Artefaktweg; nie Zugangsdaten
wiederverwenden, die auf dem alten Server lagen.

## 14. Öffentliches Repository

Durchgesehen (Stand dieses Commits):

| Klasse | Befund | Stand |
|---|---|---|
| Echte Geheimnisse (Schlüssel, Token, Verbindungen mit Passwort) | keine gefunden | Geheimnisprüfung bleibt massgeblich (`npm run security:secrets`, CI) |
| Demopasswörter | `README.md`, `.env.example`, `tests/README.md` bereinigt; bleiben in Seeds/Prüfhilfen für Wegwerf-Systeme und in der Git-Geschichte; `checklist.txt` (committete Fassung, Datei der Betreiberin) | verbrannt, in der Produktion wirkungslos (Abschnitt 1) |
| Betriebsdetails (IP des alten Servers, Server-ID, Wirtsschlüssel-Fingerabdrücke, Pfade) | in `docs/NEXT_DEVELOPMENT_AUDIT.md`, `ops/security-monitor/*`, weiteren Berichten | geringe Sensibilität; der alte Server wird stillgelegt. Ein bereinigter Stand löscht die Geschichte nicht |
| Vorfallsdetails | nur allgemein („Beweismaterial"); keine Beweisdetails im Repository | so belassen |

Empfehlung an die Betreiberin: das Repository bis zur V2-Umschaltung **privat**
schalten (Eigentümerentscheid, `docs/GITHUB_GOVERNANCE.md`).

## 15. Produktionsvorprüfung

`npm run production:preflight` (Ausgang 0 nur, wenn **jede** Prüfung lief und
bestand; `--nur-umgebung` endet mit 3). Prüft ohne Werte auszugeben:
`NODE_ENV`, `CLENARIS_UMGEBUNG=production`, `APP_URL` und kanonische Adresse
(https, keine Loopback-/Test-/Beispieldomain, keine nackte IP), Pflichtgeheimnisse
(Länge, Format, kein Beispiel-/CI-/Prüfwert, `ENCRYPTION_KEY` ≠ `JWT_SECRET`),
keine Test-/Vorschaudatenbank, keine Demo- oder Übergangsschalter,
Startpasswörter, Proxy-Konsistenz (4.1), Scanner, Sicherheitsmeldung,
Release-Ausführer, Redis, Release-Manifest; mit Verbindung: Datenbank,
Migrationsstand und -einstufung, Konten gegen veröffentlichte Passwörter,
Ersteinrichtung, Redis-`PING`, clamd-`PONG`.

---

## 16. Aufbau Production V2 (Plan)

1. **Neuer Hetzner-Server** (eigenes Projekt oder zumindest neue Ressource),
   Ubuntu LTS, Lösch- und Neuaufbauschutz, Hetzner-Backups an.
2. **Neue Firewall** nach Abschnitt 4, vor dem ersten Start angehängt.
3. **Wirtsschlüssel** über die Hetzner-Konsole lesen → `SERVER_SSH_KNOWN_HOSTS`.
4. **Dienstbenutzer** `clenaris` ohne sudo für die Anwendung; SSH nur mit
   neuem Schlüssel, Passwortanmeldung aus, root-Anmeldung aus.
5. Node 22 (gleiche Hauptversion wie CI), PostgreSQL 16 nur auf Loopback,
   Redis nur auf Loopback mit Passwort, **clamd** nur auf Loopback, Nginx.
6. `shared/.env` mit **neuen** Werten nach Abschnitt 3 (Modus 600).
7. Überwachung (`ops/security-monitor/`) auf einem getrennten Rechner, neue
   `SECURITY_REPORT_TOKEN`.
8. Sicherungsziel ausserhalb des Servers (verschlüsselt, Aufbewahrung
   festgelegt), `scripts/db-backup.ts` + Wiederherstellungsprobe
   (`docs/BACKUP_DR.md`).
9. Erstes Artefakt über den Workflow (`DEPLOY_ENABLED=true` **erst jetzt**),
   Abnahme V2-3.
10. Erstes Konto der Systemverantwortung über `scripts/create-admin.ts`.

## 17. Datenübernahme (Plan)

```
alte Datenbank (nicht vertrauenswürdig)
  → logischer Export (pg_dump -Fc), Prüfsumme protokolliert
    — erzeugt über die Steuerfläche/Rettungssystem, nicht per Anmeldung am laufenden Host
  → isolierte Prüfumgebung: db-restore-verify.ts (Struktur)
  → datenbank-vertrauenspruefung.ts (Daten), Befunde klären
  → ENCRYPTION_KEY-Migration (3.1)
  → sitzungen-widerrufen.ts --ausfuehren
  → Import in die V2-Datenbank, production:preflight
```

**Nicht** übernommen: Programme, `node_modules`, Betriebssystemdateien,
Cron-/systemd-Dateien, unbekannte Uploads. Dateien nur nach Prüfung mit dem
echten Scanner und nur, soweit sie in `file_assets` verzeichnet sind.

## 18. Umschaltung (Plan)

Erst wenn alles belegt ist: V2-Sicherheitsabnahme · Cloudflare-Ursprungssperre
von aussen geprüft · ClamAV-Abnahme · Sicherung und Wiederherstellungsprobe ·
Überwachung · rotierte Geheimnisse · widerrufene Sitzungen · neues
Verwaltungskonto · `production:preflight` bestanden · Rauchtest. Dann DNS bzw.
Cloudflare-Ursprung auf V2, alten Server vom Netz (Firewall ohne eingehende
Regeln), später geordnet stilllegen.

## 19. Eigentümerentscheide

| Jetzt ohne Eigentümer möglich (erledigt im Code) | Eigentümerfreigabe nötig |
|---|---|
| Demozugänge in der Produktion wirkungslos, Seeds sicher | Hetzner-Firewall für den alten Server (Eindämmung) und für V2 |
| Produktionsvorprüfung, Verträglichkeitstor, Artefaktweg | Snapshot/Beweissicherung des alten Servers |
| Sitzungswiderruf, Schlüsselmigration, Vertrauensprüfung als Werkzeuge | neuer Server, Kosten |
| Dokumentation, Prüfungen | Rotation bei Stripe, Supabase, Resend, Twilio, Google, Anthropic |
| | GitHub: alte Secrets löschen, neue anlegen, `DEPLOY_ENABLED` erst für V2 |
| | Sichtbarkeit des Repositories |
| | Cloudflare/DNS-Umschaltung |
