# Pendenzen — Register der Mission vom 2026-09-28

> Zweig `feature/produkt-ux-sicherheit-2026-09-28`, Ausgang `241d8d5`.
> Jeder Punkt, der in dieser Mission auftaucht, steht hier — auch der, der
> nicht behoben wurde. **Kein Punkt verschwindet still**: Ein erledigter Punkt
> wechselt den Status und bekommt Beleg und Commit, er wird nicht gelöscht.

Status: `OPEN` · `IN PROGRESS` · `CODE COMPLETE` (Code und Prüfung da, Vollauf
steht aus) · `VERIFIED` (in der Vollprüfung grün) · `EXTERNAL EVIDENCE
REQUIRED` · `CLOSED` (ohne Änderung erledigt, z. B. bereits behoben).

Priorität: **P0** Datenverlust/Sicherheitsbruch jetzt · **P1** falsche Beträge,
Zugriff über Kunden- oder Mandantengrenze, Kernablauf unbenutzbar · **P2**
Robustheit, Randfall, Verteidigung in der Tiefe · **P3** Pflege.

## B — Nachprüfung früherer Befunde (gegen `241d8d5`)

Nicht aus den Berichten übernommen, sondern am Code nachgelesen (drei
Durchgänge: Finanzen, Zugriff, Infrastruktur).

