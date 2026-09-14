# Project Implementation Checklist — Clenaris

**Stand:** 2026-09-14 · **Grundlage:** vollständige Analyse des Quellcodes (kein Abgleich mit Roadmaps oder Absichtserklärungen). Jede Zeile nennt den Ort im Repository, an dem die Aussage geprüft werden kann.

**Prüfumfang:** 133 Seiten (`page.tsx`), 240 Route-Dateien unter `src/app/api`, 46 Dienste, 26 Validierungsmodule, 111 Prisma-Modelle, 67 Enums, 12 Migrationen, 19 Testdateien, rund 106 000 Zeilen TypeScript/TSX unter `src/`.

**Werkzeuglauf am Prüftag:** `npm run typecheck` → 0 Fehler · `npm run lint` → 0 Warnungen, 0 Fehler · `grep TODO|FIXME|HACK|XXX` über `src/`, `prisma/`, `scripts/` → 0 Treffer.

## Statusdefinitionen

| Symbol | Bedeutung |
|---|---|
| ✅ | Vollständig umgesetzt und im Code nachvollziehbar funktionsfähig |
| 🟡 | Vorhanden, aber mit fehlenden Teilen oder bekannten Problemen |
| ❌ | Nicht umgesetzt |
| ⚠️ | Vorhanden, braucht aber eine Sicherheits-, Leistungs- oder Testprüfung |

---

## 0. Zusammenfassung

| Bereich | ✅ Vollständig | 🟡 Teilweise | ❌ Fehlend | ⚠️ Prüfung nötig | Summe |
|---|---|---|---|---|---|
| Frontend (Abschnitt 2) | 101 | 16 | 4 | 1 | 122 |
| Backend (Abschnitt 3) | 72 | 24 | 3 | 7 | 106 |
| Sicherheit (Abschnitt 4) | 11 | 7 | 3 | 3 | 24 |
| Tests (Abschnitt 5) | 14 | 11 | 10 | 0 | 35 |
| Wunschliste (Abschnitt 8) | 14 | 1 | 0 | 1 | 16 |
| **Gesamt** | **212** | **59** | **20** | **12** | **303** |

Die Plattform ist funktional weitgehend vollständig: alle drei Anwendungsbereiche (Administration, Mitarbeitendenportal, Kundenkonto), die öffentliche Website mit Online-Buchung, das Modul Unternehmensführung, Fakturierung mit QR-Rechnung und die Automatisierungen sind im Code vorhanden und über HTTP-Tests abgedeckt. Die offenen Punkte sind vor allem **Sicherheitshärtung** (Next.js-Version mit bekannter Schwachstelle, CSP, 2FA-Geheimnis im Klartext), **Lücken im API-Umfang** (Gutschriften, Lohnabrechnung, Anonymisierung ohne Endpunkt), **Testlücken** (Zahlungen, Webhooks, Exporte) und **fehlende Betriebsautomatisierung** (keine CI).

---

## 1. Architekturübersicht

| Ebene | Technologie | Ort |
|---|---|---|
| Frontend | Next.js 15.1.4 (App Router), React 19.0.0, TypeScript 5.7, Tailwind 3.4, Radix UI, lucide-react, react-hook-form + Zod, TanStack Query 5, zustand 5 (nur Buchungsassistent), next-themes, recharts, FullCalendar 6, sonner | `src/app`, `src/components`, `src/features` |
| Backend | Next.js Route Handlers (Node-Runtime), Middleware auf Edge, Prisma 6.2, jose (JWT HS256), @node-rs/argon2, ioredis, Zod | `src/app/api`, `src/server/services`, `src/lib` |
| Datenbank | PostgreSQL 16+ über Prisma; Supabase-Pooler (PgBouncer) für die Applikation, Direktverbindung für Migrationen | `prisma/schema.prisma`, `prisma/migrations` |
| Hosting | Vercel, Region `fra1`; Supabase Postgres und Storage; Redis (Upstash) optional | `vercel.json`, `docs/DEPLOYMENT.md` |
| Deployment | Vercel-Build (`prisma generate && next build`), zwei Vercel-Crons (`5 * * * *`, `0 5 * * *`), Migrationen manuell mit `npm run db:deploy`. **Keine CI-Pipeline** (kein `.github/`). | `vercel.json`, `package.json` |
| PDF | `@react-pdf/renderer` (Rechnung, Offerte, Einsatzbericht, Führungsbericht) | `src/lib/pdf/` |
| Exporte | ExcelJS (4 Arbeitsmappen), docx (Führungsbericht) | `src/server/services/export.service.ts`, `bi-report.service.ts` |
| Integrationen | Stripe (Checkout + Webhook), Resend, Twilio, Anthropic, Supabase Storage, Google Maps | `src/lib/payments`, `src/lib/email`, `src/lib/sms`, `src/lib/ai`, `src/lib/storage`, `src/lib/maps` |

### Hauptordner

| Ordner | Inhalt |
|---|---|
| `src/app/(public)/` | Öffentliche Website, ISR-gerendert, CMS-gesteuert (24 Seiten) |
| `src/app/(auth)/` | Anmeldung, 2FA, Registrierung, Passwort, Einladung, Verifikation (7 Seiten) |
| `src/app/(app)/admin/` | Administration inkl. `fuehrung/` (79 Seiten) |
| `src/app/(app)/portal/` | Mitarbeitendenportal (11 Seiten) |
| `src/app/(app)/konto/` | Kundenkonto (10 Seiten) |
| `src/app/api/` | 240 Route-Dateien; `/api/public/*` ohne Sitzung, `/api/cron/*` mit `CRON_SECRET` |
| `src/server/services/` | 46 Dienste — der einzige Ort, der Prisma schreibend nutzen soll |
| `src/lib/validation/` | 26 Zod-Module (Laufzeit + OpenAPI) |
| `src/lib/auth/` | `permissions.ts` (211 Berechtigungen, 10 Gruppen), `rbac.ts`, `session.ts`, `jwt.ts`, `totp.ts`, `password.ts` |
| `src/features/<bereich>/` | Client-Komponenten je Bereich (admin, fuehrung, portal, account, booking, marketing, messaging, shared) |
| `src/components/app/` | App-Shell, `PageHeader`, `KpiTile`, `FilterBar`, `DataList`, `ResourceForm`/`FormDialog`, `ActionButton`, `SortHeader`, `Pagination` |
| `src/components/ui/` | Basiskomponenten (Button, Input, Badge/StatusBadge, Overlays, Controls, Form) |
| `scripts/` | OpenAPI- und ERD-Generatoren, KPI-Backfill, `server-only`-Stub |
| `tests/api`, `tests/pages` | HTTP-Tests gegen den laufenden Server |
| `docs/` | `ARCHITECTURE.md`, `API.md`, `DATABASE.md`, `DEPLOYMENT.md`, `openapi.*`, `bi/` |

### Wichtige Dateien

| Datei | Rolle |
|---|---|
| `src/middleware.ts` | Vorfilter auf Edge: Signaturprüfung, `ROUTE_GUARDS`, `PERMISSION_ROUTES`, Refresh-Umleitung |
| `src/lib/api/handler.ts` | `defineRoute` / `definePublicRoute` / `defineCronRoute` — Origin-Prüfung, Sitzung, Berechtigungen, Rate-Limit, Zod, Fehlerabbildung |
| `src/lib/api/response.ts` | `toErrorResponse`, Antwort-Umschlag `{ data, meta }` |
| `src/lib/errors.ts` | 11 typisierte Fehlerklassen |
| `src/lib/pricing/engine.ts` | Preisberechnung (ausschliesslich serverseitig) |
| `src/lib/pdf/swiss-qr.ts` | QR-Rechnung SIX v2.3, Eigenimplementierung |
| `src/server/services/numbering.service.ts` | Lückenlose Belegnummern innerhalb der Transaktion |
| `src/lib/audit.ts` | Prüfprotokoll mit Redaktion sensibler Felder |
| `src/lib/logger.ts` | Eigener JSON-Logger mit PII-Maskierung |
| `src/lib/env.ts` | Zod-validierte Umgebung, `hasIntegration()` |
| `src/lib/cms/registry.ts`, `editable.tsx`, `preview.ts` | CMS-Blöcke, Vorschau-Wrapper, Iframe-Schutz |
| `scripts/openapi-routes.ts` | Handgepflegte Routenliste (3 403 Zeilen), muss den Schutz jeder Route spiegeln |

---

## 2. Frontend

### 2.1 Öffentliche Website `src/app/(public)/`

