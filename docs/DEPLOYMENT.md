# Inbetriebnahme und Betrieb

**Zielumgebung ist Production V2: ein eigener Hetzner-Server.** Die Kette
lautet

```
Internet → Cloudflare → Hetzner Cloud Firewall → Nginx → Next.js auf 127.0.0.1:3000
```

und darin sind alle Glieder verbindlich, nicht nur das letzte. Datenbank und
Redis sind aus dem Internet nicht erreichbar.

Die verbindlichen Festlegungen für V2, jede davon andernorts in diesem
Dokument ausgeführt:

| | |
|---|---|
| Quelle der Wahrheit | **GitHub `main`** im Repository `javadqasemi/Clenaris`. Der Server zieht **nichts** aus Git — er bekommt das in der CI aus `main` gebaute und geprüfte Artefakt (Teil II) |
| Repository | Sichtbarkeit ist ein Entscheid der Inhaberschaft (`docs/GITHUB_GOVERNANCE.md` §3). Bis 2026-09-27 stand hier „privat, mit Deploy-Key für den Server"; seit dem Artefaktweg braucht der Server keinen Zugang zum Repository |
| Auslieferung | **GitHub Actions**, Qualitätstor und Auslieferung getrennt; zwei Wege (direkter Auftrag `auslieferung` und Release-Ausführer) nach **einem** Aktivierungsvertrag (C3) — Teil II, Abschnitte 12, 15, 16 |
| Wirtsschlüssel | **gepinnt, Pflicht.** Kein `ssh-keyscan`-Rückfall, kein Vertrauen beim ersten Kontakt (13.4) |
| `SERVER_USER` | **Pflicht.** Kein Rückfall auf `root` (14) |
| `DIRECT_URL` | **Pflicht in der Produktion** — die Produktionsvorprüfung jeder Aktivierung bricht ohne sie ab. Seit Prisma 7 steht die Adresse nicht mehr in `schema.prisma`, sondern in `prisma.config.ts`: Die Kommandozeile (`migrate deploy`) nimmt `DIRECT_URL`, sonst `DATABASE_URL`. Hinter einem Pooler im Transaktionsmodus (PgBouncer, Supabase :6543) muss sie am Pooler vorbeiführen — `migrate` verträgt dessen Sperrverhalten nicht. Die Laufzeit liest nur `DATABASE_URL` (3) |
| HTTP-Eingang | **nur über Cloudflare.** Der Ursprung nimmt auf 80/443 nur Cloudflare-Netze an (13.5.2) |
| Secrets | **keine Übernahme aus dem Altbestand.** Neu erzeugen oder beim Anbieter rotieren (14) |

Die Anwendung selbst ist an keinen Anbieter gebunden: sie braucht Node 22
(`.nvmrc`, `engines` ≥ 22 — dieselbe Hauptversion wie die CI, weil
`node_modules` im Artefakt mitreist), ein PostgreSQL ≥ 16 und einen
S3-kompatiblen Speicher — ohne den fällt sie auf einen lokalen
Postgres-Blob-Treiber zurück.

