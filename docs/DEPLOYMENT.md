# Inbetriebnahme und Betrieb

Zielumgebung: **Vercel** in der Region `fra1` (Frankfurt) mit **Supabase**
Postgres und Storage. Beides steht in der EU; für Schweizer Personendaten ist
das nach DSG und DSGVO zulässig, sofern es in der Datenschutzerklärung genannt
ist — die mitgelieferte Erklärung nennt es.

Die Applikation ist an nichts davon gebunden: sie braucht Node ≥ 20.11, ein
PostgreSQL ≥ 16 und einen S3-kompatiblen Speicher. Ein einzelner Server tut es
auch.

> **Zwei Wege, dieselbe Anwendung.**
> Die Abschnitte 1 bis 11 beschreiben den Betrieb allgemein und die
> Auslieferung über Vercel. Ab **Abschnitt 12** steht die automatische
> Auslieferung auf einen **eigenen Server** über GitHub Actions, PM2 und SSH —
> ein Push auf `main` genügt. Die Abschnitte 1 bis 3, 5 bis 6 und 9 gelten für
> beide Wege; nur Abschnitt 4 (`vercel --prod`), 7 (Vercel Cron) und 8 (DNS auf
> Vercel) werden im eigenen Betrieb durch Abschnitt 13 ersetzt.

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

### Vor dem nächsten Push: offene Release-Blocker

Stand 2026-09-21, nach der Freigabe des Betreibers. Punkt 3 bis 5 waren das
eigentliche Push-Tor — ein Push auf `main` löst die Auslieferung aus —, und
sie sind erledigt.

**Zur Spalte „Stand" gehört, woher die Aussage kommt.** Einiges ist von diesem
Arbeitsplatz aus nachprüfbar, anderes grundsätzlich nicht: GitHub gibt
Secretwerte technisch nicht heraus, und die Hetzner-Konsole steht hier nicht
zur Verfügung. Wo nur der Betreiber es sehen kann, steht *bestätigt* statt
*geprüft*. Das ist kein Misstrauen, sondern die Trennung, die diese Tabelle
überhaupt nützlich macht.

| # | Punkt | Stand | Beleg |
|---|---|---|---|
| 1 | Aktuellen Server bestätigt: Hetzner `164144336`, `2.29.18.45`, hel1 | **erledigt** | Hetzner-API und TLS-Zertifikat des Ursprungs |
| 2 | Frühere Auslieferungsläufe auf Geheimnisabfluss geprüft | **teilweise** | `SECRET EXPOSURE STATUS UNKNOWN`, Begründung in `NEXT_DEVELOPMENT_AUDIT.md` S-09 |
| 3 | `SERVER_HOST` zeigt auf den aktuellen Server | **erledigt** | bestätigt vom Betreiber |
| 4 | Host-Schlüssel von `2.29.18.45` über die Hetzner-Konsole erhoben | **erledigt** | `SHA256:LqwwARXhcVf1Md+wPBEUiurjML0s1+nIpvTMUeU2YDI`, gegen die Konsole abgeglichen; siehe 13.4a |
| 5 | `SERVER_SSH_KNOWN_HOSTS` mit genau diesem Schlüssel gesetzt | **erledigt** | bestätigt vom Betreiber |
| 6 | Cloud-Firewall am Server | **erledigt** | bestätigt vom Betreiber — die alte `Zentra-Firewall` (22/5432/4444 gegen `0.0.0.0/0`) darf dafür **nicht** verwendet worden sein |
| 7 | Port 3000 extern dicht | **erledigt** | externer Verbindungsversuch: gefiltert |
| 8 | PostgreSQL (5432/5433) extern dicht | **erledigt** | beide gefiltert |
| 9 | Redis (6379) extern dicht | **erledigt** | gefiltert |
| 10 | Lösch- und Rebuild-Schutz am Server | **erledigt** | bestätigt vom Betreiber |
| 11 | `pg_dump`/`pg_restore` auf dem Server vorhanden und Hauptversion ≥ Server | **erledigt** | bestätigt vom Betreiber; das Sicherungsskript prüft es beim Lauf noch einmal selbst und bricht sonst ab |
| 12 | Sicherungsverzeichnis beschreibbar | **erledigt** | bestätigt vom Betreiber |
| 13 | Produktions-Secrets vollständig | **offen** | nur der Betreiber kann das sehen; die Liste steht in 14.1 |
| 14 | Migrations-Vorprüfung gegen Produktionsdaten | läuft automatisch | `scripts/migration-preflight.ts`, fail-closed |
| 15 | Unmittelbare Datenbanksicherung | läuft automatisch | `scripts/db-backup.ts`, fail-closed |
| 16 | Push, CI, Auslieferung | freigegeben | — |

