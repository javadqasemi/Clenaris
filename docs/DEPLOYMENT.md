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
| Quelle der Wahrheit | **GitHub `main`** im Repository `javadqasemi/Clenaris`. Der Server zieht ausschliesslich von dort |
| Repository | **privat.** Der Server braucht deshalb einen eigenen, nur lesenden Deploy-Key (13.3) |
| Auslieferung | **GitHub Actions**, Qualitätstor und Auslieferung getrennt (Teil II) |
| Wirtsschlüssel | **gepinnt, Pflicht.** Kein `ssh-keyscan`-Rückfall, kein Vertrauen beim ersten Kontakt (13.4) |
| `SERVER_USER` | **Pflicht.** Kein Rückfall auf `root` (14) |
| `DIRECT_URL` | **Empfohlen bei Pooling.** Seit Prisma 7 steht die Adresse nicht mehr in `schema.prisma`, sondern in `prisma.config.ts`: Die Kommandozeile (`migrate deploy`) nimmt `DIRECT_URL`, sonst `DATABASE_URL`. Hinter einem Pooler im Transaktionsmodus (PgBouncer, Supabase :6543) muss sie gesetzt sein und am Pooler vorbeiführen — `migrate` verträgt dessen Sperrverhalten nicht. Die Laufzeit liest nur `DATABASE_URL` (14) |
| HTTP-Eingang | **nur über Cloudflare.** Der Ursprung nimmt auf 80/443 nur Cloudflare-Netze an (13.5.2) |
| Secrets | **keine Übernahme aus dem Altbestand.** Neu erzeugen oder beim Anbieter rotieren (14) |

Die Anwendung selbst ist an keinen Anbieter gebunden: sie braucht Node ≥ 20.11,
ein PostgreSQL ≥ 16 und einen S3-kompatiblen Speicher — ohne den fällt sie auf
einen lokalen Postgres-Blob-Treiber zurück.

> **HISTORICAL — Vercel.**
> Die Abschnitte 4 (`vercel --prod`), 7 (Vercel Cron) und 8 (DNS auf Vercel)
> beschreiben einen **früheren** Betriebsweg und gelten für V2 **nicht**. Sie
> bleiben stehen, weil `vercel.json` noch im Repository liegt und die
> Abschnitte erklären, was diese Datei tut; ersetzt werden sie durch
> Abschnitt 13 (eigener Server), 13.6 (Crontab) und die Cloudflare-Kette
> oben. Die Abschnitte 1 bis 3, 5, 6 und 9 bis 11 gelten unverändert für
> beide Wege — sie handeln von Datenbank, Speicher, Konfiguration, Stripe,
> E-Mail, Sicherung und Betrieb, nicht vom Anbieter.

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

Vor dem Seed in Produktion `SEED_ADMIN_EMAIL` und `SEED_ADMIN_PASSWORD` setzen
— sonst entsteht ein Administrationskonto mit den Demo-Zugangsdaten aus dem
Repository. Der Seed bricht in der Produktion ab, wenn sie fehlen.

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
| A6 | Default-Branch ist `main` | **offen** | siehe Betreiberliste unten |
| A7 | `main` gegen Force-Push und Löschen geschützt, CI als Pflichtprüfung | **offen** | dito |
| A8 | Repository privat | **offen** | dito |
| A9 | Umgebung `production` nimmt nur `main` an | **offen** | dito |
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
| B7 | Eigener, nur lesender Deploy-Key für das private Repository | offen |
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
Sie stehen deshalb als *offen*, nicht als *erledigt* — auch dann, wenn die
Arbeit getan ist.

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

