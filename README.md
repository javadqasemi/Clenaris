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
| **Umfang** | 88 Seiten · 96 API-Endpunkte · 77 Datenmodelle · ~50 000 Zeilen |
| **Rollen** | ADMIN · MANAGER · EMPLOYEE · CUSTOMER |
| **Sprache** | Deutsch (Schema und Endpunkte für FR/IT/EN vorbereitet) |
| **Betrieb** | Vercel (Region `fra1`) · Supabase Postgres & Storage · Redis optional |

## Loslegen

Voraussetzungen: **Node.js ≥ 20.11** und ein erreichbarer **PostgreSQL 16+**.

```bash
npm install
cp .env.example .env          # DATABASE_URL und JWT_SECRET eintragen
npm run db:deploy             # Migrationen anwenden
npm run db:seed               # Schweizer Demodaten
npm run dev                   # http://localhost:3000
```

Der Seed ist idempotent — er lässt sich beliebig oft ausführen — und legt einen
vollständigen Betrieb an: Firma, Öffnungszeiten, 33 Postleitzahlen im
Einsatzgebiet, 6 Leistungen mit 12 Zusätzen und 6 Preisregeln, 7 Konten,
5 Kundschaften mit Buchungen, Einsätzen und Rechnungen, dazu Website-Inhalte.

### Demozugänge

| Rolle | E-Mail | Passwort |
| --- | --- | --- |
| Administration | `admin@clenaris.ch` | `Admin#2026Clenaris` |
| Betriebsleitung | `manager@clenaris.ch` | `Demo#2026Clenaris` |
| Mitarbeitende | `anna.keller@clenaris.ch` | `Demo#2026Clenaris` |
| Kundschaft | `nicole.wyss@example.ch` | `Demo#2026Clenaris` |

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
npm run db:seed      # Demodaten
npm run db:studio    # Prisma Studio
npm run db:reset     # Datenbank zurücksetzen und neu befüllen

npm run docs         # OpenAPI, API-Referenz und ER-Diagramm neu erzeugen
```

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
mit Standort, Checkliste, Vorher-Nachher-Fotos, Materialverbrauch,
Unterschrift der Kundschaft, Ferienanträge, Lohnabrechnungen.

**Kundenkonto** mit Terminen, Offerten, Rechnungen samt Online-Zahlung per
TWINT oder Karte, Objekten, Nachrichten und Bewertungen.

**Fakturierung** mit QR-Einzahlungsschein, Mahnläufen, Gutschriften,
Teilzahlungen, Ausgaben, Lieferanten und Buchhaltungsexport.

**Auswertungen** zu Umsatz, Kosten, Deckungsbeitrag, Auslastung und
Cashflow-Prognose, als Excel und PDF exportierbar.

**Automatisierungen** über zwei Cron-Läufe: Terminerinnerungen (24 h und 2 h),
Mahnungen, ablaufende Offerten, Serienbuchungen, Bewertungsanfragen,
Geburtstagsgrüsse.

**KI-Funktionen** — Offertentwurf, E-Mail-Entwurf, Berichtstext, Antwort auf
Bewertungen, Übersetzung, Zusammenfassung, Website-Chat, Tourenvorschlag. Alle
liefern Entwürfe; ausgeführt oder versendet wird nichts ohne Freigabe.

## Aufbau

```
prisma/
  schema.prisma            77 Modelle, 39 Aufzählungstypen
  migrations/              Erstmigration
  seed.ts                  idempotente Schweizer Demodaten
docs/
  ARCHITECTURE.md          Architekturentscheide
  DATABASE.md              ER-Diagramme (erzeugt)
  API.md                   Endpunktreferenz (erzeugt)
  openapi.yaml / .json     OpenAPI 3.1 (erzeugt)
  DEPLOYMENT.md            Inbetriebnahme und Betrieb
scripts/                   Generatoren für Doku und Spezifikation
src/
  app/
    (public)/              Website
    (auth)/                Anmeldung, Registrierung, Passwort
    (app)/admin|portal|konto
    api/                   83 Route-Dateien, 96 Endpunkte
  components/
    ui/                    Basiskomponenten
    marketing/ app/ charts/
  features/                fachliche Oberflächen je Bereich
  lib/                     Auth, Preis-Engine, PDF, Zahlungen, KI, Validierung
  server/services/         Geschäftslogik (14 Dienste)
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
| `NEXT_PUBLIC_APP_URL` | ja | Basisadresse für Magic Links und PDFs |
| `REDIS_URL` | – | Rate-Limits und Cache über Prozessgrenzen hinweg |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | – | Dateiablage |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | – | Karten- und TWINT-Zahlung |
| `RESEND_API_KEY` | – | E-Mail-Versand |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | – | SMS-Erinnerungen |
| `ANTHROPIC_API_KEY` | – | KI-Funktionen |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | – | Navigation und Geokodierung |
| `CRON_SECRET` | ja¹ | schützt die Scheduler-Endpunkte |

¹ In der Produktion zwingend — ohne ihn weisen die Cron-Endpunkte jede Anfrage
ab, auch die von Vercel.

Vollständige Liste mit Beispielwerten: `.env.example`.

## Datenschutz und Aufbewahrung

- Passwörter als Argon2id-Hash (19 MiB, t=2, p=1 — OWASP-Empfehlung 2024).
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
- **[docs/DATABASE.md](docs/DATABASE.md)** — ER-Diagramme je Fachbereich
- **[docs/API.md](docs/API.md)** — alle 96 Endpunkte mit Feldern und Regeln
- **[docs/openapi.yaml](docs/openapi.yaml)** — maschinenlesbare Spezifikation
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — Inbetriebnahme, Betrieb, Sicherung