Punkt 2 bleibt bewusst offen und ist **kein** Push-Hindernis: Die Frage
betrifft die Vergangenheit, nicht den nächsten Lauf. Der nächste Lauf geht
gegen einen gepinnten, beim Anbieter gegengeprüften Wirtsschlüssel.

Zu 7 bis 9: Der Server hat **keine** Cloud-Firewall, die Ports sind trotzdem
dicht — das besorgt die Firewall auf dem Server selbst beziehungsweise die
Loopback-Bindung. Die Cloud-Firewall bleibt als zweite Schicht empfehlenswert,
ist aber kein offenes Scheunentor.

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

In Vercel unter *Settings → Environment Variables*. Pflicht in Produktion:

```
DATABASE_URL
DIRECT_URL
JWT_SECRET                 openssl rand -base64 48
NEXT_PUBLIC_APP_URL        https://clenaris.qasemi.ch
CRON_SECRET                openssl rand -hex 32
ENCRYPTION_KEY             openssl rand -hex 32   (genau 64 Hex-Zeichen)
```

> **Die Produktionsadresse ist `clenaris.qasemi.ch`**, nicht `clenaris.ch`.
> Letzteres ist der Markenname und steht in den Firmenangaben; im DNS
> existiert es (Stand 2026-09-19) nicht. Überall dort, wo eine Adresse
> *angesprochen* wird — `NEXT_PUBLIC_APP_URL`, `API_URL`, die `servers` der
> OpenAPI-Spezifikation —, gehört die erreichbare Adresse hin. Eine
> Konfiguration, die auf einen nicht auflösenden Namen zeigt, erzeugt Magic
> Links und PDF-Verweise, die ins Leere führen.

`ENCRYPTION_KEY` verschlüsselt das TOTP-Geheimnis, die AHV-Nummer und den
Alarmcode in der Datenbank (`src/lib/crypto.ts`). Fehlt er, leitet die
Anwendung den Schlüssel aus `JWT_SECRET` ab und läuft weiter — ein Wechsel von
`JWT_SECRET` machte dann aber alle drei Felder unlesbar. Deshalb steht er hier
unter den Pflichtwerten und nicht unter den Empfehlungen.

**Diesen Schlüssel sichern wie das Datenbankpasswort.** Geht er verloren,
geht kein Konto verloren — aber jede Person mit zweitem Faktor muss ihn neu
einrichten, und AHV-Nummern und Alarmcodes sind nachzutragen. Rotieren lässt
er sich nur mit einem Skript, das jeden Wert entschlüsselt und neu
verschlüsselt; ein blosser Austausch der Variablen macht den Bestand unlesbar.

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
    │  git push origin main
    ▼
GitHub
    │
    ▼
GitHub Actions  ── .github/workflows/deploy.yml
    │
    ├─ Auftrag 1: Prüfung  (bricht ab → keine Auslieferung)
    │     Linter · TypeScript · Geheimnis-Suche · Dokumentation
    │     PostgreSQL 16 starten · Migrationen · Demodaten
    │     Build · Anwendung starten · vollständige Testreihe
    │
    └─ Auftrag 2: Auslieferung  (nur wenn Auftrag 1 grün ist)
          Secrets über SSH ablegen
          scripts/deploy.sh auf dem Server
             ├─ Sicherung von Build und .env
             ├─ git fetch · git reset --hard origin/main
             ├─ npm ci
             ├─ prisma generate · migrate deploy (nur wenn nötig)
             ├─ npm run build
             ├─ pm2 reload  (ohne Ausfallzeit)
             ├─ Health Check lokal  ──┐ schlägt fehl → Rücksprung
             └─ Aufräumen             │
          Health Check von aussen  ───┘  prüft zusätzlich den Commit