| ID | Bereich | Befund | Prio | Status | Beleg / Prüfung | Commit | Extern |
|---|---|---|---|---|---|---|---|
| B-01 | Finanzen | Rechnung: `bookingId`/`quoteId` beim Anlegen ungeprüft (fremde Kundschaft; Kundenkonto sieht fremde Rechnung an eigener Buchung) | P1 | VERIFIED | `sicherheitsluecken.test.ts` „Rechnung nimmt keine Buchung … anderen Kundschaft" — Produktionsbau 35/0 | a5735c2 | |
| B-02 | Finanzen | Erstattungen monoton und idempotent | — | CLOSED (bereits behoben) | `erstattungsstandUebernehmen` FOR UPDATE, `zahlungsbuch.test.ts`, `nebenlaeufigkeit.test.ts` | | |
| B-03 | Finanzen | Ausstellen gegen Löschen eines Entwurfs: nummerierte Rechnung kann weich gelöscht werden (Lücke nach Art. 957a OR) | P1 | VERIFIED | `nebenlaeufigkeit.test.ts` „Ausstellen und Löschen … gleichzeitig" — Produktionsbau 18/0. Hinweis: Das Löschen einer *ausgestellten* Rechnung verweigerte der Trigger `rechnung_unveraenderlich` schon (500 statt 422); offen war das Ausstellen eines eben gelöschten Entwurfs | a5735c2 | |
| B-04 | Finanzen | QR-Referenz wiederholt sich jedes Jahr (Zähler ohne Jahr) | P1 | VERIFIED | `nebenlaeufigkeit.test.ts` „QR-Referenz … Jahr und Laufnummer"; Scanner löst alte und neue Form (`scan-kennung.test.ts`) | a5735c2 | |
| B-05 | Finanzen | Entwurfsplatzhalter `ENTWURF-<ms>` kollidiert bei zwei Entwürfen in derselben Millisekunde → 500 | P2 | VERIFIED | `nebenlaeufigkeit.test.ts` „fünf Entwürfe gleichzeitig angelegt" | a5735c2 | |
| B-06 | Geld | Vertragsabrechnung rechnet mit Gleitkomma (`Math.round(x*100)/100`), 90 min × 12.35 → 18.52 statt 18.53 | P1 | VERIFIED | `vertraege-rechenkern.test.ts` „Vertragsabrechnung — Betrag dezimal" (5 Fälle, alle vorher ein Rappen zu wenig) — 48/0 | a5735c2 | |
| B-07 | Geld | Excel-Summen und MWST-Bericht als Gleitkommasummen | P2 | CODE COMPLETE | `export.service.ts`, `analytics.service.ts` über `summe`/`aufRappen` | | |
| B-08 | Geld | `BEZAHLT_TOLERANZ` 0.05 markiert bezahlt, gespeicherter Saldo bleibt 0.05 — Kundenkonto zeigt offen, Online-Zahlung über Rappen möglich | P2 | CODE COMPLETE | `saldoNeuBilden` schreibt 0; Migration `…_bezahlt_ohne_restsaldo`; Integritätsregel angepasst; `zahlungsbuch.test.ts` „zwei Rappen zu wenig" | | |
| B-09 | Lohn | Lohn-PDF nur eigene, nur veröffentlicht; Veröffentlichen idempotent | — | CLOSED (bereits behoben) | `lohnabrechnung.test.ts` | | |
| B-10 | Mandant | Lesen mandantengetrennt; `where`-Spread-Falle nicht mehr vorhanden | — | CLOSED (bereits behoben) | `mandanten.test.ts` | | |
| B-11 | IDOR | Vertrag: `propertyId` ungeprüft, `quoteId` nicht gegen Kundschaft, verantwortliche Personen nicht gegen Organisation | P1 | VERIFIED | `vertraege.test.ts` „Bezüge des Vertrags" 49/0; Prüfbestand in 4 Dateien korrigiert (setzte fremde Objekte voraus) | a5735c2 | |
| B-12 | IDOR | Kundschaft hängt Nachrichtenverlauf an fremden Einsatz (nur Organisation geprüft) | P1 | VERIFIED | `sicherheitsluecken.test.ts` „Nachrichtenverlauf zu einem fremden Einsatz" | a5735c2 | |
| B-13 | Mandant | Schreibseitige Fremdschlüssel ohne Organisationsprüfung (Lieferant, Verantwortliche, Eltern-Ziel, Sitzung, Kennzahl am Schlüsselergebnis) | P2 | VERIFIED | `bezug.service.ts`; `mandanten.test.ts` „Verweise der Führung und der Finanzen" — Produktionsbau 64/0 | 4b56a4b | |
| B-14 | Dateien | Dateizugriff: Bindung, Scan-Tor, Prüfsumme | — | CLOSED (bereits behoben) | `datei-zugriff.test.ts`, `dateisicherheit.test.ts` | | |
| B-15 | Sitzung | Refresh-Token einmalig, Familie bei Wiederverwendung gesperrt | — | CLOSED (bereits behoben) | `session-refresh.test.ts` | | |
| B-16 | Dateien | Upload-Bytes einmalig; Signaturartefakte B/C bei Übernahme eines hängenden Abschlusses überschreibbar | P2 | CODE COMPLETE | `finalizeSignatureRequest`: eigene Datei je Abschlussversuch, Verknüpfung weiterhin bedingt. Der Wettlauf selbst ist über HTTP nicht erzwingbar; die Signaturreihen (`signatur`, `offertannahme`) sichern gegen Rückschritt | | |
| B-17 | Automation | Hängende Läufe ohne Lease wieder freigegeben; Aktion kann bei gestopptem Worker doppelt laufen | P2 | CODE COMPLETE | Pachtzeichen `attempts`: Prüfung vor jeder Aktion, Aktion bedingt beansprucht (anlegen oder CAS statt `upsert`), Abschluss nur mit eigener Pacht. Interleaving über HTTP nicht erzwingbar; `automatisierungen`, `nebenlaeufigkeit` sichern gegen Rückschritt | | |
| B-18 | SSRF | Webhook-Ziel inkl. DNS-Rebinding geprüft; `64:ff9b:1::/48`, `192.88.99.0/24` fehlen | P3 | CODE COMPLETE | `istPrivateAdresse`; `automatisierungen.test.ts` Adressprüfung (gelaufen, grün) | | |
| B-19 | Zuteilung | Automation `UPDATE_STATUS` schrieb ohne Ausgangszustand — reaktivierte Abgesagtes, sagte Abgeschlossenes ab | P2 | CODE COMPLETE | `ERLAUBTE_AUSGANGSZUSTAENDE` im `where`; `automatisierungen.test.ts` „Statusregeln" (gelaufen, grün) | | |
| B-20 | Ablage | `scopeId` frei (max. 60 Zeichen) im Speicherschlüssel, auch anonym (`../`) | P1 | VERIFIED | `dateisicherheit.test.ts` „Zuordnung mit Pfadzeichen" — 42/0 | a5735c2 | |
| B-21 | Protokoll | Prüfprotokoll durchweg geschwärzt | — | CLOSED (bereits behoben) | `protokoll-schwaerzung.test.ts` | | |
| B-22 | Buchung | Gutscheinlimit wird vor der Transaktion geprüft, Zählung ohne Bedingung → Überbuchung des Gutscheins | P1 | VERIFIED | `buchung-integritaet.test.ts` „Limit 2, fünf gleichzeitig" und „Kleinbuchstaben" — 34/0 | a5735c2 | |
| B-23 | Buchung | Doppelte Übermittlung erzeugt zwei Buchungen (kein Idempotenzschlüssel) | P2 | CODE COMPLETE | Absendekennung aus dem Assistenten, eindeutig je Organisation (Migration `…_buchung_absendekennung`), Wiederholung unter der Buchungssperre liefert die erste Buchung; `buchung-integritaet.test.ts` „dreimal gleichzeitig" | | |
| B-24 | Konvention | Inline-Schemas in 12 Routen | P3 | VERIFIED | OpenAPI bytegleich | e07658d | |