| Feature | Status | Ort | Details | Hinweise |
|---|---|---|---|---|
| Startseite | ✅ | `(public)/page.tsx` | ISR 3600 s, 33 CMS-Blöcke, Vorher-Nachher-Regler, Schnellschätzung → `/api/public/pricing/estimate`, JSON-LD | Bilder als rohes `<img>` in `before-after.tsx` |
| Leistungen (Übersicht/Detail) | ✅ | `leistungen/`, `leistungen/[slug]/` | ISR + `generateStaticParams`, CMS, CTA-Slots | |
| Preise | ✅ | `preise/page.tsx` | Preistabelle + FAQ-Akkordeon, 15 CMS-Blöcke | |
| Einsatzgebiet + PLZ-Prüfung | ✅ | `einsatzgebiet/page.tsx`, `PostalCodeCheck` | GET `/api/public/service-areas/check`, 350 ms Debounce | Keine Karte (Google-Maps-Schlüssel nur für Geocoding genutzt) |
| Galerie | ✅ | `galerie/page.tsx` | Vorher-Nachher-Slider aus `GalleryItem` | |
| Bewertungen | ✅ | `bewertungen/page.tsx` | ISR 1800 s, Verteilung, JSON-LD | |
| Über uns | ✅ | `ueber-uns/page.tsx` | Team aus `Employee` (`activeStaffWhere`) | |
| FAQ | ✅ | `faq/page.tsx` | FAQPage-JSON-LD | Nicht CMS-editierbar (Inhalte aus `Faq`-Modell) |
| Blog (Liste/Artikel) | ✅ | `blog/`, `blog/[slug]/` | ISR 1800 s, Markdown, JSON-LD | Liste ohne CMS-Blöcke |
| Karriere + Bewerbungsformular | ✅ | `karriere/`, `karriere/[slug]/`, `ApplicationForm` | Lebenslauf-Upload via `/api/files/upload-url`, Zod `jobApplicationSchema`, Honigtopf | |
| Kontaktformular | ✅ | `kontakt/page.tsx`, `ContactForm` | POST `/api/public/contact`, UTM-Felder, Honigtopf, Rate-Limit 6/h | |
| Offertanfrage | ✅ | `offerte/page.tsx`, `QuoteRequestForm` | POST `/api/public/quotes` → Lead (dedupliziert) + Offertentwurf + Meldung ans Büro | |
| Offerte online (Token) | ✅ | `offerte/[token]/page.tsx`, `QuoteResponse` | Annahme mit Unterschrift (`SignaturePad`), Ablehnung mit Grund, PDF | `noindex` |
| Rechnung online (Token) | ✅ | `rechnung/[token]/`, `PayInvoice` | TWINT/Karte via Stripe Checkout, QR-Angaben, PDF, Dankeseite | |
| Online-Buchung (6 Schritte) | ✅ | `buchen/page.tsx`, `src/features/booking/*` | zustand + `sessionStorage`, Preis via React Query (30 s), Verfügbarkeit `/api/public/availability`, Bestätigungsseite | Keine Zahlung im Ablauf (bewusst: Zahlung nach Einsatz) |
| Gast-Buchung verwalten (Token) | 🟡 | `buchung/[token]/page.tsx` | Zeigt Buchung an | Seite kündigt Verschieben/Absagen an, bietet aber keine Aktion; keine öffentlichen Endpunkte dafür |
| Newsletter (Anmelden/Bestätigen/Abmelden) | 🟡 | `site-footer.tsx`, `newsletter/bestaetigen`, `newsletter/abmelden` | Double-Opt-in | Bestätigen/Abmelden schreiben in der DB **während eines GET-Renders** (Prefetch-/Crawler-Risiko) |
| Rechtliche Seiten | ✅ | `legal/{agb,cookies,datenschutz,impressum}` | ISR 86400 s, `LegalDocument` mit Versionszähler | |
| Header/Navigation | ✅ | `src/components/marketing/site-header.tsx` | Dropdowns, Glas-Effekt, CTA-Slots aus DB, Konto-Button, Theme-Toggle rechts, Mobile-Sheet | Reihenfolge entspricht der Wunschliste |
| Footer | ✅ | `site-footer.tsx` | Adresse, Öffnungszeiten, Newsletter, Footer-CTAs | |
| Cookie-Banner | ✅ | `cookie-banner.tsx`, `src/lib/consent` | Gleichwertige Schaltflächen, Kategorien, Analytics erst nach Einwilligung | |
| KI-Chat-Widget | ✅ | `chat-widget.tsx` | SSE von `/api/public/ai/chat` | Telefonnummer im Fehlerfall hartkodiert (Z. 111) |
| SEO | 🟡 | `src/app/layout.tsx`, `sitemap.ts`, `robots.ts`, `src/lib/cms/metadata.ts` | Metadaten je Seite, Sitemap mit DB-Fallback, Robots sperrt interne Bereiche und KI-Crawler, JSON-LD auf 6 Seiten | `alternates.languages` verweist auf `/en`, `/fr`, `/it` — **diese Routen existieren nicht** |
| CMS-Editierbarkeit | 🟡 | `src/lib/cms/registry.ts`, `editable.tsx` | 10 Seiten nutzen `createCms` | `/offerte`, `/kontakt`, `/faq`, `/blog`, `legal/*`, `buchen/*` ohne CMS-Blöcke; Gruppen `contact`, `footer`, `legal` ohne Konsumenten |
| Fehler-/Ladegrenzen | ❌ | — | Kein `error.tsx`, `loading.tsx`, `not-found.tsx` unter `(public)` | Fehler fallen auf `src/app/error.tsx` zurück und verlieren das Website-Layout |

### 2.2 Authentifizierung `src/app/(auth)/`

| Feature | Status | Ort | Details | Hinweise |
|---|---|---|---|---|
| Anmeldung (ein Portal für alle Rollen) | ✅ | `auth/anmelden`, `src/features/auth/login-form.tsx` | Zod `loginSchema`, Weiterleitung nach Rolle über `homeRouteFor`, `?weiter=` nur über `safeReturnPath`, Hinweise `?grund=inaktiv|abgelaufen` | |
| Zweiter Faktor (TOTP) | ✅ | `auth/bestaetigen`, `two-factor-form.tsx` | 6 Einzelfelder, Auto-Submit, Wiederherstellungscode | |
| Registrierung (nur Kundschaft) | ✅ | `auth/registrieren`, `register-form.tsx` | Passwort-Stärkeanzeige, AGB/Marketing-Einwilligung, Honigtopf | |
| Passwort vergessen / neu | ✅ | `auth/passwort-vergessen`, `auth/passwort-neu` | POST/PATCH `/api/auth/password` | `passwort-vergessen` ist die einzige nicht-dynamische Auth-Seite |
| Einladung annehmen | ✅ | `auth/einladung` | `SetPasswordForm mode="invite"` | |
| E-Mail-Verifikation | ✅ | `auth/verifizieren` | Ruft `verifyEmail()` serverseitig beim Rendern | Kein eigener API-Endpunkt; Seite ist der Endpunkt |
| Abmelden | ✅ | `app-shell.tsx`, `session-keepalive.tsx` | POST `/api/auth/logout`, automatisch nach Inaktivität | |
| Auth-Layout | 🟡 | `(auth)/layout.tsx` | Zeigt hervorgehobene Bewertung | **Jede** Auth-Seite macht dafür eine DB-Abfrage; kein `loading.tsx`/`error.tsx` im Segment |

### 2.3 Administration `src/app/(app)/admin/`

Alle Seiten sind Server Components, lesen über Dienste oder Prisma und schützen sich mit `requirePermission()` bzw. `requirePagePermission()`; Schaltflächen werden mit `can()` entschieden. 78 von 79 Seiten haben eine Berechtigungsprüfung (Ausnahme: `admin/profil`, das nur `requireSession()` braucht).

