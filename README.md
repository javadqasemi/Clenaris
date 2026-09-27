# Clenaris

SaaS-Plattform für Reinigungsbetriebe im Kanton Bern — öffentliche Website,
Online-Buchung, CRM, Disposition, Zeiterfassung, Fakturierung mit Schweizer
QR-Rechnung, Mitarbeitendenportal und Kundenkonto.

Deutschsprachig, mit Schweizer Besonderheiten dort, wo sie zählen: 8.1 % MWST,
QR-Einzahlungsschein nach SIX-Norm v2.3, lückenlose Belegnummern nach
Art. 957a OR, AHV/ALV/BVG/UVG in der Lohnabrechnung, Datenhaltung nach
Schweizer DSG und DSGVO.

---

## Auf einen Blick

| | |
| --- | --- |
| **Stack** | Next.js 15 (App Router) · React 19 · TypeScript · Tailwind · Prisma 6 · PostgreSQL 16+ |
| **Umfang** | <!-- kennzahlen:umfang -->166 Seiten · 373 Route-Dateien mit 538 Endpunkten · 151 Datenmodelle · 84 Dienste · 90 Prüfdateien<!-- /kennzahlen:umfang --> (gezählt von `scripts/kennzahlen.ts`) |
| **Rollen** | SUPER_ADMIN · ADMIN · MANAGER · EMPLOYEE · CUSTOMER |
| **Sprache** | Deutsch (Schema und Endpunkte für FR/IT/EN vorbereitet) |
| **Betrieb** | Eigener Server: Internet → Cloudflare → Cloud Firewall → Nginx → Next.js auf `127.0.0.1:3000`, ausgeliefert über GitHub Actions → SSH → PM2 · Postgres & Objektspeicher · Redis empfohlen |
| **Prüfung** | 20 Testdateien gegen die laufende Anwendung über HTTP; die CI führt sie bei jedem Pull Request gegen `main` und bei jedem Push auf `main` aus — ausgeliefert wird nur aus `main`, nie aus einem Pull Request |

## Loslegen

Voraussetzungen: **Node.js ≥ 20.11** und ein erreichbarer **PostgreSQL 16+**.

```bash
npm install
cp .env.example .env          # DATABASE_URL und JWT_SECRET eintragen
npm run db:deploy             # Migrationen anwenden
npm run db:seed:demo          # Konfiguration plus Schweizer Demodaten
npm run dev                   # http://localhost:3000
```

Beide Seeds sind idempotent und lassen sich beliebig oft ausführen. Sie sind
getrennt, weil sie verschiedene Zwecke haben:

- **`db:seed`** legt den Betrieb an — Firma, Öffnungszeiten, 33 Postleitzahlen
  im Einsatzgebiet, 6 Leistungen mit 12 Zusätzen und 6 Preisregeln, die Konten
  und das Team, dazu die Website-Inhalte. Das ist auch der Seed für ein echtes
  System.
- **`db:seed:demo`** führt `db:seed` aus und legt obendrauf Geschäftsdaten an:
  Kundschaft, Buchungen, Einsätze, Offerten, Rechnungen. Das ist der Seed für
  die Entwicklung und für die Prüfungen. Auf einem System, das in Betrieb geht,
  gehört er nicht ausgeführt.

### Demozugänge

| Rolle | E-Mail | Passwort |
| --- | --- | --- |
| Systemverantwortung | `system@clenaris.ch` | `System#2026Clenaris` |
| Administration | `admin@clenaris.ch` | `Admin#2026Clenaris` |
| Betriebsleitung | `manager@clenaris.ch` | `Demo#2026Clenaris` |
| Mitarbeitende | `anna.keller@clenaris.ch` | `Demo#2026Clenaris` |
| Kundschaft | `nicole.wyss@example.ch` | `Demo#2026Clenaris` |