## E — Leistung

| ID | Bereich | Befund | Prio | Status | Beleg | Commit | Extern |
|---|---|---|---|---|---|---|---|
| E-01 | Bündel | Zod (~20 kB gzip) im Wurzellayout, also auf **jeder** Seite inkl. öffentlicher Startseite: `utils.ts` (für `cn`) importierte `laufzeit-konfiguration.ts` mit Schema auf oberster Ebene | P2 | CODE COMPLETE | `lib/laufzeit-ursprung.ts` ohne Zod; `scripts/leistungsbudget.ts` misst | | |
| E-02 | Budget | Deterministische Budgets (JS je Route, HTML je Seite) statt Millisekunden | P2 | IN PROGRESS | `scripts/leistungsbudget.ts`, Werte nach Integrationsbau | | |
| E-03 | Messung | Zielliste um Verträge, Personal, Buchen ergänzt | P3 | CODE COMPLETE | `scripts/leistungsmessung.ts` | | |

## C — Offerte: Rabattart und Navigation

| ID | Bereich | Befund | Prio | Status | Beleg / Prüfung | Commit | Extern |
|---|---|---|---|---|---|---|---|
| C-01 | UI | Seitenleiste/Kopfzeile verschwinden bei geöffneter Auswahl (html `overflow-x: clip` blockiert die Weitergabe der Scrollsperre) | P1 | CODE COMPLETE | `tests/e2e/offerte-rabatt.spec.ts` (vorher rot) | c28328e | |
| C-02 | Offerte | „Kein Rabatt" wird nicht gespeichert | P1 | CODE COMPLETE | `flows.test.ts` „Offerte speichern wie die Maske" | c28328e | |
| C-03 | Formulare | Jedes Datumsfeld (`dateOnlySchema`) über `zodResolver` → 422; Offerte weder anlegen noch bearbeiten | P1 | CODE COMPLETE | `flows.test.ts`, Browserfall | c28328e | |
| C-04 | Formulare | Englische Zod-Meldungen in der Oberfläche | P2 | CODE COMPLETE | `flows.test.ts` | c28328e | |
| C-05 | Offerte | PATCH nur mit Rabatt rechnet die Summen nicht neu | P2 | CODE COMPLETE | `flows.test.ts` | c28328e | |

## D — Bilder, Firefox und die anderen Engines