| Feature | Status | Ort | Details | Hinweise |
|---|---|---|---|---|
| Dashboard | ✅ | `admin/page.tsx`, `src/components/charts/` | 8 KPI-Kacheln, 4 recharts-Diagramme (lazy), `RangePicker` | |
| Einsatzkalender (Disposition) | ✅ | `admin/kalender`, `src/features/admin/dispatch-calendar.tsx` | FullCalendar Tag/Woche/Liste, 00:00–24:00, Ziehen/Ablegen → `/api/jobs/[id]/move`, Team → `/assign` | Wunschliste (01–24 Uhr) erfüllt |
| Buchungen Liste/Detail/Bearbeiten | ✅ | `admin/buchungen/*`, `booking-editor.tsx`, `booking-actions.tsx` | Filter/Sortierung/Blättern, Statuswechsel, Löschen, Bearbeitungsformular | |
| Einsätze Liste/Detail | ✅ | `admin/einsaetze/*` | Bearbeiten, Checkliste, Team, Nachkalkulation, Material, Fotos, Bericht (6 `can()`-Blöcke) | |
| Offerten Liste/Neu/Detail/Bearbeiten | ✅ | `admin/offerten/*`, `quote-editor.tsx` | Kundschaft inline anlegen, Einheit je Leistung (`unitForService`), Positionen, Rabatt, PDF, Senden, Duplizieren, Umwandeln | Rechnung: `computeQuoteTotals` mit Zeilenrabatt, Gesamtrabatt, MwSt. je Position, `round2` |
| Leads Liste/Kanban/Neu/Detail/Bearbeiten | ✅ | `admin/leads/*`, `lead-form.tsx`, `lead-pipeline.tsx` | Pipeline mit Drag, Aktivitäten, Umwandlung in Kundschaft, Deduplizierung serverseitig | |
| Kundschaft Liste/Neu/Detail | ✅ | `admin/kunden/*` | CSV-Export, Bearbeiten-Dialog, Löschen, Zusammenführen, Adressen, Objekte, Aktivitäten | `CustomerForm` nur für Anlage; Bearbeiten über separaten Dialog (Konvention „Formular wiederverwenden" nicht angewandt) |
| Objekte | ✅ | `admin/objekte` | Zeilenaktionen, Filter/Blättern | |
| Aufgaben | ✅ | `admin/aufgaben` | Erstellen, Bearbeiten, Erledigen, Löschen | Ohne Filterleiste |
| Nachrichten | ✅ | `admin/nachrichten`, `src/features/messaging/` | React Query, Threads, Antworten | |
| Rechnungen Liste/Neu/Detail | ✅ | `admin/rechnungen/*`, `invoice-form.tsx`, `invoice-actions.tsx` | KPI, CSV, Ausstellen, Senden, Stornieren, Zahlung erfassen, PDF | Keine Gutschrift-Schaltfläche (kein Endpunkt) |
| Zahlungen | ✅ | `admin/zahlungen` | Liste, KPI, Zeilenaktionen | |
| Ausgaben / Lieferanten | ✅ | `admin/ausgaben` | Tabs, Dialoge, Zeilenaktionen | |
| Auswertungen | ✅ | `admin/auswertungen`, `export-panel.tsx` | Berichte, Excel/CSV, Buchhaltungsexport | |
| Personal Liste/Neu/Detail | ✅ | `admin/personal/*`, `employee-form.tsx`, `employee-actions.tsx` | Abwesenheiten entscheiden, Konto-Aktionen (Zugangslink, Sperre, Foto), Dokumente, Lohnhistorie | `EmployeeForm` nur für Anlage |
| Bewerbungen / Stellen | ✅ | `admin/personal/bewerbungen` | Status, Stellenverwaltung | |
| Bewertungen | ✅ | `admin/bewertungen`, `review-moderation` | Freigeben, Antwortentwurf (KI) | |
| Blog | ✅ | `admin/blog` | KI-Entwurf, Bearbeiten, Veröffentlichen, Löschen | |
| Marketing (Newsletter/Gutscheine) | 🟡 | `admin/marketing` | Abonnentenliste, Gutscheine | **Kein Newsletter-Versand** (kein Endpunkt trotz `newsletter:create`) |
| KI-Werkstatt | ✅ | `admin/ki`, `ai-workspace` | Offertentwurf, E-Mail, Zusammenfassung, Übersetzung, Blog | |
| Medienbibliothek | 🟡 | `admin/medien`, `media-library.tsx` | Umbenennen, Löschen, Filter | **Kein Upload-Element** auf der Seite, obwohl `canUpload` übergeben wird |
| Website-Texte (CMS in place) | ✅ | `admin/inhalte`, `src/components/cms/preview-bridge.tsx` | Echte Website im Iframe, `contentEditable`, Entwurf → Publikation → Revisionen | Wunschliste erfüllt |
| Website (FAQ/Galerie/Menü/Rechtstexte) | ✅ | `admin/website`, `website-workspace.tsx` | 4 Formulare, 9 `can()`-Blöcke | |
| Handlungsaufrufe (CTA) | ✅ | `admin/cta` | Anlegen, Bearbeiten, Publizieren, Reihenfolge, Papierkorb | |
| SEO | ✅ | `admin/seo`, `seo-editor` | | Kein `GET /api/seo`; Seite liest direkt |
| Benutzer | ✅ | `admin/benutzer`, `user-workspace.tsx` | Einladen, Rolle, Sperren, Passwortlink, 2FA-Reset, Löschen/Wiederherstellen | |
| Rollen | 🟡 | `admin/rollen` | Berechtigungsmatrix | Nur lesend; Rollenvergabe nur über Benutzer/Personalakte |
| Prüfprotokoll | ✅ | `admin/protokoll` | Filter/Blättern, nur SUPER_ADMIN | Seite verspricht Aufbewahrungsfrist, die es im Backend nicht gibt |
| Papierkorb | ✅ | `admin/papierkorb`, `trash.service.ts` | 7 Modelle, Wiederherstellen/Endgültig löschen mit Fachsperren | |
| Einstellungen (7 Tabs) | ✅ | `admin/einstellungen/*` | Firma, Arbeitszeiten, Katalog, Finanzen, Betrieb/Feiertage, Automationen, Integrationen; Unterseiten Gebiet, Leistungen (5 Formulare) | Integrationen nur Statusanzeige |
| Profil | ✅ | `admin/profil` → `konto/profil` | Avatar-Upload, Kontaktdaten, Benachrichtigungen, Passwort, 2FA, Farbschema | Einzige Admin-Seite ohne Berechtigungsprüfung (fachlich korrekt) |
| `not-found.tsx` unter `(app)` | ❌ | — | `requirePagePermission()` und `notFound()` auf ~10 Seiten fallen auf das Wurzel-404 ohne App-Shell | |

### 2.4 Unternehmensführung `src/app/(app)/admin/fuehrung/`

| Feature | Status | Ort | Details | Hinweise |
|---|---|---|---|---|
| Cockpit | ✅ | `fuehrung/page.tsx` | Gesundheitswert (`HealthGauge`), Risikomatrix, Roadmap, Assistent | |
| Kennzahlen Liste/Detail | ✅ | `fuehrung/kennzahlen/*` | Verlauf aus `KpiSnapshot`, manuelle Werte, Ziele, Gewichte | |
| Ziele (OKR/Strategie/Roadmap) | ✅ | `fuehrung/ziele/*` | `ResourceForm`, Key Results, Check-in, Duplizieren, Review | |
| Budget | ✅ | `fuehrung/budget/*` | Zeilen-Editor, Genehmigen (friert ein), Abschliessen, Abweichung | MANAGER ohne Zugriff (gewollt) |
| Investitionen | ✅ | `fuehrung/investitionen/*` | Abschreibungsplan, Anlagenverzeichnis | |
| Szenarien | ✅ | `fuehrung/szenarien/*` | Editor, Berechnen, Vergleich, Vorschlag | |
| Risiken | ✅ | `fuehrung/risiken/*` | Matrix, Review | |
| Qualität/Compliance | ✅ | `fuehrung/qualitaet/*` | Kontrollen, Review | |
| Massnahmen (CAPA) | ✅ | `fuehrung/massnahmen` | Statuswechsel | Kein `GET /api/bi/actions/[id]`, nur PATCH |
| Dokumente | ✅ | `fuehrung/dokumente/*`, `document-upload.tsx` | Versionen, Fristen, Sichtbarkeit (`EMPLOYEE_PRIVATE`), auditierter Download | |
| Wissen | ✅ | `fuehrung/wissen/*` | Artikel mit Sichtbarkeit | |
| Markt (Wettbewerber, SWOT/PESTEL) | ✅ | `fuehrung/markt/*`, `analysis-board-editor` | | |
| Sitzungen | ✅ | `fuehrung/sitzungen/*`, `MeetingForm` | Pendenzen | Formular wird für Neu und Bearbeiten wiederverwendet |
| Berichte | ✅ | `fuehrung/berichte`, `ReportTools` | PDF/Excel/Word, Zeitpläne, Download | `/api/bi/reports` ohne DELETE |
| Assistent | ✅ | `fuehrung/assistent` | `reasoning`, `dataSources`, `confidence` | Ohne `ANTHROPIC_API_KEY` → 503 (getestet) |
| Sortierung in Führungslisten | ❌ | — | Filter und Blättern vorhanden, kein `SortHeader` | |

### 2.5 Mitarbeitendenportal `src/app/(app)/portal/`

| Feature | Status | Ort | Details | Hinweise |
|---|---|---|---|---|
| Tagesübersicht | ✅ | `portal/page.tsx` | Aktive Zeiterfassung, KPI, Heute/Woche, Abwesenheiten | |
| Einsätze Liste/Detail | ✅ | `portal/einsaetze/*`, `job-workspace.tsx`, `time-clock.tsx` | Ein-/Ausstempeln mit Standort, Checkliste (optimistisch), Fotos (signierter Upload), Abschluss mit Bericht und Unterschrift | Pflichtpunkte der Checkliste erzwungen |
| Zeiterfassung | ✅ | `portal/zeiterfassung` | Zeitraum, Soll 8,4 h/Arbeitstag, Saldo | Nur lesend; keine Korrektur/Freigabe im UI (Berechtigung `timetracking:approve` existiert) |
| Abwesenheiten | ✅ | `portal/abwesenheiten` | Antrag, Rückzug, Feriensaldo | |
| Lohn | 🟡 | `portal/lohn` | Echte `Payslip`-Daten, Abzüge AHV/IV, ALV, BVG, UVG, PDF-Link | Abrechnungen können über **keinen Endpunkt** erzeugt werden; `pdfUrl` wird nirgends befüllt |
| Kalender | ✅ | `portal/kalender`, `personal-calendar.lazy.tsx` | FullCalendar, `/api/jobs/calendar` | |
| Wissen | ✅ | `portal/wissen/*` | `knowledge:read` | Ohne `loading.tsx` |
| Ziele | ✅ | `portal/ziele` | Eigene + Firmenziele, Check-in | Ohne `loading.tsx` |
| Profil | 🟡 | `portal/profil` | Re-Export der Konto-Profilseite | Keine Beschäftigungsdaten (Pensum, Vertrag) für Mitarbeitende sichtbar |

### 2.6 Kundenkonto `src/app/(app)/konto/`

| Feature | Status | Ort | Details | Hinweise |
|---|---|---|---|---|
| Übersicht | ✅ | `konto/page.tsx` | Nächste Termine mit Team, offene Rechnungen/Offerten, Empfehlungscode | |
| Buchungen Liste/Detail | ✅ | `konto/buchungen/*`, `booking-actions.tsx` | Verschieben/Absagen (`/api/account/bookings/[id]/*`), 24-h-Sperre | Telefonnummer hartkodiert (Z. 97, 99) |
| Offerten | ✅ | `konto/offerten` | Entwürfe ausgeblendet, PDF | |
| Rechnungen Liste/Detail | ✅ | `konto/rechnungen/*` | Blättern, Summen, Online-Zahlung (Stripe), PDF | |
| Objekte + Adressen | ✅ | `konto/objekte` | Vollständiges CRUD | |
| Nachrichten | ✅ | `konto/nachrichten`, `account/messages.tsx` | React Query | |
| Bewertungen | ✅ | `konto/bewertungen`, `ReviewForm` | Eigene Bewertungen mit Status | |
| Profil (geteilt) | ✅ | `konto/profil`, `src/features/account/*` | Avatar-Upload, Kontaktdaten, Benachrichtigungen, Passwort, 2FA, Farbschema | Ohne `loading.tsx` |
| Layout-Rollenprüfung | ⚠️ | `konto/layout.tsx` | Nur Sitzungsprüfung, keine eigene Rollenprüfung (anders als `portal/layout.tsx`) | Verlässt sich auf `ROUTE_GUARDS` in der Middleware — mit CVE-2025-29927 relevant (siehe Abschnitt 4) |

### 2.7 Querschnittsthemen

| Feature | Status | Ort | Details | Hinweise |
|---|---|---|---|---|
| Framework/Architektur | ✅ | `docs/ARCHITECTURE.md` | Server Components lesen, Route Handler schreiben; keine Server Actions | Konsistent umgesetzt |
| App-Shell | ✅ | `src/components/app/app-shell.tsx` | Sidebar `lg:`, Mobile-Sheet, Brotkrumen, Glocke, Konto-Menü, `SessionKeepalive`, `ThemeSync` | Kein gemeinsames `(app)/layout.tsx`; Sitzungslogik dreifach in admin/konto/portal |
| Rollenbasierte Navigation | ✅ | `app-shell.tsx`, `filterNavigation` | Navigation serverseitig gebaut und je Rolle gefiltert; Badges aus 8 parallelen Zählungen | |
| Formulare (react-hook-form + Zod) | 🟡 | 28 Dateien, z. B. `customer-form.tsx` | Client-Zod aus `src/lib/validation` | Server-422-Feldfehler landen **nicht** am Feld, nur als globaler Text (`customer-form.tsx:78-81`) |
| Formulare (`ResourceForm`/`FormDialog`) | ✅ | `src/components/app/resource-form.tsx` | `FieldSpec[]`, Feldfehler aus `ApiError.fieldErrors`, `role="alert"` | Client-Validierung nur „Pflichtfeld" |
| Aktionen (`ActionButton`) | ✅ | `src/components/app/action-button.tsx` | POST/PATCH/DELETE, Bestätigungsdialog, Notiz, Toast | |
| Tabellen/Listen | 🟡 | `page-parts.tsx`, `data-list.tsx`, `sort-header.tsx` | `TableScroll`, `DataList`, Blättern über `seite`, `aria-sort` | Sortierung nur auf 6 von ~20 Listen; `DataListHeader` ist `aria-hidden` |
| Suche/Filter | ✅ | `filter-bar.tsx` | URL-gesteuert, setzt `seite` zurück | Auf 21 Seiten |
| Modale/Dialoge | ✅ | `src/components/ui/overlays.tsx` | Radix Dialog/Sheet/Dropdown/Popover/Tooltip | Fokusfalle, Esc, `aria-modal` |
| Benachrichtigungen (Glocke) | ✅ | `notification-panel.tsx`, `app-shell.tsx:221` | Zähler alle 30 s, Liste bei Öffnen, gelesen/alle gelesen | Datensätze entstehen in `notification.service.ts:79` (IN_APP) |
| Toasts | ✅ | `src/components/providers.tsx` | sonner, unten rechts, 5 s | |
| State-Management | ✅ | `providers.tsx`, `src/features/booking/store.ts` | React Query nur für Kalender/Preis/Nachrichten/Glocke; zustand nur im Buchungsassistenten; sonst `router.refresh()` | Entspricht der Architekturregel |
| API-Client | ✅ | `src/lib/api/client.ts` | `{data, meta}`-Umschlag, `ApiError` mit `fieldErrors`, 401 → einmaliger Refresh über geteiltes Promise, Download | |
| Sitzungs-Keepalive | ✅ | `session-keepalive.tsx` | Proaktives Refresh bei Aktivität, Abmeldung nach `SESSION_IDLE_TTL` | |
| Ladezustände | 🟡 | 53 `loading.tsx` | Skelette aus `page-skeletons.tsx` | Fehlen unter `(public)`, `(auth)`, `konto/profil`, `portal/profil`, `portal/wissen*`, `portal/ziele` |
| Fehlergrenzen | 🟡 | `src/app/error.tsx`, `(app)/*/error.tsx` | `AreaError` je Bereich | Fehlen unter `(public)` und `(auth)`; kein `not-found.tsx` unter `(app)` |
| Datei-Uploads | ✅ | `job-photos.tsx`, `document-upload.tsx`, `image-field.tsx`, `avatar-uploader.tsx` | Signierte URL → PUT direkt zu Supabase oder `/api/files/blob/[id]` | Medienbibliothek ohne Upload (siehe 2.3) |
| Theme (Hell/Dunkel/System) | ✅ | `providers.tsx`, `theme-toggle.tsx`, `globals.css` | `defaultTheme="system"`, `attribute="class"`, Sun/Moon/Monitor-Icons, Konto-Präferenz via `ThemeSync`, vollständige Token-Sets `:root`/`.dark` | Wunschliste erfüllt |
| Responsive | ✅ | `app-shell.tsx`, `site-header.tsx`, Buchung | `sm`/`lg`-Strategie, Sheet-Navigation, feste Breiten mit `max-w-[calc(100vw-2rem)]` gedeckelt, Tests `tables.test.ts` | Kein Zwischenzustand (eingeklappte Sidebar) |
| Barrierefreiheit | 🟡 | global | `lang="de-CH"`, Skip-Link, `:focus-visible`, `prefers-reduced-motion`, 292 `aria-*`, Labels automatisch verdrahtet, `aria-current`, `aria-sort`, jedes `<img>` mit `alt` | `DataListHeader` `aria-hidden`; Vorher-Nachher-Regler nur Maus/Touch (`before-after.tsx:160`) |
| Performance | 🟡 | `next.config.ts`, `*.lazy.tsx`, `charts/lazy.tsx` | `next/font`, ISR, `optimizePackageImports`, FullCalendar/recharts lazy, `@react-pdf` nur serverseitig, Middleware nur auf App-Bereichen | Öffentliche Seiten nutzen kein `next/image` (AVIF/WebP-Pipeline ungenutzt) |
| Mehrsprachigkeit | ❌ | — | Alles hartkodiert Deutsch; `locale` nur als DB-Spalte | `alternates.languages` verweist auf nicht existierende Routen |
| Sprachkonsistenz (Deutsch) | ✅ | überall | Keine englischen UI-Texte oder Kommentare gefunden; nur technische Bezeichner | |

---

## 3. Backend

### 3.1 Infrastruktur

| Feature | Status | Ort | Details | Hinweise |
|---|---|---|---|---|
| Routen-Fabrik | ✅ | `src/lib/api/handler.ts` | Origin-Prüfung → IP → Sitzung → Rollen → Berechtigungen → Rate-Limit → Zod (Body/Query/Params) → Handler → `toErrorResponse` | 3 Routen ohne Fabrik, alle begründet: Stripe-Webhook, `files/blob/[id]`, `content/preview` |
| Validierung | ✅ | `src/lib/validation/` (26 Module) | Jede Body-Route deklariert ein Schema; kein direktes `request.json()`; deutsche Meldungen; `orderBy` nur über Whitelists | Speist auch OpenAPI |
| Fehlerklassen | 🟡 | `src/lib/errors.ts`, `src/lib/api/response.ts` | 11 Klassen; `BusinessRuleError` 422; Prisma P2002/P2025/P2003 abgebildet; Stacks in Produktion unterdrückt | **`ValidationError` = 400, `ZodError` = 422 mit demselben Code `VALIDATION_ERROR`** |
| Antwort-Umschlag | ✅ | `response.ts` | `{ data, meta }`, `serialize()` für Decimal/Date/BigInt | Vollständige JSON-Runde je Antwort |
| Logging | 🟡 | `src/lib/logger.ts` | Eigener JSON-Logger, PII-Maskierung (E-Mail, Telefon, IBAN, AHV, Tokens), Secret-Denylist, `LOG_LEVEL` | **Kein Request-Logging**; `LOG_LEVEL` fehlt in `.env.example` |
| Prüfprotokoll (Audit) | 🟡 | `src/lib/audit.ts`, ~190 Aufrufstellen | Akteur, Entität, Diff mit Redaktion, IP, User-Agent; 12 Aktionsarten; Exporte auditiert; nur SUPER_ADMIN liest | **Keine Aufbewahrungs-/Löschlogik** (`auditLog.deleteMany` existiert nicht), Tabelle wächst unbegrenzt |
| Rate-Limiting | 🟡 | `src/lib/rate-limit.ts`, `src/lib/redis.ts` | 13 Kontingente (login 8/5 min, register 5/h, passwordReset 4/h, quoteRequest 10/h, aiChat 60/h …) | Ohne `REDIS_URL` prozesslokal → in Serverless faktisch wirkungslos; `webhook`-Kontingent definiert, aber nicht angewandt |
| OpenAPI/ERD-Generatoren | ✅ | `scripts/generate-openapi.ts`, `openapi-discover.ts`, `generate-erd.ts` | Bricht bei undokumentierter Route oder Schutzabweichung ab | `openapi-routes.ts` mit 3 403 Zeilen handgepflegt |
| DB-Verbindung | ✅ | `src/lib/db.ts` | Singleton, `connection_limit=1` für PgBouncer, `DIRECT_URL` für Migrationen | |
| Caching | ✅ | `src/lib/redis.ts` `cache.remember`, 23 Aufrufe in 12 Dateien | Cache-Aside mit `cacheKeys`-Registry und `invalidate*`-Funktionen; `React.cache` für `getSession` | Kein `unstable_cache`/`revalidateTag` |

### 3.2 Authentifizierung und Autorisierung

| Feature | Status | Ort | Details | Hinweise |
|---|---|---|---|---|
| Passwort-Hashing | ✅ | `src/lib/auth/password.ts` | Argon2id 19 456 KiB / t=2 / p=1 (OWASP 2024) | |
| Passwort-Richtlinie | 🟡 | `src/lib/validation/common.ts:31` | min 10, max 128, Gross/Klein/Ziffer | Kein Sonderzeichen; **kein Breach-Check (HIBP)** |
| JWT / Cookies | ✅ | `src/lib/auth/jwt.ts` | HS256, `iss`/`aud`, `typ`-Prüfung, `clenaris_at`/`clenaris_rt`, httpOnly, `sameSite=lax`, `secure` in Produktion | `secure` hängt an `NODE_ENV` |
| Refresh-Rotation | ✅ | `session-refresh.service.ts` | Familie, Wiederverwendung sperrt Familie, Idle-Fenster serverseitig, SHA-256-Hash in DB | Getestet |
| Sitzungswiderruf | ✅ | `session.ts:114`, `user.service.ts`, `auth.service.ts` | `sessionsRevokedAt` vs `iat` bei Sperre, Rollenwechsel, Passwortänderung, 2FA-Reset | Kostet eine PK-Abfrage je Request (bewusst) |
| Konto-Sperre | ✅ | `auth.service.ts:44` | 8 Fehlversuche → 15 min; Dummy-Argon2 gegen Timing; identische Fehlermeldung | Nicht getestet |
| Registrierung | ✅ | `auth.service.ts:75` | Nur `CUSTOMER`; Einwilligungen mit IP | |
| Passwort-Reset | ✅ | `auth.service.ts:303-390` | 32-Byte-Token, SHA-256, 60 min, einmalig, ältere entwertet, immer gleiche Antwort | |
| Einladung | ✅ | `inviteUser`, `acceptInvite`, `sendAccessLinkFor` | 7 Tage, `mustChangePassword` | |
| 2FA (TOTP) | ⚠️ | `src/lib/auth/totp.ts`, `two-factor.service.ts` | RFC 6238 eigen, ±1 Fenster, `timingSafeEqual`, 10 Argon2-gehashte Wiederherstellungscodes, MFA-Cookie 5 min, Admin-Reset | **`twoFactorSecret` liegt im Klartext (Base32) in der DB**; MFA-Cookie ist als Access-Token signiert (nur durch anderen Cookie-Namen getrennt) |
| Berechtigungskatalog | ✅ | `src/lib/auth/permissions.ts` | 211 flache `resource:action`, 10 Gruppen, `scoped`-Markierung, Meta-Pflicht erzwungen durch Typ | |
| Rollen-Grants | ✅ | `src/lib/auth/rbac.ts` | SUPER_ADMIN 211, ADMIN 208, MANAGER ~100, EMPLOYEE 22, CUSTOMER 18, GUEST 0; `ROLE_RANK`, `assignableRoles` | |
| Impersonation | ❌ | `permissions.ts:256`, `rbac.ts:215` | Berechtigung `user:impersonate` deklariert | **Keine Route, kein Dienst** — totes Versprechen in der Rechtematrix |
| Middleware | ✅ | `src/middleware.ts` | Nur Signaturprüfung, `ROUTE_GUARDS`, `PERMISSION_ROUTES`, Refresh-Umleitung, `noindex`/`no-store` | Vorfilter, keine Autorisierung (dokumentiert) |
| Eigentümerschaft (read_own) | ✅ | `property.service.ts:40`, `document.service.ts:36`, `objective.service.ts:34`, `knowledge.service.ts:34`, `address.service.ts:47`, `booking.service.ts:1343` | Im `where`, nicht im Rendering; Sentinel `'__keines__'` gegen leere Filter | Rechnung/Nachricht nur auf Seitenebene gescoped (siehe 3.3) |
| Benutzerverwaltung | ✅ | `src/app/api/users/*`, `user.service.ts` | Einladen, Liste, Sperren, Rolle (Selbstschutz, Rang, letzter SUPER_ADMIN), Passwortlink, 2FA-Reset, Löschen/Wiederherstellen | Kein `GET /users/[id]` |

### 3.3 API-Domänen

| Domäne | Status | Endpunkte | Lücken / Hinweise |
|---|---|---|---|
| auth | ✅ | login, logout, register, refresh (GET+POST), session, password (POST+PATCH), 2fa (5) | E-Mail-Verifikation nur über Seite |
| users | ✅ | GET/POST, [id] PATCH/DELETE, role, 2fa, password-reset, restore | kein GET by id |
| employees | 🟡 | GET/POST, [id] GET/PATCH/DELETE | Keine Endpunkte für Lohn, Timesheet, Ferien |
| absences | ✅ | GET/POST, decide, withdraw | bewusst kein DELETE |
| time | 🟡 | clock-in, clock-out | Keine Korrektur/Freigabe trotz `timetracking:approve` |
| customers | 🟡 | CRUD, addresses CRUD, merge (GET+POST), restore | **Keine Anonymisierung** (`anonymizeCustomer` ohne Route) |
| properties | ✅ | CRUD + restore | |
| leads | ✅ | GET/POST, [id] PATCH/DELETE, convert, restore | kein GET by id, Pipeline-Daten nur über Seite |
| quotes | ✅ | CRUD, send, convert, duplicate, pdf, restore | |
| bookings | 🟡 | GET, [id] GET/PATCH/DELETE, cancel, confirm, reschedule, restore, invoice; account/bookings cancel+reschedule | **Kein authentifiziertes `POST /bookings`** — Anlage nur über `/api/public/bookings` |
| jobs | 🟡 | [id] CRUD, assign, team, checklist, complete, costing, move, photos, report, restore, calendar | **Kein `GET /jobs`, kein `POST /jobs`** (`createJob` ungenutzt); Einsätze entstehen nur aus Buchungen |
| invoices | 🟡 | GET/POST, [id] PATCH/DELETE, issue, send, cancel, payments, pdf, restore | Kein GET by id; **keine Gutschrift-Route** (`createCreditNote` ungenutzt) |
| payments | ✅ | GET, [id] PATCH/DELETE | Erfassung über Rechnung (gewollt) |
| expenses / suppliers / tasks | ✅ | GET/POST, [id] PATCH/DELETE | Kein Dienst — Logik in der Route |
| messages | ✅ | GET/POST, [id] GET/POST | Kein Schliessen/Löschen; Eigentümerschaft in der Route |
| notifications | ✅ | GET, count, read, read-all | |
| reviews | ✅ | GET/POST, [id] PATCH/DELETE, reply-draft | Eigentümerfilter in `reviews/route.ts:38` |
| blog / gallery / faq / job-postings / holidays / coupons / price-rules / tax-rates / service-categories / service-extras / navigation | ✅ | GET/POST + [id] PATCH/DELETE (blog auch GET) | |
| services / catalog | ✅ | CRUD + reorder | |
| cta | ✅ | CRUD, publish, restore, reorder | |
| seo | 🟡 | PATCH | kein GET |
| content / CMS | ✅ | content PATCH/POST, asset PATCH, revisions GET/POST, preview GET | Asset-Allowlist `src/lib/cms/assets.ts` |
| legal | ✅ | GET, [slug] GET/PUT | |
| media / files | ⚠️ | media GET/POST, [id] PATCH/DELETE; upload-url; blob PUT/GET | Blob-Route ohne Sitzung (Adresse = Berechtigung) |
| newsletter | 🟡 | GET, [id] DELETE | **Kein Versand** |
| applications | 🟡 | [id] GET/PATCH/DELETE; public POST | Keine Sammelliste per API |
| activities | 🟡 | POST | Kein GET trotz `activity:read` |
| settings / company / opening-hours | ✅ | GET+PATCH / GET+PATCH / GET+PUT | |
| templates | ✅ | GET, email/[id] PATCH, sms/[id] PATCH | Anlegen/Löschen bewusst nicht |
| automations | ✅ | CRUD | |
| service-areas | ✅ | CRUD + bulk | |
| exports | ✅ | buchhaltung POST, kunden/rechnungen/zeiterfassung GET | Auditiert; nicht getestet |
| ai | ✅ | blog-draft, dispatch, email, quote-draft, summarize, translate | `ai:use` (MANAGER+) |
| bi/* | ✅ | 62 Routen (KPIs, Ziele, Budget, Investitionen, Szenarien, Risiken, Kontrollen, Massnahmen, Dokumente, Wissen, Markt, Sitzungen, Berichte, Cockpit, Assistent) | `reports` ohne DELETE |
| webhooks | ✅ | stripe POST | Signatur, Idempotenz, 3 Events |
| cron | ✅ | daily, hourly | |
| public/* | ✅ | 13 Routen | alle `definePublicRoute`, alle mit Rate-Limit |

### 3.4 Dienste

| Feature | Status | Ort | Details | Hinweise |
|---|---|---|---|---|
| Dienstschicht | 🟡 | `src/server/services/` (46) | Vollständige Fachlogik für CRM, Buchung, Einsatz, Rechnung, Katalog, CMS, Personal, Unternehmensführung | **49 Route-Dateien greifen direkt auf Prisma zu** (Reviews, Messages, Tasks, Expenses, Suppliers, Blog, Activities, SEO, Settings, Payments, Applications haben keinen Dienst) |
| Dienstfunktionen ohne Endpunkt | 🟡 | `invoice.service.ts`, `employee.service.ts`, `crm.service.ts`, `job.service.ts` | `createCreditNote`, `generatePayslip`, `anonymizeCustomer`, `createJob`, `listJobs`, `createInvoiceFromQuote` | Fachlich fertig, per API nicht erreichbar |
| Preis-Engine | 🟡 | `src/lib/pricing/engine.ts` | 7 Stufen: Grundpreis (5 Modelle), Zusätze, Anfahrt nach PLZ, Preisregeln, Frequenzrabatt, Kundenrabatt + Gutschein, Mindestwert/MwSt.; MwSt. aus `service.vatRate` (Default 8.1) | **Keine 5-Rappen-Rundung** — `roundToRappen()` in `src/lib/utils.ts:160` existiert, wird nicht verwendet; kein Unit-Test |
| Belegnummern | ✅ | `numbering.service.ts` | `NumberSequence` mit `upsert` + `increment` in derselben Transaktion; Nummer erst beim Ausstellen | Art. 957a OR |
| Rechnungen | ✅ | `invoice.service.ts` | Ausstellen nur aus DRAFT, `qrReference`, PDF fehlertolerant, Zahlung idempotent (`providerPaymentId`), Toleranz 0.05, Mahnwesen 3 Stufen mit Gebühren, SMS ab Stufe 2 | Gutschrift ohne Route |
| QR-Rechnung | ⚠️ | `src/lib/pdf/swiss-qr.ts` | SIX v2.3 eigen, QR-IBAN-Erkennung (30000–31999), Modulo-10-rekursiv | **Kein Test mit festen Erwartungswerten** (in `ARCHITECTURE.md` selbst als Lücke benannt) |
| Buchungen | ✅ | `booking.service.ts` | Serien, Umbuchen, Absagen, Gast-Token, Eigentümerschaft | |
| Einsätze | ✅ | `job.service.ts` (21 Funktionen) | Disposition, Team mit Rollen, Checkliste, Fotos, Material, Nachkalkulation, Lohnkosten | |
| CRM | ✅ | `crm.service.ts` | Lead-Deduplizierung (E-Mail, Telefon, Name+Firma), Umwandlung, Kunden-Merge, Duplikatsuche, Anonymisierung | Wunschliste (keine doppelten Leads) erfüllt |
| Lohn | 🟡 | `employee.service.ts:758-836` | `SOCIAL_RATES` im Code: AHV/IV/EO 5.3 %, ALV 1.1 % bis 12 350, UVG 0.73 %, **BVG pauschal 7 % als Näherung**; Brutto aus Monatslohn×Pensum oder Stunden×Satz; `Payslip` upsert | Kein Endpunkt, kein Lohnausweis-PDF, keine Quellensteuer, keine Familienzulagen, kein Swissdec |
| Analytik | ✅ | `analytics.service.ts` | Dashboard-KPIs, Umsatzreihe, Auslastung, P&L, MwSt.-Bericht, Cashflow-Prognose; 9 parametrisierte `$queryRaw` | Nur von Seiten genutzt |
| Unternehmensführung | ✅ | `kpi`, `objective`, `budget`, `investment`, `scenario`, `governance`, `document`, `knowledge`, `meeting`, `bi-report`, `cockpit`, `health`, `insight`, `fuehrung` | Snapshots gespeichert, Nachtlauf 6 Schritte, reine Mathematik in `src/lib/bi/math.ts` getestet | |
| Papierkorb | ✅ | `trash.service.ts` | 7 Modelle mit Fachsperren | 19 Modelle haben `deletedAt`; 12 ohne Wiederherstellung |
| Benachrichtigungs-Dispatcher | ✅ | `notification.service.ts` | IN_APP/EMAIL/SMS, Kanalpräferenzen, Marketing-Opt-in, gesperrte Konten | |

### 3.5 Datenbank

| Feature | Status | Ort | Details | Hinweise |
|---|---|---|---|---|
| Schema | ✅ | `prisma/schema.prisma` (3 700 Zeilen) | 111 Modelle, 67 Enums, 131 `@@index`, 47 `@@unique`, 62 `organizationId`-Felder, `Decimal(12,2)` für Beträge, `timestamptz` | |
| Migrationen | ⚠️ | `prisma/migrations/` (12) | `20260904090000_init` … `20260914140000_personal_stammdaten_lohnhistorie` | Letzte Migration handbearbeitet (Datenrückfüllung); `prisma migrate reset` tabu (siehe `CLAUDE.md`) |
| Seed | ✅ | `prisma/seed.ts` (1 296 Z.), `seed-demo.ts` (1 180 Z.) | Idempotent, repariert Demo-Kundenkonto | `SEED_ADMIN_PASSWORD` mit Demo-Vorgabe in `.env.example` |
| Mandantenfähigkeit | 🟡 | `organization.service.ts` | Schema trägt sie, Auflösung über festen Slug | Kein Subdomain-Routing, keine Row-Level Security (in `ARCHITECTURE.md` benannt) |
| Blob-Speicher in Postgres | ✅ | `StoredFile`, `src/lib/storage/local.ts` | Fallback ohne Supabase, 256 MiB, 2 h Schreibfenster | |
| ERD-Dokumentation | ✅ | `docs/DATABASE.md`, `scripts/generate-erd.ts` | Bricht bei fehlendem Modell in `DOMAINS` ab | |

### 3.6 Speicher, E-Mail, SMS, Cron, Integrationen

| Feature | Status | Ort | Details | Hinweise |
|---|---|---|---|---|
| Dateispeicher | ⚠️ | `src/lib/storage/{index,supabase,local,profiles}.ts` | Treiber-Switch, 9 Profile mit MIME-Whitelist, Dateinamen-Sanitisierung, signierte Up-/Downloads (remote) | **Alle Profile teilen 1 GiB**; kein Virenscan; lokale Blobs (auch CVs, Personaldokumente) nur durch cuid geschützt |
| E-Mail | ✅ | `src/lib/email/client.ts`, `templates.ts` (21 Vorlagen), DB-Vorlagen `EmailTemplate` | Resend; ohne Schlüssel simuliert; `EmailLog`; BCC-Archiv | |
| SMS | ✅ | `src/lib/sms/client.ts` (7 Vorlagen), `SmsTemplate` | Twilio; simuliert ohne Credentials; `SmsLog` mit Segmenten | |
| Cron täglich | 🟡 | `src/app/api/cron/daily/route.ts` | 10 Aufgaben mit `Promise.allSettled`: Serienbuchungen, Mahnungen, ablaufende Offerten, Bewertungsanfragen, Geburtstage, Folgeaufgaben, Aufgabenerinnerungen, Token-Cleanup, Upload-Purge, `runFuehrungNightly` | Kommentar sagt 06:00, `vercel.json` sagt `0 5 * * *` UTC; `maxDuration` 300 |
| Cron stündlich | ✅ | `cron/hourly` | Buchungserinnerungen 24 h/2 h, Team-Erinnerungen | |
| Hintergrund-Queue | ❌ | — | Alles synchron im Request | Bei Wachstum: Nachtlauf-Schleifen mit `notify()` je Datensatz (N+1) |
| Stripe | ✅ | `src/lib/payments/stripe.ts`, `webhooks/stripe/route.ts` | Checkout (Karte/TWINT, Rappen, `de`), Refund, SetupIntent; Webhook: `checkout.session.completed`, `charge.refunded`, `payment_intent.payment_failed`; Buchung nur über Webhook | Nicht getestet |
| Anthropic | ✅ | `src/lib/ai/{client,features,features-bi}.ts` | `AI_MODEL`/`AI_MODEL_FAST`, adaptive thinking, strukturierte Ausgabe, Streaming; 10 Features + BI-Assistent; Refusal-Behandlung; Token-Deckel | Kein monatliches Budget |
| Supabase Storage | ✅ | `src/lib/storage/supabase.ts` | Signierte URLs, privater Bucket | |
| Redis | ✅ | `src/lib/redis.ts` | Rate-Limit + Cache; Memory-Fallback | |
| Google Maps | ✅ | `src/lib/maps/google.ts` | Geocoding/Distanz mit Cache | Keine Kartenanzeige im Frontend |
| Datatrans | ❌ | nur `.env.example` | Variablen dokumentiert, in `env.ts` nicht validiert, kein Code | Toter Konfigurationsblock |
| Buchhaltungsschnittstelle | 🟡 | `export.service.ts` | CSV/XLSX | Keine geprüfte Abacus-/Bexio-Anbindung |

### 3.7 Umgebungskonfiguration

| Feature | Status | Ort | Details | Hinweise |
|---|---|---|---|---|
| Zod-validierte Umgebung | ✅ | `src/lib/env.ts` | `DATABASE_URL`, `JWT_SECRET` (≥32) Pflicht; TTLs mit Defaults; `hasIntegration()` für stripe/resend/twilio/supabase/redis/maps/ai | |
| Degradierung ohne Dienste | ✅ | `env.ts`, `email/client.ts`, `sms/client.ts`, `storage/index.ts`, `redis.ts` | Jede fehlende Integration schaltet ihr Feature ab oder simuliert | Getestet für KI (503) |
| `.env.example` | 🟡 | Wurzel | Vollständig für genutzte Dienste | Enthält ungenutzte `DATATRANS_*`, `COMPANY_STREET/…`; fehlt `LOG_LEVEL` |
| `CRON_SECRET` | ✅ | `handler.ts:255` | Fehlt er, wird jede Cron-Anfrage abgewiesen (fail-closed) | Vergleich nicht zeitkonstant (siehe Abschnitt 4) |
| `.gitignore` | ✅ | Wurzel | `.env`, `.env*.local`, `.env.production` | |

### 3.8 Datenbank-Performance

| Feature | Status | Ort | Details | Hinweise |
|---|---|---|---|---|
| Pagination | ✅ | `paginationQuery`, `skipTake()` | Offset-basiert, `pageSize ≤ 100`, `findMany` + `count` parallel | Kein Cursor (für aktuelle Datenmengen ausreichend) |
| Indizes | ✅ | `schema.prisma`, Migration `20260905100000_performance_indexes` | 131 `@@index` | |
| N+1 im Nachtlauf | ⚠️ | `invoice.service.ts:577`, `fuehrung.service.ts:74`, `automation.service.ts` | Schleifen mit `notify()` je Datensatz (je 1–3 Abfragen) | Akzeptabel bei kleinen Mengen |
| `select` vs `include` | 🟡 | `listBookings`, `processOverdueInvoices` | Tiefe `include`-Bäume | Schlank in `listUsers`, `reviews` |
| Sitzung je Request | ⚠️ | `session.ts:115` | Eine `User`-PK-Abfrage pro angemeldetem Request | Bewusster Tausch für sofortigen Widerruf |

---

## 4. Sicherheits-Checkliste

| Prüfpunkt | Status | Ort | Befund |
|---|---|---|---|
| **Next.js-Version** | ❌ | `package.json:76` (`next` 15.1.4) | **Betroffen von CVE-2025-29927** (Middleware-Umgehung über `x-middleware-subrequest`; behoben in 15.1.8 / 15.2.3). Der Header wird nirgends behandelt. Wirkung: Umgehung der Seiten-Vorfilterung; API-Routen und die meisten Seiten prüfen selbst nach — `konto/layout.tsx` prüft die Rolle jedoch nicht selbst. |
| Authentifizierung | ✅ | `auth.service.ts`, `jwt.ts`, `session-refresh.service.ts` | Argon2id, Rotation mit Familiensperre, Sperre nach 8 Fehlversuchen, Timing-Schutz, Reset-Token einmalig |
| Autorisierung | ✅ | `rbac.ts`, `handler.ts:186-199`, Dienste | Keine Route ohne Berechtigung (7 sitzungsgebundene Selbstbedienungsrouten ohne `permissions`, alle korrekt); Eigentümerschaft im `where` |
| API-Schutz (CSRF) | ✅ | `handler.ts:114-141` | Origin-Prüfung auf unsicheren Methoden + `SameSite=Lax`; getestet |
| Bot-Schutz öffentliche Formulare | 🟡 | `validation/common.ts:112` | Honigtopf + Rate-Limit | Kein Turnstile/reCAPTCHA |
| Passwortsicherheit | 🟡 | `validation/common.ts:31` | Richtlinie ohne Sonderzeichen; kein HIBP-Abgleich |
| 2FA-Geheimnis | ❌ | `two-factor.service.ts:89` | `twoFactorSecret` im Klartext in der DB (im Audit/Log redigiert, im Datenbestand nicht) |
| Datenvalidierung | ✅ | `src/lib/validation`, `handler.ts` | Kein rohes `request.json()`; kein `$queryRawUnsafe`; `orderBy` per Whitelist; Massenzuweisung durch Zod abgefangen |
| Datei-Upload | 🟡 | `storage/profiles.ts`, `files/blob/[id]/route.ts` | MIME-Whitelist, Sanitisierung, kein SVG/HTML; **1 GiB für alle Profile**, kein Virenscan, lokale Blobs unauthentifiziert (Capability-URL) |
| CMS-Asset-Allowlist | ✅ | `src/lib/cms/assets.ts` | Entity/Feld-Paare fest verdrahtet |
| CMS-Vorschau-Iframe | ✅ | `src/lib/cms/preview.ts:37-66` | Draft-Cookie + `content:update` + `Sec-Fetch-Dest: iframe` |
| Sicherheits-Header | 🟡 | `next.config.ts:12-93` | HSTS (2 Jahre, preload), nosniff, `X-Frame-Options SAMEORIGIN`, Referrer-Policy, Permissions-Policy, `frame-ancestors 'self'` | **CSP `script-src` mit `'unsafe-inline'` und `'unsafe-eval'`** — CSP als XSS-Schutz wirkungslos; kein Nonce, kein `report-uri` |
| Umgebungsvariablen | ✅ | `.gitignore:27`, `env.ts` | `.env` ignoriert; keine Fallback-Geheimnisse im Code; `JWT_SECRET` ≥ 32 erzwungen |
| Demo-Zugangsdaten | ⚠️ | `README.md:45-48`, `.env.example:90`, `tests/helpers/accounts.ts` | Vier Konten im Klartext; `SEED_ADMIN_PASSWORD` mit Vorgabewert — bei Produktions-Seed ohne Überschreiben entsteht ein Admin mit bekanntem Passwort (`docs/DEPLOYMENT.md` warnt) |
| Webhook-Sicherheit | ✅ | `webhooks/stripe/route.ts:32-44` | Signatur über Rohtext, Idempotenz über `providerPaymentId @unique`, 500 für Retry | `webhook`-Rate-Limit nicht angewandt |
| Cron-Authentifizierung | 🟡 | `handler.ts:248-263` | Bearer-Vergleich mit `!==`, nicht `timingSafeEqual` |
| Prüfprotokoll | 🟡 | `src/lib/audit.ts` | Akteur/IP/UA, Redaktion | Keine Aufbewahrungsfrist/Löschung (DSG-Datenminimierung) |
| Fehlerleckage | ✅ | `response.ts:69-152` | Interne Fehler generisch, Stacks nur in Entwicklung, Prisma-Codes abgebildet |
| Open Redirect | ✅ | `src/lib/auth/safe-redirect.ts` | Allowlist für `weiter`; getestet |
| Rate-Limit-Wirksamkeit | ⚠️ | `redis.ts:123-130` | Ohne `REDIS_URL` prozesslokal — auf Vercel ohne Redis ist der Login-Bruteforce-Schutz nicht verlässlich |
| Öffentliche API / PII | ✅ | `api/auth/session`, `api/public/*`, `sitemap.ts` | Minimale Rückgaben; Sitemap nur veröffentlichte Inhalte; `noindex` auf `/api/*` |
| KI-Endpunkte | 🟡 | `public/ai/chat/route.ts` | Prompt-Injection-Schutz (Zitatzaun), Datenminimierung, 800 Token, 60/h/IP | Kein globales Budget |
| Impersonation | ❌ | — | Berechtigung ohne Implementierung; keine Zeitbegrenzung/Audit definierbar |
| Abhängigkeiten | ⚠️ | `package.json` | ESLint 8 (End-of-Life), `@anthropic-ai/sdk` 0.x | Kein `npm audit` in CI (keine CI) |

---

## 5. Test-Checkliste

Methode laut `tests/README.md`: Tests fahren die **laufende Anwendung über HTTP** an (`node:test` via `tsx`, `--test-concurrency=1`, geteilte DB mit fünf Demo-Konten). ~278 literale `it()`-Aufrufe in 19 Dateien; durch Schleifen (`smoke`, `tables`, `sorting`, `public-site`) effektiv rund 470 Prüfungen.

| Testart | Status | Ort | Details |
|---|---|---|---|
| Unit-Tests | 🟡 | `tests/api/bi-rechenkerne.test.ts` | Einzige Datei, die Anwendungscode importiert (`src/lib/bi/math`, `periods`), 22 Tests. **Fehlen für Preis-Engine, QR-Referenz-Prüfziffer, Token-Rotation** (in `ARCHITECTURE.md` selbst benannt) |
| Integrationstests (API) | ✅ | `tests/api/*.test.ts` (15 Dateien) | RBAC-Matrix, 2FA, Abläufe, CMS, Katalog, Website-Betrieb, Eigentümerschaft, Sitzungs-Refresh, Personal, Einsätze, CRUD-Audit, Adressen, Einstellungen, Unternehmensführung |
| Seitentests (SSR-HTML) | ✅ | `tests/pages/*.test.ts` (4 Dateien) | Smoke je Rolle (56 Admin + 9 Portal + 8 Konto + Detailseiten + PDFs), Tabellenbreiten, Sortierung, öffentliche Verlinkung/robots/sitemap |
| Frontend-Komponententests | ❌ | — | Kein Vitest/Jest/RTL |
| E2E (Browser) | ❌ | — | Kein Playwright/Cypress |
| CI | ❌ | — | Kein `.github/workflows`; `npm test`, `typecheck`, `lint` laufen nur manuell |
| Manuelle Prüfung | 🟡 | `checklist.txt`, Speicher | Produktbesitzer testet im Browser; DB-Stand ändert sich dadurch mitten in Testläufen |
| Typecheck / Lint | ✅ | `npm run typecheck`, `npm run lint` | Am Prüftag beide fehlerfrei |

### Abdeckung je Domäne

| Domäne | Abdeckung | Datei(en) |
|---|---|---|
| auth (login/session/refresh) | 🟡 | `session-refresh`, `two-factor`, `flows` — **Registrierung, Reset, Einladung, Logout, Konto-Sperre ungetestet** |
| 2FA | ✅ | `two-factor` (28 Tests) |
| RBAC / Eigentümerschaft / Origin | ✅ | `rbac`, `ownership`, `addresses` |
| Benutzer / Personal | ✅ | `rbac`, `employees` |
| Kundschaft / Adressen / Leads | ✅ | `addresses`, `flows`, `crud-audit` |
| Offerten | 🟡 | `flows` (anlegen, PDF, duplizieren) — `send`, `convert`, Token-Antwort ungetestet |
| Buchungen | 🟡 | `flows` (öffentlich) — Admin-Statuswechsel und `account/bookings/*` ungetestet |
| Einsätze | ✅ | `jobs` |
| Rechnungen | 🟡 | `flows` (ausstellen, PDF), `rbac` (Papierkorb) — `send`, `cancel`, `payments` ungetestet |
| **Zahlungen** | ❌ | — |
| **Stripe-Webhook** | ❌ | — |
| **Exporte (PII)** | ❌ | — |
| **Gutscheine** | ❌ | — |
| **Zeiterfassung (clock-in/out)** | ❌ | nur Seite im Smoke |
| **Bewerbungen** | ❌ | nur indirekt |
| **Blog-API** | ❌ | nur Seite im Smoke |
| Ausgaben / Aufgaben / Medien / Benachrichtigungen / Bewertungen | 🟡 | Smoke bzw. Einzelfälle |
| Nachrichten | ✅ | `flows` |
| CMS / SEO | ✅ | `cms` |
| Katalog / Preisberechnung (HTTP) | ✅ | `catalog`, `flows` |
| Website-Betrieb (FAQ, Galerie, Navigation, Rechtstexte, Gebiet, Stellen, Automationen, Firma) | ✅ | `website-ops` |
| Einstellungen / Feiertage / Abwesenheiten | ✅ | `settings`, `crud-audit` — `absences/[id]/decide` ungetestet |
| Cron | 🟡 | `flows` (nur Token-Schutz, nicht die Aufgaben) |
| Datei-Upload | 🟡 | `employees` (Avatar) — MIME/Grösse/Ablauf ungetestet |
| KI | 🟡 | `bi-fuehrung` (Assistent 503/Rolle) — `/api/ai/*`, öffentlicher Chat ungetestet |
| Unternehmensführung | ✅ | `bi-fuehrung` (26), `bi-rechenkerne` (22), Smoke |
| Öffentliche Formulare | 🟡 | Kontakt, Newsletter, Buchung, Honigtopf ✅ — Offertanfrage, Token-PDF/Pay ungetestet |

---

## 6. Technische Schulden

### Fehler (Bugs)

| # | Befund | Ort |
|---|---|---|
| B1 | `alternates.languages` verweist auf `/en`, `/fr`, `/it` — Routen existieren nicht (Suchmaschinen erhalten 404) | `src/app/layout.tsx:76` |
| B2 | Medienbibliothek erhält `canUpload`, zeigt aber kein Upload-Element | `src/features/admin/media/media-library.tsx:76-84` |
| B3 | Gast-Buchungsseite kündigt Verschieben/Absagen an, ohne es anzubieten | `src/app/(public)/buchung/[token]/page.tsx:135` |
| B4 | Prüfprotokoll-Seite verspricht Aufbewahrungsfrist, Backend löscht nie | `src/app/(app)/admin/protokoll/page.tsx:45`, `src/lib/audit.ts` |
| B5 | `ValidationError` → 400, `ZodError` → 422, derselbe Fehlercode | `src/lib/errors.ts`, `src/lib/api/response.ts:106` |
| B6 | Cron-Kommentar (06:00) widerspricht `vercel.json` (`0 5 * * *` UTC) | `src/app/api/cron/daily/route.ts`, `vercel.json:12` |
| B7 | Newsletter bestätigen/abmelden schreiben während GET-Render | `src/app/(public)/newsletter/*` |
| B8 | Telefonnummern hartkodiert statt aus `getPublicCompanyInfo()` | `src/app/error.tsx:57`, `src/features/account/booking-actions.tsx:97`, `src/components/marketing/chat-widget.tsx:111` |
| B9 | README-Kennzahlen veraltet (88 Seiten / 96 Endpunkte / 14 Dienste / „Erstmigration") — tatsächlich 133 / 240 / 46 / 12 Migrationen | `README.md:19`, `:145`, `:151` |

### Fehlende Funktionen

| # | Fehlt | Betroffene Stelle |
|---|---|---|
| F1 | Gutschrift-Endpunkt und -Schaltfläche (`createCreditNote` fertig) | `invoice.service.ts`, `invoice-actions.tsx` |
| F2 | Lohnabrechnung erzeugen (`generatePayslip` fertig), Lohnausweis-PDF | `employee.service.ts:766` |
| F3 | Kunden-Anonymisierung (DSG/DSGVO-Löschbegehren) per API/UI (`anonymizeCustomer` fertig) | `crm.service.ts` |
| F4 | Authentifiziertes `POST /api/bookings` (Personal muss über die öffentliche Route buchen) | `src/app/api/bookings/route.ts` |
| F5 | `GET /api/jobs`, `POST /api/jobs` (Einsatz ohne Buchung) | `job.service.ts createJob/listJobs` |
| F6 | Newsletter-Versand | `newsletter:create` ohne Route |
| F7 | Zeiterfassung korrigieren/freigeben (`timetracking:approve`) | Portal/Admin |
| F8 | Impersonation (`user:impersonate`) — umsetzen oder Berechtigung entfernen | `permissions.ts:256` |
| F9 | `GET /api/seo`, `GET /api/activities`, GET-by-id für ~12 Ressourcen | diverse |
| F10 | Cancel/Reschedule für Gast-Buchungen per Token | öffentlich |
| F11 | `not-found.tsx` unter `(app)`; `error.tsx`/`loading.tsx` unter `(public)` und `(auth)` | `src/app` |
| F12 | Mehrsprachigkeit (DE/FR/IT/EN vorbereitet, nicht umgesetzt) | global |
| F13 | Buchhaltungsschnittstelle (Bexio/Abacus) | `export.service.ts` |
| F14 | Hintergrund-Queue für Nachtlauf und Massenversand | Cron |

### Refactoring

| # | Thema | Ort |
|---|---|---|
| R1 | 49 Route-Dateien greifen direkt auf Prisma zu; Dienste für Reviews, Messages, Tasks, Expenses, Suppliers, Blog, Activities, SEO, Settings, Payments, Applications anlegen | `src/app/api/**` |
| R2 | rhf-Formulare bilden Server-Feldfehler nicht auf Felder ab (nur `ResourceForm` tut es) | `src/features/admin/*-form.tsx` |
| R3 | `CustomerForm`/`EmployeeForm` nur Anlage; Bearbeiten in separaten Dialogen — Konvention „Formular wiederverwenden" | `customer-form.tsx`, `employee-form.tsx` |
| R4 | Gemeinsames `(app)/layout.tsx` — Sitzungs-/Rollenlogik dreifach | `admin|konto|portal/layout.tsx` |
| R5 | `Datatrans`- und `COMPANY_STREET/…`-Variablen aus `.env.example` entfernen; `LOG_LEVEL` ergänzen | `.env.example`, `env.ts` |
| R6 | `editable-row.tsx` nur einmal genutzt | `src/components/app/editable-row.tsx` |
| R7 | Eigentümerschaft für Rechnungen/Nachrichten in den Dienst ziehen statt Seitenebene | `konto/rechnungen/[id]/page.tsx:49`, `konto/nachrichten/page.tsx:26` |

### Leistung

| # | Thema | Ort |
|---|---|---|
| P1 | Öffentliche Seiten ohne `next/image`; rohes `<img>` im Vorher-Nachher-Regler | `before-after.tsx:121,140` |
| P2 | Auth-Layout macht je Seitenaufruf eine Bewertungsabfrage | `(auth)/layout.tsx` |
| P3 | Nachtlauf-Schleifen mit `notify()` je Datensatz | `invoice.service.ts:577`, `fuehrung.service.ts:74` |
| P4 | `serialize()` per `JSON.parse(JSON.stringify())` je Antwort | `response.ts` |
| P5 | Sortierung fehlt auf 14 Listen; Führungslisten ohne `SortHeader` | Admin-Listen |

### Sicherheitsverbesserungen

Siehe Abschnitt 4: Next.js-Update (S1), 2FA-Geheimnis verschlüsseln (S2), CSP ohne `unsafe-*` (S3), Audit-Retention (S4), zeitkonstanter Cron-Vergleich (S5), HIBP-Abgleich (S6), Upload-Limits je Profil und Virenscan (S7), private Dokumente hinter Authentifizierung (S8), Demo-Passwörter aus README oder klar als Entwicklungsdaten markieren (S9), Redis in Produktion verpflichtend (S10), `webhook`-Rate-Limit anwenden (S11).

---

## 7. Nächste Entwicklungsprioritäten

### Priorität 1 — Kritisch

1. **Next.js auf ≥ 15.1.8 (besser 15.2.3+) heben** und `x-middleware-subrequest` prüfen — CVE-2025-29927. Dazu `konto/layout.tsx` eine eigene Rollenprüfung geben, damit keine Seite allein auf der Middleware ruht.
2. **`twoFactorSecret` verschlüsselt speichern** (z. B. AES-GCM mit Schlüssel aus der Umgebung) inkl. Migration bestehender Werte.
3. **Redis in Produktion verpflichtend machen** oder Login-Rate-Limit in die DB verlagern — sonst ist der Bruteforce-Schutz auf Vercel wirkungslos.
4. **CSP härten**: `'unsafe-eval'` entfernen, `'unsafe-inline'` durch Nonces ersetzen, `report-uri` setzen.
5. **CI einrichten** (`typecheck`, `lint`, `npm test` gegen eine Build-Instanz mit Demo-Seed), damit die 470 Prüfungen automatisch laufen.
6. **Tests für geldrelevante Pfade**: Stripe-Webhook (Signatur, Idempotenz, Refund), Zahlungserfassung, Rechnung senden/stornieren, Exporte; Unit-Tests für Preis-Engine und QR-Referenz mit festen Erwartungswerten.

### Priorität 2 — Wichtige Verbesserungen

1. Gutschrift-, Lohnabrechnungs- und Anonymisierungs-Endpunkte samt UI (Dienste sind fertig).
2. Authentifiziertes `POST /api/bookings` und `GET/POST /api/jobs`.
3. Medien-Upload auf `/admin/medien`; Gast-Buchung per Token verschieben/absagen.
4. Audit-Log-Retention als Cron-Aufgabe; zeitkonstanter `CRON_SECRET`-Vergleich; `webhook`-Rate-Limit anwenden.
5. Upload-Limits je Profil (Avatar ≠ 1 GiB), Virenscan-Hook, private Dokumente/CVs nur authentifiziert ausliefern.
6. Server-Feldfehler in rhf-Formularen abbilden; `ValidationError`/`ZodError`-Statuscode vereinheitlichen.
7. Dienste für die 11 routen-internen Domänen; `(app)/layout.tsx`; `not-found.tsx` unter `(app)`, `error.tsx`/`loading.tsx` unter `(public)`/`(auth)`.
8. 5-Rappen-Rundung in Preis- und Rechnungsrechnung anwenden (oder bewusst dokumentiert weglassen).
9. `alternates.languages` entfernen; README-Kennzahlen aktualisieren; hartkodierte Telefonnummern ersetzen.
10. Testlücken schliessen: Registrierung, Reset, Einladung, Konto-Sperre, Zeiterfassung, Gutscheine, Bewerbungen, Offert-Token-Antwort.

### Priorität 3 — Zukünftige Funktionen

1. Newsletter-Versand (Kampagnen, Segmente) — Abonnentenverwaltung existiert bereits.
2. Zeiterfassungs-Korrektur und Freigabe; Lohnausweis-PDF, Quellensteuer, Familienzulagen, Swissdec.
3. Impersonation mit Zeitlimit und Audit — oder Berechtigung streichen.
4. Mehrsprachigkeit (FR/IT/EN) mit Wörterbüchern statt Inline-Texten.
5. Mehrmandantenbetrieb: Auflösung über Subdomain, Row-Level Security.
6. Buchhaltungsschnittstelle Bexio/Abacus.
7. Hintergrund-Queue (z. B. QStash/Inngest) für Nachtlauf und Massenversand.
8. Kartenanzeige im Einsatzgebiet und in der Disposition (Google-Maps-Schlüssel ist vorbereitet).
9. `next/image` auf der Website, eingeklappte Sidebar als Zwischenzustand, Sortierung auf allen Listen.

---

## 8. Abgleich mit der Wunschliste (`checklist.txt`)

| Wunsch | Status | Nachweis |
|---|---|---|
| Theme-Button und Anmelden nach „Termin buchen"; modernes Hell/Dunkel-Icon; Standard = System | ✅ | `site-header.tsx` (Reihenfolge CTA → Konto → Theme), `theme-toggle.tsx` (Sun/Moon/Monitor), `providers.tsx` (`defaultTheme="system"`) |
| Ein Anmeldeportal für alle Rollen mit rollenbasierter Weiterleitung | ✅ | `login-form.tsx`, `rbac.ts:268 homeRouteFor` |
| Dashboard: Theme-Icon; Glocke zeigt Meldungen je Benutzer | ✅ | `app-shell.tsx:353`, `notification-panel.tsx`, `notification.service.ts:79` |
| Profil: Benutzerbild hochladen/bearbeiten | ✅ | `src/features/account/avatar-uploader.tsx` |
| Profil: Design-Konsistenz der Karten Konto/Sicherheit | ⚠️ | Nur visuell prüfbar; `DetailSection`/`protocol-list` werden verwendet |
| Einstellungen im Profil nur benutzerbezogen | ✅ | Profil: Kontakt, Benachrichtigungen, Passwort, 2FA, Farbschema; Firmeneinstellungen getrennt unter `/admin/einstellungen` |
| Einsatzkalender Tag/Woche 01:00–00:00 statt 06–20 Uhr | ✅ | `dispatch-calendar.tsx` `slotMinTime 00:00`, `slotMaxTime 24:00` |
| Buchung bearbeiten inkl. Status | ✅ | `admin/buchungen/[id]/bearbeiten`, `booking-actions.tsx` |
| Einsatz: Auftrag, Checkliste, Nachkalkulation, Team bearbeiten; Mitarbeitende erledigen; Fotos hochladen/bearbeiten | ✅ | `admin/einsaetze/[id]` (6 Editoren), `portal/einsaetze/[id]` (`job-workspace.tsx`, `time-clock.tsx`, `job-photos.tsx`) |
| Website-Offertanfragen erscheinen unter Offerten | ✅ | `api/public/quotes/route.ts` → Lead + Offertentwurf + Meldung |
| Offerte: neue Kundschaft inline; Leistungen als Positionen mit automatischer Einheit (m² / Stück) | ✅ | `quote-editor.tsx:161 unitForService`, `:740` Kundschaft-Dialog |
| Berechnungen korrekt | 🟡 | `computeQuoteTotals`: Zeilenrabatt, Gesamtrabatt (Prozent/Fix), MwSt. je Position, `round2` — plausibel; **kein Unit-Test**, keine 5-Rappen-Rundung |
| Keine doppelten Leads (E-Mail, Telefon, Name, Firma) | ✅ | `crm.service.ts findMatchingLead` |
| Leads manuell als Kundschaft erfassen | ✅ | `POST /api/leads/[id]/convert`, `lead-actions.tsx` |
| Website-Texte: echte Website im Bearbeitungsmodus, in place editierbar | ✅ | `admin/inhalte`, `preview-bridge.tsx` |
| Dashboard allgemein: Bearbeiten/Löschen-Funktionen | ✅ | `ActionButton`/`FormDialog` auf allen geprüften Listen (siehe 2.3) |

---

## Zählung

Ausgezählt über alle Tabellenzeilen mit Status-Spalte in den Abschnitten 2–5 und 8:

| Status | Anzahl | Anteil |
|---|---|---|
| ✅ Vollständig | 212 | 70 % |
| 🟡 Teilweise | 59 | 19 % |
| ❌ Fehlend | 20 | 7 % |
| ⚠️ Prüfung nötig | 12 | 4 % |
| **Summe** | **303** | |

Die Zählung ist reproduzierbar: jede Zeile, deren zweite Spalte genau ein Statussymbol enthält, zählt einmal. Die Aufteilung je Abschnitt steht in der Zusammenfassung (Abschnitt 0).