**Was jetzt passiert.** Meldet `prisma migrate status` offene Migrationen,
läuft vor `migrate deploy` zwingend:

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
| **Ablageort** | `CLENARIS_BACKUP_DIR`, Vorgabe `<über der Anwendung>/backups/clenaris-db`. Bewusst **ausserhalb** des Anwendungsverzeichnisses: Dort räumen `git reset --hard` und die Aufbewahrung der Build-Sicherungen. Wer `/var/backups/clenaris/database` will, gibt dem Dienstbenutzer Schreibrecht und setzt die Variable. |
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
# Sicherung von Hand, etwa vor einem Eingriff:
APP_DIRECTORY=/home/clenaris/app npx tsx scripts/db-backup.ts --grund manuell

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
nicht migriert und nicht ausgeliefert; der laufende Stand bleibt unberührt.
Scheitert die Migration selbst, bricht die Auslieferung ab, bevor gebaut oder
neu geladen wird — die Anwendung läuft weiter auf dem alten Build, und die
Sicherung von eben liegt bereit. Scheitert der Health Check, springt die
Auslieferung auf den vorherigen Commit und den gesicherten Build zurück; das
Schema bleibt, wie die Migration es hinterlassen hat.

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

Im eigenen Betrieb stehen sie in der `.env` des Servers (13.3); die von
GitHub verwalteten führt die Auslieferung dort ein (14). Pflicht in
Produktion:

```
DATABASE_URL
DIRECT_URL
JWT_SECRET                 openssl rand -base64 48
APP_URL                    https://<produktionsadresse>   (Laufzeit)
CRON_SECRET                openssl rand -hex 32
ENCRYPTION_KEY             openssl rand -hex 32   (genau 64 Hex-Zeichen)
```

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
REDIS_URL                          Rate-Limits über Instanzgrenzen hinweg
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
RESEND_API_KEY
EMAIL_FROM
ANTHROPIC_API_KEY
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
GOOGLE_MAPS_SERVER_KEY
TRUSTED_PROXY_MODE                 NONE | SINGLE_REVERSE_PROXY | CLOUDFLARE — siehe 13.5.1
```

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

**Was beobachten.**

- 5xx-Rate auf `/api/webhooks/stripe` — dort steht Geld dahinter.
- Dauer von `/api/cron/daily`; nähert sie sich 60 Sekunden, muss der Lauf
  aufgeteilt werden.
- Verbindungsanzahl der Datenbank. Bei Pooling gehört `connection_limit=1` in
  die `DATABASE_URL`, sonst erschöpfen parallele Functions den Pool.
- 429-Antworten. Häufen sie sich für angemeldete Konten, sind die Klassen zu
  eng gefasst.

**Wenn etwas klemmt.**

| Symptom | Ursache | Abhilfe |
| --- | --- | --- |
| Build bricht beim Vorrendern ab | keine DB-Verbindung während des Builds | `DATABASE_URL` auch für die Build-Umgebung setzen |
| „Too many connections" | Pooling ohne Limit | `?pgbouncer=true&connection_limit=1` |
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

Ab hier geht es um den Weg ohne Vercel: Ein Push auf `main` baut, prüft und
liefert aus, ohne dass jemand eingreift.

## 12. Architektur der Pipeline

```
Entwicklung
    │  Arbeitszweig → Pull Request gegen main
    ▼
GitHub Actions  ── .github/workflows/deploy.yml
    │
    ├─ Auftrag 1: Prüfung          läuft bei PR · Push auf main · Handstart
    │     Linter · TypeScript · Geheimnis-Suche · Dokumentation
    │     PostgreSQL 16 starten · Migrationen · Demodaten
    │     Build · Anwendung starten · vollständige Testreihe · Browser
    │
    └─ Auftrag 2: Auslieferung     NUR bei Push auf main oder Handstart,
          │                        NIE aus einem Pull Request,
          │                        und nur bei DEPLOY_ENABLED = true
          │                        (needs: Auftrag 1 grün)
          Secrets über SSH ablegen
          scripts/deploy.sh auf dem Server
             ├─ Sicherung von Build und .env
             ├─ git fetch · git reset --hard origin/main
             ├─ npm ci
             ├─ prisma generate · Vorprüfung · DB-Sicherung · migrate deploy
             ├─ npm run build
             ├─ pm2 reload  (ohne Ausfallzeit)
             ├─ Health Check lokal  ──┐ schlägt fehl → Rücksprung
             └─ Aufräumen             │
          Health Check von aussen  ───┘  prüft zusätzlich den Commit