> **HISTORICAL — Vercel.**
> Die Abschnitte 4 (`vercel --prod`), 7 (Vercel Cron) und 8 (DNS auf Vercel)
> beschreiben einen **früheren** Betriebsweg und gelten für V2 **nicht**. Sie
> bleiben stehen, weil `vercel.json` noch im Repository liegt und die
> Abschnitte erklären, was diese Datei tut; ersetzt werden sie durch
> Abschnitt 13 (eigener Server), 13.6 (Crontab) und die Cloudflare-Kette
> oben. Die Abschnitte 2, 3, 5, 6 und 11 gelten für beide Wege — sie handeln
> von Speicher, Konfiguration, Stripe, E-Mail und der Abnahme, nicht vom
> Anbieter. **Nicht unverändert** gelten der Kopf von Abschnitt 1 (Supabase-
> Pooler mit `connection_limit`, `npm run db:deploy` und `npm run db:seed` von
> Hand), Abschnitt 9 (die tägliche Supabase-Sicherung; für V2 gilt
> `docs/BACKUP_DR.md`) und die Pool-Hinweise in Abschnitt 10 („Functions") —
> sie stammen aus der Vercel-Zeit und tragen dort je einen Hinweis. Die
> Unterabschnitte von Abschnitt 1 ab „Vor der Inbetriebnahme von Production
> V2" sind für V2 geschrieben.

> **Wo die Angaben zum alten Server geblieben sind.**
> Bis 2026-09-21 stand hier die Infrastruktur des bisherigen
> Produktionsservers: Adresse, Anbieterkennung, Wirtsschlüssel-Fingerabdruck,
> Firewall-Messungen. Dieser Server ist **Beweismaterial eines Vorfalls** und
> wird für V2 nicht wiederverwendet, nicht beliefert und nicht als Vorlage
> genommen. Die Angaben sind deshalb aus dieser Betriebsanleitung entfernt
> und stehen dort, wo sie hingehören: im Untersuchungsteil S-09 von
> [`NEXT_DEVELOPMENT_AUDIT.md`](NEXT_DEVELOPMENT_AUDIT.md).
>
> Sie sind **keine Geheimnisse** — eine IP-Adresse und ein öffentlicher
> Wirtsschlüssel sind öffentliche Angaben, und sie werden hier auch nicht wie
> kompromittierte Zugangsdaten behandelt. Sie sind schlicht **veraltet**, und
> eine Betriebsanleitung, die ein totes Ziel nennt, ist gefährlicher als eine,
> die schweigt: Jemand liefert danach dorthin aus.

---

## 1. Datenbank

Supabase-Projekt in `eu-central-1` anlegen und beide Verbindungszeichenfolgen
notieren:

```bash
# Pooler (Port 6543) — für die Applikation
DATABASE_URL="postgresql://postgres.<ref>:<pw>@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1"

# Direktverbindung (Port 5432) — für Migrationen
DIRECT_URL="postgresql://postgres.<ref>:<pw>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"
```

Die Trennung ist notwendig: Prisma Migrate braucht Advisory Locks, die ein
Transaction-Pooler nicht durchreicht.

```bash
npm run db:deploy     # Migrationen anwenden
npm run db:seed       # nur bei einer Neuinstallation
```

Der Seed legt neben Organisation, Leistungen und Preisen zwei
Verwaltungskonten an. Auf einem produktiven System — und überall, wo
`prisma/seed-guard.ts` keine Test- oder Vorschaudatenbank erkennt und
`ALLOW_DEMO_SEED=ja` fehlt — verlangt er dafür
`SEED_ADMIN_PASSWORD` und `SEED_SUPERADMIN_PASSWORD` — mindestens 12 Zeichen
und kein im Repository veröffentlichtes Passwort — und bricht ohne sie ab
(`prisma/seed.ts`, `pruefeStartpasswoerter`); ein Konto mit den
Demo-Zugangsdaten entsteht dort nicht mehr.

> **Für Production V2 gilt dieser Kopf nicht.** Auf V2 migriert nur die
> Aktivierung (Abschnitt 15: `migrate deploy` aus dem entpackten Release,
> davor die Sicherung); auf dem Server läuft kein `npm`. Der Seed setzt die
> beiden Startpasswörter voraus, die nach `docs/NOTFALL_WIEDERHERSTELLUNG.md`
> §3 auf V2 nie gesetzt werden — wie eine Erstinstallation auf einer leeren
> Datenbank abläuft, ist ungeklärt (`docs/PENDENZEN.md` P2H-76); geplant ist
> die Übernahme der geprüften Datenbank (`NOTFALL_WIEDERHERSTELLUNG.md` §17).
> Und unter Prisma 7 (`adapter-pg`, `src/lib/prisma-client.ts`) liest niemand
> mehr `pgbouncer=true` oder `connection_limit` aus der `DATABASE_URL`: Die
> Poolgrösse ist die von `pg` — höchstens 10 Verbindungen je Prozess
> (P2H-57). Die Trennung `DATABASE_URL`/`DIRECT_URL` gilt weiter (Abschnitt 3).

### Vor der Inbetriebnahme von Production V2: offene Punkte

Stand 2026-09-21.

**Die Spalte „Beleg" ist der eigentliche Inhalt dieser Tabelle.** Ein Häkchen
ohne Beleg ist in einer Sicherheitsliste schlimmer als ein offener Punkt: Der
offene Punkt wird bearbeitet, das unbelegte Häkchen nicht mehr. Deshalb drei
Stufen, und sie werden nicht vermischt:

- **belegt** — von diesem Arbeitsplatz aus nachgemessen (Anbieter-API,
  TLS-Handshake, Portversuch, Prisma-Versuch, GitHub-API).
- **bestätigt** — der Betreiber hat es gesehen, hier grundsätzlich nicht
  nachprüfbar. Trifft auf GitHub-Secrets zu (GitHub gibt Werte technisch nicht
  heraus) und auf die Anbieterkonsole.
- **unbelegt** — es liegt *kein* aktueller Beleg vor. Auch dann, wenn die
  Arbeit vielleicht getan ist.

Der Unterschied zwischen *bestätigt* und *unbelegt* hängt daran, ob es einen
unabhängigen Messweg gibt. Bei einem Secret gibt es keinen — die Aussage des
Betreibers ist die bestmögliche Evidenz. Beim Zustand eines Servers gibt es
einen: die API des Anbieters.

**Die Liste beschreibt den zu bauenden Server, nicht den alten.** Alle
Messwerte, die sich auf den bisherigen Produktionsserver bezogen, sind nach
[`NEXT_DEVELOPMENT_AUDIT.md`](NEXT_DEVELOPMENT_AUDIT.md) S-09 gewandert. Sie
sind Vorfallsbelege und taugen nicht als Zielvorgabe: Ein Häkchen, das an
einer Maschine gemessen wurde, die nicht mehr beliefert wird, ist kein
Häkchen.

**A — GitHub, gehärtet vor dem Serverbau.**

| # | Punkt | Stand | Beleg |
|---|---|---|---|
| A1 | Historie vollständig auf Zugangsdaten geprüft | **belegt** | alle 55 erreichbaren Commits, sämtliche Anbietermuster: kein echtes Zugangsdatum, nur Platzhalter, `example.ch`-Fixtures und CI-Wegwerfwerte |
| A2 | Geheimnis-Suche ohne Fehlalarm | **belegt** | Tokengrenze in `scripts/ci-secret-scan.sh`; Regressionsprüfungen in `tests/api/auslieferung-absicherung.test.ts` |
| A3 | Pull Requests durchlaufen das Qualitätstor | **belegt** | Auslöser `pull_request` gegen `main`, kein `pull_request_target` |
| A4 | Ein Pull Request liefert nie aus | **belegt** | `github.event_name != 'pull_request'` am Auslieferungsauftrag, dazu `needs: qualitaet` |
| A5 | Auslieferung nur nach ausdrücklichem Einschalten | **belegt** | `vars.DEPLOY_ENABLED == 'true'`, fail-closed — verhindert, dass der erste grüne Lauf an ein Altziel liefert |
| A6 | Default-Branch ist `main` | **bestätigt** (seit 2026-09-27) | Umstellung durch die Inhaberschaft, `docs/GITHUB_GOVERNANCE.md` §1 — nach der API-Lesung vom 2026-09-27 nicht erneut gelesen |
| A7 | `main` gegen Force-Push und Löschen geschützt, CI als Pflichtprüfung | **belegt** (2026-09-27) | Regelsatz „main schützen" (ID 24071027), über die API gelesen, `docs/GITHUB_GOVERNANCE.md` §2 |
| A8 | Repository privat | **offen** — Entscheid der Inhaberschaft (E-9) | Seit dem Artefaktweg hängt der Server nicht mehr daran (kein Deploy-Key); auf GitHub Free verlöre ein privates Repository den Regelsatz (`GITHUB_GOVERNANCE.md` §3) |
| A9 | Umgebung `production` nimmt nur `main` an | **belegt** (2026-09-27) | Zweigregel der Umgebung, über die API gelesen, `docs/GITHUB_GOVERNANCE.md` §1; dazu `github.ref == 'refs/heads/main'` am Auftrag seit 2026-09-30 |
| A10 | Actions-Rechte nach Least Privilege | **teilweise belegt** | im Workflow: Vorgabe `contents: read`, Auslieferungsauftrag `permissions: {}`. Die Repository-Einstellung selbst ist Betreibersache |

**B — Der neue Server, vor der ersten Auslieferung.** Jeder Punkt gilt für die
noch zu bauende Maschine; keiner ist heute belegbar.

| # | Punkt | Stand |
|---|---|---|
| B1 | Cloud Firewall des Anbieters angelegt und **angehängt**: 80/443 nur Cloudflare-Netze, 22 nur eigene Verwaltungsadressen, sonst nichts | offen |
| B2 | Firewall auf dem Server (nftables/ufw) zusätzlich aktiv | offen |
| B3 | 3000, 5432, 6379 von aussen nicht erreichbar — **nachgemessen**, nicht angenommen | offen |
| B4 | `delete_protection` und `rebuild_protection` eingeschaltet | offen |
| B5 | Infrastruktursicherung (Cloud-Backup/Snapshot) eingeschaltet | offen |
| B6 | Wirtsschlüssel über die **Anbieterkonsole** gelesen und als `SERVER_SSH_KNOWN_HOSTS` gepinnt | offen |
| B7 | ~~Eigener, nur lesender Deploy-Key für das private Repository~~ | **entfällt** — der Server holt seit dem Artefaktweg nichts aus Git |
| B8 | `pg_dump`/`pg_restore` vorhanden, Hauptversion ≥ Server | offen — das Sicherungsskript prüft es beim Lauf und bricht sonst ab |
| B9 | Sicherungsverzeichnis ausserhalb des Anwendungsverzeichnisses, beschreibbar | offen — ebenso fail-closed |
| B10 | Produktions-Secrets vollständig und **neu** (14) | offen |
| B11 | Ursprung nur für Cloudflare-Netze erreichbar, danach `TRUSTED_PROXY_MODE=CLOUDFLARE` — **in dieser Reihenfolge** (13.5.2) | offen |

**Zwei Firewalls, und sie messen nicht dasselbe.** Der Unterschied hat am
alten Server eine Schicht gekostet und gehört deshalb hierher:

- Die **Cloud Firewall** des Anbieters liegt vor dem Server, in dessen Netz.
  Sie ist unabhängig vom Betriebssystem und wirkt auch dann, wenn die Maschine
  falsch konfiguriert, frisch aufgesetzt oder im Rettungssystem ist.
- Die **Firewall auf dem Server** (nftables/ufw) wirkt nur, solange das
  System läuft und richtig konfiguriert ist. Ein `ufw disable`, ein Rebuild
  oder ein Rettungssystem nimmt sie weg.

Ein geschlossener Port beweist also nur, dass *eine* der beiden greift. Für
V2 sind beide vorgesehen, und B1 wird getrennt von B2 abgehakt. Eine
vorhandene Firewall des Anbieters, die 22, 5432 oder 4444 gegen `0.0.0.0/0`
öffnet, wird **nicht** wiederverwendet — sie ist keine Abkürzung, sondern das
Gegenteil einer Regelmenge.

**Was nur der Betreiber abhaken kann (A6–A9).** GitHub gibt weder
Secret-Werte noch Einstellungen ohne Authentifizierung heraus; von einem
Arbeitsplatz ohne Token sind diese vier Punkte grundsätzlich nicht messbar.
Sie standen deshalb als *offen*, bis eine Lesung über die API vorlag (A7, A9
am 2026-09-27) oder die Inhaberschaft die Umstellung bestätigt hat (A6).

### Zwei Sicherungsebenen, die nicht dasselbe sind

Sie werden leicht verwechselt, und die Verwechslung kostet im Ernstfall Daten.

**Anwendungssicherung (Datenbank).** Der `pg_dump` unten, vor jeder Migration,
aus der Auslieferung heraus. Er sichert genau den fachlichen Zustand und lässt
sich selektiv zurückspielen. Er sichert **nicht** den Server, nicht die
Dateiablage der `StoredFile`-Zeilen ausserhalb der Datenbank und nicht die
Konfiguration.

**Infrastruktursicherung (Hetzner).** Cloud-Backup beziehungsweise Snapshot des
gesamten Servers. Sie ist **derzeit nicht aktiviert** (`backup_window: null`).
Sie deckt Betriebssystem, Konfiguration und Platte ab und hilft bei einem
Serververlust — aber sie ist kein Ersatz für den Dump vor einer Migration: Ein
tägliches Snapshot liegt im Zweifel Stunden daneben, und aus einem Snapshot eine
einzelne Tabelle zurückzuholen ist ein eigenes Vorhaben.

Keine der beiden ersetzt die andere. Für den Produktionsbetrieb gehören beide
eingeschaltet.

### Datenbanksicherung vor Schemaänderungen

Hier stand bis zuletzt ein offener P1: Die Auslieferung sicherte Build und
`.env` — also genau das, was sich aus Git und den Secrets wiederherstellen
lässt — und **nicht** die Daten. Der Punkt ist geschlossen.

**Was jetzt passiert.** Die Aktivierung (`deploy/v2/release-aktivieren.sh`,
Abschnitt 15) ruft beides aus dem frisch entpackten Release auf, mit
`APP_DIRECTORY` = Basisverzeichnis. Meldet `prisma migrate status` offene
Migrationen, läuft vor `migrate deploy` zwingend:

1. **`scripts/migration-preflight.ts`** — liest die offenen Migrationen, sammelt
   jede darin verlangte Eindeutigkeit ein und prüft **nur lesend**, ob die
   vorhandenen Daten sie verletzen würden. Tabellen und Spalten, die dieselbe
   Reihe erst anlegt, werden als solche erkannt und übersprungen.
2. **`scripts/db-backup.ts`** — `pg_dump --format=custom`, danach vier
   Prüfungen: Datei vorhanden, Grösse > 0, `pg_restore --list` lesbar und nicht
   leer, SHA-256 gebildet.

Beides ist **fail-closed**: Meldet die Vorprüfung einen Konflikt oder scheitert
die Sicherung, endet die Auslieferung *vor* der ersten Schemaänderung. Ohne
offene Migration wird nichts gesichert — es ändert sich ja nichts.

| | |
|---|---|
| **Ablageort** | `CLENARIS_BACKUP_DIR`, Vorgabe `<über APP_DIRECTORY>/backups/clenaris-db` — bei der Aktivierung also neben dem Basisverzeichnis, etwa `/home/clenaris/backups/clenaris-db`. Bewusst **ausserhalb**: Im Basisverzeichnis ersetzt und löscht die Aktivierung Releases und Archive (Aufbewahrung), und eine Sicherung, die beim nächsten Aufräumen mit verschwindet, ist keine. Wer `/var/backups/clenaris/database` will, gibt dem Dienstbenutzer Schreibrecht und setzt die Variable. |
| **Format** | PostgreSQL Custom Archive (`--format=custom`, Kompression 6) — wahlfrei wiederherstellbar, einzelne Tabellen möglich |
| **Name** | `clenaris_<UTC-Zeitstempel>_<Commit>.dump`, etwa `clenaris_2026-09-20T21-19-18-860Z_4eb385f2b032.dump` |
| **Rechte** | Verzeichnis `700`, Datei `600`. Kein Nginx-Zugriff, kein Abruf über die Anwendung, **kein** Upload als CI-Artefakt |
| **Aufbewahrung** | `CLENARIS_BACKUP_KEEP`, Vorgabe 7. Gelöscht wird erst **nach** der geprüften neuen Sicherung, nur im Sicherungsverzeichnis, nur bei exakt passendem Namensmuster, und die neueste nie |
| **Protokolliert** | Zeitpunkt, Dateiname, Grösse, SHA-256, Archiveinträge, Server- und Clientversion |
| **Nie protokolliert** | Verbindungszeichenfolge, Passwort, Secrets. Die Verbindung wird zerlegt und über `PGHOST`/`PGUSER`/`PGPASSWORD` übergeben — sie steht damit auch nicht in der Prozessliste des Servers |

> **Voraussetzung auf dem Server.** Die Sicherung braucht `pg_dump`,
> `pg_restore` und `psql` — die PostgreSQL-Clientwerkzeuge. Auf einem Server,
> auf dem die Datenbank selbst läuft, sind sie da; liegt die Datenbank
> woanders, gehören sie nachinstalliert:
>
> ```bash
> sudo apt install postgresql-client-18   # Hauptversion wie der Server
> ```
>
> Fehlen sie, bricht die Auslieferung **vor** der Migration ab und sagt es —
> sie läuft nicht ohne Sicherung weiter. Liegen sie ausserhalb des `PATH`,
> zeigt `PG_BIN` auf ihr Verzeichnis.

**Versionen.** Vor dem Dump wird `SHOW server_version` gegen den Server und
`pg_dump --version` gegen den Client gestellt. Ein Client mit kleinerer
Hauptversion bricht ab — ein älterer `pg_dump` kennt neuere Katalogstrukturen
nicht und erzeugt im schlimmsten Fall ein unvollständiges Archiv, das erst beim
Zurückspielen auffällt.

**Der geprobte Rückweg.** `scripts/db-restore-verify.ts` legt eine
Wegwerfdatenbank `clenaris_restore_verify_<Zeitstempel>` an, spielt ein Archiv
hinein, vergleicht die Zeilenzahlen von vierzehn Tabellen mit der Quelle und
wirft sie wieder weg. Der Zielname wird im Skript erzeugt und muss einem festen
Muster entsprechen — `clenaris`, `clenaris_preview`, `clenaris_test` und jede
Produktionsadresse können es nicht erfüllen.

```bash
# Sicherung von Hand, etwa vor einem Eingriff — aus dem laufenden Release,
# ohne npx (auf dem Server wird nichts nachgeladen):
cd /home/clenaris/clenaris/current
APP_DIRECTORY=/home/clenaris/clenaris node node_modules/tsx/dist/cli.mjs scripts/db-backup.ts --grund manuell

# Den Rückweg proben (nicht gegen Production):
npx tsx scripts/db-restore-verify.ts --datei <pfad.dump>
```

Der Restore-Test läuft **nicht** bei jeder Auslieferung: Dafür bräuchte es eine
zweite Datenbank in Produktionsgrösse, und die gibt es nicht. Er beweist den
Mechanismus; ein eigener Wiederherstellungslauf kann später folgen.

**Zurückspielen im Ernstfall.** Das Archiv ist ein gewöhnliches Custom Archive:

```bash
# In eine frische Datenbank, nicht über die laufende drüber:
createdb clenaris_wiederhergestellt
pg_restore --no-owner --exit-on-error --dbname clenaris_wiederhergestellt <pfad.dump>
```

Erst prüfen, dann umschalten. Eine Migration wird **nicht** automatisch
rückwärts ausgeführt — das bleibt eine fachliche Entscheidung.

**Wenn etwas schiefgeht.** Scheitert die Sicherung oder die Vorprüfung, wird
nicht migriert und nicht umgeschaltet; der laufende Stand bleibt unberührt
(Ausgang 10). Scheitert die Migration selbst, bricht die Aktivierung vor dem
Umschalten ab — die Anwendung läuft weiter aus dem bisherigen Release, und die
Sicherung von eben liegt bereit; das Protokoll meldet, dass das Schema
womöglich teilweise migriert ist. Bestätigt die neue Fassung nach dem
Umschalten ihre Identität nicht, schaltet die Aktivierung auf das vorherige
Release zurück und prüft es (Ausgang 20); das Schema bleibt, wie die
Migration es hinterlassen hat. Gebaut wird in keinem dieser Fälle.

> **`npm run db:seed:demo` gehört nie auf ein System, das in Betrieb geht.**
> Er legt erfundene Kundschaft, erfundene Bewertungen und **Rechnungen** an.
> Die Rechnungen verbrauchen Nummern aus `NumberSequence`; diese Folge muss
> nach Art. 957a OR lückenlos sein, und eine im Spass vergebene Nummer lässt
> sich nicht zurückgeben. Erfundene Kundenstimmen auf einer öffentlichen
> Website sind zusätzlich wettbewerbsrechtlich heikel.
>
> `prisma/seed-guard.ts` bricht den Demo-Seed deshalb ab, sobald die
> Zieldatenbank nicht als Testdatenbank erkennbar ist (`test`, `demo`,
> `scratch`, `sandbox` im Namen). Verlassen Sie sich nicht allein darauf —
> der Schalter kennt Ihre Produktionsdatenbank nur an ihrem Namen.
>
> Für Prüfungen gibt es `npm run db:test:setup`; die Trennung der Umgebungen
> steht in `tests/README.md`.

## 2. Dateiablage

Bucket `clenaris` anlegen, **nicht öffentlich**. Zugriff läuft über signierte
Adressen; ein öffentlicher Bucket würde Vorher-Nachher-Fotos aus Privatwohnungen
für jeden erreichbar machen, der eine Adresse errät.

Erlaubte Dateitypen und Grössen stehen in `src/lib/storage/supabase.ts` unter
`UPLOAD_PROFILES` und werden serverseitig durchgesetzt.

## 3. Umgebungsvariablen

Im eigenen Betrieb stehen sie ausschliesslich in `shared/.env` auf dem Server
(13.3); die Pipeline überträgt seit 2026-09-27 keine einzige davon (14). Die
Produktionsvorprüfung jeder Aktivierung (`scripts/production-preflight.ts`)
prüft genau diese Datei. Pflicht in Produktion — fehlt einer, hält die
Aktivierung vor der Migration an:

```
NODE_ENV                   production   (auch in shared/.env: die Vorprüfung läuft vor PM2 und liest die Datei)
CLENARIS_UMGEBUNG          production   (oder staging)
DATABASE_URL               keine Test-, Vorschau- oder Demodatenbank, kein Standardpasswort
DIRECT_URL                 dito; hinter einem Pooler am Pooler vorbei
JWT_SECRET                 openssl rand -base64 48   (mindestens 32 Zeichen)
APP_URL                    https://<produktionsadresse>   (Laufzeit; keine IP, kein localhost)
CRON_SECRET                openssl rand -hex 32   (mindestens 32 Zeichen)
ENCRYPTION_KEY             openssl rand -hex 32   (genau 64 Hex-Zeichen, verschieden von JWT_SECRET)
TRUSTED_PROXY_MODE         NONE | SINGLE_REVERSE_PROXY | CLOUDFLARE   (13.5.1)
CLAMAV_HOST                Adresse von clamd — ohne Scanner endet jeder Upload in ERROR
```

Die Vorprüfung weist ausserdem jeden Wert ab, der aus `.env.example`, der CI
oder der Prüfreihe bekannt ist, und jeden gesetzten Demo- oder Prüfschalter
(`ALLOW_DEMO_SEED`, `CLENARIS_TEST_CACHE_DIR`, `CLENARIS_LEGACY_FILES=allow`,
`LEGACY_PUBLIC_TOKENS`, `CLENARIS_PRUEF_RELEASE_MANIFEST`). Bei
`TRUSTED_PROXY_MODE=CLOUDFLARE` verlangt sie zusätzlich
`CLENARIS_URSPRUNG_NUR_CLOUDFLARE=bestaetigt`.

Beim **Bau** zusätzlich `NEXT_PUBLIC_SITE_URL` — die kanonische Domain der
Website, für jede Umgebung dieselbe (`https://clenaris.qasemi.ch`). Sie ist
die einzige Adresse, die im Bau festsitzt (Canonical, Sitemap, robots.txt der
statisch erzeugten Seiten). Alles andere — Links in E-Mails, PDFs,
Zahlungsrücksprünge, Signaturen, die Herkunftsprüfung — liest `APP_URL` zur
Laufzeit (V2-1, `docs/PRODUCTION_V2.md` §5). Fehlt `APP_URL` in der
Produktion, verweigert die Anwendung jeden absoluten Link, statt auf
`localhost` zu zeigen. Ein älteres `NEXT_PUBLIC_APP_URL` in der `.env` gilt
weiter als Rückfall, zur Laufzeit gelesen.

> **Die Produktionsadresse ist nicht `clenaris.ch`.** Das ist der Markenname
> und steht in den Firmenangaben; als Hostname existierte er im DNS zuletzt
> (2026-09-19) nicht. Überall dort, wo eine Adresse *angesprochen* wird —
> `APP_URL`, `NEXT_PUBLIC_SITE_URL`, `API_URL`, die `servers` der OpenAPI-Spezifikation —,
> gehört die tatsächlich erreichbare Adresse hin. Eine Konfiguration, die auf
> einen nicht auflösenden Namen zeigt, erzeugt Magic Links und PDF-Verweise,
> die ins Leere führen, und der Fehler fällt erst der Kundschaft auf.

`ENCRYPTION_KEY` verschlüsselt das TOTP-Geheimnis, die AHV-Nummer und den
Alarmcode in der Datenbank (`src/lib/crypto.ts`). Fehlt er, leitet die
Anwendung den Schlüssel aus `JWT_SECRET` ab und läuft weiter — ein Wechsel von
`JWT_SECRET` machte dann aber alle drei Felder unlesbar. Deshalb steht er hier
unter den Pflichtwerten und nicht unter den Empfehlungen.

**Diesen Schlüssel sichern wie das Datenbankpasswort.** Geht er verloren,
geht kein Konto verloren — aber jede Person mit zweitem Faktor muss ihn neu
einrichten, und AHV-Nummern und Alarmcodes sind nachzutragen.

**Rotieren lässt er sich heute nicht.** `src/lib/crypto.ts` kennt weder einen
Zweitschlüssel-Lesepfad noch ein Umschlüsselungsskript (S-08); ein Wert mit
Präfix `enc:v1:`, der sich mit dem aktuellen Schlüssel nicht entschlüsseln
lässt, wirft. Ein blosser Austausch der Variablen macht den Bestand also
unlesbar — nicht ungültig, sondern unwiederbringlich. Ein solches Skript
müsste geschrieben und geprüft werden; es zu erfinden, ohne es gegen echte
Daten gefahren zu haben, wäre schlimmer als sein Fehlen.

> **Für Production V2 ist das Zeitfenster jetzt.** Eine frische Datenbank
> enthält keinen Wert mit `enc:v1:`. Solange das gilt, ist der Schlüssel frei
> wählbar und kostet nichts. Das Fenster schliesst sich mit dem **ersten**
> eingerichteten zweiten Faktor, der ersten AHV-Nummer und dem ersten
> Alarmcode. `ENCRYPTION_KEY` gehört deshalb in die allererste `.env`, nicht
> in eine spätere Nachbesserung.
>
> Soll später ein Datenbestand aus einer früheren Installation übernommen
> werden, kehrt sich die Lage um: Dann braucht es entweder den damaligen
> Schlüssel — beziehungsweise den damaligen `JWT_SECRET`, falls nie ein
> eigener gesetzt war — oder vorher ein Umschlüsselungsskript. Das ist eine
> eigene Entscheidung und gehört nicht in die Inbetriebnahme.

Empfohlen:

```
REDIS_URL                          Rate-Limits über Instanzgrenzen hinweg (ohne: Warnung der Vorprüfung)
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
RESEND_API_KEY
EMAIL_FROM
ANTHROPIC_API_KEY
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
GOOGLE_MAPS_SERVER_KEY
SECURITY_REPORT_TOKEN              Eingang der Sicherheitsberichte (ohne: geschlossen, Warnung)
RELEASE_EXECUTOR_TOKEN             nur mit dem Release-Ausführer, beide zusammen
RELEASE_EXECUTOR_SIGNING_KEY       und verschieden
CLENARIS_BESUCHSMESSUNG            nur „an" schaltet die eigene Besuchsmessung ein; Vorgabe aus,
                                   erst nach der Rechtsprüfung (TA-02) — die Vorprüfung warnt bei „an"
```

`NEXT_PUBLIC_SUPABASE_ANON_KEY` und `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` liest
der Code seit V2-1 nicht mehr (`docs/PRODUCTION_V2.md` §5); sie gehören nicht
in eine neue `shared/.env`.

Firmenangaben (`COMPANY_*`) sind nur der Ausgangszustand für den Seed — im
laufenden Betrieb gilt der Datensatz `Organization`.

`SUPABASE_SERVICE_ROLE_KEY` und `STRIPE_SECRET_KEY` gehören ausschliesslich in
die Server-Umgebung. Alles mit `NEXT_PUBLIC_` steht im Browser-Bundle und ist
öffentlich — dort darf kein Geheimnis stehen.

## 4. Ausliefern

```bash
vercel --prod
```

`npm run build` erzeugt vorher den Prisma-Client. Der Build braucht Zugriff auf
die Datenbank: einige öffentliche Seiten werden vorgerendert, und dafür wird
gelesen.

Region `fra1` und die Cron-Läufe stehen in `vercel.json` und brauchen keine
weitere Einrichtung.

## 5. Stripe-Webhook

Endpunkt `https://<domain>/api/webhooks/stripe`, Ereignisse:

```
checkout.session.completed
payment_intent.succeeded
payment_intent.payment_failed
charge.refunded
```

Das Signaturgeheimnis als `STRIPE_WEBHOOK_SECRET` hinterlegen. Der Endpunkt
prüft die Signatur gegen den **Rohkörper** — deshalb liest er den Body als Text
und nicht als JSON.

Für TWINT im Stripe-Dashboard unter *Settings → Payment methods* freischalten.

Lokal testen:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
stripe trigger checkout.session.completed
```

## 6. E-Mail

Domain in Resend verifizieren und diese DNS-Einträge setzen:

| Typ | Name | Zweck |
| --- | --- | --- |
| TXT | `@` | SPF |
| CNAME | `resend._domainkey` | DKIM |
| TXT | `_dmarc` | DMARC (`p=quarantine`) |

Ohne DKIM landen Buchungsbestätigungen und Rechnungen im Spam. Bei einer
Rechnung ist das kein Schönheitsfehler, sondern eine verpasste Zahlungsfrist.

Optional archiviert `EMAIL_BCC_ARCHIVE` jede ausgehende Nachricht in einem
Postfach.

## 7. Planmässige Aufgaben

Vercel Cron ruft zwei Endpunkte auf (definiert in `vercel.json`):

| Zeitplan | Endpunkt | Aufgaben |
| --- | --- | --- |
| `5 * * * *` | `/api/cron/hourly` | Terminerinnerungen 24 h und 2 h vorher, Aufgabenerinnerungen |
| `0 5 * * *` | `/api/cron/daily` | Mahnläufe, ablaufende Offerten, Serienbuchungen, Bewertungsanfragen, Geburtstagsgrüsse, Automatisierungen |

Beide verlangen `Authorization: Bearer $CRON_SECRET`. Ohne gesetztes
`CRON_SECRET` weisen sie **jede** Anfrage ab — auch die von Vercel. Das ist
Absicht: ein offener Endpunkt, der Mahnungen versendet, ist schlimmer als ein
Endpunkt, der nicht läuft.

Prüfen:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/daily
```

## 8. Domain und DNS

| Typ | Name | Wert |
| --- | --- | --- |
| A | `@` | `76.76.21.21` |
| CNAME | `www` | `cname.vercel-dns.com` |

Vercel stellt das Zertifikat aus und erneuert es. HSTS setzt die Middleware.

## 9. Sicherung

> Für Production V2 (eigener Server, kein Supabase-Tarif) gilt
> `docs/BACKUP_DR.md`; die Aktivierung sichert vor jeder Migration selbst
> (Abschnitt 1, „Datenbanksicherung vor Schemaänderungen"). Der folgende
> Absatz beschreibt den Betrieb mit Supabase.

Supabase sichert täglich automatisch (Aufbewahrung je nach Tarif). Für die
zehnjährige Aufbewahrungspflicht der Geschäftsbücher (Art. 958f OR) reicht das
nicht — ein monatlicher Export gehört an einen zweiten Ort:

```bash
pg_dump "$DIRECT_URL" --format=custom --file="clenaris-$(date +%Y-%m).dump"
```

Wiederherstellung üben, bevor man sie braucht:

```bash
pg_restore --clean --if-exists --dbname="$TEST_DATABASE_URL" clenaris-2026-09.dump
```

Der Storage-Bucket ist nicht Teil des Datenbankauszugs. Belege, Einsatzfotos
und Lohnabrechnungen brauchen eine eigene Sicherung.

## 10. Betrieb

> Der Abschnitt stammt aus der Vercel-Zeit. Für V2 berichtigt sind die
> Pool-Angaben unten: Unter Prisma 7 hält jeder Node-Prozess einen eigenen
> `pg`-Pool, und `connection_limit` in der Adresse wirkt nicht mehr. Prozesse,
> Protokolle und Wiederherstellung auf dem Server: Abschnitte 13, 17 und 18.

**Was beobachten.**

- 5xx-Rate auf `/api/webhooks/stripe` — dort steht Geld dahinter.
- Dauer von `/api/cron/daily`; nähert sie sich 60 Sekunden, muss der Lauf
  aufgeteilt werden.
- Verbindungsanzahl der Datenbank. Jeder PM2-Prozess (`PM2_INSTANCES`,
  Vorgabe 2, `ecosystem.config.js`) hält einen `pg`-Pool von höchstens 10
  Verbindungen (`src/lib/prisma-client.ts`, pg-Vorgabe); `max_connections`
  der Datenbank muss Prozesse × 10 plus Werkzeuge tragen. Der frühere Rat,
  `connection_limit=1` gegen parallele Vercel-Functions in die `DATABASE_URL`
  zu schreiben, wirkt unter Prisma 7 nicht — der Adapter liest den Wert nicht
  (`docs/PENDENZEN.md` P2H-57: Pool ohne Fristen, Produktentscheid).
- 429-Antworten. Häufen sie sich für angemeldete Konten, sind die Klassen zu
  eng gefasst.

**Wenn etwas klemmt.**

| Symptom | Ursache | Abhilfe |
| --- | --- | --- |
| Build bricht beim Vorrendern ab | keine DB-Verbindung während des Builds | `DATABASE_URL` auch für die Build-Umgebung setzen |
| „Too many connections" | mehr Prozesse × 10 Verbindungen, als `max_connections` trägt | Prozesszahl (`PM2_INSTANCES`) oder `max_connections` anpassen; `?pgbouncer=true&connection_limit=1` wirkt unter Prisma 7 nicht |
| Cron läuft nicht | `CRON_SECRET` fehlt | Variable setzen und neu ausliefern |
| Zahlung bleibt offen | Webhook nicht erreichbar oder Signatur falsch | Stripe-Ereignisprotokoll prüfen |
| PDF ohne QR-Code | `COMPANY_QR_IBAN` fehlt oder ist keine QR-IBAN | IBAN prüfen (Institut 30000–31999) |
| E-Mails im Spam | DKIM/SPF fehlt | DNS-Einträge nachtragen |

**Vor jeder Auslieferung.**

```bash
npm run typecheck && npm run lint && npm run build && npm run docs
```

`npm run docs` bricht ab, wenn ein Endpunkt existiert, aber nicht dokumentiert
ist — das hält die Spezifikation ehrlich.

## 11. Vor dem Produktivgang

- [ ] `JWT_SECRET` und `CRON_SECRET` frisch erzeugt, nicht aus dem Repository
- [ ] Administrationskonto mit eigenem Passwort, Demokonten entfernt
- [ ] Storage-Bucket nicht öffentlich
- [ ] Stripe im Live-Modus, Webhook erreichbar, TWINT freigeschaltet
- [ ] DKIM, SPF und DMARC gesetzt und mit einer Testmail geprüft
- [ ] Beide Cron-Läufe einmal von Hand ausgelöst
- [ ] Firmendaten, Bankverbindung und QR-IBAN im Datensatz `Organization`
- [ ] Öffnungszeiten, Feiertage und Einsatzgebiet erfasst
- [ ] Leistungskatalog und Preise geprüft — sie gelten ab der ersten Buchung
- [ ] Impressum, Datenschutzerklärung und AGB juristisch geprüft
- [ ] Wiederherstellung aus einer Sicherung einmal durchgespielt

### 11.1 Offene Prüfungen vor dem Produktivgang

Diese Punkte sind **weder** als Fehler **noch** als in Ordnung bewertet. Sie
liessen sich in der Entwicklung nicht abschliessend prüfen und brauchen den
Produktivbetrieb bzw. einen autorisierten Zugriff darauf.

**Sucuri SiteCheck: `403 Forbidden` — Ursache noch nicht ermittelt.**
Status: `PRE-PRODUCTION VERIFICATION REQUIRED`. Kein Malware-Befund: Der
externe Scanner erreicht die vorgeschaltete Infrastruktur und bekommt 403,
mehr sagt der Befund nicht. Zu klären ist, **welche Schicht** antwortet:

```
Internet → DNS/CDN/WAF → Host-Firewall → Reverse Proxy (Nginx) → Next.js → Middleware → Clenaris
```

Vorgehen, ausschliesslich lesend und erst mit autorisiertem Zugriff:

1. Von mindestens zwei externen Netzen `curl -I https://clenaris.qasemi.ch/`
   und `curl -v … -o /dev/null`. Erwartung für eine öffentliche Startseite:
   200 oder eine Weiterleitung auf 200 — nicht 401/403.
2. Browser, gewöhnlicher `curl`-User-Agent und ein bot-ähnlicher Request
   vergleichen. Bekommen nur automatisierte Clients 403, liegt die Ursache in
   Bot-, WAF- oder Proxy-Regeln.
3. Den Zeitpunkt des Scans notieren und ihn in Nginx-Access- und Error-Log,
   Firewall/WAF-Log, Anwendungs- und Rate-Limit-Log suchen. Die Frage ist,
   ob die Anfrage Next.js überhaupt erreicht.

Entscheidungsbaum: Erscheint der Scan im Nginx-Log mit 403 → Nginx/App
untersuchen. Erscheint er nicht, blockiert aber die Firewall/WAF →
Perimeter-Regel. Leitet Nginx weiter und Next.js liefert 403 → Middleware,
API oder Anwendungsregeln. Wird nur Sucuri blockiert, andere Bots nicht →
die konkrete Regel benennen und erst dann entscheiden, ob überhaupt etwas zu
ändern ist.

**Nicht tun:** keine Sucuri-Adresse freischalten, nur damit der Scanner grün
wird — und schon gar keine aus Blogbeiträgen oder Foren übernommene. Ein
Scanner bekommt keinen Zugriff auf `/admin`, `/portal`, `/konto`, private
APIs oder private Dateien, weil er ein Scanner ist. Ein grünes
Sucuri-Ergebnis ist ein Signal unter zwölf, kein Sicherheitsnachweis: nach
dem Rollout getrennt prüfen — HTTP/TLS, Security-Header, öffentliche
Angriffsfläche, Reputation, DNS, CSP, Cookies, Auth-Endpunkte, Rate-Limits,
Dateizugriff, `PublicAccessToken`-Flüsse, Informationspreisgabe.

**Direktzugriff auf den Anwendungsport** (13.5.1). Status:
`PRE-PRODUCTION VERIFICATION REQUIRED`. Von einem externen Netz prüfen, dass
`http://<server>:3000/` und `http://<server>:3000/api/health` **nicht**
antworten (Verbindung verworfen oder Timeout), während
`https://clenaris.qasemi.ch/api/health` antwortet. Erst wenn das feststeht,
ist `TRUSTED_PROXY_MODE=SINGLE_REVERSE_PROXY` eine wahre Aussage; bis dahin
bleibt `NONE` die richtige Einstellung, auch wenn Nginx die Köpfe bereits
setzt. `ecosystem.config.js` bindet seit Gate 4C an `127.0.0.1`; die
Prüfung von aussen bleibt trotzdem nötig, weil sie den *laufenden* Server
betrifft, nicht die Datei im Repository.

**Supabase-Rücklauf beim Datei-Abschluss** (`downloadObject` in
`src/lib/storage/supabase.ts`): implementiert und typgeprüft, aber nie gegen
einen echten Objektspeicher gefahren. Status:
`PRE-PRODUCTION VERIFICATION REQUIRED`.

**Stripe-Rückkehr:** Die Rückkehradressen sind nachweislich frei von
Clenaris-Tokens (`tests/api/stripe-rueckkehr.test.ts`). Ein vollständiger
Durchlauf gegen einen Stripe-Doppelgänger — unbekannte Sitzung, falscher
Zweck, fremde Rechnung, API-Fehler — steht aus, weil Stripe in der
Entwicklung nicht eingerichtet ist.

**Legacy-Links (`LEGACY_PUBLIC_TOKENS`):** Vor dem Rollout offene Vorgänge
inventarisieren, sichere Links ausstellen, neu versenden, dann den Schalter
auf der sicheren Seite lassen. Ohne gesetzte Variable ist er aus.

---

# Teil II — Automatische Auslieferung auf einen eigenen Server

Ab hier geht es um den Weg ohne Vercel: Ein Push auf `main` baut und prüft,
packt das Artefakt aus genau diesem Bau und liefert es — sobald
`DEPLOY_ENABLED` gesetzt ist — aus, ohne dass jemand eingreift. Der Server
baut nie.

## 12. Architektur der Pipeline

```
Entwicklung
    │  Arbeitszweig → Pull Request gegen main
    ▼
GitHub Actions  ── .github/workflows/deploy.yml
    │
    ├─ Auftrag 1: Prüfung          läuft bei PR · Push auf main · Handstart
    │     npm ci · verify:static (Linter, Typen, Geheimnisse, Doku, Testmatrix …) · Stückliste
    │     PostgreSQL 16 · Migrationen · Datenbankschranken
    │     Konfigurations-Seed · Build ohne Zwischenspeicher · Leistungsbudget
    │     Release-Artefakt packen       (vor jedem Serverstart; im Pull Request nur Probe)
    │     Demodaten · Testserver · verify:tests (HTTP und Browser)
    │     Ablage release-<sha>          (nur Push oder Handstart auf main)
    │
    ├─ Auftrag 2: Auslieferung     NUR Push oder Handstart auf main,
    │     │                        NIE aus einem Pull Request,
    │     │                        nur bei DEPLOY_ENABLED = true
    │     │                        (needs: Auftrag 1 grün)
    │     Artefakt dieses Laufs holen · Beilage prüfen (Commit, Lauf, main, auslieferbar, Summe)
    │     läuft dieser Commit schon als anderer Bau? → nichts übertragen, Hinweis, grün
    │     Archiv + .sha256 + release-aktivieren.sh AUS DEM ARCHIV → releases-eingang/
    │     release-aktivieren.sh <archiv> --erwartet-sha256 <summe>     (Vertrag C3, Abschnitt 15)
    │         Sperre · Summe · Manifest · frisch entpacken · Vorprüfung
    │         · Sicherung + migrate deploy · Umschalten mit Identitätsprüfung
    │         · bei Misserfolg zurück auf die vorherige Fassung (Ausgang 20)
    │     Identität von aussen prüfen (version = Commit, buildId der Beilage, belegt)
    │
    └─ Auftrag 3: Reproduzierbarkeit   nur Handstart: zweimal bauen, scripts/bau-vergleich.ts
```

**Zwei Wege in die Produktion.** Neben dem Auftrag `auslieferung` gibt es den
Release-Ausführer (`deploy/v2/release-ausfuehrer.yml`, eine Vorlage, die erst
nach `.github/workflows` kopiert wird): Er arbeitet freigegebene und
terminierte Aufträge aus dem Update Center ab, holt das Artefakt eines grünen
Push-Laufs auf `main` und ruft **dasselbe** Aktivierungsskript mit derselben
erwarteten Summe auf (`docs/PRODUCTION_V2.md` §6). Beide bleiben (Entscheid
der Betreiberin, 2026-09-30); eingeschaltet wird jeder mit seiner eigenen
Variablen — `DEPLOY_ENABLED` bzw. `RELEASE_EXECUTOR_ENABLED`. **Der direkte
Weg umgeht die Freigabe im Release Center:** Jeder grüne Push auf `main` wird
ausgeliefert, sobald `DEPLOY_ENABLED` steht. Beide Aufträge teilen die
Nebenläufigkeitsgruppe `clenaris-auslieferung-production`, damit nie zwei
Aktivierungen zugleich laufen; GitHub hält je Gruppe aber höchstens einen
wartenden Lauf und bricht einen älteren wartenden ab (`cancelled`, auf dem
Server ist dann nichts geschehen). Beide Wege gleichzeitig einzuschalten ist
deshalb nicht der vorgesehene Zustand.

**Drei Auslöser, zwei davon dürfen liefern.** Ein Pull Request löst das volle
Qualitätstor aus und nichts sonst — er ist eine Frage, keine Entscheidung.
Bis Gate V2 prüfte der Workflow ausschliesslich `main`, also erst *nach* dem
Zusammenführen; ein Fehler fiel damit zum spätestmöglichen Zeitpunkt auf.

Bewusst `pull_request` und nicht `pull_request_target`: Letzteres stellt die
Secrets des Repositories bereit, während es den Code aus dem Pull Request
ausführt. Das Qualitätstor kommt deshalb ohne ein einziges `secrets.*` aus —
`tests/api/auslieferung-absicherung.test.ts` hält das fest.

**Was hier eine Anwendung ist.** Die Anforderung nennt „Frontend bauen" und
„Backend bauen" getrennt. In diesem Projekt gibt es diese Trennung nicht:
Next.js 15 mit App Router hält Seiten (Server und Client Components) und
Schnittstelle (Route Handlers unter `src/app/api/`) im selben Baum, und
`npm run build` erzeugt beides in einem Durchgang. Ein künstlich getrennter
zweiter Build-Schritt würde nichts bauen, was nicht schon gebaut wäre.

**Warum die Prüfung so aufwendig ist.** Die Testreihe fährt die *laufende*
Anwendung über echtes HTTP an (siehe `tests/README.md`); Unit-Tests der Dienste
gibt es bewusst nicht. Der Prüfauftrag braucht deshalb eine echte Datenbank,
ein vollständiges Schema, Demodaten und einen gestarteten Produktionsbuild. Ein
Workflow, der bloss `npm test` aufriefe, scheiterte sofort mit „Kein Server
erreichbar".

**Warum gebaut wird, bevor Demodaten da sind, und gepackt, bevor ein Server
läuft.** Die öffentliche Website wird beim Bau aus der Datenbank vorgerendert,
und der gestartete Prüfserver schreibt neu gerenderte Seiten in `.next`
zurück. Ein Bau gegen die Demodatenbank oder ein nach den Prüfreihen gepacktes
Artefakt trüge erfundene Kundschaft und Bewertungen in die Produktion — das
Packskript verweigert beides. Abgelegt wird das Artefakt trotzdem erst nach
grünen Prüfreihen.

**Beteiligte Dateien.**

| Datei | Aufgabe |
| --- | --- |
| `.github/workflows/deploy.yml` | Prüfung, Packen, Ablage, Auslieferung, Reproduzierbarkeit. Auslöser: `pull_request` gegen `main`, `push` auf `main`, `workflow_dispatch` |
| `scripts/release-artefakt.ts` | Packt das Artefakt aus dem geprüften Bau (Archiv, `.sha256`, Beilage; `RELEASE.json` Format 2) |
| `deploy/v2/release-aktivieren.sh` | Aktiviert ein Artefakt auf dem Server (Vertrag C3); kommt mit dem Archiv |
| `deploy/v2/release-ruecksprung.sh` | Rücksprung von Hand aus dem aufbewahrten Archiv (Abschnitt 16) |
| `scripts/release-umschalten.ts` | Umschalten mit Identitätsprüfung — aufgerufen von Aktivierung und Rücksprung, nie von Hand |
| `deploy/v2/release-ausfuehrer.yml` | Vorlage des zweiten Wegs (Release-Ausführer), nicht unter `.github/workflows` |
| `scripts/deploy.sh` | **abgelöst** — bricht ab und nennt die beiden Skripte oben |
| `scripts/ci-secret-scan.sh` | Sucht Zugangsdaten im verfolgten Bestand |
| `ecosystem.config.js` | PM2: Cluster-Modus, Arbeitsverzeichnis ist das Release, Bindung an `127.0.0.1` |
| `src/app/api/health/route.ts` | `GET /api/health` — Betriebsbereitschaft samt Datenbank und Identität der Instanz |
| `.nvmrc` | Node-Hauptversion für CI und Server (22) |

## 13. Server einrichten (einmalig)

Voraussetzungen: Debian oder Ubuntu, erreichbares PostgreSQL ≥ 16, eine Domain
mit Zertifikat.

**13.1 Dienstbenutzer.** Die Auslieferung läuft nie als `root`: `SERVER_USER`
ist Pflicht, und der Workflow bricht ohne ihn vor der ersten Verbindung ab,
statt auf `root` zurückzufallen. Ein eigener Benutzer begrenzt den Schaden
eines kompromittierten Schlüssels auf das Anwendungsverzeichnis.

```bash
sudo adduser --disabled-password --gecos "" clenaris
sudo -iu clenaris
```

**13.2 Node, PM2 und Werkzeuge.** Node in **derselben Hauptversion wie die
CI** (`.nvmrc`, heute 22): `node_modules` reist im Artefakt mit und enthält
native Teile (Prisma); Aktivierung und Rücksprung verweigern eine abweichende
Hauptversion. Dazu `flock` (util-linux), `sha256sum`, `tar` und `readlink`,
die die Aktivierung voraussetzt.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs curl util-linux coreutils tar
sudo npm install -g pm2
```

**13.3 Verzeichnisaufbau und Umgebung.**

Der Server holt **nichts** aus Git: kein `git clone`, kein Deploy-Key, kein
`npm ci`, kein Bau. Er bekommt das geprüfte Artefakt über SSH in einen Eingang
und aktiviert es (Abschnitt 15). Die Sichtbarkeit des Repositorys ist damit
für den Server ohne Belang (Entscheid der Inhaberschaft,
`docs/GITHUB_GOVERNANCE.md` §3). Einmalig anzulegen ist nur die Basis — sie ist
das Secret `APP_DIRECTORY` und wird auf dem Server zu `CLENARIS_BASIS`:

```
/home/clenaris/clenaris/              = APP_DIRECTORY = CLENARIS_BASIS
  shared/.env                         Geheimnisse und Konfiguration, Modus 600, nie im Artefakt
  shared/logs/                        Protokolle über Releases hinweg (legt die Aktivierung an)
  releases/<commit>/                  ein entpacktes Artefakt je Commit (legt die Aktivierung an)
  current -> releases/<commit>        aktive Fassung
  archiv/clenaris-<sha12>.tar.gz      aktivierte Archive samt .sha256, für den Rücksprung
  releases-eingang/                   Übergabe aus der Pipeline, nach dem Entpacken geleert
  aktivierungen.jsonl                 eine Zeile je Aktivierung und Rücksprung
  .release.lock                       gemeinsame Sperre
/home/clenaris/backups/clenaris-db/   Datenbanksicherungen (Vorgabe neben der Basis)
```

```bash
mkdir -p ~/clenaris/shared && install -m 600 /dev/null ~/clenaris/shared/.env
```

`shared/.env` jetzt vollständig ausfüllen — **alle** Werte aus Abschnitt 3.
Seit dem Notfallauftrag vom 2026-09-27 reisen **keine** Anwendungsgeheimnisse
mehr durch die Pipeline; die Datei auf dem Server ist die einzige Quelle, und
die Produktionsvorprüfung jeder Aktivierung prüft genau die Werte, die die
Anwendung lesen wird. Was hier fehlt, hält die erste Aktivierung an.

Die erste Aktivierung startet PM2 aus dem Release (ohne vorherige Fassung
wird gestartet statt neu geladen) und sichert die Prozessliste mit `pm2 save`
erst nach bestätigter Identität. Danach einmalig:

```bash
pm2 startup        # den ausgegebenen Befehl als root ausführen
```

Ohne `pm2 startup` steht die Anwendung nach einem Neustart des Servers still —
und niemand merkt es, bis die erste Anfrage kommt.

> **Erstinstallation auf einer leeren Datenbank — nicht geklärt.** Die
> Produktionsvorprüfung, die jede Aktivierung vor der Migration ausführt
> (`--phase vor-migration`), liest den Migrationsstand und die Konten und
> verlangt eine abgeschlossene Ersteinrichtung (ein Konto der
> Systemverantwortung, `scripts/create-admin.ts`). Gegen eine Datenbank ohne
> Schema ist das nicht bestehbar, und `create-admin.ts` braucht das Schema.
> Der geplante Weg für V2 ist die geprüfte Übernahme der bestehenden Datenbank
> (`docs/NOTFALL_WIEDERHERSTELLUNG.md` §17) — dort sind Schema und Konten da.
> Für eine wirklich leere Datenbank ist die Reihenfolge auf dem Probeserver
> festzulegen (V2-3, `docs/PENDENZEN.md` P2H-76); bis dahin nichts von Hand
> „vorziehen", was die Aktivierung sonst mit Sicherung und Vorprüfung täte.

Das erste Konto der Systemverantwortung entsteht über `scripts/create-admin.ts`
aus dem aktiven Release, nie über Startpasswörter in der Umgebung
(`docs/NOTFALL_WIEDERHERSTELLUNG.md` §3 und §16). Ein Seed der
Betriebskonfiguration (`prisma/seed.ts`) läuft nie automatisch; ob und wann er
auf einer neuen Produktionsdatenbank läuft, ist ein bewusster Handgriff — der
Demo-Seed nie.

**13.4 Zugangsschlüssel und Wirtsschlüssel.** Auf dem Arbeitsplatz erzeugen, den
öffentlichen Teil auf den Server legen, den privaten als GitHub Secret:

```bash
ssh-keygen -t ed25519 -C "github-actions-clenaris" -f ~/.ssh/clenaris_deploy -N ""
ssh-copy-id -i ~/.ssh/clenaris_deploy.pub clenaris@<server>
```

**Der Wirtsschlüssel ist Pflicht, und `ssh-keyscan` allein genügt nicht.**

Hier stand einmal, `SERVER_SSH_KNOWN_HOSTS` sei „empfohlen" und ein fehlender
Schlüssel werde mit einer Warnung ungeprüft übernommen. Beides ist seit
`625cfc2` falsch: Die Auslieferung **bricht ab**, wenn das Secret fehlt oder
keinen Eintrag für den Wirt enthält, und sie verbindet ausschliesslich mit
`StrictHostKeyChecking=yes`.

Der Grund steht im Workflow ausführlich: Ein Rückfall auf `ssh-keyscan` ist
Vertrauen beim ersten Kontakt. An einem Arbeitsplatz, der sich den Schlüssel
merkt, ist das vertretbar; in einer Pipeline ist **jede** Verbindung die erste,
also findet die Prüfung nie statt — und wer sich dazwischenstellt, bekommt den
privaten Auslieferungsschlüssel und damit den Server.

`ssh-keyscan` beantwortet nur die Frage „welchen Schlüssel bietet der Gegenüber
gerade an". Es beantwortet **nicht** die Frage, ob das der richtige Gegenüber
ist. Deshalb in dieser Reihenfolge, und der zweite Schritt ist der eigentliche:

```bash
# 1) Den angebotenen Schlüssel einsammeln — noch ohne ihm zu trauen.
ssh-keyscan -t ed25519 <server> > /tmp/clenaris_known_hosts
ssh-keygen -lf /tmp/clenaris_known_hosts -E sha256

# 2) Auf dem Server selbst — über die Konsole des Anbieters, NICHT über SSH —
#    denselben Fingerabdruck ausgeben lassen:
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256

# 3) Nur bei zeichengenauer Übereinstimmung: Inhalt als Secret hinterlegen.
cat /tmp/clenaris_known_hosts
```

Stimmen die beiden Fingerabdrücke nicht überein, wird **nicht** ausgeliefert —
dann steht jemand dazwischen, oder der Server wurde neu aufgesetzt. Im zweiten
Fall wird der Schlüssel bewusst und nachvollziehbar ersetzt, nicht stillschweigend
übernommen. Es gab in diesem Projekt bereits einen Wirtsschlüsselkonflikt; er ist
der Grund für diesen Abschnitt.

Bei einem SSH-Port ungleich 22 muss der Eintrag die Form `[host]:port` haben —
der Workflow prüft das mit `ssh-keygen -F` und bricht sonst ab.

In `/etc/ssh/sshd_config` sicherstellen: `PermitRootLogin no`,
`PasswordAuthentication no`.

**13.4a Die Gestalt des Secrets `SERVER_SSH_KNOWN_HOSTS`.**

Der Wert ist eine `known_hosts`-Zeile, ohne Kommentar, ohne nötigen
Zeilenumbruch am Ende:

```
<name> ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA…
```

Zwei Bedingungen hängen daran, und beide haben schon einmal eine Auslieferung
gekostet:

- **Der Name links muss zeichengenau dem entsprechen, was in `SERVER_HOST`
  steht.** `ssh` schlägt unter dem Namen nach, mit dem es verbindet, nicht
  unter der aufgelösten Adresse. Steht dort ein DNS-Name statt der IP, lautet
  die Zeile `<name> ssh-ed25519 AAAA…`; bei einem Port ungleich 22
  `[<name>]:<port> ssh-ed25519 AAAA…`. Sind beide Wege im Gebrauch, gehören
  beide Zeilen ins Secret. Der Workflow prüft das mit `ssh-keygen -F` und
  bricht sonst ab.
- **Den Eintrag nicht mit `ssh-keygen -H` verschlüsseln.** Gehashte Einträge
  funktionieren zwar, aber dann lässt sich der Secretwert nicht mehr mit
  blossem Auge gegen den Fingerabdruck aus der Anbieterkonsole prüfen — und
  genau diese Nachprüfbarkeit ist der Zweck der Übung.

**Zur Struktur, falls der Schlüssel von Hand übertragen wird.** Ein
ed25519-Wirtsschlüssel hat 68 Zeichen Base64, entpackt 51 Byte:
längenpräfixiert `ssh-ed25519` (11 Byte) plus 32 Byte Schlüsselmaterial. Ein
Übertragungsschaden beim Abtippen fällt daran auf. Der Kommentar hinter dem
Schlüssel ist belanglos — er geht weder in den Fingerabdruck noch in
`known_hosts` ein.

**Ein Wirtsschlüssel wird nie stillschweigend ersetzt.** Weicht der
angebotene Schlüssel vom gepinnten ab, wird **nicht** ausgeliefert, und die
Frage lautet zuerst *warum*: Entweder steht jemand dazwischen, oder die
Maschine wurde neu aufgesetzt. Nur im zweiten Fall wird der Wert ersetzt, und
zwar bewusst und aus der Anbieterkonsole.

> **Für Production V2 gibt es hier keinen Sollwert, und das ist Absicht.**
> Der Server existiert noch nicht; sein Wirtsschlüssel entsteht beim
> Aufsetzen. Ein hier eingetragener Fingerabdruck wäre entweder der einer
> anderen Maschine oder eine Erfindung — beides ist schlimmer als eine leere
> Stelle.
>
> Die Fingerabdrücke, die dieses Projekt bisher gesehen hat — der des alten
> Produktionsservers, der eines noch früheren und der eines **fremden**
> Hosts, der dessen freigewordene Adresse übernommen hat —, stehen in
> [`NEXT_DEVELOPMENT_AUDIT.md`](NEXT_DEVELOPMENT_AUDIT.md) S-09. Keiner von
> ihnen gehört je wieder in ein Secret.
>
> Steht in der lokalen `~/.ssh/known_hosts` dieses Arbeitsplatzes noch ein
> Eintrag für eine frühere Adresse, gehört er entfernt
> (`ssh-keygen -R <adresse>`): Er pinnt einen Schlüssel für eine Maschine,
> die jemand anderem gehört. Gefährlich ist das nicht — die Zeile verhindert
> eher eine Verbindung, als sie eine ermöglicht —, aber sie ist irreführend.

**13.5 Reverse Proxy.** Die Anwendung hört auf `127.0.0.1:3000` und wird nie
direkt ins Netz gestellt. Nginx oder Caddy davor beendet TLS und reicht weiter.
Die Sicherheitskopfzeilen (CSP, HSTS, `X-Frame-Options`) setzt bereits
`next.config.ts`; der Proxy darf sie nicht überschreiben.

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
}
```

`X-Forwarded-For` ist nicht Kosmetik: Ohne diesen Kopf sehen alle
Ratenbegrenzungen dieselbe IP-Adresse — die des Proxys — und greifen entweder
für alle gleichzeitig oder für niemanden.

**13.5.1 Welchem Kopf die Anwendung glaubt — `TRUSTED_PROXY_MODE`.** Seit Gate
4B liest die Anwendung die Adresse der anfragenden Stelle nicht mehr aus
„irgendeinem" Kopf, sondern nur aus dem, den die Betreiberin als
vertrauenswürdig erklärt hat (`src/lib/http/client-ip.ts`). Der Grund: Ein
Kopf wie `CF-Connecting-IP` oder `X-Forwarded-For` ist vom Absender frei
wählbar, solange kein Proxy davor ihn überschreibt. Die gespeicherte Adresse
im Prüfprotokoll und im Signaturprotokoll wäre sonst eine Behauptung des
Absenders.

| `TRUSTED_PROXY_MODE` | Gelesener Kopf | Topologie, die der Modus voraussetzt |
|---|---|---|
| `NONE` (Vorgabe) | keiner — die Adresse gilt als **nicht verfügbar** | keine Annahme. Alle Aufrufer teilen sich einen Rate-Limit-Schlüssel; ehrlicher als eine erfundene Adresse |
| `SINGLE_REVERSE_PROXY` | **nur** `X-Real-IP` — fehlt er, gilt die Adresse als nicht verfügbar (kein Rückfall auf `X-Forwarded-For`, seit Gate 4C) | `Client → Reverse Proxy → Next.js`, **nie** `Client → Next.js direkt`; der Proxy **setzt** beide Köpfe aus `$remote_addr` |
| `CLOUDFLARE` | `CF-Connecting-IP` | `Client → Cloudflare → geschützter Ursprung`; der Ursprung nimmt nur Cloudflare-Netze an |

**Die Zusage, die ein Modus macht — und die, die er nicht machen kann.** Die
Anwendung sieht nur Kopfzeilen. Sie kann nicht wissen, ob `X-Real-IP` von
Ihrem Nginx stammt oder von einem Client, der den Anwendungsport direkt
erreicht hat. Richtig ist deshalb nicht „`SINGLE_REVERSE_PROXY` verhindert
Header-Spoofing", sondern:

> `SINGLE_REVERSE_PROXY` ist nur sicher, wenn der Ursprung **ausschliesslich**
> über den kontrollierten Reverse Proxy erreichbar ist und dieser `X-Real-IP`
> und `X-Forwarded-For` **überschreibt**.

Dasselbe gilt für `CLOUDFLARE`: `CF-Connecting-IP` verdient kein Vertrauen,
nur weil der Kopf vorhanden ist — jeder kann ihn setzen. Er verdient es erst,
wenn der Ursprung Verbindungen ausserhalb der Cloudflare-Netze verwirft.

**Die Falle, in die der alte Aufbau gelaufen ist — und die V2 vermeiden
muss.** Cloudflare war im Einsatz, und der Ursprung war trotzdem unter seiner
IP-Adresse direkt erreichbar: Eine Anfrage mit passendem `Host`-Kopf an die
Adresse des Servers wurde mit 200 beantwortet, auch mit selbst gesetztem
`X-Forwarded-For` und `X-Real-IP`. Die Messungen dazu stehen in
[`NEXT_DEVELOPMENT_AUDIT.md`](NEXT_DEVELOPMENT_AUDIT.md) S-09.

Ein Ursprung, der Anfragen auch an Cloudflare vorbei beantwortet, macht
**jeden** Modus falsch — und zwar ohne dass irgendetwas fehlschlägt:

- **`CLOUDFLARE` wäre unsicher.** Wer die IP kennt, spricht direkt mit Nginx
  und setzt `CF-Connecting-IP` selbst. Genau die Bedingung, die der Modus
  voraussetzt — „der Ursprung nimmt nur Cloudflare-Netze an" — ist nicht
  erfüllt.
- **`SINGLE_REVERSE_PROXY` wäre unsicher *und* falsch.** Unsicher, weil der
  Anwendungsport zwar gefiltert sein mag, `443` am Ursprung aber offen ist: Wer dort
  anklopft, ist für Nginx ein gewöhnlicher Client, und Nginx setzt `X-Real-IP`
  auf dessen echte Adresse — so weit korrekt. Falsch wird es für den
  regulären Weg: Kommt die Anfrage über Cloudflare, ist `$remote_addr` die
  Adresse eines Cloudflare-Knotens. Alle echten Besucherinnen erscheinen dann
  unter einer Handvoll Adressen. Rate-Limits werden dadurch beinahe global,
  und — schwerer wiegend — **das Signaturprotokoll schriebe die Adresse eines
  Cloudflare-Knotens statt die der unterzeichnenden Person.** Ein
  Beweisprotokoll, das eine fremde Adresse als die des Unterzeichners führt,
  ist schlechter als eines, das `UNAVAILABLE` sagt.
- **`NONE`** ist als einziger Modus ehrlich, kostet aber die Adressbindung der
  Rate-Limits: Alle Aufrufer teilen sich den Schlüssel `unbekannt`, und ein
  einzelner Angreifer sperrt damit alle anderen aus.

**Die Reihenfolge der Behebung ist damit vorgegeben.** Zuerst den Ursprung
schliessen — Cloud Firewall oder Nginx-Allowlist auf die Cloudflare-Netze für
`80`/`443` —, danach `real_ip_header CF-Connecting-IP` mit
`set_real_ip_from` für dieselben Netze, und **erst dann**
`TRUSTED_PROXY_MODE=CLOUDFLARE`. In umgekehrter Reihenfolge entsteht genau die
Vertrauensannahme, die `client-ip.ts` vermeiden soll.

Bis dahin bleibt `NONE` richtig. Es ist die einzige Einstellung, die keine
Aussage behauptet, die die Topologie nicht hergibt.

**13.5.2 Der Weg dorthin — Firewall-Plan, noch nicht angewendet.**

Reihenfolge ist hier alles. Wer den Modus zuerst umstellt und die Firewall
danach baut, hat in der Zwischenzeit genau die Lücke offen, die er schliessen
wollte.

**Schritt 1 — Cloudflare-Netze frisch holen.** Die Listen ändern sich. Keine
Liste aus diesem Dokument und keine aus einem älteren Skript übernehmen,
sondern zum Zeitpunkt der Änderung direkt von der offiziellen Quelle:

```bash
curl -fsS https://www.cloudflare.com/ips-v4 -o /tmp/cf-v4.txt
curl -fsS https://www.cloudflare.com/ips-v6 -o /tmp/cf-v6.txt
wc -l /tmp/cf-v4.txt /tmp/cf-v6.txt   # Plausibilität: grössenordnungsmässig 15 und 7
```

Das ist der Wartungspunkt des ganzen Aufbaus. Eine eingefrorene Liste sperrt
irgendwann echte Besucherinnen aus, und der Fehler sieht aus wie ein Ausfall
von Cloudflare. Wer die Liste pflegt und wie oft, gehört in den Betriebsplan —
ein Cron-Eintrag, der die Datei zieht und bei Änderung meldet, ist das
Minimum.

**Schritt 2 — Hetzner Cloud Firewall, neu anlegen.** Eine im Projekt
vorhandene Firewall wird **nicht** wiederverwendet und **nicht** angehängt,
nur weil sie da ist: Die im Konto liegende Regelmenge öffnete 22, 5432 und
4444 gegen `0.0.0.0/0` und wäre damit keine Firewall, sondern eine
Bestätigung. Für den V2-Server entsteht eine eigene:

| Richtung | Protokoll | Port | Quellen | Begründung |
|---|---|---|---|---|
| eingehend | TCP | **443** | die aktuellen Cloudflare-IPv4- und -IPv6-Netze | der eigentliche Zweck — der Ursprung antwortet nur noch hinter Cloudflare |
| eingehend | TCP | **80** | dieselben Netze | Cloudflare spricht den Ursprung teils auf 80 an; die 301 nach HTTPS bleibt erhalten |
| eingehend | TCP | **22** | **eigene Verwaltungsadressen, nicht Cloudflare** | Cloudflare leitet kein SSH weiter. Käme 22 in die Cloudflare-Regel, wäre der Server ausgesperrt |
| eingehend | 3000, 5432, 5433, 6379, 4444 | — | **keine Regel** | nicht freigeben. Die Hetzner Cloud Firewall verwirft alles, wofür keine Regel besteht |
| ausgehend | — | — | **unbeschränkt** | die Anwendung holt Let's-Encrypt-Erneuerungen, Paketquellen, Stripe, Resend und Twilio |

Die Hetzner Cloud Firewall ist **stateful**: Antwortpakete zu erlaubten
eingehenden Verbindungen brauchen keine eigene ausgehende Regel, und
ausgehende Verbindungen brauchen keine eingehende. Wer hier trotzdem
Rückrichtungen mitpflegt, baut sich Regeln, die nichts tun und beim nächsten
Lesen Verwirrung stiften.

**Zu Port 22 die Warnung, die dieser Aufbau verdient.** Der Zugang zum Server
hängt danach an einer Regel, die man selbst schreibt. Vor dem Anhängen der
Firewall die eigene Adresse prüfen, eine zweite Verwaltungsadresse eintragen,
wenn eine existiert, und die Hetzner-Konsole als Rückweg im Kopf behalten —
sie funktioniert unabhängig von der Firewall.

**Schritt 3 — Nginx die echte Adresse beibringen.** Erst *nachdem* die
Firewall hängt und geprüft ist:

```nginx
# Die Netze aus Schritt 1, eine Zeile je Präfix. Ausgelagert, damit ein
# Aktualisierungslauf die Datei ersetzen kann, ohne den Server-Block anzufassen.
include /etc/nginx/cloudflare-real-ip.conf;   # set_real_ip_from <präfix>; …
real_ip_header CF-Connecting-IP;
real_ip_recursive off;

proxy_set_header X-Real-IP       $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
```

Nach `real_ip_header` ist `$remote_addr` **die Adresse der Besucherin**, nicht
mehr die des Cloudflare-Knotens — das ist der ganze Punkt, und deshalb dürfen
die `proxy_set_header`-Zeilen unverändert `$remote_addr` verwenden. Weiterhin
gilt: **setzen, nicht anhängen.** `$proxy_add_x_forwarded_for` hängt den
serverseitigen Wert an einen vom Client gelieferten an, und die Anwendung liest
den ersten Eintrag — also den des Angreifers.

**Schritt 4 — Modus umstellen.** In `shared/.env` auf dem Server
`TRUSTED_PROXY_MODE=CLOUDFLARE` **und** `CLENARIS_URSPRUNG_NUR_CLOUDFLARE=bestaetigt`
setzen und neu laden (oder mit der nächsten Aktivierung). Die
Produktionsvorprüfung weist `CLOUDFLARE` ohne diese Bestätigung ab. Bis
2026-09-27 war `TRUSTED_PROXY_MODE` eine Repository-Variable, die die
Auslieferung in die `.env` übertrug; seit dem Notfallauftrag überträgt die
Pipeline keine Anwendungskonfiguration mehr (Abschnitt 14).

**Schritt 5 — nachmessen, nicht annehmen.** Der direkte Zugriff muss danach
ins Leere laufen:

```bash
# <domain> = die öffentliche Adresse, <ursprung-ip> = die IP des V2-Servers.
# `--resolve` geht bewusst an Cloudflare vorbei und spricht den Ursprung direkt an.
curl -sS --max-time 10 --resolve <domain>:443:<ursprung-ip> \
     https://<domain>/api/health
# erwartet: Zeitüberschreitung oder abgewiesene Verbindung, keine 200
```

Erst wenn dieser Aufruf **nicht** antwortet, ist `DIRECT ORIGIN HTTP/HTTPS
ACCESS: BLOCKED` eine belegte Aussage. Und erst dann stimmt, was der Modus
`CLOUDFLARE` über die Topologie behauptet.

Die Zielkette lautet dann: Internet → Cloudflare → Hetzner Cloud Firewall →
Nginx → Next.js auf Loopback.

**Invariante für den Reverse Proxy (13.5).** Der Proxy setzt beide Köpfe aus
der Socket-Adresse und reicht nichts vom Client durch — `X-Forwarded-For`
wird **gesetzt**, nicht mit `$proxy_add_x_forwarded_for` verlängert (das
hängt den serverseitigen Wert an einen vom Client gelieferten an, und die
Anwendung liest den ersten Eintrag):

```nginx
    proxy_set_header X-Real-IP       $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
```

und in die Umgebung `TRUSTED_PROXY_MODE=SINGLE_REVERSE_PROXY`. Zur Laufzeit
fällt die Anwendung ohne die Variable auf den Modus `NONE` zurück
(`src/lib/env.ts`): Rate-Limits greifen dann ohne Adressbezug (alle Aufrufer
teilen sich den Schlüssel `unbekannt`), und Prüf- wie Signaturprotokoll
tragen `ipSource = UNAVAILABLE` — die Aussage „nicht bekannt", im Protokoll
genau so ausgewiesen. In der Produktion verlangt die Produktionsvorprüfung
den Wert aber ausdrücklich (`scripts/production-preflight.ts`): Fehlt er,
hält die Aktivierung vor der Migration an (Abschnitt 3); `NONE` bewusst
gesetzt ergibt nur eine Warnung.

**Invariante für den Anwendungsport.** Der Next.js-Port (Vorgabe 3000) darf
in Produktion **nicht** aus dem Internet erreichbar sein — sonst umgeht jede
direkte Verbindung den Proxy, und mit ihr die Adressermittlung, TLS und die
Zugriffsprotokolle. Erlaubt ist ausschliesslich:

```
Internet → 443 → Reverse Proxy → 127.0.0.1:3000 (Next.js)
```

Seit Gate 4C bindet `ecosystem.config.js` Next.js nur an Loopback
(`args: 'start -H 127.0.0.1'`) — örtlich geprüft: Der Port antwortet auf
`127.0.0.1`, auf der Netzadresse der Maschine wird die Verbindung verworfen.
Nginx (`proxy_pass http://127.0.0.1:3000`) und die Identitätsprüfung der
Aktivierung (`http://127.0.0.1:<port>/api/health`, `scripts/release/umschaltung.ts`)
sprechen ohnehin Loopback an; für sie ändert sich nichts. Das ersetzt keine Host-Firewall,
macht aber den offenen Port zur Ausnahme, die jemand bewusst herstellen
müsste. Was auf dem Server *heute* läuft, ist damit nicht bewiesen — siehe
11.1: Vor dem Produktivgang von aussen prüfen, dass `:3000` nicht
erreichbar ist, und erst danach den Proxy-Modus setzen.

**13.5.3 Der Unterzeichnungsbereich.** `/signieren` und `/api/public/signatures`
brauchen keinen eigenen Proxy-Block. Zwei Dinge dürfen dort aber nicht
passieren: Der Proxy darf `Referrer-Policy` und `Cache-Control` der Anwendung
nicht überschreiben (der Bereich setzt `no-referrer` und `no-store`), und ein
Zugriffsprotokoll, das **Fragmente** aufzeichnet, gibt es nicht — Browser
schicken `#t=…` nie mit. Der rohe Zugangstoken erreicht den Server nur im
Körper von `POST /api/public/signatures/exchange`; Körper gehören in kein
Zugriffsprotokoll.

**13.6 Planmässige Aufgaben.** `vercel.json` steuert die beiden Cron-Läufe nur
auf Vercel. Im eigenen Betrieb übernimmt das die Crontab des Dienstbenutzers:

```cron
5  * * * * curl -fsS -m 300 -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/hourly >> ~/clenaris/shared/logs/cron.log 2>&1
0  5 * * * curl -fsS -m 600 -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/daily  >> ~/clenaris/shared/logs/cron.log 2>&1
```

Der Stundenlauf schliesst seit 2026-09-30 auch verwaiste Aufträge des
Release-Ausführers ab (über zwei Stunden in DEPLOYING, entschieden nach der
Identität der Instanz).

Ohne diesen Schritt bleiben Terminerinnerungen, Mahnläufe, Serienbuchungen und
der nächtliche Führungslauf aus — ohne jede Fehlermeldung.

## 14. GitHub Secrets

*Settings → Secrets and variables → Actions*, oder in der Umgebung
`production`. Im Repository steht kein einziger Zugangswert.

**Seit dem Notfallauftrag vom 2026-09-27 kennt die Pipeline nur noch, was sie
zum Verbinden braucht.** Die Anwendungsgeheimnisse (`DATABASE_URL`,
`DIRECT_URL`, `JWT_SECRET`, `CRON_SECRET`, `ENCRYPTION_KEY`) und die
Konfiguration (`TRUSTED_PROXY_MODE`, `APP_URL` …) stehen ausschliesslich in
`shared/.env` auf dem Server (13.3); der Workflow liest sie nicht und
überträgt nichts in die `.env`. Jeder Ort, der ein Geheimnis kennt, ist ein
Ort, an dem es rotiert werden muss, wenn etwas passiert. Die Zeilen unten, die
solche Werte noch nennen, sind deshalb als **nicht mehr gelesen** markiert —
diese Secrets gehören gelöscht (`docs/NOTFALL_WIEDERHERSTELLUNG.md` §3).

| Secret | Pflicht | Bedeutung |
| --- | --- | --- |
| `SERVER_HOST` | ja | Adresse des Servers. **Quelle der Wahrheit** — die Adresse steht nirgends im Repository, und das ist Absicht: Sie darf sich ändern lassen, ohne dass jemand Code anfasst. Genau deshalb kann aber auch niemand ausser Ihnen prüfen, wohin sie zeigt. Für V2 gilt: **erst die Adresse des neuen Servers eintragen, dann `DEPLOY_ENABLED` setzen** (14.2), nie umgekehrt. Eine Adresse aus dem Altbestand wird nicht weiterverwendet — auch dann nicht, wenn sie „ja noch funktioniert" |
| `SERVER_USER` | ja | Dienstbenutzer, etwa `clenaris`. Geprüft wie `SERVER_HOST`: Fehlt er, bricht der Auftrag vor der ersten Verbindung mit „Secret SERVER_USER fehlt" ab — kein Rückfall auf `root` (Schritt „SSH vorbereiten" in `deploy.yml`, seit `fb15d26` vom 2026-09-21, und in der Vorlage `deploy/v2/release-ausfuehrer.yml`). Ohne diese Prüfung ginge ein fehlender Wert als `@host` hinaus, und die Meldung zeigte aufs Netz statt auf die Konfiguration |
| `SERVER_SSH_KEY` | ja | Privater Schlüssel, vollständig samt Kopf- und Fusszeile |
| `APP_DIRECTORY` | ja | Basisverzeichnis auf dem Server, etwa `/home/clenaris/clenaris` — wird dort zu `CLENARIS_BASIS` (13.3). Ein absoluter Pfad nur aus Buchstaben, Ziffern, `.`, `_`, `/`, `-`; sonst bricht der Auftrag ab, weil der Wert Teil eines Befehls und eines `scp`-Ziels wird |
| ~~`DATABASE_URL`~~ | **nicht mehr gelesen** | gehört in `shared/.env`; Secret löschen |
| ~~`JWT_SECRET`~~ | **nicht mehr gelesen** | gehört in `shared/.env`; Secret löschen. Für den Wert selbst gilt weiter: **im laufenden Betrieb nie ändern** — ein neuer Wert meldet alle Sitzungen ab, und ohne eigenen `ENCRYPTION_KEY` hängt die Feldverschlüsselung daran. Für Production V2 wird er **neu erzeugt**, weil ein Signaturschlüssel aus einer Umgebung, die als kompromittiert gilt, kein Signaturschlüssel mehr ist |
| `SERVER_PORT` | nein | SSH-Port, Vorgabe 22 |
| `SERVER_SSH_KNOWN_HOSTS` | **ja** | Gepinnter Wirtsschlüssel. Fehlt er, **bricht die Auslieferung ab** — es gibt keinen Rückfall (13.4), und die Gestalt des Werts steht in 13.4a. Der Schlüssel des V2-Servers wird über die **Anbieterkonsole** gelesen, nicht über `ssh-keyscan`: Letzteres sagt nur, was der Gegenüber gerade anbietet, nicht ob es der richtige Gegenüber ist. Ein Eintrag aus dem Altbestand pinnt eine Maschine, die nicht mehr beliefert wird — im schlimmsten Fall eine, die inzwischen jemand anderem gehört |
| ~~`DIRECT_URL`~~ | **nicht mehr gelesen** | gehört in `shared/.env` — dort **Pflicht** (die Produktionsvorprüfung verlangt sie). **Stand seit Prisma 7 (2026-09-29):** `schema.prisma` deklariert keine Adresse mehr; `prisma.config.ts` nimmt `DIRECT_URL`, sonst `DATABASE_URL`, und `prisma generate` und der Bau brauchen keine Adresse. Hinter einem Pooler im Transaktionsmodus muss sie am Pooler vorbeiführen, denn `migrate` verträgt dessen Sperrverhalten nicht |
| `API_URL` | **abgelöst** | Wandert nach *Variables* (14.2): Die öffentliche Adresse ist Konfiguration, kein Geheimnis. Der Workflow liest `vars.API_URL` und fällt für den Übergang auf das Secret zurück; sobald die Variable steht, wird das Secret gelöscht |
| ~~`ENCRYPTION_KEY`~~ | **nicht mehr gelesen** | gehört in `shared/.env` — dort Pflicht (64 Hex, verschieden von `JWT_SECRET`) |
| ~~`CRON_SECRET`~~ | **nicht mehr gelesen** | gehört in `shared/.env` — dort Pflicht (mindestens 32 Zeichen) |
| `RELEASE_EXECUTOR_TOKEN`, `RELEASE_EXECUTOR_SIGNING_KEY` | nur für den Release-Ausführer | in der Umgebung `production`, je mindestens 32 Zeichen und verschieden; dieselben Werte in `shared/.env` der Instanz. Ohne sie bleibt die Ausführerschnittstelle zu (401/503) |

**Bestehende Werte nicht ohne Not neu erzeugen.** Für vier Werte in
`shared/.env` ist ein frischer Wert keine Hygienemassnahme, sondern ein
Eingriff mit Folgen:

| Wert | Was ein neuer Wert anrichtet |
|---|---|
| `DATABASE_URL` | zeigt auf eine andere Datenbank oder scheitert. Nur ändern, wenn sich Zugangsdaten oder Ziel tatsächlich geändert haben |
| `JWT_SECRET` | alle bestehenden Sitzungen sind sofort ungültig — und alle Verschlüsselungswerte, falls kein eigener `ENCRYPTION_KEY` gesetzt ist |
| `CRON_SECRET` | die Cron-Einträge auf dem Server tragen den alten Wert; die planmässigen Aufgaben scheitern danach still mit 401 |
| `ENCRYPTION_KEY` | **der gefährlichste.** `src/lib/crypto.ts` kennt keine Schlüsselrotation und keinen Zweitschlüssel-Lesepfad (S-08). Sind bereits TOTP-Geheimnisse, AHV-Nummern oder Alarmcodes verschlüsselt, macht ein neuer Wert sie unlesbar — nicht ungültig, sondern unwiederbringlich. Nur setzen, solange noch kein solcher Wert geschrieben ist |

Für alle vier gilt: Wenn sie heute gesetzt und funktionsfähig sind, bleiben sie
stehen.

**Zwei Namen aus der Anforderung gibt es hier nicht.**

- `NEXTAUTH_SECRET` — das Projekt benutzt NextAuth nicht. Die Anmeldung läuft
  über eigene, signierte Tokens (`src/lib/auth/`); der Schlüssel dafür heisst
  `JWT_SECRET`. Ein zusätzliches `NEXTAUTH_SECRET` wäre eine Variable, die
  nichts tut, und genau solche Variablen verwirren später bei der Fehlersuche.
- `API_URL` — die Anwendung kennt keine getrennte Schnittstellenadresse, weil
  Oberfläche und Schnittstelle unter derselben Adresse laufen. Bis 2026-09-27
  wurde der Wert auf dem Server auf `APP_URL` abgebildet; heute dient er nur
  noch der Pipeline: für die Frage, ob der Commit schon als anderer Bau läuft,
  und für die Identitätsprüfung von aussen. `APP_URL` steht in `shared/.env`.

**14.2 Repository-Variablen — Konfiguration, keine Geheimnisse.**

*Settings → Secrets and variables → Actions → **Variables***. Der Unterschied
ist nicht kosmetisch: Ein Secret wird in Protokollen maskiert und lässt sich
nicht wieder anzeigen, eine Variable schon. Für einen Wert, der ohnehin
öffentlich sein darf, ist die Maskierung kein Gewinn, sondern verhindert nur,
dass man im Protokoll sieht, was gesetzt war.

| Variable | Pflicht | Bedeutung |
| --- | --- | --- |
| `DEPLOY_ENABLED` | **Schalter** (direkter Weg) | `true` schaltet den Auslieferungsauftrag ein. Jeder andere Wert und jede nicht gesetzte Variable lassen ihn **übersprungen** — fail-closed. Das Qualitätstor läuft davon unberührt bei jedem Push, jedem Pull Request und jedem Handstart. **Erst setzen, wenn der V2-Server steht und `SERVER_HOST`, `SERVER_SSH_KEY` und `SERVER_SSH_KNOWN_HOSTS` auf ihn zeigen.** Ohne diesen Schalter wäre der erste grüne Lauf zugleich eine Auslieferung an das Ziel, das die bestehenden Secrets gerade nennen — und niemand hätte sie ausgelöst |
| `RELEASE_EXECUTOR_ENABLED` | **Schalter** (nur Release-Ausführer) | `true` schaltet den Release-Ausführer ein, sobald seine Vorlage unter `.github/workflows` liegt; sonst fail-closed übersprungen. Dieselbe Regel wie bei `DEPLOY_ENABLED`: erst setzen, wenn der V2-Server steht. Beide Schalter zugleich ist nicht der vorgesehene Zustand (Abschnitt 12) |
| `CLENARIS_URL` | nur Release-Ausführer | Herkunft der Instanz, deren Ausführerschnittstelle der Ausführer anspricht |
| `API_URL` | empfohlen | Öffentliche Adresse der Anwendung, etwa `https://<domain>`. Trägt die Frage „läuft dieser Commit schon als anderer Bau?" und die Identitätsprüfung von aussen (`version`, `buildId`, `identitaet`). Steht sie nicht, fällt der Workflow für den Übergang auf das gleichnamige Secret zurück; fehlt beides, entfällt die Prüfung von aussen mit einer Warnung — bindend ist die Identitätsprüfung auf dem Server |
| ~~`TRUSTED_PROXY_MODE`~~ | **nicht mehr gelesen** | gehört in `shared/.env` und ist dort **Pflicht**: Die Produktionsvorprüfung bricht ab, wenn der Wert fehlt oder unbekannt ist, und weist `CLOUDFLARE` ohne `CLENARIS_URSPRUNG_NUR_CLOUDFLARE=bestaetigt` ab. Bis 2026-09-27 übertrug die Auslieferung die Variable in die `.env` |

**Warum die Prüfung auf den unbekannten Wert wichtiger ist als die Variable
selbst.** `src/lib/http/client-ip.ts` fällt bei jedem nicht erkannten Wert auf
`NONE` zurück. Im Anfragepfad ist das genau richtig — lieber keine Adresse als
eine erfundene. Als Betriebszustand wäre es eine Falle: Aus `CLOUDFARE`
würde lautlos „kein Proxy bekannt", alle Aufrufer teilten sich ab sofort einen
Rate-Limit-Schlüssel, und niemand erführe davon. Die Produktionsvorprüfung
lässt deshalb nur die drei Namen durch.

**GitHub verwaltet nur die Verbindung.** Alle Anwendungswerte — Datenbank,
Schlüssel, Stripe, Resend, Twilio, Supabase, Maps, Firmenangaben, Proxy-Modus,
Besuchsmessung — stehen in `shared/.env` auf dem Server, und die Pipeline
fasst diese Datei nicht an. Bis 2026-09-27 führte `deploy.sh` einzelne Werte
aus den Secrets ein; das ist mit dem Artefaktweg entfallen.

## 15. Ablauf einer Auslieferung

`main` ist geschützt und nimmt keinen direkten Push mehr an. Der Weg führt
über einen Arbeitszweig und einen Pull Request:

```bash
git switch -c arbeit/beschreibung
git add .
git commit -m "Beschreibung"
git push -u origin arbeit/beschreibung
# Pull Request gegen main öffnen — das Qualitätstor läuft darauf.
```

Ist der Pull Request grün, wird er zusammengeführt. Der Push auf `main`, der
dabei entsteht, löst denselben Workflow ein zweites Mal aus — diesmal mit dem
Auslieferungsauftrag, sofern `DEPLOY_ENABLED` auf `true` steht. Unter
*Actions* läuft der Fortschritt mit.

Dass das Qualitätstor zweimal läuft, ist kein Versehen: Der Pull Request
prüft den *zusammengeführten* Stand, wie GitHub ihn erzeugt; der Lauf auf
`main` prüft, was tatsächlich dort gelandet ist. Zwischen beiden kann ein
zweiter Pull Request liegen.

**Von Hand auslösen.** *Actions → Auslieferung → Run workflow* auf `main` —
ohne Eingaben (die früheren Schalter `seed` und `skip_rollback` gehörten zu
`scripts/deploy.sh` und sind seit 2026-09-27 entfallen; eine Aktivierung
seedet nie und springt bei nicht bestätigter Identität immer zurück). Ein
Handstart baut denselben Commit ein zweites Mal, mit neuer Build-ID; läuft
der Commit schon, wird nichts übertragen und der Auftrag endet grün mit einem
Hinweis (Frage über `API_URL`; ohne sie meldet die Aktivierung den Fall mit
Ausgang 10). Nur ein Handstart löst auch den Auftrag `reproduzierbarkeit` aus.

**Direkt auf dem Server ausliefern gibt es nicht mehr.** `scripts/deploy.sh`
bricht ab. Wer ohne GitHub aktivieren muss, braucht ein in der CI gebautes
Artefakt samt Summe aus der Zusammenfassung des Laufs und ruft die
Aktivierung von Hand auf:

```bash
CLENARIS_BASIS=/home/clenaris/clenaris \
  bash <eingang>/release-aktivieren.sh <eingang>/clenaris-<sha12>.tar.gz --erwartet-sha256 <64 Hex>
```

Das Skript kommt aus dem Archiv selbst (`tar -xzOf <archiv>
deploy/v2/release-aktivieren.sh`), nie aus `current/`.

**Die Aktivierung (Vertrag C3)** prüft, entpackt und schaltet in dieser
Reihenfolge: Sperre `${BASIS}/.release.lock` → Summe (erwartet = gemessen =
`.sha256`, an einer privaten Kopie) → Manifest (Format 2, auslieferbar, Node-
Hauptversion) → frisch entpacken, `BUILD_ID` = Manifest → Korrekturen RB-001
und RB-002 → Produktionsvorprüfung vor der Migration → bei offenen Migrationen
Vorprüfung der Eindeutigkeiten, geprüfte Sicherung, `migrate deploy` →
Vorprüfung ohne offene Migration → Umschalten mit Identitätsprüfung (drei
bestätigende Antworten in Folge: `version` = Commit, `buildId` = Manifest,
`identitaet` = `belegt`) → Archiv nach `archiv/` → Aufbewahrung. Einzelheiten
und Begründungen: `docs/PRODUCTION_V2.md` §2.

| Ausgang | Zustand | Was zu tun ist |
| --- | --- | --- |
| 0 | `AKTIV` | nichts — die neue Fassung läuft und belegt ihre Identität |
| 10 | `NICHT_UMGESCHALTET` | Grund im Protokoll; `current` ist unverändert. **Migrationen können angewandt sein** — das Protokoll sagt es (`migration` in `aktivierungen.jsonl`) |
| 11 | `GESPERRT` | eine andere Aktivierung oder ein Rücksprung läuft; abwarten, erneut auslösen. Die Sperre gibt `flock` mit dem Prozess frei — keine Datei löschen |
| 20 | `ZURUECK` | die neue Fassung hat ihre Identität nicht bestätigt; die vorherige läuft **nachweislich** wieder. Nichts ausgeliefert; Ursache in `pm2 logs` und `/api/health` der neuen Fassung suchen |
| 30 | `UNKLAR` | sofort von Hand prüfen: `readlink -f current`, `pm2 ls`, `/api/health`; notfalls Rücksprung (Abschnitt 16) |

Die letzte Zeile der Ausgabe ist immer `ERGEBNIS {"code":…,"zustand":"…","commit":"…"}`;
der Workflow deutet den Ausgang einzeln und meldet ihn mit Klartext.

**Ohne Ausfallzeit, soweit PM2 mitspielt.** PM2 lädt die Anwendung aus dem
neuen Release-Verzeichnis neu; übernimmt eine PM2-Fassung das neue
Arbeitsverzeichnis beim Neuladen nicht, wird die Anwendung aus dem Release neu
gestartet — eine kurze Unterbrechung statt einer stillen alten Fassung (auf
einem echten Server noch nicht beobachtet, `docs/PENDENZEN.md` P2H-20).
Angemeldete Benutzer bleiben angemeldet, weil die Sitzung in einem signierten
Token im Cookie steckt und nicht im Arbeitsspeicher des Prozesses — solange
`JWT_SECRET` gleich bleibt, ist jeder Arbeiter für jede Sitzung zuständig.

**Migrationen** laufen nur, wenn `prisma migrate status` welche findet — und
nur nach der Vorprüfung und einer geprüften Sicherung (Abschnitt 1).

**Protokolle:** der Lauf in GitHub Actions (mit Prüfsumme und Kurzfassung der
Beilage in der Zusammenfassung), `${BASIS}/aktivierungen.jsonl` (eine Zeile je
Aktivierung und Rücksprung: Zeit, Art, von, nach, Code, Zustand, Migration)
und `shared/logs/` für PM2.

## 16. Rücksprung

Bis 2026-09-27 sprang `scripts/deploy.sh` per `git reset --hard`, `npm ci` und
Neubau zurück — auf dem Server, ungeprüft. Heute gibt es zwei Rücksprünge,
und keiner baut etwas:

**Automatisch, während einer Aktivierung.** Bestätigt die neue Fassung ihre
Identität nicht (drei Antworten in Folge mit Commit, Build-ID und `belegt`),
schaltet die Aktivierung `current` auf die vorherige Fassung zurück und prüft
**diese** genauso. Gelingt das: Ausgang 20 (`ZURUECK`); sonst 30 (`UNKLAR`).
Ein Rücksprung, der nur behauptet wird, ist keiner.

**Von Hand, später** — wenn sich ein Fehler erst nach Stunden zeigt:

```bash
CLENARIS_BASIS=/home/clenaris/clenaris \
  bash ~/clenaris/current/deploy/v2/release-ruecksprung.sh \
    --auf <Commit, 40 Hex> --erwartet-sha256 <64 Hex> [--port 3000] [--schema-bewusst]
```

1. Die Hülle hält dieselbe Sperre wie die Aktivierung (besetzt → 11) und
   startet `scripts/release-ruecksprung.ts` aus dem **laufenden** Release.
2. Zurück geht es nur auf ein Archiv unter `${BASIS}/archiv/`: Seine Summe
   muss der erwarteten **und** der `.sha256` daneben entsprechen, sein
   `RELEASE.json` genau `--auf` nennen, seine Node-Hauptversion der des
   Servers. Die erwartete Summe kommt aus der Zusammenfassung des CI-Laufs
   oder aus dem Release Center (`Release.artifactSha256`) — nicht vom Server,
   denn eine Summe neben dem Archiv kann tauschen, wer das Archiv tauschen kann.
3. Entpackt wird frisch aus einer privaten Kopie; umgeschaltet und geprüft
   wird wie bei der Aktivierung. Ausgänge 0/10/11/20/30, `ERGEBNIS`-Zeile,
   Eintrag in `aktivierungen.jsonl`. Ist das Ziel schon aktiv: 10, nichts zu tun.

Aufbewahrt werden die letzten `CLENARIS_RELEASES_KEEP` Releases (Vorgabe 5,
mindestens 2, nie das aktive und nie das vorherige) und ihre Archive; weiter
zurück geht es nur mit einem neu gelieferten Artefakt.

> **Der Rücksprung stellt die Anwendung wieder her, nicht das Datenbankschema.**
>
> Prisma kennt keine Abwärtsmigration, und eine automatisch erzeugte wäre
> gefährlicher als der Fehler, den sie beheben soll — sie verwürfe Daten, die
> die neue Fassung bereits geschrieben hat. Wurden in einem fehlgeschlagenen
> Lauf Migrationen angewandt, bleiben sie bestehen, und das Protokoll sagt es
> ausdrücklich. Der Rücksprung von Hand fragt deshalb, welche Migrationen des
> laufenden Release das Ziel **nicht** kennt, und liest ihre Einstufung aus
> `security/migrations-vertraeglichkeit.json` des laufenden Release: Alles
> ausser RUECKWAERTSVERTRAEGLICH (auch eine fehlende Einstufung) hält an —
> ausser mit `--schema-bewusst`, und das steht dann im Protokoll.
>
> Daraus folgt die Regel für **jede** Migration: Sie muss zur *vorherigen*
> Programmfassung passen. Spalte hinzufügen statt umbenennen; `NOT NULL` erst
> in einem zweiten Schritt, wenn die alte Fassung nicht mehr läuft; Spalten
> löschen erst eine Auslieferung später. Wer das einhält, kann jederzeit
> zurückspringen. Wer es verletzt, hat nach einem Rücksprung eine Anwendung,
> die gegen ein Schema läuft, das sie nicht kennt.
>
> Die bestehende Regel aus `CLAUDE.md` gilt unverändert: **niemals**
> `prisma migrate reset`. Der nicht-zerstörende Weg ist
> `prisma migrate diff` → SQL-Datei → `prisma db execute` →
> `prisma migrate resolve --applied`.

Was **nie** zum Rücksprung gehört: `git`, `npm ci`, `npm run build`, ein von
Hand umgehängter `current`-Verweis ohne Prüfung oder `prisma migrate reset`.
Ein Rücksprung, der etwas erzeugt, statt ein Geprüftes wiederherzustellen,
ist der Weg, den der Notfallauftrag abgeschafft hat.

## 17. Wiederherstellung

| Lage | Vorgehen |
| --- | --- |
| Anwendung antwortet nicht | `pm2 status`, `pm2 logs clenaris --lines 100`, dann `pm2 reload clenaris` |
| Nach einem Serverneustart ist nichts gestartet | `pm2 resurrect`; fehlt der Dienst dauerhaft, `pm2 startup` nachholen |
| Datenbank nicht erreichbar | `/api/health` meldet 503. Postgres und `DATABASE_URL` prüfen; die Anwendung fängt sich von selbst, sobald die Datenbank antwortet |
| `shared/.env` verloren | Aus Abschnitt 3 neu aufbauen — die Pipeline führt seit 2026-09-27 keine Kopie mehr; die Werte stehen bei den Anbietern bzw. im Passwortverwalter der Betreiberin. `ENCRYPTION_KEY` vorher sichern (Abschnitt 3) |
| Aktives Release-Verzeichnis zerschossen | mit `release-ruecksprung.sh --auf <vorheriger Commit> --erwartet-sha256 <Summe>` auf das vorherige, aufbewahrte Archiv zurück (Abschnitt 16), danach einen neuen Commit ausliefern. Derselbe Commit wird weder erneut aktiviert (bestätigt die Instanz ihre Identität nicht, endet die Aktivierung mit 10, sonst mit 0 „nichts zu tun") noch als Rücksprungziel angenommen (10). Der Rücksprung startet sein Werkzeug aus dem aktiven Release — fehlen dort `scripts/release-ruecksprung.ts` oder `tsx`, verweigert er (10), und es bleibt nur die Auslieferung eines neuen Commits. Nie auf dem Server bauen |
| Nicht aktives Release-Verzeichnis zerschossen | nichts zu tun: Die nächste Aktivierung und jeder Rücksprung entpacken ihr Ziel frisch aus dem Archiv und ersetzen ein vorhandenes Verzeichnis |
| Server vollständig verloren | Abschnitt 13 neu durchlaufen, Datenbank aus der Sicherung einspielen (`docs/BACKUP_DR.md`), dann den Workflow von Hand auslösen |

Die Anwendung hält **keinen** Zustand ausser Datenbank und Dateiablage. Ein
neuer Server ist deshalb ein Nachmittag Arbeit und kein Datenverlust —
vorausgesetzt, die Sicherung aus Abschnitt 9 existiert und wurde einmal
geprüft.

## 18. Fehlerbehebung

| Symptom | Ursache | Abhilfe |
| --- | --- | --- |
| Prüfauftrag bricht bei „Anwendung starten" ab | Build oder Migration in CI fehlgeschlagen | Artefakt `server-log` im Lauf herunterladen |
| `Kein Server unter http://localhost:3000 erreichbar` | Health Check kam nicht hoch | `server.log` prüfen; meist fehlt eine Umgebungsvariable |
| Dokumentationsschritt scheitert | `npm run docs` wurde nicht mitgeliefert | Lokal ausführen, Ergebnis committen |
| Geheimnis-Suche schlägt an | Zugangsdaten im Bestand | Beim Anbieter widerrufen, dann aus der Historie entfernen. Das Entfernen allein genügt nicht |
| `Permission denied (publickey)` | Schlüssel oder Benutzer falsch | `SERVER_SSH_KEY` vollständig (mit Kopf- und Fusszeile), öffentlicher Teil in `~/.ssh/authorized_keys` |
| `Host key verification failed` | Wirtsschlüssel geändert | `SERVER_SSH_KNOWN_HOSTS` neu erzeugen — und prüfen, *warum* er sich geändert hat |
| Aktivierung endet mit 11 (`GESPERRT`) | Eine Aktivierung oder ein Rücksprung hält `${BASIS}/.release.lock` | abwarten; `flock` gibt die Sperre mit dem Prozess frei — die Datei nicht löschen. Hält sie dauerhaft, hat ein Kindprozess den Deskriptor geerbt (`fuser`/`lsof` auf die Datei) |
| Aktivierung endet mit 10: „SHA-256 … ist nicht die erwartete" | Archiv unterwegs verändert oder falsche Summe übergeben | nicht umgehen — das Archiv ist nicht das geprüfte; neu übertragen bzw. Summe aus der CI-Zusammenfassung nehmen |
| Aktivierung endet mit 10: „Node-Hauptversion weicht vom Bau ab" | Server und CI haben verschiedene Node-Hauptversionen | Node auf dem Server an `.nvmrc` angleichen (V2-2) |
| Aktivierung endet mit 10: „Derselbe Commit … läuft bereits, aber als anderer Bau" | Handstart hat den laufenden Commit neu gebaut | nichts — der laufende Bau bleibt; ohne `API_URL` erkennt der Workflow den Fall nicht vorab |
| Identität von aussen meldet den alten Commit oder `identitaet` ≠ `belegt` | PM2 hat nicht aus dem neuen Release geladen, oder ein Proxy-Zwischenspeicher | `pm2 describe clenaris` (Arbeitsverzeichnis), `pm2 logs`; die Aktivierung hätte das mit 20 oder 30 gemeldet — Protokoll prüfen |
| `EACCES` beim Schreiben | Verzeichnis gehört `root` | `sudo chown -R clenaris:clenaris ~/clenaris` |
| Build bricht mit Speichermangel ab | nur in der CI — der Server baut nicht | Läuferlast prüfen; auf dem Server gibt es keinen Bau |

## 19. Wartung und Versionsverwaltung

**Welcher Stand läuft?** Die Instanz belegt ihn selbst — aus `RELEASE.json`
und `.next/BUILD_ID` in ihrem Release-Verzeichnis (`src/lib/release/identitaet.ts`),
nicht aus einer Umgebungsvariable. Bis 2026-09-27 schrieb `deploy.sh` den
Commit als `APP_VERSION` in die `.env`, bis 2026-09-30 setzte ihn die
Aktivierung über PM2 — geprüft wurde in beiden Fällen genau der Wert, den der
Weg selbst gesetzt hatte. `APP_VERSION` wird nirgends mehr gelesen.

```bash
curl -fsS https://<domain>/api/health | jq '.data | {version, buildId, release, identitaet}'
```

`version` ist der Commit — nur wenn `identitaet` `belegt` ist, sonst `null`;
`buildId` steht in jedem Zustand da. Aktivierung und Workflow prüfen nach jeder
Auslieferung Commit, Build-ID und `belegt`. Genau das fängt den
unangenehmsten Fehler: ein Neuladen, das still nicht greift und weiter die
alte, gesunde Fassung ausliefert — grün, und trotzdem ist nichts angekommen.

**Regelmässig.**

| Rhythmus | Aufgabe |
| --- | --- |
| wöchentlich | `pm2 status`, `aktivierungen.jsonl` und `shared/logs/` durchsehen |
| monatlich | Datenbankauszug an einen zweiten Ort (Abschnitt 9) |
| monatlich | `npm audit`, Abhängigkeiten aktualisieren, über die Pipeline ausliefern |
| vierteljährlich | Wiederherstellung üben |
| jährlich | SSH-Schlüssel und `CRON_SECRET` erneuern — **nicht** `JWT_SECRET`, das meldet alle ab |

**Protokolle rotieren**, sonst füllt PM2 die Platte:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
```

Releases und ihre Archive räumt die Aktivierung selbst auf
(`CLENARIS_RELEASES_KEEP`, Vorgabe 5, nie das aktive und nie das vorherige);
`aktivierungen.jsonl` wächst um eine Zeile je Lauf und wird nicht gekürzt.

**Versionen.** Mit dem direkten Weg (`DEPLOY_ENABLED`) geht jeder grüne Commit
auf `main` in Produktion; mit dem Release-Ausführer nur, was im Update Center
freigegeben und terminiert ist. Wer einen benannten Stand braucht — für eine
Übergabe, einen Prüfbericht, eine Rechnungsperiode —, setzt eine Marke:

```bash
git tag -a v1.2.0 -m "Buchungsbestätigung als PDF"
git push origin v1.2.0
```

Die Marke ändert an der Auslieferung nichts; sie macht einen Commit später
auffindbar.

**Erledigt seit Production V2.** Hier stand als Empfehlung, den Prüfauftrag
zusätzlich für Pull Requests auszulösen. Das ist geschehen: Der Workflow
trägt den Auslöser `pull_request` gegen `main`, und der Auslieferungsauftrag
schliesst Pull Requests ausdrücklich aus. Was noch aussteht, ist die andere
Hälfte — den Prüfauftrag in den Schutzregeln von `main` als **erforderlich**
zu hinterlegen. Ein Auslöser sagt, dass geprüft *wird*; erst die Schutzregel
sagt, dass ohne grüne Prüfung nicht zusammengeführt werden *darf*.