| ID | Bereich | Befund | Prio | Status | Beleg / Prüfung | Commit | Extern |
|---|---|---|---|---|---|---|---|
| D-01 | Website | Gemeldet: Bilder (Vorher/Nachher) in Firefox erst nach mehrmaligem Neuladen. Lokal in Firefox **nicht** nachstellbar: hochgeladene Bilder in allen sechs Lagen (kalt, warm, Neuladen, Linkwechsel, langsam, mobil) dekodiert | P1 | EXTERNAL EVIDENCE REQUIRED | `tests/e2e/bilder.browser.spec.ts` Chromium/Firefox/WebKit 15/15 gegen den Produktionsbau | 4e81670 | Firefox gegen die Produktionsadresse (Cloudflare, https, echte Galerie) — Abnahme: Galerie und Startseite in Firefox mit leerem Cache öffnen, Netzwerkpanel: Status und Typ jeder `/api/files/blob/*`-Antwort; dazu `scripts/abnahme/bilder-browser.ts` |
| D-02 | Website | WebKit: `upgrade-insecure-requests` stuft auf http-Auslieferung jede Unteranfrage auf https hoch (auch Loopback) — Seite ungestylt, Bilder leer | P1 | VERIFIED | Probe „SSL connect error" vor, 15/15 nach der Korrektur | 4e81670 | |
| D-03 | Demodaten | Demogalerie veröffentlicht Adressen `/gallery/*.jpg`, die es nie gab — kaputte Bilder in jedem Browser | P2 | VERIFIED | Seed zieht solche Einträge zurück; Bildprüfung ohne kaputte Bilder | 4e81670 | Produktion: prüfen, ob dort Demo-Galerieeinträge veröffentlicht sind (Notfallauftrag 2026-09-27: Demodaten in Prod) |

## K — Sitzung

| ID | Bereich | Befund | Prio | Status | Beleg / Prüfung | Commit | Extern |
|---|---|---|---|---|---|---|---|
| K-01 | Anmeldung | „Angemeldet bleiben" war eine Scheinfunktion: geprüft, verworfen, jede Sitzung 30 Tage persistent; Kästchen vorausgewählt | P1 | CODE COMPLETE | `session-refresh.test.ts` „Sitzungscookies" | | |
| K-02 | Sitzung | Ein Tab im Hintergrund meldete die ganze Sitzung ab, während im anderen gearbeitet wurde | P1 | CODE COMPLETE | `tests/e2e/sitzung-tabs.spec.ts` | | |
| K-03 | Sitzung | Abmeldung erreichte die anderen Tabs nicht | P2 | CODE COMPLETE | `tests/e2e/sitzung-tabs.spec.ts` | | |
| K-04 | Sitzung | Warnung vor Ablauf mit Weiterarbeiten/Abmelden | P2 | CODE COMPLETE | `tests/e2e/sitzung-tabs.spec.ts` | | |
| K-05 | Doku | Grenzen (Schliessen nicht erkennbar, Sitzungswiederherstellung) | — | CODE COMPLETE | `docs/SITZUNG.md` | | |

## N, O, P, Q — Arbeitsweise