```

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

**Beteiligte Dateien.**

| Datei | Aufgabe |
| --- | --- |
| `.github/workflows/deploy.yml` | Prüfung und Auslieferung. Auslöser: `pull_request` gegen `main`, `push` auf `main`, `workflow_dispatch` |
| `scripts/deploy.sh` | Auslieferung auf dem Server; idempotent, mit Rücksprung |
| `scripts/ci-secret-scan.sh` | Sucht Zugangsdaten im verfolgten Bestand |
| `ecosystem.config.js` | PM2: Cluster-Modus, zwei Instanzen, Reload ohne Ausfallzeit |
| `src/app/api/health/route.ts` | `GET /api/health` — Betriebsbereitschaft samt Datenbank |
| `.nvmrc` | Node-Hauptversion für CI und Server |

## 13. Server einrichten (einmalig)

Voraussetzungen: Debian oder Ubuntu, erreichbares PostgreSQL ≥ 16, eine Domain
mit Zertifikat.

**13.1 Dienstbenutzer.** Die Auslieferung läuft nie als `root`; `deploy.sh`
bricht ab, wenn sie es täte. Ein eigener Benutzer begrenzt den Schaden eines
kompromittierten Schlüssels auf das Anwendungsverzeichnis.

```bash
sudo adduser --disabled-password --gecos "" clenaris
sudo -iu clenaris
```

**13.2 Node und PM2.**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git curl
sudo npm install -g pm2
```

**13.3 Repository und Umgebung.**

Das Repository ist **privat**. Ein anonymes `git clone` über HTTPS scheitert
deshalb — der Server braucht einen eigenen Zugang, und zwar einen, der nur
lesen darf und nur für diesen Server gilt:

```bash
# Auf dem Server, als Dienstbenutzer: Schlüsselpaar nur für das Holen des Codes.
ssh-keygen -t ed25519 -C "clenaris-deploy-key-v2" -f ~/.ssh/id_repo -N ""
cat ~/.ssh/id_repo.pub
```

Den öffentlichen Teil in GitHub unter *Settings → Deploy keys → Add deploy
key* eintragen, **ohne** „Allow write access". Ein Deploy-Key gilt für genau
ein Repository; ein persönliches Zugriffstoken gälte für alle und wäre auf
einem Server der falsche Schlüssel.

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-clenaris
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_repo
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config

