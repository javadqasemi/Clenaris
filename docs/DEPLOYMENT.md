# Inbetriebnahme und Betrieb

Zielumgebung: **Vercel** in der Region `fra1` (Frankfurt) mit **Supabase**
Postgres und Storage. Beides steht in der EU; für Schweizer Personendaten ist
das nach DSG und DSGVO zulässig, sofern es in der Datenschutzerklärung genannt
ist — die mitgelieferte Erklärung nennt es.

Die Applikation ist an nichts davon gebunden: sie braucht Node ≥ 20.11, ein
PostgreSQL ≥ 16 und einen S3-kompatiblen Speicher. Ein einzelner Server tut es
auch.

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