| ID | Bereich | Aufgabe | Prio | Status | Beleg | Commit | Extern |
|---|---|---|---|---|---|---|---|
| N-01 | Skill | `.claude/skills/security/SKILL.md` | P1 | CODE COMPLETE | Prüftabelle mit Clenaris-Wegen | | |
| O-01 | Skill | `.claude/skills/ui-ux/SKILL.md` | P1 | CODE COMPLETE | Bausteine, Ebenen, Engines, Zustände | | |
| P-01 | Skill | `.claude/skills/pendenzen/SKILL.md` | P1 | CODE COMPLETE | Vorher suchen, nichts still löschen, Löschdetektor, Register | | |
| Q-01 | DoD | Pflichtablauf (15 Schritte), browserübergreifende Zeile, Verweis in `.claude/rules/engineering.md` | P1 | CODE COMPLETE | `docs/ENGINEERING_DEFINITION_OF_DONE.md` | | |
| J-01 | Scanner | Ausbau 2026-09-28: Vertrag über Nummer, beide QR-Referenzformen, Gerät Zuteilen/Zurücknehmen, Ausstempeln, Verweise PDF/Rapport, Etikett-Links für Einsatz und Objekt, reine Regeln `src/lib/scan/regeln.ts` | P2 | CODE COMPLETE | `scan-regeln.test.ts`, `scan-kennung.test.ts` gelaufen (grün); `scan.test.ts`, `scan.spec.ts` geschrieben, **nicht gelaufen** (kein Server) | | |
| J-02 | Scanner | „Nachbestellen" nach Scan — fehlt, weil es kein Bestell-/Lieferantenbestellmodell gibt | P3 | OPEN | `docs/SCANNER.md`, Stand 2026-09-28 | | |
| J-03 | Scanner | Lagerorte als Etikettart — fehlt, weil es kein Lagerortmodell gibt | P3 | OPEN | `docs/SCANNER.md`, Stand 2026-09-28 | | |
| J-04 | Scanner | Abnahme auf echten Geräten (Kamera, Handscanner) | P2 | EXTERNAL EVIDENCE REQUIRED | `docs/SCANNER_DEVICE_ACCEPTANCE.md` | | Geräte |
| SEO-01 | Website | Canonical `/` im Wurzellayout von jeder Seite ohne eigene Angabe geerbt; hreflang auf nicht vorhandene `/en`, `/fr`, `/it`; `og:url` der Startseite auf Seiten ohne eigenes OG | P2 | CODE COMPLETE | `docs/SEO_AUDIT.md` §1–3; `seo-rechenkern.test.ts` gelaufen (grün); `public-site.test.ts` geschrieben, **nicht gelaufen** (kein Server) | | |
| SEO-02 | Website | JSON-LD mit festem Firmennamen, erfundener Preisspanne, falschem Leistungspreis, doppeltem `FAQPage`, `City.postalCode` | P2 | CODE COMPLETE | `lib/seo/structured-data.ts`, `components/marketing/json-ld.tsx`; `seo-rechenkern.test.ts` grün | | |
| SEO-03 | Website | Sitemap ohne Mandant, mit `noindex`-Seiten; robots ohne `/signieren`, `/abnahme/`, `/zahlung/` | P2 | CODE COMPLETE | `sitemap.ts`, `robots.ts`, `invalidateSeo`; `cms.test.ts`/`public-site.test.ts` geschrieben, nicht gelaufen | | |
| SEO-04 | Website | Vorschaubild-URL nahm `javascript:`/`data:` an; Titel/Beschreibung ungefiltert | P2 | CODE COMPLETE | `updateSeoSchema`, `sichereBildUrl`, `klartext`; `cms.test.ts` geschrieben, nicht gelaufen | | |
| SEO-05 | Verwaltung | Übersicht „SEO-Status" in `/admin/seo` | P3 | CODE COMPLETE | `features/admin/seo-status.tsx`, `seoStatus()` in `seo-rechenkern.test.ts` | | |
| SEO-06 | Website | Kein Standard-Vorschaubild (`og:image`), generische `alt` „Vorher/Nachher", kein Favicon/Manifest | P3 | OPEN | `docs/SEO_AUDIT.md` §9 — Gestaltungsentscheid | | |
| SEO-07 | Website | Rich-Result-Test und schema.org-Validator gegen die Produktionsdomain | P3 | EXTERNAL EVIDENCE REQUIRED | `docs/SEO_AUDIT.md` §9 | | Google, schema.org |
| VC-01 | Kontakt | Visitenkarte als QR-Code (SVG, serverseitig) und `.vcf`-Download auf `/kontakt` | P3 | CODE COMPLETE | `lib/kontakt/vcard.ts`, `lib/kontakt/qr.ts`, `GET /api/public/kontakt/vcard`; `vcard-rechenkern.test.ts` grün; `public-site.test.ts` geschrieben, nicht gelaufen | | |
| VC-02 | Kontakt | Scan des Codes mit echter iOS- und Android-Kamera (kein QR-Decoder im Repo) | P3 | EXTERNAL EVIDENCE REQUIRED | `vcard-rechenkern.test.ts` Kopfkommentar | | Geräte |
| TA-01 | Website/Auswertung | Eigene Besuchsmessung: `TrafficEvent`, `POST /api/public/traffic` (Kontingent `traffic`), `GET /api/traffic`, `/admin/auswertungen/website` (`traffic:read`), Aufbewahrung 13 Monate im Nachtlauf | P2 | CODE COMPLETE | `traffic-rechenkern.test.ts` 37/0 grün; `traffic.test.ts` geschrieben, nicht gelaufen; Migration `20260928120000_traffic_analytics` nicht angewandt; `prisma generate` ausstehend | | |
| TA-02 | Datenschutz | Absatz zur eigenen Besuchsmessung in Datenschutz- und Cookie-Erklärung (eingebaute Fassung) — fachlich/rechtlich prüfen; eine in `/admin` gepflegte Fassung ersetzt die eingebaute und muss von Hand ergänzt werden | P2 | EXTERNAL EVIDENCE REQUIRED | `docs/TRAFFIC_ANALYTICS.md` §7 | | Datenschutzberatung |
| TA-03 | Website | Browserprüfung der Erfassung (Einwilligung erteilen/widerrufen, `sendBeacon` beim `tel:`-Klick, keine Meldung ohne Einwilligung) | P3 | OPEN | kein `tests/e2e`-Fall | | |