cd ~ && git clone github-clenaris:javadqasemi/Clenaris.git app && cd app
cp .env.example .env && chmod 600 .env
```

`IdentitiesOnly yes` ist kein Zierrat: Ohne die Zeile bietet `ssh` der
Gegenstelle der Reihe nach jeden Schlüssel an, den der Agent kennt — und
GitHub nimmt den ersten, der passt. Welches Repository der Server dann
erreicht, hängt davon ab, welcher Schlüssel zuerst dran war.

`deploy.sh` ruft später `git fetch origin main` auf und benutzt genau diesen
Weg; ein Wechsel der Adresse gehört deshalb in `git remote set-url`, nicht in
den Workflow.

`.env` jetzt vollständig ausfüllen — **alle** Werte aus Abschnitt 3, nicht nur
die aus den GitHub Secrets. Die Pipeline führt später nur die von GitHub
verwalteten Schlüssel ein und lässt den Rest unangetastet; was hier fehlt,
fehlt dauerhaft.

```bash
npm ci
npm run db:deploy
SEED_ADMIN_PASSWORD="$(openssl rand -base64 24)" \
SEED_SUPERADMIN_PASSWORD="$(openssl rand -base64 24)" npm run db:seed
npm run build
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup        # den ausgegebenen Befehl als root ausführen
```

Ohne `pm2 startup` und `pm2 save` steht die Anwendung nach einem Neustart des
Servers still — und niemand merkt es, bis die erste Anfrage kommt.

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

**Schritt 4 — Modus umstellen.** Repository-Variable
`TRUSTED_PROXY_MODE=CLOUDFLARE` setzen (14.2) und ausliefern.

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

und in die Umgebung `TRUSTED_PROXY_MODE=SINGLE_REVERSE_PROXY`. Ohne diese
Variable läuft die Anwendung im Modus `NONE`: Rate-Limits greifen dann je
Prozess ohne Adressbezug (alle Aufrufer teilen sich den Schlüssel
`unbekannt`), und Prüf- wie Signaturprotokoll tragen
`ipSource = UNAVAILABLE`. Das ist kein Fehler, sondern die Aussage „nicht
bekannt" — sie wird im Protokoll genau so ausgewiesen.

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
Nginx (`proxy_pass http://127.0.0.1:3000`) und der Health-Check in
`scripts/deploy.sh` (`http://127.0.0.1:<port>/api/health`) sprechen ohnehin
Loopback an; für sie ändert sich nichts. Das ersetzt keine Host-Firewall,
macht aber den offenen Port zur Ausnahme, die jemand bewusst herstellen
müsste. Was auf dem Server *heute* läuft, ist damit nicht bewiesen — siehe
11.1: Vor dem Produktivgang von aussen prüfen, dass `:3000` nicht
erreichbar ist, und erst danach den Proxy-Modus setzen.