Die beiden Verwaltungskonten folgen `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`
bzw. `SEED_SUPERADMIN_*`, sobald diese in der `.env` stehen; die Tabelle nennt
die Rückfallwerte. Auf einem erreichbaren System müssen sie gesetzt sein —
sonst bricht der Seed ab.

Nach der Anmeldung führt die Rolle an den richtigen Ort: `/admin`, `/portal`
oder `/konto`.

## Skripte

```bash
npm run dev          # Entwicklungsserver
npm run build        # Produktionsbuild (erzeugt vorher den Prisma-Client)
npm run start        # Produktionsserver
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint
npm run format       # Prettier

npm run db:migrate   # Migration erzeugen und anwenden (Entwicklung)
npm run db:deploy    # Migrationen anwenden (Produktion)
npm run db:seed      # nur die Konfiguration: Firma, Leistungen, Preise, Gebiet, Team
npm run db:seed:demo # Konfiguration plus Demodaten — das, was die Prüfungen brauchen
npm run db:studio    # Prisma Studio

npm test             # ganze Prüfreihe gegen einen laufenden Server
npm run test:api     # nur die Endpunkte
npm run test:pages   # nur die ausgelieferten Seiten

npm run docs         # OpenAPI, API-Referenz und ER-Diagramm neu erzeugen
```

`npm run db:reset` steht zwar in `package.json`, ist hier aber tabu: Frühere
Migrationen sind von Hand nachbearbeitet, ein Zurücksetzen verwirft sie. Der
nicht zerstörende Weg steht in `CLAUDE.md`.

Die Prüfungen fahren die **laufende Anwendung** über echtes HTTP an und
brauchen deshalb eine gefüllte Datenbank *und* einen gestarteten Server —
Einzelheiten in [`tests/README.md`](tests/README.md).

`npm run docs` prüft dabei, ob Routenbaum und dokumentierte Endpunkte
übereinstimmen, und bricht ab, wenn ein Endpunkt undokumentiert ist.

## Was die Plattform kann

**Öffentliche Website.** Startseite mit Vorher-Nachher-Regler,
Leistungsseiten, Preisrechner, Einsatzgebietsprüfung nach Postleitzahl,
Galerie, Bewertungen, FAQ, Blog, Stellen, Kontakt- und Offertformular,
rechtliche Seiten.

**Online-Buchung** in sechs Schritten: Leistung, Objekt, Zusätze, Häufigkeit,
Termin, Kontakt. Der Preis wird bei jeder Änderung serverseitig neu gerechnet
und mit vollständiger Herleitung angezeigt. Ohne Konto buchbar; die
Bestätigungsmail enthält einen Magic Link zum Verschieben und Absagen.

**Offerten** erstellen, duplizieren, versenden, online annehmen lassen — mit
Unterschrift, IP und Zeitstempel als Nachweis — und in eine Buchung oder
Rechnung überführen.

**Disposition** im Kalender mit Ziehen und Ablegen, Serienterminen,
Teamzuteilung mit Überschneidungsprüfung und einem KI-Tourenvorschlag, der
Fahrwege verkürzt (vorschlagen, nicht ausführen).

**Mitarbeitendenportal** fürs Telefon: Tagesübersicht, Ein- und Ausstempeln
mit Standort, Checkliste, Zugangshinweise samt verschlüsseltem Alarmcode,
Vorher-Nachher-Fotos, Materialverbrauch, Unterschrift der Kundschaft,
Ferienanträge, Lohnabrechnungen (Anzeige — das Erzeugen fehlt noch, siehe
Audit).

**Kundenkonto** mit Terminen, Offerten, Rechnungen samt Online-Zahlung per
TWINT oder Karte, Objekten, Nachrichten und Bewertungen.

**Fakturierung** mit QR-Einzahlungsschein, Mahnläufen, Teilzahlungen,
Ausgaben, Lieferanten und Buchhaltungsexport. *Gutschriften sind als Dienst
vorhanden, aber noch ohne Endpunkt und ohne Schaltfläche — siehe
[`docs/NEXT_DEVELOPMENT_AUDIT.md`](docs/NEXT_DEVELOPMENT_AUDIT.md), Abschnitt 6.*

