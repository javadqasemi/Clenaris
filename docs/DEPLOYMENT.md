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
Repository.

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
NEXT_PUBLIC_APP_URL        https://clenaris.ch
CRON_SECRET                openssl rand -hex 32
```

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

**13.4 Zugangsschlüssel.** Auf dem Arbeitsplatz erzeugen, den öffentlichen Teil
auf den Server legen, den privaten als GitHub Secret:

```bash
ssh-keygen -t ed25519 -C "github-actions-clenaris" -f ~/.ssh/clenaris_deploy -N ""
ssh-copy-id -i ~/.ssh/clenaris_deploy.pub clenaris@<server>
ssh-keyscan -H <server> | base64 -w0     # Inhalt für SERVER_SSH_KNOWN_HOSTS
```

In `/etc/ssh/sshd_config` sicherstellen: `PermitRootLogin no`,
`PasswordAuthentication no`.

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
| `SERVER_HOST` | ja | Adresse des Servers |
| `SERVER_USER` | ja | Dienstbenutzer, etwa `clenaris` |
| `SERVER_SSH_KEY` | ja | Privater Schlüssel, vollständig samt Kopf- und Fusszeile |
| `APP_DIRECTORY` | ja | Absoluter Pfad, etwa `/home/clenaris/app` |
| `DATABASE_URL` | ja | Verbindung der Anwendung |
| `JWT_SECRET` | ja | Mindestens 32 Zeichen. **Nie ändern** — ein neuer Wert meldet alle Sitzungen ab |
| `SERVER_PORT` | nein | SSH-Port, Vorgabe 22 |
| `SERVER_SSH_KNOWN_HOSTS` | empfohlen | Wirtsschlüssel. Fehlt er, wird er ungeprüft übernommen und der Lauf warnt |
| `DIRECT_URL` | empfohlen | Direktverbindung für Migrationen |
| `API_URL` | empfohlen | Öffentliche Adresse, etwa `https://clenaris.ch`. Wird zu `NEXT_PUBLIC_APP_URL` und trägt den Health Check von aussen |
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