**13.5.2 Der Unterzeichnungsbereich.** `/signieren` und `/api/public/signatures`
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
5  * * * * curl -fsS -m 300 -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/hourly >> ~/app/logs/cron.log 2>&1
0  5 * * * curl -fsS -m 600 -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/daily  >> ~/app/logs/cron.log 2>&1
```

Ohne diesen Schritt bleiben Terminerinnerungen, Mahnläufe, Serienbuchungen und
der nächtliche Führungslauf aus — ohne jede Fehlermeldung.

## 14. GitHub Secrets

*Settings → Secrets and variables → Actions*, oder in der Umgebung
`production`. Im Repository steht kein einziger Zugangswert.

| Secret | Pflicht | Bedeutung |
| --- | --- | --- |
| `SERVER_HOST` | ja | Adresse des Servers. **Quelle der Wahrheit** — die Adresse steht nirgends im Repository, und das ist Absicht: Sie darf sich ändern lassen, ohne dass jemand Code anfasst. Genau deshalb kann aber auch niemand ausser Ihnen prüfen, wohin sie zeigt. Für V2 gilt: **erst die Adresse des neuen Servers eintragen, dann `DEPLOY_ENABLED` setzen** (14.2), nie umgekehrt. Eine Adresse aus dem Altbestand wird nicht weiterverwendet — auch dann nicht, wenn sie „ja noch funktioniert" |
| `SERVER_USER` | ja | Dienstbenutzer, etwa `clenaris`. Anders als `SERVER_HOST` und `SERVER_SSH_KEY` **ungeprüft**: Fehlt er, verbindet der Lauf als `@host` und scheitert erst beim Aushandeln, mit einer Meldung, die aufs Netz zeigt statt auf die Konfiguration |
| `SERVER_SSH_KEY` | ja | Privater Schlüssel, vollständig samt Kopf- und Fusszeile |
| `APP_DIRECTORY` | ja | Absoluter Pfad, etwa `/home/clenaris/app` |
| `DATABASE_URL` | ja | Verbindung der Anwendung |
| `JWT_SECRET` | ja | Mindestens 32 Zeichen. **Im laufenden Betrieb nie ändern** — ein neuer Wert meldet alle Sitzungen ab, und ohne eigenen `ENCRYPTION_KEY` hängt die Feldverschlüsselung daran (siehe dort). Für Production V2 gilt das Gegenteil: Der Wert wird **neu erzeugt**, weil ein Signaturschlüssel aus einer Umgebung, die als kompromittiert gilt, kein Signaturschlüssel mehr ist |
| `SERVER_PORT` | nein | SSH-Port, Vorgabe 22 |
| `SERVER_SSH_KNOWN_HOSTS` | **ja** | Gepinnter Wirtsschlüssel. Fehlt er, **bricht die Auslieferung ab** — es gibt keinen Rückfall (13.4), und die Gestalt des Werts steht in 13.4a. Der Schlüssel des V2-Servers wird über die **Anbieterkonsole** gelesen, nicht über `ssh-keyscan`: Letzteres sagt nur, was der Gegenüber gerade anbietet, nicht ob es der richtige Gegenüber ist. Ein Eintrag aus dem Altbestand pinnt eine Maschine, die nicht mehr beliefert wird — im schlimmsten Fall eine, die inzwischen jemand anderem gehört |
| `DIRECT_URL` | **bei Pooling ja** | Direktverbindung für die Prisma-Kommandozeile (`migrate deploy`). **Stand seit Prisma 7 (2026-09-29):** `schema.prisma` deklariert keine Adresse mehr; `prisma.config.ts` nimmt `DIRECT_URL`, sonst `DATABASE_URL`. Der frühere Abbruch mit P1012 bei fehlender Variable (nachgemessen 2026-09-21 unter Prisma 6) gibt es damit nicht mehr — `prisma generate` und der Bau brauchen keine Adresse. Pflicht bleibt sie, wo `DATABASE_URL` auf einen Pooler im Transaktionsmodus zeigt, denn `migrate` verträgt dessen Sperrverhalten nicht. Der Workflow überträgt die Variable nur, wenn das Secret nicht leer ist |
| `API_URL` | **abgelöst** | Wandert nach *Variables* (14.2): Die öffentliche Adresse ist Konfiguration, kein Geheimnis. Der Workflow liest `vars.API_URL` und fällt für den Übergang auf das Secret zurück; sobald die Variable steht, wird das Secret gelöscht |
| `ENCRYPTION_KEY` | empfohlen | Schlüssel der Feldverschlüsselung (64 Hex). Ohne ihn leitet die Anwendung ihn aus `JWT_SECRET` ab — siehe Abschnitt 3 |
| `CRON_SECRET` | empfohlen | Für die planmässigen Aufgaben |

**Bestehende Werte nicht ohne Not neu erzeugen.** Für vier Secrets ist ein
frischer Wert keine Hygienemassnahme, sondern ein Eingriff mit Folgen:

| Secret | Was ein neuer Wert anrichtet |
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
  Oberfläche und Schnittstelle unter derselben Adresse laufen. Das Secret
  existiert trotzdem und wird auf `APP_URL` abgebildet (und für den Übergang
  zusätzlich auf das ältere `NEXT_PUBLIC_APP_URL`).

**14.2 Repository-Variablen — Konfiguration, keine Geheimnisse.**

*Settings → Secrets and variables → Actions → **Variables***. Der Unterschied
ist nicht kosmetisch: Ein Secret wird in Protokollen maskiert und lässt sich
nicht wieder anzeigen, eine Variable schon. Für einen Wert, der ohnehin
öffentlich sein darf, ist die Maskierung kein Gewinn, sondern verhindert nur,
dass man im Protokoll sieht, was gesetzt war.

| Variable | Pflicht | Bedeutung |
| --- | --- | --- |
| `DEPLOY_ENABLED` | **Schalter** | `true` schaltet den Auslieferungsauftrag ein. Jeder andere Wert und jede nicht gesetzte Variable lassen ihn **übersprungen** — fail-closed. Das Qualitätstor läuft davon unberührt bei jedem Push, jedem Pull Request und jedem Handstart. **Erst setzen, wenn der V2-Server steht und `SERVER_HOST`, `SERVER_SSH_KEY` und `SERVER_SSH_KNOWN_HOSTS` auf ihn zeigen.** Ohne diesen Schalter wäre der erste grüne Lauf zugleich eine Auslieferung an das Ziel, das die bestehenden Secrets gerade nennen — und niemand hätte sie ausgelöst |
| `API_URL` | empfohlen | Öffentliche Adresse der Anwendung, etwa `https://<domain>`. Wird auf dem Server zu `APP_URL` (und `NEXT_PUBLIC_APP_URL` als Rückfall) und trägt den Health Check von aussen. Steht sie nicht, fällt der Workflow für den Übergang auf das gleichnamige Secret zurück; fehlt beides, entfällt die Prüfung von aussen mit einer Warnung |
| `TRUSTED_PROXY_MODE` | nein, aber empfohlen | `NONE` \| `SINGLE_REVERSE_PROXY` \| `CLOUDFLARE` — welcher Kopfzeile die Anwendung die Client-Adresse glaubt (13.5.1). **Ist sie nicht gesetzt, überträgt die Auslieferung nichts und die `.env` des Servers behält ihren bisherigen Wert.** Das ist Absicht: Eine Auslieferung soll die Vertrauensannahme nicht heimlich umstellen. Ein *unbekannter* Wert bricht die Auslieferung dagegen ab, statt stillschweigend auf `NONE` zu fallen |