## L — Oberfläche (Audit 2026-09-28)

Lesendes Audit der Oberfläche (Rollen, tote Links, leere Menüs, Knöpfe ohne
Wirkung). HTTP-Prüfungen geschrieben, **nicht gelaufen** (während der Umsetzung
lief eine Vollprüfung gegen den Testserver); reine Regeln in
`oberflaeche-regeln.test.ts` gelaufen (10/0). `tsc --noEmit` und `eslint` über
alle geänderten Dateien sauber.

| ID | Bereich | Befund | Prio | Status | Beleg / Prüfung | Commit | Extern |
|---|---|---|---|---|---|---|---|
| L-01 | Führung | Cockpit lud Risikomatrix, fällige Risiken/Marktprüfungen und ablaufende Dokumente für jede Rolle — die Betriebsleitung (ohne `risk:read`/`market:read`/`document:read`) sah Titel und Links in HTML und `GET /api/bi/cockpit`; Auffälligkeit „Fällige Prüfungen" verlinkte ins Risikoregister | P1 | CODE COMPLETE | `insightScopeFor`/`countDueReviews(scope)` in `insight.service.ts`, `getCockpit` lädt nur Erlaubtes (`risks: null`), Seite lässt Abschnitte weg, Assistent mit Rollensicht; `bi-fuehrung.test.ts` „die Betriebsleitung bekommt im Cockpit keine Risiken und keine Dokumente" | | |
| L-02 | Führung | Massnahmen verlinkten „Risiko: …" auch ohne `risk:read` (404) | P1 | CODE COMPLETE | Link nur mit Leserecht des Registers, sonst Text; `bi-fuehrung.test.ts` „Massnahmenliste …" | | |
| L-03 | Personal | Meldung „Neuer Abwesenheitsantrag" → `/admin/personal/abwesenheiten` (404) | P1 | CODE COMPLETE | Link `/admin/personal?reiter=abwesenheiten`, Reiter aus der URL; `smoke.test.ts` (Pfad + „L-03") | | |
| L-04 | Kundenbereich | Bewertungsbitte (Konto-Startseite, Automation) → `/konto/bewertungen/neu` (404) | P1 | CODE COMPLETE | `/konto/bewertungen?buchung=…`, Formular wählt eigene bewertbare Buchung vor und öffnet; Doppelprüfung kennt alten Link; `smoke.test.ts` „L-04", `kommunikation.test.ts` | | |
| L-05 | Portal | Aufgabenmeldungen schickten Mitarbeitende nach `/admin/aufgaben`/`/admin/fuehrung/…` (nicht betretbar); keine Aufgabenansicht im Portal | P1 | CODE COMPLETE | `/portal/aufgaben` (eigene offene Aufgaben, Abhaken über `PATCH /api/tasks/:id`), Navigationseintrag, `taskLinkFor`/`taskLinkForUser` an allen fünf Meldestellen; `ownership.test.ts` „Aufgaben im Portal", `smoke.test.ts`, `oberflaeche-regeln.test.ts` | | |
| L-06 | Personal | Leerzustand „Person erfassen" ohne `employee:create` | P1 | CODE COMPLETE | Aktion nur mit Recht. Keine HTTP-Prüfung: Der Leerzustand erscheint nur ohne jede Personalakte, der Demobestand hat welche | | |
| L-07 | Führung | Massnahmen: „Alle" nicht wählbar (Filterleiste strich `alle`, Seite fiel auf „offen") | P1 | CODE COMPLETE | `FilterDefinition.defaultValue` in `filter-bar.tsx`; `bi-fuehrung.test.ts` „Massnahmenliste …" | | |
| L-08 | Navigation | `/konto` für alle Rollen offen (nur Fehlerseiten für Personal); Portalnavigation ungefiltert („Meine Ziele" ohne `objective:read_own`) | P2 | CODE COMPLETE | `ROUTE_GUARDS` `/konto` nur CUSTOMER; Portal über `filterNavigation`; `rbac.test.ts` (`/konto`-Zeile, „filtert die Portalnavigation"), `oberflaeche-regeln.test.ts` | | |
| L-09 | Fehler | Fehlergrenze zeigte bei fehlender Berechtigung „Der Fehler liegt bei uns" | P2 | CODE COMPLETE | `ForbiddenError.digest = FORBIDDEN_DIGEST` (Next reicht einen gesetzten `digest` unverändert durch), `AreaError` zeigt „Keine Berechtigung" ohne „Erneut versuchen"; `oberflaeche-regeln.test.ts`. Browserfall fehlt | | |
| L-10 | Rechte | Elf reine Eingabemasken mit `requirePermission` statt `requirePagePermission` | P2 | CODE COMPLETE | alle elf umgestellt; `/admin/fuehrung/ziele/neu` zusätzlich in `PERMISSION_ROUTES` (Status vor dem Streamen); `rbac.test.ts` Zeile `/admin/fuehrung/ziele/neu` | | |
| L-11 | KI | KI-Knöpfe ohne Prüfung von `ai:use` und eingerichtetem Anbieter (Einsatzbericht, Offertentwurf, Antwortentwurf Bewertung, Blogentwurf) | P2 | CODE COMPLETE | Seiten übergeben `can(…,'ai:use') && hasIntegration('ai')`; Blog ohne KI: Artikel selbst verfassen statt Dialog ausblenden. Keine HTTP-Prüfung (Anbieter im Testserver nicht steuerbar) | | |
| L-12 | Finanzen | „Ausstellen" ohne Rückfrage, obwohl es die lückenlose Nummer zieht | P2 | CODE COMPLETE | `ActionButton` mit Bestätigung. Browserfall fehlt (Dialog nicht im Server-HTML) | | |
| L-13 | Finanzen | Leeres Menü „Weitere Aktionen" bei bezahlten/stornierten Rechnungen | P2 | CODE COMPLETE | `smoke.test.ts` „L-13"; dasselbe Muster in `job-actions.tsx` | | |
| L-14 | Personal | Personalakte zeigte der Betriebsleitung „Noch keine Dokumente abgelegt" (Sicht liefert ihr nichts) | P2 | CODE COMPLETE | Abschnitt und Abfrage nur mit `document:read`; `smoke.test.ts` „L-14" | | |
| L-15 | Listen | Suchfeld ohne Wirkung (Massnahmen, Sicherheit) | P2 | CODE COMPLETE | `FilterBar search={false}`; `bi-fuehrung.test.ts` prüft Massnahmen | | |
| L-16 | Kunden | „Termin buchen" → `/buchen?kunde=…`, Parameter nie ausgewertet | P2 | CODE COMPLETE | Link auf `/buchen` (einziger Erfassungsweg, wie in der Buchungsliste); `smoke.test.ts` „L-16" | | |
| L-17 | Personal | `/admin/personal/bewerbungen` nur über Benachrichtigung erreichbar | P2 | CODE COMPLETE | Knopf mit `application:read` in `/admin/personal`; `smoke.test.ts` „L-17" | | |
| L-18 | Kundenbereich | Kundschaft hält `contract:read_own` und `quality:read_own` („im Kundenbereich lesbar", `rbac.ts`), aber `/konto` hat weder Vertrags- noch Kontrollseite | P2 | CODE COMPLETE | `/konto/vertraege`, `/konto/vertraege/[id]`, `/konto/qualitaet` (nur lesend); `listCustomerContracts`/`getCustomerContract` (`contract.service.ts`: Eigentum + Mandant + Zustände OFFERED/ACTIVE/PAUSED/NOTICE_GIVEN/ENDED im `where`, nur geltende/abgelöste Fassungen, Feldauswahl wie Vertrags-PDF), `listCustomerInspections` (`quality.service.ts`, Sichtregel `qualityVisibilityWhere`); Navigation über `filterNavigation` mit den beiden Rechten; Preissatz `preisText` gemeinsam mit dem PDF. Kein Link auf das signierte Dokument (einzige Route verlangt `signature:read`). Prüfungen: `ownership.test.ts` „L-18: die Kundschaft sieht nur eigene, zugegangene Verträge — ohne interne Felder", „L-18: die Kundschaft sieht nur abgeschlossene Kontrollen der eigenen Objekte — ohne interne Notiz"; `smoke.test.ts` (`/konto/vertraege`, `/konto/qualitaet`, `/konto/vertraege/:id`). Geschrieben, nicht gelaufen; `tsc`/`eslint` sauber | | |
| L-19 | Navigation | Kontomenü „Einstellungen" neben gleichnamigem Seitenleisteneintrag der Firmenkonfiguration | P3 | CODE COMPLETE | „Persönliche Einstellungen" (`app-shell.tsx`); `produktsprint-2026-09-26.spec.ts` angepasst | | |
| L-20 | Führung | „★" als Zeichen in der Wettbewerberliste | P3 | CODE COMPLETE | lucide `Star` (`markt/page.tsx`) | | |
| L-21 | Kundenbereich / API | Gefunden bei L-18: `GET /api/contracts/:id` liefert der Kundschaft (`contract:read_own`) den eigenen Vertrag mit `include` statt Auswahl — samt `internalNote`, `costCenter`, Zuständigen (Verantwortung, Verkauf, Betreuung), Fassungs-`internalNote`, Entwurfsfassungen, Änderungsanträgen und Preisanpassungen; `GET /api/contracts` listet ihr auch `DRAFT`/`IN_REVIEW`/`CANCELLED`. Die neuen Seiten sind davon nicht betroffen (eigene Auswahl) | P1 | CODE COMPLETE | Beide GET-Routen leiten Kundschaft durch `getCustomerContract`/`listCustomerContracts` (Zustände `KUNDENSICHTBARE_VERTRAGSZUSTAENDE`, Feldauswahl wie PDF, `?status=DRAFT` wirkungslos); OpenAPI-Beschreibungen angepasst | `vertraege.test.ts` „eigener Vertrag: Entwurf unsichtbar, aktive Fassung ohne interne Felder (L-21)" und „Kundschaft sieht ausschliesslich die eigenen Verträge" (gegen den Bestand geprüft) | |