```

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
| `.github/workflows/deploy.yml` | Prüfung und Auslieferung, Auslöser `push` auf `main` und `workflow_dispatch` |
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

```bash
cd ~ && git clone https://github.com/javadqasemi/Clenaris.git app && cd app
cp .env.example .env && chmod 600 .env
```

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

**13.4a Der erhobene Wirtsschlüssel des aktuellen Servers.**

Am 2026-09-21 hat der Betreiber `/etc/ssh/ssh_host_ed25519_key.pub` auf Server
`164144336` über die **Hetzner-Konsole** gelesen — also über den Weg des
Anbieters, nicht über SSH und nicht über `ssh-keyscan`. Der Kommentar im
Schlüssel lautet `root@ubuntu-4gb-hel1-1` und passt zur Maschine (4 GB, hel1).

| | |
|---|---|
| Typ | `ssh-ed25519`, 256 Bit |
| SHA-256 | `SHA256:LqwwARXhcVf1Md+wPBEUiurjML0s1+nIpvTMUeU2YDI` |
| MD5 | `MD5:42:8e:2a:a7:19:54:bc:c8:e6:90:a3:9f:72:a5:da:70` |

Der Schlüsselkörper wurde vor der Übernahme strukturell geprüft: 68 Zeichen
Base64, 51 Byte, längenpräfixiert als `ssh-ed25519` (11) plus 32 Byte
Schlüsselmaterial. Ein Übertragungsschaden beim Abtippen wäre daran
aufgefallen; der Zeilenumbruch, den die Konsole im Kommentar erzeugt, ist
belanglos, weil der Kommentar weder in den Fingerabdruck noch in `known_hosts`
eingeht.

Damit ist der Wert für `SERVER_SSH_KNOWN_HOSTS` — eine Zeile, kein
Zeilenumbruch am Ende nötig, und **ohne** Kommentar:

```
2.29.18.45 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBXDXamMZlC8r2Tr/9Oh2Q6MlyufpmZiU7eDwBwNQCGv
```

Zwei Bedingungen hängen daran:

- **Der Name links muss zeichengenau dem entsprechen, was in `SERVER_HOST`
  steht.** `ssh` schlägt unter dem Namen nach, mit dem es verbindet, nicht
  unter der aufgelösten Adresse. Steht dort ein DNS-Name statt der IP, lautet
  die Zeile `<name> ssh-ed25519 AAAA…`; bei einem Port ungleich 22
  `[<name>]:<port> ssh-ed25519 AAAA…`. Sind beide Wege im Gebrauch, gehören
  beide Zeilen ins Secret.
- **Den Eintrag nicht mit `ssh-keygen -H` verschlüsseln.** Gehashte Einträge
  funktionieren zwar, aber dann lässt sich der Secretwert nicht mehr mit blossem
  Auge gegen den Fingerabdruck oben prüfen — und genau diese Nachprüfbarkeit ist
  der Zweck der Übung.

**Drei Schlüssel, die nicht verwechselt werden dürfen.** Das Projekt hat im
Verlauf drei verschiedene ed25519-Wirtsschlüssel gesehen; nur der erste ist
gültig:

| Fingerabdruck | Wozu er gehört |
|---|---|
| `SHA256:Lqww…U2YDI` | **Der aktuelle Server** `2.29.18.45`, aufgesetzt 2026-08-31. Der einzige Sollwert |
| `SHA256:k2mQx1lDuD9kURdFAGxbKxznHfGqvvqHwJWJRmWTuPQ` | Der **frühere Clenaris-Server**, am 2025-10-01 lokal in `~/.ssh/known_hosts` unter `46.62.175.39` gepinnt. Historisch, die Maschine existiert nicht mehr |
| `SHA256:xiMHcWWxo4UVb4JmYzwremYJdN1lXoGxw+UEZK7+1k4` | Der Schlüssel, den `46.62.175.39` am 2026-09-19 **angeboten** hat, als die Verbindung mit `REMOTE HOST IDENTIFICATION HAS CHANGED` scheiterte. Er gehört einem **Dritten** (`PTR mail1.domainmarket.gr`) und darf nirgends gepinnt werden |

Der mittlere Eintrag steht weiterhin in der lokalen `~/.ssh/known_hosts` dieses
Arbeitsplatzes und pinnt einen Schlüssel für eine Adresse, die fremd ist. Das
ist kein aktives Risiko — die Zeile verhindert eher eine versehentliche
Verbindung, als sie eine ermöglicht —, aber sie ist irreführend und gehört
entfernt, sobald der Weg zum neuen Server eingerichtet ist:

```bash
ssh-keygen -R 46.62.175.39
```

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
Cloudflare wird derzeit nicht eingesetzt; der Modus bleibt aus, bis diese
Bedingung hergestellt und geprüft ist.

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
| `SERVER_HOST` | ja | Adresse des Servers. **Quelle der Wahrheit** — die Adresse wird nirgends im Repository hartkodiert. Vor dem nächsten Push prüfen, dass sie auf den aktuellen Server zeigt (`2.29.18.45`, Hetzner `164144336`) und **nicht** mehr auf `46.62.175.39`; jene Adresse gehört seit dem Neuaufbau einem Dritten (`PTR mail1.domainmarket.gr`). GitHub gibt Secretwerte nicht heraus — die Prüfung kann nur Sie vornehmen |
| `SERVER_USER` | ja | Dienstbenutzer, etwa `clenaris` |
| `SERVER_SSH_KEY` | ja | Privater Schlüssel, vollständig samt Kopf- und Fusszeile |
| `APP_DIRECTORY` | ja | Absoluter Pfad, etwa `/home/clenaris/app` |
| `DATABASE_URL` | ja | Verbindung der Anwendung |
| `JWT_SECRET` | ja | Mindestens 32 Zeichen. **Nie ändern** — ein neuer Wert meldet alle Sitzungen ab |
| `SERVER_PORT` | nein | SSH-Port, Vorgabe 22 |
| `SERVER_SSH_KNOWN_HOSTS` | **ja** | Gepinnter Wirtsschlüssel. Fehlt er, **bricht die Auslieferung ab** — es gibt keinen Rückfall (siehe 13.4). Der Wert für den aktuellen Server steht fertig in **13.4a**; sein Fingerabdruck ist `SHA256:Lqww…U2YDI`. Ein Eintrag, der aus einem `ssh-keyscan` gegen `46.62.175.39` stammt, pinnt den Schlüssel eines fremden Hosts und ist sofort zu ersetzen |
| `DIRECT_URL` | empfohlen | Direktverbindung für Migrationen |
| `API_URL` | empfohlen | Öffentliche Adresse, zurzeit `https://clenaris.qasemi.ch`. Wird zu `NEXT_PUBLIC_APP_URL` und trägt den Health Check von aussen |
| `ENCRYPTION_KEY` | empfohlen | Schlüssel der Feldverschlüsselung (64 Hex). Ohne ihn leitet die Anwendung ihn aus `JWT_SECRET` ab — siehe Abschnitt 3 |
| `CRON_SECRET` | empfohlen | Für die planmässigen Aufgaben |