**Warum die Prüfung auf den unbekannten Wert wichtiger ist als die Variable
selbst.** `src/lib/http/client-ip.ts` fällt bei jedem nicht erkannten Wert auf
`NONE` zurück. Im Anfragepfad ist das genau richtig — lieber keine Adresse als
eine erfundene. Als Auslieferungsverhalten wäre es eine Falle: Aus `CLOUDFARE`
würde lautlos „kein Proxy bekannt", alle Aufrufer teilten sich ab sofort einen
Rate-Limit-Schlüssel, und niemand erführe davon. Der Workflow lässt deshalb nur
die drei Namen durch.

**Nur diese Werte verwaltet GitHub.** Stripe, Resend, Twilio, Supabase, Maps
und die Firmenangaben bleiben in der `.env` auf dem Server. `deploy.sh` führt
die Werte ein, statt die Datei zu ersetzen — ein Ersetzen löschte alles übrige,
und die Anwendung liefe danach ohne E-Mail-Versand und ohne Zahlungen weiter,
ohne dass irgendetwas fehlschlüge. Ein stiller Teilausfall ist schlimmer als
ein lauter Abbruch.

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

**Von Hand auslösen.** *Actions → Auslieferung → Run workflow*. Zwei Schalter:
`seed` führt zusätzlich den Konfigurations-Seed aus (Firma, Leistungen, Preise
— niemals Demodaten), `skip_rollback` lässt einen Fehlschlag zur Analyse
stehen.

**Direkt auf dem Server**, wenn GitHub einmal nicht erreichbar ist:

```bash
ssh clenaris@<server>
cd ~/app && bash scripts/deploy.sh
```

Ohne `.env.incoming` bleibt die `.env` unberührt — deshalb ist dieser Aufruf
gefahrlos.

**Ohne Ausfallzeit.** `pm2 reload` startet die neuen Arbeiter und beendet die
alten erst, wenn die neuen auf dem Port hören. Angemeldete Benutzer bleiben
angemeldet, weil die Sitzung in einem signierten Token im Cookie steckt und
nicht im Arbeitsspeicher des Prozesses — solange `JWT_SECRET` gleich bleibt,
ist jeder Arbeiter für jede Sitzung zuständig.

**Migrationen** laufen nur, wenn `prisma migrate status` welche findet.

**Protokolle** liegen unter `logs/deployment/<zeitstempel>.log` (30 Tage) und
`logs/pm2/`. Beide sind in `.gitignore`.

## 16. Rücksprung

Er löst automatisch aus, wenn `npm ci`, der Build, die Migration, der Reload
oder der Health Check fehlschlagen:

1. `git reset --hard` auf den vorherigen Commit
2. `npm ci` (die Abhängigkeiten können sich geändert haben)
3. gesicherten Build aus `.deploy/backups/<zeitstempel>/.next` zurückspielen
4. gesicherte `.env` zurückspielen
5. `pm2 reload`
6. Health Check erneut — bestätigt, dass der alte Stand wieder antwortet

Drei Sicherungen werden aufbewahrt. Wer weiter zurück muss, nimmt Git und baut
neu.

> **Der Rücksprung stellt die Anwendung wieder her, nicht das Datenbankschema.**
>
> Prisma kennt keine Abwärtsmigration, und eine automatisch erzeugte wäre
> gefährlicher als der Fehler, den sie beheben soll — sie verwürfe Daten, die
> die neue Fassung bereits geschrieben hat. Wurden in einem fehlgeschlagenen
> Lauf Migrationen angewandt, bleiben sie bestehen, und das Protokoll sagt es
> ausdrücklich.
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

Von Hand auf einen bestimmten Stand:

```bash
ssh clenaris@<server> && cd ~/app
git reset --hard <commit>
npm ci && npm run build
pm2 reload ecosystem.config.js --env production
curl -fsS http://127.0.0.1:3000/api/health
```

## 17. Wiederherstellung

| Lage | Vorgehen |
| --- | --- |
| Anwendung antwortet nicht | `pm2 status`, `pm2 logs clenaris --lines 100`, dann `pm2 reload clenaris` |
| Nach einem Serverneustart ist nichts gestartet | `pm2 resurrect`; fehlt der Dienst dauerhaft, `pm2 startup` nachholen |
| Datenbank nicht erreichbar | `/api/health` meldet 503. Postgres und `DATABASE_URL` prüfen; die Anwendung fängt sich von selbst, sobald die Datenbank antwortet |
| `.env` verloren | Aus `.deploy/backups/<zeitstempel>/.env` zurückspielen, sonst aus Abschnitt 3 neu aufbauen |
| Arbeitsbaum zerschossen | `git reset --hard origin/main && rm -rf node_modules .next && bash scripts/deploy.sh` |
| Server vollständig verloren | Abschnitt 13 neu durchlaufen, Datenbank aus dem Auszug (Abschnitt 9) einspielen, dann den Workflow von Hand auslösen |

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
| `Eine andere Auslieferung läuft bereits` | Sperre steht | Läuft keine: `rm ~/app/.deploy/deploy.lock` |
| Health Check von aussen meldet den alten Commit | Reload hat still nicht gegriffen | `pm2 logs`, dann `pm2 reload`; Proxy-Zwischenspeicher prüfen |
| `EACCES` beim Schreiben | Verzeichnis gehört `root` | `sudo chown -R clenaris:clenaris ~/app` |
| Build bricht mit Speichermangel ab | Zu wenig RAM | Auslagerungsdatei anlegen oder `NODE_OPTIONS=--max-old-space-size=2048` |

## 19. Wartung und Versionsverwaltung

**Welcher Stand läuft?** `deploy.sh` schreibt den ausgelieferten Commit als
`APP_VERSION` in die `.env`, und `/api/health` meldet ihn:

```bash
curl -fsS https://<domain>/api/health | jq .data.version
```

Der Workflow prüft nach jeder Auslieferung, dass dieser Wert dem gerade
gebauten Commit entspricht. Genau das fängt den unangenehmsten Fehler: ein
Reload, der still nicht greift und weiter die alte, gesunde Fassung ausliefert
— grün, und trotzdem ist nichts angekommen.

**Regelmässig.**

| Rhythmus | Aufgabe |
| --- | --- |
| wöchentlich | `pm2 status` und `logs/deployment/` durchsehen |
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

Die Auslieferungsprotokolle räumt `deploy.sh` selbst nach 30 Tagen auf, die
gesicherten Builds nach drei Läufen.

**Versionen.** `main` ist immer der ausgelieferte Stand; jeder Commit darauf
geht in Produktion. Wer einen benannten Stand braucht — für eine
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