**Auswertungen** zu Umsatz, Kosten, Deckungsbeitrag, Auslastung und
Cashflow-Prognose, als Excel und PDF exportierbar.

**Unternehmensführung** — Führungscockpit mit Gesundheitswert, Kennzahlen mit
festgeschriebenem Verlauf, Strategie und Quartalsziele mit Schlüsselergebnissen
(OKR) und Roadmap, Budget mit Abweichung zum Ist, Anlagenverzeichnis mit
Abschreibung, Szenarien (bester, erwarteter, schlechtester Fall), Risikoregister
mit Matrix, Qualitäts- und Compliance-Kontrollen mit Massnahmen (CAPA),
Dokumentenablage mit Fassungen und Fristen, Wissensdatenbank, Wettbewerbs- und
Marktbeobachtung mit SWOT/PESTEL, Sitzungsprotokolle mit Pendenzen, Berichte
als PDF, Excel und Word nach Zeitplan — und ein Assistent, der Entwürfe mit
Begründung, Datenquelle und Vertrauensgrad liefert.

**Automatisierungen** über zwei Cron-Läufe: Terminerinnerungen (24 h und 2 h),
Mahnungen, ablaufende Offerten, Serienbuchungen, Bewertungsanfragen,
Geburtstagsgrüsse.

**KI-Funktionen** — Offertentwurf, E-Mail-Entwurf, Berichtstext, Antwort auf
Bewertungen, Übersetzung, Zusammenfassung, Website-Chat, Tourenvorschlag. Alle
liefern Entwürfe; ausgeführt oder versendet wird nichts ohne Freigabe.

## Aufbau

```
.github/workflows/         Prüfung bei jedem Pull Request, Auslieferung nur aus main
prisma/
  schema.prisma            <!-- kennzahlen:schema -->151 Modelle, 119 Aufzählungstypen<!-- /kennzahlen:schema -->
  migrations/              <!-- kennzahlen:migrationen -->49 Migrationen<!-- /kennzahlen:migrationen -->
  seed.ts                  Konfiguration (idempotent)
  seed-demo.ts             Demodaten obendrauf
docs/
  ARCHITECTURE.md          Architekturentscheide
  NEXT_DEVELOPMENT_AUDIT.md  Standortbestimmung und Entwicklungsphasen
  PROJECT_IMPLEMENTATION_CHECKLIST.md  Feature-für-Feature-Prüfung
  DATABASE.md              ER-Diagramme (erzeugt)
  API.md                   Endpunktreferenz (erzeugt)
  openapi.yaml / .json     OpenAPI 3.1 (erzeugt)
  DEPLOYMENT.md            Inbetriebnahme und Betrieb
  bi/                      Bauplan der Unternehmensführung
scripts/                   Generatoren, Deployment, KPI-Backfill
src/
  app/
    (public)/              Website
    (auth)/                Anmeldung, Registrierung, Passwort
    (app)/admin|portal|konto
    api/                   <!-- kennzahlen:api -->373 Route-Dateien, 538 Endpunkte<!-- /kennzahlen:api -->
  components/
    ui/                    Basiskomponenten
    marketing/ app/ charts/
  features/                fachliche Oberflächen je Bereich
  lib/                     Auth, Preis-Engine, PDF, Zahlungen, KI, Validierung, Verschlüsselung
  server/services/         Geschäftslogik (47 Dienste)
tests/                     HTTP-Prüfungen gegen die laufende Anwendung
```

Ausführlich: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Konfiguration

Ohne die optionalen Dienste läuft die Applikation vollständig — sie schaltet
die betroffene Funktion ab, statt zu scheitern. Ohne Redis greift ein
prozesslokaler Speicher, ohne Resend werden E-Mails protokolliert statt
versendet.