**Zwei Namen aus der Anforderung gibt es hier nicht.**

- `NEXTAUTH_SECRET` — das Projekt benutzt NextAuth nicht. Die Anmeldung läuft
  über eigene, signierte Tokens (`src/lib/auth/`); der Schlüssel dafür heisst
  `JWT_SECRET`. Ein zusätzliches `NEXTAUTH_SECRET` wäre eine Variable, die
  nichts tut, und genau solche Variablen verwirren später bei der Fehlersuche.
- `API_URL` — die Anwendung kennt keine getrennte Schnittstellenadresse, weil
  Oberfläche und Schnittstelle unter derselben Adresse laufen. Das Secret
  existiert trotzdem und wird auf `NEXT_PUBLIC_APP_URL` abgebildet.

**Nur diese Werte verwaltet GitHub.** Stripe, Resend, Twilio, Supabase, Maps
und die Firmenangaben bleiben in der `.env` auf dem Server. `deploy.sh` führt
die Werte ein, statt die Datei zu ersetzen — ein Ersetzen löschte alles übrige,
und die Anwendung liefe danach ohne E-Mail-Versand und ohne Zahlungen weiter,
ohne dass irgendetwas fehlschlüge. Ein stiller Teilausfall ist schlimmer als
ein lauter Abbruch.

## 15. Ablauf einer Auslieferung

```bash
git add .
git commit -m "Beschreibung"
git push origin main
```

Mehr ist nicht zu tun. Unter *Actions* läuft der Fortschritt mit.

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

**Empfohlene Ergänzung.** Dieser Workflow prüft `main`, also *nach* dem
Zusammenführen. Wer den Fehler vorher finden will, schaltet in den
Zweigschutzregeln von `main` den Prüfauftrag als erforderlich für Pull
Requests ein — dieselbe Datei, ein zusätzlicher Auslöser `pull_request`.