| Variable | Pflicht | Zweck |
| --- | --- | --- |
| `DATABASE_URL` | ja | PostgreSQL-Verbindung |
| `DIRECT_URL` | – | Direktverbindung für Migrationen (bei Pooling) |
| `JWT_SECRET` | ja | mindestens 32 Zeichen |
| `APP_URL` | ja | Adresse dieser Instanz für Links in E-Mails, PDFs, Zahlungen, Signaturen und die Herkunftsprüfung — zur Laufzeit gelesen (älterer Name `NEXT_PUBLIC_APP_URL` gilt als Rückfall) |
| `NEXT_PUBLIC_SITE_URL` | beim Bau | kanonische Domain der Website (Canonical, Sitemap, robots.txt), für jede Umgebung dieselbe |
| `REDIS_URL` | – | Rate-Limits und Cache über Prozessgrenzen hinweg |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | – | Dateiablage |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | – | Karten- und TWINT-Zahlung |
| `RESEND_API_KEY` | – | E-Mail-Versand |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | – | SMS-Erinnerungen |
| `ANTHROPIC_API_KEY` | – | KI-Funktionen |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | – | Navigation und Geokodierung |
| `CRON_SECRET` | ja¹ | schützt die Scheduler-Endpunkte |
| `ENCRYPTION_KEY` | ja¹ | verschlüsselt TOTP-Geheimnis, AHV-Nummer und Alarmcode (64 Hex-Zeichen) |

¹ In der Produktion zwingend. Ohne `CRON_SECRET` weisen die Scheduler-Endpunkte
jede Anfrage ab. Ohne `ENCRYPTION_KEY` läuft die Anwendung zwar, leitet den
Schlüssel aber aus `JWT_SECRET` ab — ein Wechsel von `JWT_SECRET` machte die
verschlüsselten Felder dann unlesbar.

Vollständige Liste mit Beispielwerten: `.env.example`.

## Datenschutz und Aufbewahrung

- Passwörter als Argon2id-Hash (19 MiB, t=2, p=1 — OWASP-Empfehlung 2024).
- TOTP-Geheimnis, AHV-Nummer und Alarmcode verschlüsselt (AES-256-GCM,
  `src/lib/crypto.ts`) — gegen einen Datenbankabzug, nicht gegen einen
  Angreifer im laufenden Prozess.
- Sitzungen über httpOnly-Cookies; Refresh-Token rotieren, Wiederverwendung
  eines verbrauchten Tokens verwirft die ganze Familie.
- Kartendaten erreichen die Applikation nie — die Zahlung läuft über Stripe
  Checkout, gespeichert wird nur der Verweis.
- Jeder ändernde Vorgang landet im Prüfprotokoll mit Vorher-Nachher-Vergleich.
- Einwilligungen werden mit Zeitpunkt und IP nachgewiesen (DSGVO Art. 7 Abs. 1).
- Analysewerkzeuge werden erst nach Einwilligung geladen — nicht bloss
  stillgelegt, sondern gar nicht erst eingebunden.
- Finanzbelege sind fortschreibend: eine ausgestellte Rechnung wird nie
  geändert, Korrekturen laufen über Gutschriften (Art. 957a OR).

## Weiterführend

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — die Entscheide und ihre Begründung
- **[docs/NEXT_DEVELOPMENT_AUDIT.md](docs/NEXT_DEVELOPMENT_AUDIT.md)** — wo die Plattform steht und was als Nächstes kommt
- **[docs/DATABASE.md](docs/DATABASE.md)** — ER-Diagramme je Fachbereich
- **[docs/API.md](docs/API.md)** — <!-- kennzahlen:api-doku -->alle 538 Endpunkte<!-- /kennzahlen:api-doku --> mit Feldern und Regeln
- **[docs/openapi.yaml](docs/openapi.yaml)** — maschinenlesbare Spezifikation
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — Inbetriebnahme, Betrieb, Sicherung
