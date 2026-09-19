# Clenaris — Standortbestimmung und nächste Entwicklungsphasen

**Stand:** 2026-09-19 · **Grundlage:** Quellcode im Arbeitsbaum (`main`, letzter
Commit `4d07be0`, Arbeitsbaum sauber). Jede Aussage nennt die Stelle, an der sie
überprüfbar ist. Wo dieses Dokument dem
[`PROJECT_IMPLEMENTATION_CHECKLIST.md`](PROJECT_IMPLEMENTATION_CHECKLIST.md)
(Stand 2026-09-14) widerspricht, gilt dieses hier — die Prüfung von damals lag
vor den letzten vier Commits desselben Tages.

**Zielbild:** Clenaris soll nicht die Website eines Reinigungsbetriebs sein,
sondern das **Betriebssystem eines Schweizer Reinigungs- und Gebäudedienst­leisters**:
Website · CMS · CRM · Verkauf · Kundschaft · Objekte · Offerten · Buchungen ·
Verträge · Einsätze · Disposition · Personal · Zeiterfassung · Lohn ·
Qualität · Material · Finanzen · Fakturierung · Zahlungen · Kommunikation ·
Automatisierung · Marketing · Unternehmensführung.

---

## 0. Kennzahlen am Prüftag

| Grösse | Wert | Ermittelt mit |
|---|---|---|
| Seiten (`page.tsx`) | 134 | `Get-ChildItem src/app -Recurse -Filter page.tsx` |
| Route-Dateien (`route.ts`) | 244 | `src/app/api/**` |
| Dienste | 47 | `src/server/services/*` |
| Validierungsmodule | 27 | `src/lib/validation/*` |
| Prisma-Modelle / Enums | 111 / 67 | `prisma/schema.prisma` (3 700 Zeilen) |
| Migrationen | 12 | `prisma/migrations/` |
| Testdateien / `it()`-Aufrufe | 20 / 297 | `tests/` (durch Schleifen effektiv ~490 Zusicherungen) |
| Zeilen TypeScript/TSX unter `src/` | 108 057 | |
| Berechtigungen | 424 Zeilen Katalog, 10 Gruppen | `src/lib/auth/permissions.ts` |

**Werkzeuglauf am Prüftag:** `npm run typecheck` → 0 Fehler ·
`npm run lint` → 0 Warnungen · `npm audit` → **8 Schwachstellen
(1 kritisch, 5 hoch, 2 mittel)**.

---

## 1. Was sich seit der letzten Dokumentation geändert hat

Die vier letzten Commits vom 2026-09-14 liegen **nach** dem Prüfstand des
bisherigen Checklisten-Dokuments. Damit sind folgende Aussagen dort überholt:

| Bisherige Aussage | Tatsächlich | Beleg |
|---|---|---|
| „**Keine CI-Pipeline** (kein `.github/`)" | CI existiert und ist vollständig: Lint, Typecheck, Secret-Scan, Dokumentationsabgleich, Migration, Demo-Seed, Build, gestarteter Server, **ganze Testreihe**, dann erst Auslieferung | `.github/workflows/deploy.yml` |
| „Hosting: Vercel" | Zwei Wege: Vercel *und* eigener Server über GitHub Actions → SSH → `scripts/deploy.sh` → PM2 (Cluster, Reload ohne Ausfall) mit Health-Check gegen `github.sha` und Rückrollen | `ecosystem.config.js`, `scripts/deploy.sh`, `docs/DEPLOYMENT.md` Abschnitt 12–13 |
| `createInvoiceFromQuote` „ungenutzt" | Verdrahtet | `quote.service.ts:840` |
| 240 Routen / 46 Dienste / 133 Seiten | 244 / 47 / 134 | s. Abschnitt 0 |
| Datenbereinigung fehlt | `/admin/datenbereinigung`, `POST /api/system/purge`, `purge.service.ts` (436 Zeilen) — bereichsweises endgültiges Löschen vor dem Livegang, ein Prüfprotokolleintrag **innerhalb** der Transaktion | `src/server/services/purge.service.ts` |
| Buchungsbestätigung als PDF fehlt | `GET /api/bookings/[id]/pdf`, `GET /api/public/bookings/[token]/pdf` | |
| Nachkalkulation je Einsatz fehlt | `GET /api/jobs/[id]/costing`, `src/lib/costing/job.ts` | |

**Unverändert offen** sind dagegen alle als P1 markierten Sicherheitspunkte von
damals — einschliesslich der Next.js-Version. Sie sind seither **schlechter**
geworden, weil weitere Advisories dazugekommen sind (Abschnitt 3).

**Neu in dieser Prüfung gefunden** (in der bisherigen Checkliste nicht
enthalten): S-01 (Rechteasymmetrie Lohn), S-02 (behauptete, nicht existierende
Verschlüsselung), B-01 (`alarmCode` wird nie gespeichert), O-01 (Einteilung
ignoriert bewilligte Abwesenheiten), K-01 (Reinigungspläne sind Quelltext),
T-01 (die Testreihe hing am persönlichen `SEED_ADMIN_PASSWORD` der jeweiligen
Maschine).

**Befund zum Datenbestand am Prüftag.** Die Entwicklungsdatenbank `clenaris`
enthält 0 Kundschaften, 0 Buchungen, 0 Einsätze, 0 Rechnungen und 0
Mitarbeitende; von den Konten ist nur `system@clenaris.ch` übrig. Katalog,
Einstellungen, Website-Texte und die 1 037 Protokollzeilen stehen. Das ist
genau das Muster der Datenbereinigung — **nur steht sie nicht im
Prüfprotokoll**, und `runPurge` schreibt seinen Eintrag ausdrücklich
*innerhalb* der Transaktion („Ein Löschen, das nicht protokolliert werden
kann, findet nicht statt", `purge.service.ts`). Der letzte protokollierte
Änderungsvorgang stammt vom 2026-09-14 20:52 UTC; seither nur Anmeldungen.
Die Daten sind also **nicht über die Anwendung** entfernt worden, sondern an
ihr vorbei — Prisma Studio, direktes SQL oder ein früheres Zurücksetzen. Dass
viele ältere Protokollzeilen jetzt `user: null` tragen, bestätigt, dass Konten
gelöscht wurden (Fremdschlüssel auf `SetNull`).

Diese Prüfung hat daran nichts geändert (siehe Abschnitt 9.1).

---

## 2. Gesamturteil

Clenaris ist **kein Prototyp**. Die tragenden Architekturentscheide sind
umgesetzt und werden eingehalten: Lesen in Server Components, Schreiben
ausschliesslich über Route Handler, jede Route über eine Fabrik mit erklärtem
Schutz, jede Eingabe über ein Zod-Schema aus `src/lib/validation`, Fachlogik in
`src/server/services`, Eigentümerschaft im `where` statt im Rendering,
Belegnummern lückenlos in der Transaktion, Preise nur serverseitig. Die
Dokumentation ist teilweise erzeugt und in der CI gegen den Code abgeglichen.

Die Lücken liegen **nicht** in der Architektur, sondern in drei anderen
Bereichen:

1. **Sicherheit und Abhängigkeiten.** Die eingesetzte Next.js-Fassung ist
   gegenüber über dreissig veröffentlichten Advisories offen, darunter eine
   Autorisierungs­umgehung in der Middleware und eine unauthentifizierte RCE.
   Dazu kommt eine Rechteasymmetrie, über die die Betriebsleitung
   Lohn- und Bankangaben **schreiben** kann, die sie nicht lesen darf.
2. **Fertige Fachlogik ohne Zugang.** Gutschrift, Lohnabrechnung,
   Kunden­anonymisierung, Einsatz ohne Buchung, Zeitkorrektur — die Dienste sind
   geschrieben und getestet-fähig, es fehlt jeweils nur der Endpunkt und die
   Schaltfläche. Das ist der billigste Fortschritt im ganzen Projekt.
3. **Reinigungsspezifischer Betrieb.** Reinigungsplan, Objektwissen,
   Materialwirtschaft, Reklamationsführung und Vertragsverwaltung sind
   entweder im Quelltext hartkodiert oder als bewusste Vereinfachung
   modelliert. Das trägt einen Betrieb mit fünf Mitarbeitenden; es trägt keinen
   mit fünfzig.

---

## 3. Sicherheitsbefunde

### S-00 · Next.js 15.1.4 — kritisch

`npm audit` meldet für die eingesetzte Fassung **über dreissig** Advisories.
Die für diese Anwendung bedeutsamen:

| Advisory | Wirkung hier |
|---|---|
| GHSA-f82v-jwr5-mffw (CVE-2025-29927) — Authorization Bypass in Middleware | `src/middleware.ts` ist der einzige Rollenfilter für `/konto` (siehe S-03). Der Header `x-middleware-subrequest` wird nirgends behandelt. |
| GHSA-p293-qw3h-jr36 — unauthentifizierte RCE auf Windows-Hosts | Nur relevant, falls je unter Windows betrieben; die Entwicklungsmaschine ist Windows. |
| GHSA-2xp9-vwfh-vxw4 — unauthentifizierte RCE in der Bildoptimierung bei AVIF | `next.config.ts` aktiviert `formats: ['image/avif', 'image/webp']` und erlaubt entfernte Bildquellen. |
| GHSA-4342-x723-ch2f, GHSA-c4j6-fc7j-m34r — SSRF | |
| Mehrere Cache-Poisoning- und DoS-Befunde | Selbstbetrieb hinter Reverse Proxy |
| Abhängig verwundbar: `postcss` (4 Advisories, hoch), `sharp`/libvips (hoch) | kommen mit Next |

**Behebung:** `next` auf 15.5.x. Damit fallen `postcss` und `sharp`
mit. Verbleibend danach: `deepmerge-ts` (über `@prisma/config`, nur Build-Zeit)
und `uuid` (über `exceljs`, nur Schreiben von Arbeitsmappen) — beides ohne
Angriffsfläche in der Laufzeit dieser Anwendung, beides ohne bruchfreien Fix.

### S-01 · Betriebsleitung schreibt Lohn- und Bankangaben, die sie nicht lesen darf — hoch

`GET /api/employees/[id]` trennt sauber: Lohn, AHV-Nummer und IBAN liefert der
Dienst nur mit `includeSensitive: can(session.role, 'payslip:create')`
(`src/app/api/employees/[id]/route.ts:33`). Die Begründung steht im
Doc-Kommentar darüber und ist richtig.

`PATCH /api/employees/[id]` prüft dagegen nur `employee:update`
(Zeile 46) — und `MANAGER` hat diese Berechtigung (`rbac.ts:152`). Das
`updateEmployeeSchema` nimmt `hourlyRate`, `monthlySalary`, `ahvNumber`,
`iban` und `notes` entgegen (`validation/operations.ts:466-483`).

Folge: Die Betriebsleitung kann den Stundenlohn beliebiger Mitarbeitender
ändern und die Auszahlungs-IBAN überschreiben, **ohne den bisherigen Wert
sehen zu dürfen**. Der Vorgang landet zwar im Prüfprotokoll, aber redigiert.
Dass `POST /api/employees` ausdrücklich auf `ADMIN`/`SUPER_ADMIN` beschränkt
ist (`employees/route.ts:54`, mit genau dieser Begründung im Kommentar), zeigt,
dass es sich um ein Versehen handelt und nicht um eine Absicht.

### S-02 · Behauptete, aber nicht existierende Verschlüsselung — hoch

Zwei Schemafelder tragen den Kommentar, sie seien verschlüsselt:

```prisma
alarmCode String?   // verschlüsselt gespeichert (siehe lib/crypto)   prisma/schema.prisma (Property)
ahvNumber String?   // 756.xxxx.xxxx.xx — verschlüsselt               prisma/schema.prisma (Employee)
```

**`src/lib/crypto` existiert nicht.** Beide Werte lägen im Klartext in der
Datenbank. Das ist gefährlicher als gar kein Kommentar: Wer die Datei liest,
hält die Frage für beantwortet.

Dasselbe gilt für `User.twoFactorSecret` — Base32 im Klartext
(`two-factor.service.ts:89`). Wer einen Datenbankabzug hat, kann für jedes
Konto gültige zweite Faktoren erzeugen; der zweite Faktor ist dann keiner mehr.
`src/lib/audit.ts:23,27` redigiert beide Felder im Protokoll, was den Eindruck
verstärkt, sie seien geschützt.

### S-03 · `konto/layout.tsx` ohne eigene Rollenprüfung — mittel

`portal/layout.tsx:22-23` holt sich seine zugelassenen Rollen aus
`ROUTE_GUARDS` und leitet sonst um. `konto/layout.tsx:17` prüft nur, ob
*irgendeine* Sitzung besteht. Der Kundenbereich verlässt sich damit allein auf
die Middleware — genau die Schicht, die CVE-2025-29927 aushebelt. Der Schaden
bliebe begrenzt (`customerId` ist `null` für Nicht-Kundschaft, alle Abfragen
liefern leer), aber es ist die einzige Stelle, an der eine Ebene fehlt.

### S-04 · CSP ohne Wirkung gegen XSS — mittel

`next.config.ts:15` setzt `script-src 'self' 'unsafe-inline' 'unsafe-eval' …`.
Mit beiden Schlüsselwörtern ist die Richtlinie als XSS-Schutz gegenstandslos;
sie beschränkt nur noch die Herkunft. Kein Nonce, kein `report-uri`.

### S-05 · `CRON_SECRET`-Vergleich nicht zeitkonstant — niedrig

`handler.ts:255` vergleicht mit `!==`. Praktisch schwer ausnutzbar über das
Netz, aber der Fix kostet drei Zeilen.

### S-06 · Rate-Limit ohne Redis prozesslokal — mittel (betrieblich)

`redis.ts` fällt ohne `REDIS_URL` auf einen Prozessspeicher zurück. Im
PM2-Cluster mit zwei Arbeitern (`ecosystem.config.js`) bedeutet das: das
Login-Kontingent von 8 Versuchen gilt **pro Arbeiter**, also faktisch 16 — und
mit `PM2_INSTANCES=max` entsprechend mehr. Der Bruteforce-Schutz ist damit
nicht das, was er verspricht. Für den Eigenbetrieb ist Redis keine Option
mehr, sondern Voraussetzung, oder das Kontingent muss in die Datenbank.

### S-07 · Weitere, unverändert offen

Upload-Kontingent von 1 GiB für alle Profile gemeinsam
(`storage/profiles.ts`); lokale Blobs (auch Lebensläufe und Personaldokumente)
nur durch die cuid geschützt (`files/blob/[id]/route.ts`); kein
Aufbewahrungs- oder Löschlauf für das Prüfprotokoll (DSG-Datenminimierung);
Passwortrichtlinie ohne Abgleich gegen bekannte Leaks; `user:impersonate` als
Berechtigung ohne Implementierung.

---

## 4. Modulweise Standortbestimmung

Legende: **✅** vollständig · **🟡** vorhanden mit Lücken · **❌** fehlt ·
**⚠️** vorhanden, Prüfung nötig.

### 4.1 Website und Conversion

| | |
|---|---|
| **Status** | ✅ (mit Randlücken) |
| **Vorhanden** | 24 öffentliche Seiten, ISR, CMS-gesteuert über `src/lib/cms/registry.ts`; Buchungsassistent in 6 Schritten mit serverseitigem Preis bei jeder Änderung; Offertanfrage → Lead + Offertentwurf; PLZ-Prüfung; Galerie, Bewertungen, FAQ, Blog, Karriere mit Bewerbungsformular; KI-Chat; Cookie-Banner mit echter Einwilligungssteuerung; JSON-LD auf 6 Seiten |
| **Fehlt** | `error.tsx` / `loading.tsx` / `not-found.tsx` unter `(public)` und `(auth)` — Fehler verlieren das Website-Layout; Gast-Buchung per Token kündigt Verschieben und Absagen an, bietet beides nicht (`(public)/buchung/[token]/page.tsx:135`); kein `next/image` auf der Website, obwohl die AVIF/WebP-Pipeline konfiguriert ist |
| **Technische Schuld** | `alternates.languages` verweist auf `/en`, `/fr`, `/it` — diese Routen existieren nicht (`src/app/layout.tsx:76`); Telefonnummern hartkodiert statt aus `getPublicCompanyInfo()`; Newsletter-Bestätigung schreibt während eines GET-Renders |
| **Geschäftswirkung** | Gering bis mittel. Die Conversion-Pfade funktionieren; es fehlt Politur. |
| **Priorität** | P3 |

### 4.2 CRM — Leads, Kundschaft, Objekte

| | |
|---|---|
| **Status** | 🟡 |
| **Vorhanden** | Lead-Pipeline mit Kanban und serverseitiger Deduplizierung über E-Mail, Telefon, Name+Firma (`crm.service.ts findMatchingLead`); Umwandlung in Kundschaft; Kundenakte mit Adressen, Objekten, Aktivitäten, Zusammenführen; Objekt-CRUD im Büro und im Kundenkonto |
| **Fehlt — Zeitstrahl** | Es gibt keine **eine** Kundenchronik. Die Detailseite zeigt Blöcke nebeneinander; wer wissen will, was in dieser Kundenbeziehung in Reihenfolge geschehen ist (Lead → Offerte → Buchung → Einsatz → Rechnung → Reklamation → Bewertung), muss sie zusammensuchen. `Activity` existiert als Modell, hat aber kein `GET /api/activities` (nur `POST`) und keine bereichsübergreifende Ansicht. |
| **Fehlt — Objektwissen** | `Property` trägt Fläche, Zimmer, Bäder, Fenster, Stockwerk, Parkierung, Schlüsseldepot, Zugangsnotiz. Es fehlt für den Betrieb: bevorzugte Zeitfenster, Turnus, Gefahren/Hinweise (Tiere, Allergien, Chemikalien), Ausstattung vor Ort (Wasseranschluss, Strom, Lift, Putzkammer), Ansprechperson am Objekt, Fotos, Dokumente, Reinigungsplan (siehe 4.4), Einsatzhistorie als Ansicht |
| **Datenmodell** | `alarmCode` ist im Schema und im Zod-Schema (`validation/crm.ts:214`) deklariert, wird aber **von keiner Route geschrieben** (`properties/route.ts:148` und `[id]/route.ts:111` kennen nur `keyLocation`) — siehe B-01 |
| **API-Lücken** | Keine Kunden-Anonymisierung, obwohl `anonymizeCustomer` fertig ist (`crm.service.ts:1001`) — für ein DSG-Löschbegehren gibt es damit keinen Weg ausser SQL; kein `GET /api/leads/[id]`, kein `GET /api/activities` |
| **Testlücken** | Eigentümerschaft der Objekte ist in `tests/api/ownership.test.ts` geprüft; Anonymisierung und Zusammenführen sind es nicht |
| **Geschäftswirkung** | Hoch. Ohne Chronik und Objektwissen bleibt die Software eine Ablage statt eine Betriebsführung. |
| **Priorität** | P1 (Anonymisierung, Chronik) · P2 (Objektwissen) |

### 4.3 Offerten, Buchungen, Verträge

| | |
|---|---|
| **Status** | 🟡 |
| **Vorhanden** | Offerte mit Positionen, Einheit je Leistung, Zeilen- und Gesamtrabatt, MwSt. je Position, PDF, Versand, Online-Annahme mit Unterschrift/IP/Zeitstempel, Ablehnung mit Grund, Duplizieren, Umwandeln in Buchung **und** Rechnung (`quote.service.ts:840`); Buchung mit Serie über `RecurrenceRule`, Umbuchen, Absagen, Gast-Token |
| **Vertragsfrage** | Ein eigenes `Contract`-Modell gibt es nicht — und das ist vorerst richtig: `Booking` + `RecurrenceRule` (Frequenz, Intervall, Wochentage, Monatstag, Start/Ende, `count`, `generatedUntil`) trägt die Semantik eines Dauerauftrags bereits. **Was fehlt**, ist nicht das Modell, sondern die Führung darüber: keine Pause/Unterbruch, keine kundenspezifischen Ausnahmen (Feiertage, Betriebsferien), keine Ansicht „laufende Verträge" mit Turnus, Wert und nächstem Termin, keine Preisanpassung mit Stichtag, die historische Einsätze unangetastet lässt |
| **API-Lücken** | **Kein authentifiziertes `POST /api/bookings`** — das Büro legt Buchungen über `/api/public/bookings` an (`bookings/route.ts` kennt nur `GET`). Damit gelten für eine Erfassung im Büro die öffentlichen Rate-Limits und der öffentliche Validierungspfad |
| **Testlücken** | Admin-Statuswechsel und `account/bookings/*` ungetestet; Offerten-Token-Antwort ungetestet |
| **Geschäftswirkung** | Hoch. Wiederkehrende Aufträge sind das Geschäftsmodell eines Reinigungsbetriebs; sie sind der am schwächsten geführte Teil. |
| **Priorität** | P1 (`POST /api/bookings`) · P2 (Vertragsführung, Pause, Ausnahmen) |

### 4.4 Reinigungsplan und Checklisten

| | |
|---|---|
| **Status** | ❌ als System, 🟡 als Behelf |
| **Vorhanden** | `JobChecklistItem` je Einsatz (Bezeichnung, Raum, Pflicht, erledigt, Notiz, Reihenfolge); Pflichtpunkte werden beim Abschluss erzwungen (`job.service.ts:736`); Checkliste im Büro editierbar, im Portal abhakbar |
| **Der Befund (K-01)** | Die Vorlagen sind **Quelltext**: `CHECKLIST_TEMPLATES: Record<ServiceKind, …>` in `job.service.ts:87`. Eine Betriebsleitung, die „Büroreinigung" um „Kaffeemaschine entkalken, monatlich" erweitern will, braucht eine Auslieferung. Das widerspricht dem Grundsatz, dass keine betriebliche Konfiguration im Quelltext stehen soll |
| **Fehlt** | Objekt-spezifische Pläne; Hierarchie Plan → Bereich → Raum → Aufgabe; Turnus je Aufgabe (täglich / wöchentlich / monatlich / nach Vertrag); geschätzte Dauer; Qualitätsanforderung; benötigtes Material; optionale gegenüber pflichtigen Aufgaben; Fotopflicht je Aufgabe; Nachweis, welcher Planstand bei einem Einsatz galt |
| **Datenmodell** | Neu nötig: `CleaningPlan`, `CleaningPlanTask` (mit `Frequency`, Dauer, Material, Fotopflicht), Verknüpfung zu `Property` und/oder `Service`; `JobChecklistItem` erhält Herkunftsverweis und Fotopflicht |
| **Geschäftswirkung** | Sehr hoch. Das ist der Kern von „Reinigung ist Handwerk": nachweisbare, wiederholbare Leistung. Es ist auch das stärkste Verkaufsargument gegenüber Preisvergleichern. |
| **Priorität** | **P2, erste Position** |

### 4.5 Disposition und Einsätze

| | |
|---|---|
| **Status** | 🟡 |
| **Vorhanden** | FullCalendar-Disposition 00:00–24:00 mit Ziehen und Ablegen (`/api/jobs/[id]/move`), Teamzuteilung mit Rollen, Überschneidungsprüfung, KI-Tourenvorschlag (`/api/ai/dispatch`, nur Vorschlag); Einsatzdetail mit Auftrag, Checkliste, Team, Material, Fotos, Nachkalkulation, Bericht |
| **Der Befund (O-01)** | `assignJob` (`job.service.ts:411-450`) prüft **aktives Personal** und **Doppelverplanung**, aber **nicht die bewilligten Abwesenheiten**. Wer in den Ferien ist, lässt sich widerspruchslos einteilen — und erfährt es per Benachrichtigung. Dasselbe in `job.service.ts:1019` beim Verschieben. Die Daten sind da (`Absence` mit `status`), die Abfrage fehlt |
| **Fehlt weiter** | Keine Prüfung gegen `Availability` (hinterlegte Arbeitszeiten je Wochentag), gegen `EmployeeSkill` (Qualifikation für die Leistung), gegen Fahrzeit zwischen zwei Einsätzen, gegen Pensum/Überstundenrisiko; keine Warnliste „Einsätze ohne Team", „unterbesetzt", „startet gleich, niemand unterwegs" |
| **API-Lücken** | **Kein `GET /api/jobs`, kein `POST /api/jobs`** — `createJob` und `listJobs` sind fertig (`job.service.ts:204`, `:1374`) und über HTTP nicht erreichbar. Ein Einsatz ohne vorangehende Buchung (Nachbesserung, Sonderauftrag, Hauswartung auf Zuruf) lässt sich nicht anlegen |
| **Testlücken** | `tests/api/jobs.test.ts` deckt Checkliste, Team, Abschluss ab; die Konfliktprüfungen selbst nicht |
| **Geschäftswirkung** | Sehr hoch. Eine Einteilung, die Ferien ignoriert, produziert genau den Ausfall, den die Software verhindern soll. |
| **Priorität** | **P1 (O-01, `GET`/`POST /api/jobs`)** · P2 (Warnsystem) |

### 4.6 Personal

| | |
|---|---|
| **Status** | 🟡 |
| **Vorhanden** | Personalakte vollständig: Stammdaten, Anstellung, Pensum, Eintritt/Austritt, Lohnhistorie (`SalaryRecord` mit `validFrom`, Grund, ändernde Person), Schweizer Felder (AHV, Bewilligung mit Frist, IBAN, Notfallkontakt), Fähigkeiten mit Zertifikatsfrist, Verfügbarkeiten, Abwesenheiten mit Bewilligung, Dokumente über die Führungsablage mit Sichtbarkeit `EMPLOYEE_PRIVATE`, Kontoaktionen (Zugangslink, Sperre, 2FA-Reset, Foto) |
| **Trennung der Rechte** | Lesend **gelöst**: Lohn/AHV/IBAN nur mit `payslip:create`. Schreibend **nicht** — siehe S-01 |
| **Fehlt** | Zeitkorrektur und Freigabe durch die Verwaltung. `TimeEntry` trägt `manual`, `approved`, `approvedById` und einen Stundensatz-Snapshot; es gibt **keinen Endpunkt** und keine Oberfläche dafür, obwohl `timetracking:approve` als Berechtigung existiert und vergeben ist. Die geforderte Nachvollziehbarkeit (alter Wert, neuer Wert, Grund, Person, Zeitpunkt) fehlt damit ganz |
| **Fehlt weiter** | Keine Ansicht der Zeiterfassung über alle Mitarbeitenden für die Verwaltung (`timetracking:read_all` ohne Seite); kein Ferienkonto mit Übertrag; Beschäftigungsdaten (Pensum, Vertrag) für Mitarbeitende im Portal nicht sichtbar |
| **Geschäftswirkung** | Hoch. Ohne Freigabe ist die Zeiterfassung keine Lohnbasis, sondern eine Sammlung. |
| **Priorität** | **P1** |

### 4.7 Lohn

| | |
|---|---|
| **Status** | 🟡 (bewusst unfertig, korrekt gekennzeichnet) |
| **Vorhanden** | `Payslip` je Person/Jahr/Monat mit AHV/IV, ALV, BVG, UVG, übrigen Abzügen, Netto; `generatePayslip` (`employee.service.ts:766`) rechnet Brutto aus Monatslohn×Pensum oder Stunden×Satz; `SOCIAL_RATES` im Code: AHV/IV/EO 5.3 %, ALV 1.1 % bis 12 350, UVG 0.73 %, **BVG pauschal 7 % als ausdrücklich benannte Näherung**; Portal zeigt echte Abrechnungen |
| **Fehlt** | Kein Endpunkt, der eine Abrechnung erzeugt — die Seite `/portal/lohn` zeigt Daten, die auf keinem unterstützten Weg entstehen können. `pdfUrl` wird nirgends befüllt, es gibt keinen Lohnausweis |
| **Bewusst nicht umgesetzt** | Quellensteuer, Familienzulagen, BVG nach Koordinationsabzug und Altersgutschrift, UVG/UVGZ-Differenzierung, Swissdec-Übermittlung. Das ist die richtige Entscheidung: eine Näherung, die wie eine gesetzeskonforme Abrechnung aussieht, ist schlimmer als keine |
| **Empfehlung** | Die Trennung **explizit machen**: „betriebliche Lohnbasis" (was Clenaris rechnet) gegenüber „gesetzliche Lohnabrechnung" (was das Treuhandbüro rechnet). Die Oberfläche muss das sagen, nicht nur der Kommentar. Erst danach lohnt sich der Ausbau — und dann pro Regel mit Test, nicht als Paket |
| **Priorität** | P1 (Endpunkt + Kennzeichnung) · P5 (gesetzliche Vollständigkeit) |

### 4.8 Qualität und Reklamationen

| | |
|---|---|
| **Status** | 🟡 |
| **Vorhanden** | Vorher/Nachher-Fotos je Einsatz (`JobPhoto` mit `BEFORE`/`AFTER`/`DAMAGE`), Checkliste mit Pflichtpunkten, Kundenunterschrift beim Abschluss, Kundenbewertung mit Moderation, Kontrollen und Massnahmen (CAPA) in der Unternehmensführung (`ControlEntry`, `CorrectiveAction`) |
| **Die Modellentscheidung** | Das Schema sagt ausdrücklich: „*Eine Reklamation ist in dieser Anwendung eine Bewertung — die Massnahme dazu hängt hier, nicht an einem neuen Reklamationsobjekt.*" Für eine öffentliche Bewertung mit einem Stern trägt das. Für die Reklamation einer Geschäftskundschaft trägt es nicht: die ist nicht öffentlich, hat einen Mangelort (welcher Raum, welche Aufgabe), eine Frist, eine Nachbesserung als Einsatz, eine Abnahme und eine Kostenfolge |
| **Fehlt** | Qualitätskontrolle als eigener Vorgang (Stichprobe, Bewertungsraster, Punktzahl); Mangel mit Verortung auf Objekt/Raum/Checklistenpunkt; Nachbesserung als verknüpfter Einsatz mit Kostenstelle; Häufung erkennen (dieselbe Person, dasselbe Objekt, dieselbe Aufgabe) und in die Unternehmensführung heben |
| **Geschäftswirkung** | Hoch — es ist die Rückseite von 4.4. Ohne Mangelverfolgung ist der Reinigungsplan nur eine Absichtserklärung |
| **Priorität** | P2 |

### 4.9 Material und Ausrüstung

| | |
|---|---|
| **Status** | 🟡 |
| **Vorhanden** | `MaterialUsage` je Einsatz: Bezeichnung, SKU, Menge, Einheit, Einzelkosten, Summe, verrechenbar. Fliesst in die Nachkalkulation (`src/lib/costing/job.ts`) |
| **Fehlt** | Kein Materialstamm — jede Erfassung tippt den Namen neu; kein Lagerbestand, keine Mindestmenge, kein Lieferant am Artikel, kein Einkaufspreis mit Historie; keine Geräte/Maschinen mit Zuordnung, Wartungsintervall, Schaden, Ersatz (die Investitionsverwaltung der Unternehmensführung kennt Anlagen, verbindet sie aber nicht mit dem Betrieb) |
| **Datenmodell** | Neu nötig: `MaterialItem` (Stamm) mit Bestand und Mindestmenge; `MaterialUsage.itemId` als optionaler Verweis (Freitext bleibt möglich, sonst bricht Bestehendes); `Equipment` mit Wartung, verknüpfbar mit `Investment` |
| **Geschäftswirkung** | Mittel. Wirkt vor allem über die Nachkalkulation auf die Deckungsbeitragsrechnung |
| **Priorität** | P3 |

### 4.10 Finanzen

| | |
|---|---|
| **Status** | 🟡 |
| **Vorhanden** | Rechnung mit Positionen, Ausstellen nur aus `DRAFT` mit Nummernvergabe in derselben Transaktion (Art. 957a OR), QR-Rechnung nach SIX v2.3 mit QR-IBAN-Erkennung, Versand, Storno, Teilzahlung, idempotente Zahlungserfassung über `providerPaymentId`, dreistufiges Mahnwesen mit Gebühren und SMS ab Stufe 2, Ausgaben, Lieferanten, Buchhaltungsexport (CSV/XLSX), Stripe-Checkout mit TWINT und Karte über Webhook |
| **Fehlt (F-01)** | **Gutschrift.** `createCreditNote` (`invoice.service.ts:665`) und `createCreditNoteSchema` (`validation/finance.ts:75`) sind fertig. Es gibt keine Route und keine Schaltfläche. Damit hat die Anwendung für den einzigen zulässigen Korrekturweg einer ausgestellten Rechnung keinen Bedienpfad — und `README.md:102` verspricht ihn |
| **Rundung** | `roundToRappen()` (`src/lib/utils.ts:160`) existiert und wird **nirgends** verwendet; gerechnet wird durchgängig mit `round2`. Das ist vertretbar — die 5-Rappen-Rundung gehört an die Barzahlung, nicht an die Rechnung —, aber es ist nirgends entschieden und dokumentiert. Entweder anwenden, wo Bargeld im Spiel ist, oder die Funktion entfernen |
| **Testlücken** | Am schwerwiegendsten im ganzen Projekt: **keine** Tests für Zahlungserfassung, Stripe-Webhook (Signatur, Idempotenz, Rückerstattung), Gutschrift, Exporte, QR-Referenz mit festen Erwartungswerten, Preis-Engine. `docs/ARCHITECTURE.md` benennt diese Lücke selbst |
| **Geschäftswirkung** | Sehr hoch — es ist Geld, und es ist prüfungsrelevant |
| **Priorität** | **P1 (Gutschrift, Geldtests)** · P3 (Zahlungsabgleich, Rundungsentscheid) |

### 4.11 Unternehmensführung (BI)

| | |
|---|---|
| **Status** | ✅ |
| **Vorhanden** | 62 Routen, 18 Seiten: Cockpit mit Gesundheitswert, Kennzahlen mit festgeschriebenem Verlauf (`KpiSnapshot`, laufende Periode `provisional`), Ziele als ein `Objective`-Modell für OKR/Strategie/Roadmap, Budget mit Genehmigung und Abweichung, Investitionen mit Abschreibungsplan, Szenarien, Risikoregister mit Matrix, Kontrollen und Massnahmen, Dokumentenablage mit Fassungen und Sichtbarkeit, Wissen, Markt (SWOT/PESTEL), Sitzungen, Berichte nach Zeitplan als PDF/Excel/Word, KI-Assistent mit `reasoning`/`dataSources`/`confidence`. Nachtlauf schreibt Snapshots. Reine Mathematik in `src/lib/bi/math.ts`, direkt getestet |
| **Fehlt** | **Durchgriff.** Eine Kennzahl zeigt ihren Verlauf, aber nicht die Datensätze dahinter. „Warum ist die Marge gefallen?" ist nicht beantwortbar, ohne den Bereich zu wechseln |
| **Fehlt weiter** | Operative Kennzahlen, die es geben könnte und nicht gibt: Nachbesserungsquote, Reklamationsquote, Deckungsbeitrag je Objekt und je Kundschaft, produktive gegenüber bezahlten Stunden, Fahrzeitanteil. Sie hängen an 4.8 und 4.9 |
| **Priorität** | P3 (Durchgriff) — nicht umbauen, anbinden |

### 4.12 Automatisierung

| | |
|---|---|
| **Status** | 🟡 |
| **Vorhanden** | `Automation` mit Auslöser und Aktionen, `AutomationRun` als Laufprotokoll im Schema; zwei Cron-Läufe: stündlich (Terminerinnerungen 24 h/2 h, Aufgabenerinnerungen), täglich (10 Aufgaben mit `Promise.allSettled`: Serienbuchungen, Mahnungen, ablaufende Offerten, Bewertungsanfragen, Geburtstage, Folgeaufgaben, Token-Cleanup, Upload-Purge, Nachtlauf Unternehmensführung) |
| **Der Befund** | Die Läufe werden **geschrieben, aber nirgends gezeigt**. `automation-manager.tsx:164` zeigt eine Zahl („3 Läufe"), sonst nichts: kein Auslöser, keine Entität, kein Ergebnis, kein Fehlergrund, keine Wiederholung. Ein stiller Fehlschlag bleibt still |
| **Fehlt weiter** | Kein Hintergrundlauf — alles synchron im Request. Der Tageslauf hat Schleifen mit einer Benachrichtigung je Datensatz; bei wachsendem Bestand läuft er in `maxDuration` |
| **Priorität** | P4 (Sichtbarkeit zuerst, Queue erst bei Bedarf) |

### 4.13 Einstellungen

| | |
|---|---|
| **Status** | ✅ mit einer grundsätzlichen Ausnahme |
| **Vorhanden** | 7 Reiter: Firma, Arbeitszeiten, Katalog, Finanzen, Betrieb/Feiertage, Automationen, Integrationen; Unterseiten Gebiet und Leistungen mit 5 Formularen; Leistungen, Zusätze, Preisregeln, Steuersätze, Gebiet, Feiertage, Öffnungszeiten, Vorlagen alle über die Oberfläche pflegbar |
| **Ausnahme** | Die Reinigungs-Checklisten (4.4) — die einzige betriebliche Konfiguration, die eine Auslieferung braucht |
| **Priorität** | folgt aus P2/4.4 |

### 4.14 Portale

| | |
|---|---|
| **Kundenkonto** | ✅ — Übersicht, Termine mit Verschieben/Absagen (24-h-Sperre), Offerten, Rechnungen mit Online-Zahlung, Objekte mit vollem CRUD, Nachrichten, Bewertungen. Eigentümerschaft serverseitig. Offen: S-03, Rechnungs-/Nachrichten-Eigentümerschaft auf Seitenebene statt im Dienst |
| **Mitarbeitendenportal** | ✅ für die Arbeit, 🟡 für die Person — Tagesübersicht, Einsätze mit Ein-/Ausstempeln samt Standort, Checkliste, Fotos, Abschluss mit Bericht und Unterschrift, Kalender, Abwesenheiten, Lohn, Wissen, Ziele. Offen: keine Zeitkorrektur (4.6), keine Beschäftigungsdaten, kein Materialstamm bei der Erfassung |
| **Priorität** | P1 (S-03) · P4 (Rest) |

---

## 5. Fehlerliste

| # | Befund | Ort | Schwere |
|---|---|---|---|
| S-01 | `PATCH /api/employees/[id]` erlaubt `MANAGER` das Schreiben von Lohn, AHV und IBAN; `GET` verbirgt dieselben Felder vor derselben Rolle | `employees/[id]/route.ts:46` vs. `:33` | **hoch** |
| S-02 | Schemakommentare behaupten Verschlüsselung für `alarmCode` und `ahvNumber`; `src/lib/crypto` existiert nicht. `twoFactorSecret` im Klartext | `schema.prisma`, `two-factor.service.ts:89` | **hoch** |
| B-01 | `alarmCode` wird validiert, aber von keiner Route gespeichert — stiller Datenverlust | `properties/route.ts:148`, `[id]/route.ts:111` | mittel |
| O-01 | Einteilung und Verschieben prüfen keine bewilligte Abwesenheit | `job.service.ts:411`, `:1019` | **hoch** |
| S-03 | `konto/layout.tsx` ohne eigene Rollenprüfung | `(app)/konto/layout.tsx:17` | mittel |
| B-02 | `alternates.languages` zeigt auf nicht existierende Routen `/en`, `/fr`, `/it` | `src/app/layout.tsx:76` | niedrig |
| B-03 | Gast-Buchungsseite kündigt Aktionen an, die es nicht gibt | `(public)/buchung/[token]/page.tsx:135` | niedrig |
| B-04 | Prüfprotokoll-Seite verspricht eine Aufbewahrungsfrist, die das Backend nicht kennt | `admin/protokoll/page.tsx:45` | niedrig |
| B-05 | `ValidationError` → 400, `ZodError` → 422, beide mit Code `VALIDATION_ERROR` | `errors.ts`, `response.ts:106` | niedrig |
| B-06 | README-Kennzahlen um den Faktor 2–3 falsch, Vercel als einziger Betriebsweg, `db:reset` empfohlen (laut `CLAUDE.md` tabu), Gutschriften und Lohnabrechnungen als vorhanden beschrieben | `README.md:19,67,102,130,145,151,201` | mittel |
| B-07 | Medienbibliothek erhält `canUpload`, zeigt kein Upload-Element | `media-library.tsx:76` | niedrig |
| B-08 | Telefonnummern hartkodiert statt aus `getPublicCompanyInfo()` | `error.tsx:57`, `booking-actions.tsx:97`, `chat-widget.tsx:111` | niedrig |
| B-09 | `roundToRappen()` definiert und nie verwendet — Entscheid fehlt | `src/lib/utils.ts:160` | niedrig |
| T-01 | Die Testreihe hielt das Demopasswort fest, der Seed nimmt `SEED_ADMIN_PASSWORD` — auf jeder Maschine mit eigenem Startpasswort scheiterten vierzehn Dateien an einem Scheinfehler *(behoben in Phase 1)* | `tests/helpers/accounts.ts` | mittel |

---

## 6. Fertige Fachlogik ohne Zugang

Der billigste Fortschritt im Projekt: Dienst geschrieben, Endpunkt fehlt.

| Dienst | Ort | Fehlt |
|---|---|---|
| `createCreditNote` | `invoice.service.ts:665` | `POST /api/invoices/[id]/credit-note` + Schaltfläche |
| `generatePayslip` | `employee.service.ts:766` | `POST /api/employees/[id]/payslips` + Oberfläche |
| `anonymizeCustomer` | `crm.service.ts:1001` | `POST /api/customers/[id]/anonymize` + Bestätigungsdialog |
| `createJob` / `listJobs` | `job.service.ts:204`, `:1374` | `POST /api/jobs`, `GET /api/jobs` |
| `createBooking` (authentifiziert) | `booking.service.ts:58` | `POST /api/bookings` |
| Zeitkorrektur/Freigabe | Felder in `TimeEntry` vorhanden | Dienst **und** Endpunkt **und** Oberfläche |

---

## 7. Erforderliche Datenbankänderungen

Nach Phase geordnet. Alle vorwärts, keine destruktiven Schritte
(`prisma migrate diff` → SQL → `prisma db execute` → `migrate resolve`, siehe
`CLAUDE.md`).

| Phase | Änderung | Grund |
|---|---|---|
| 1 | keine | Die Sicherheitsphase kommt ohne Schemaänderung aus; die Verschlüsselung nutzt dieselben `String`-Spalten mit Präfix `enc:v1:` |
| 2 | `CleaningPlan`, `CleaningPlanArea`, `CleaningPlanTask`; `Property.cleaningPlanId`; `JobChecklistItem.planTaskId`, `.photoRequired`, `.estimatedMin` | 4.4 |
| 2 | `Property`: `timeWindowFrom`, `timeWindowTo`, `hazards`, `onSiteEquipment`, `contactName`, `contactPhone` | 4.2 |
| 2 | `QualityInspection`, `Defect` (Verortung auf Objekt/Raum/Planaufgabe, Frist, Nachbesserungs-Einsatz, Abnahme) | 4.8 |
| 2 | `Booking`: `pausedFrom`, `pausedUntil`; `RecurrenceException` | 4.3 |
| 3 | `MaterialItem`, `Equipment`; `MaterialUsage.itemId` (optional) | 4.9 |
| 3 | Indizes für die neuen Filterpfade | |

---

## 8. Vorgeschlagene Phasen

### Phase 1 — Sicherheit und Datenintegrität (P0) · **umgesetzt am 2026-09-19**

| # | Massnahme | Ort |
|---|---|---|
| 1 | **Next.js 15.1.4 → 15.5.25** (`eslint-config-next` mit). Damit fallen alle direkten Next-Advisories weg, inklusive Middleware-Umgehung (CVE-2025-29927) und der beiden RCE-Befunde; `postcss` und `sharp` kommen gepatcht mit. `npm audit`: von 8 (1 kritisch, 5 hoch) auf 7 ohne kritischen Befund | `package.json` |
| 2 | **S-01** geschlossen: `PATCH /api/employees/:id` weist `hourlyRate`, `monthlySalary`, `salaryValidFrom`, `salaryReason`, `ahvNumber` und `iban` ohne `payslip:create` mit 403 ab — symmetrisch zum `GET`. Abgewiesen, nicht stillschweigend verworfen | `employees/[id]/route.ts` |
| 3 | **S-03** geschlossen: `konto/layout.tsx` zieht seine Rollenschranke selbst aus `ROUTE_GUARDS`, wie `portal/layout.tsx` | `(app)/konto/layout.tsx` |
| 4 | **S-05** geschlossen: `CRON_SECRET` wird über SHA-256 und `timingSafeEqual` verglichen; die Längenangleichung verhindert, dass die Ausnahme bei ungleich langen Puffern selbst zum Seitenkanal wird | `lib/api/handler.ts` |
| 5 | **S-02** geschlossen: `src/lib/crypto.ts` gibt es jetzt wirklich — AES-256-GCM, Präfix `enc:v1:`, Feldname als AAD (ein Chiffrat lässt sich nicht von einer Spalte in eine andere verschieben), Klartext-Altbestand bleibt lesbar und wandert beim nächsten Schreiben mit. Verschlüsselt werden `User.twoFactorSecret`, `Employee.ahvNumber` und `Property.alarmCode`. Schlüssel aus `ENCRYPTION_KEY`, ersatzweise per HKDF aus `JWT_SECRET` | `lib/crypto.ts`, `two-factor.service.ts`, `employee.service.ts`, `properties/*` |
| 6 | **B-01** geschlossen: `alarmCode` wird gespeichert statt verworfen, erscheint in keiner Liste und wird auf dem Rapport der zugeteilten Person entschlüsselt gezeigt — genau das, was der Kommentar der Route immer behauptet hat. Eingabe über das Objektformular, dort bewusst nur schreibend | `properties/route.ts`, `properties/[id]/route.ts`, `portal/einsaetze/[id]/page.tsx`, `property-dialog.tsx` |
| 7 | Prüfungen: neun Zusicherungen für die Verschlüsselung, zwei neue Fälle im Personal (Sperre der Lohnfelder, Rundlauf der AHV-Nummer). Die alte Zusicherung, die das falsche Verhalten festhielt („Festgehalten wird hier nur, dass die Antwort keine 500 ist"), ist ersetzt | `tests/api/verschluesselung.test.ts`, `tests/api/employees.test.ts` |
| 8 | Nebenbefund behoben: `tests/helpers/accounts.ts` hielt das Demopasswort fest, während der Seed `SEED_ADMIN_PASSWORD` verwendet — auf jeder Maschine mit eigenem Startpasswort scheiterten dadurch rund vierzehn Dateien an einem Fehler, den es im Produkt nicht gibt | `tests/helpers/accounts.ts`, `tests/README.md` |
| 9 | `next lint` ist in Next 16 entfernt und warnte bereits; der Aufruf geht jetzt direkt an die ESLint-CLI | `package.json` |

**Verbleibende Meldungen von `npm audit`**, beide bewusst offen:
`postcss` innerhalb von `next` (nur mit Next 16 zu beheben — ein Hauptsprung,
der eine eigene Phase verdient; die Befunde betreffen das Verarbeiten
fremdgesteuerter CSS-Quellkarten, was hier nicht vorkommt) und `uuid`
innerhalb von `exceljs` (der Fix wäre ein Rücksprung auf `exceljs` 3.x; die
Lücke greift nur, wenn ein Aufrufer einen eigenen Puffer übergibt — die
Exportdienste tun das nicht).

**Werkzeuglauf nach der Phase** (2026-09-19, gegen `clenaris_test` auf
Port 3001, siehe Abschnitt 9.1):

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck` | 0 Fehler |
| `npm run lint` | 0 Warnungen, 0 Fehler |
| `npm run docs` | 374 Endpunkte, 111 Modelle — Routenbaum und erklärter Schutz stimmen überein |
| `npm run build` | erfolgreich (Next 15.5.25, `.next` vorher geleert) |
| `npm test` | **608 Prüfungen, 604 bestanden, 0 fehlgeschlagen, 4 übersprungen**, 188 s |

Die vier Übersprungenen sind bestandsabhängig und waren es vorher auch: zwei
Löschsperren ohne passenden Datensatz (Angebot mit Bewerbungen, Regel mit
Laufhistorie) und zwei Blätterprüfungen auf Listen mit nur einer Seite.

Im ersten Lauf fiel genau eine Prüfung durch — eine **von mir falsch gesetzte
Erwartung**, nicht ein Produktfehler: Das Pensum gehört zur Lohnbasis, eine
Änderung von 80 auf 90 Prozent schreibt deshalb zu Recht eine Zeile in die
Lohnhistorie (`employee.service.ts`, `salaryChanged`). Die Zusicherung prüft
jetzt die Werte statt der Zeilenzahl, also das, worauf es ankommt: dass kein
abgewiesener Ansatz in der Historie landet.

**Die Entwicklungsdatenbank `clenaris` wurde nicht verändert** — vorher wie
nachher 3 Konten, 1 037 Protokollzeilen, `invoice = 9`, `lead = 1`.

### Phase 2 — Betriebsablauf schliessen (P1)

`POST /api/bookings` · `GET`/`POST /api/jobs` · O-01 (Abwesenheiten bei der
Einteilung) · Gutschrift (Endpunkt + Schaltfläche) · Lohnabrechnung erzeugen +
Kennzeichnung „betriebliche Lohnbasis" · Kundenanonymisierung · Zeitkorrektur
und Freigabe mit vollständigem Änderungsnachweis · deterministische Tests für
Preis-Engine, QR-Referenz, Rechnungssummen, Gutschrift, Zahlung, Webhook.

### Phase 3 — Reinigungsbetrieb (P2)

Reinigungsplan mit Vorlagen und Objektplänen · Objektwissen · Qualitäts- und
Mangelverfolgung · Vertragsführung (Pause, Ausnahmen, Preisstichtag) ·
Dispositionswarnungen.

### Phase 4 — Rentabilität (P3)

Materialstamm und Geräte · Deckungsbeitrag je Objekt/Kundschaft/Leistung ·
Zahlungsabgleich und Offene-Posten-Führung · Durchgriff in der
Unternehmensführung · Rundungsentscheid.

### Phase 5 — Automatisierung und Portale (P4)

Laufprotokoll der Automatisierungen · Newsletter-Versand · Gast-Buchung per
Token · Medien-Upload · Portalverfeinerungen.

### Phase 6 — Ausbau (P5)

Mehrsprachigkeit · gesetzliche Lohnabrechnung mit Swissdec ·
Buchhaltungsschnittstelle · Hintergrund-Queue · Mehrmandantenbetrieb.

---

## 9. Teststrategie

### 9.1 Getrennte Datenbanken (eingeführt am 2026-09-19)

Bis hierher liefen die Prüfungen gegen dieselbe Datenbank, in der auch
entwickelt wurde. Das hat zwei Kosten, die in dieser Prüfung sichtbar wurden:

- **Belegnummern sind endlich.** Demo-Seed und `flows.test.ts` stellen
  Rechnungen aus; deren Nummern zieht `NumberSequence`, und die Folge muss
  nach Art. 957a OR lückenlos sein. Eine im Test vergebene Nummer holt kein
  Storno zurück.
- **Die Prüfungen verändern den Bestand** — sie legen an, ändern, setzen
  Rollen herab. Wer daneben im Browser arbeitet, sucht Fehler, die keine sind.
  Der Gedächtniseintrag „Nutzer testet im Browser" beschreibt genau diesen
  Reibungspunkt.

Die Trennung ist jetzt festgelegt und werkzeugunterstützt:

| Umgebung | Zweck | Demo-Seed | Zurücksetzen |
|---|---|---|---|
| Produktion | echte Daten | nie | nie |
| Entwicklung (`clenaris`) | örtliches Arbeiten | nein | nur von Hand |
| Test (`clenaris_test`) | die Prüfreihe | ja | jederzeit |
| CI | ein Lauf, dann weg | ja | mit dem Container |

- `npm run db:test:setup` (`scripts/setup-test-db.ts`) leitet die Adresse aus
  `DATABASE_URL` ab, legt `<name>_test` an, migriert und seedet **nur dort**.
  Mit `--frisch` wird sie vorher weggeworfen. Die Entwicklungsdatenbank wird
  nur gelesen.
- `prisma/seed-guard.ts` bricht jeden Demo-Seed ab, dessen Zieldatenbank nicht
  als Testdatenbank erkennbar ist — und zwar **vor** dem Konfigurations-Seed,
  der sonst bereits geschrieben hätte. Übersteuerbar mit `ALLOW_DEMO_SEED=ja`.
- Der Seed der Testdatenbank verwendet fest die Demo-Zugangsdaten statt derer
  aus der `.env`. Damit hängt die Reproduzierbarkeit nicht mehr an der
  Konfiguration der jeweiligen Maschine.
- **Nummernfolgen sind dadurch von selbst getrennt.** `numbering.service.ts`
  zählt ausschliesslich in der Tabelle `NumberSequence`, verschlüsselt über
  `(organizationId, scope, year)`, innerhalb der Geschäftstransaktion. Es gibt
  keinen globalen, externen oder gemeinsam genutzten Zähler — eine eigene
  Datenbank hat damit zwangsläufig eine eigene Folge. Nachgemessen: die
  Entwicklungsdatenbank stand vor und nach dem Aufbau der Testdatenbank auf
  `invoice = 9`, die Testdatenbank hat ihre eigene bei `invoice = 2`.

Offen bleibt der Schritt darüber hinaus, den die CI bereits vorlebt und die
örtliche Reihe noch nicht: **Prüfungen, die ihre Daten selbst erzeugen.**
Heute setzen sie den Demo-Bestand voraus. Fixtures je Datei wären robuster und
liessen Parallelität zu; das ist eine eigene Phase, kein Nebenbei.

### 9.2 Ansatz

Der Ansatz bleibt: **HTTP gegen die laufende Anwendung**, keine Unit-Tests der
Dienste (`tests/README.md`). Er hat sich bewährt und die CI trägt ihn.

Zwei Ergänzungen, beide begründet:

1. **Reine Rechenkerne direkt testen.** `tests/api/bi-rechenkerne.test.ts`
   importiert bereits `src/lib/bi/math.ts` und prüft es ohne Server. Genau das
   fehlt für `src/lib/pricing/engine.ts`, `src/lib/pdf/swiss-qr.ts`
   (Prüfziffer mit festen Erwartungswerten) und `computeInvoiceTotals`. Das
   sind deterministische Funktionen; sie über HTTP zu prüfen, misst den
   falschen Ausschnitt.
2. **Geldpfade über HTTP.** Zahlungserfassung inklusive Idempotenz,
   Rechnung senden und stornieren, Gutschrift, Stripe-Webhook mit gültiger und
   ungültiger Signatur, Exporte. Am besten in `tests/api/flows.test.ts`
   erweitert, nicht als neue Datei (siehe Tabelle in `tests/README.md`).

Für jede Änderung dieser Phasen gilt die Reihenfolge aus `CLAUDE.md`:
`typecheck` → `lint` → `npm run docs` → Build → Server starten → betroffene
Testdateien → ganze Reihe vor dem Commit.

---

## 10. Risiken

| Risiko | Wirkung | Gegenmassnahme |
|---|---|---|
| Fassungssprung Next.js bricht Rendering oder Middleware | Produktion steht | Vollständige Testreihe vor dem Commit; CI wiederholt sie; PM2-Reload ist rückrollbar (`scripts/deploy.sh`) |
| Verschlüsselung macht bestehende 2FA-Geheimnisse unbrauchbar | Niemand mit 2FA kommt hinein | Versioniertes Präfix, Klartext bleibt lesbar, Migration beim nächsten Schreiben; `tests/api/two-factor.test.ts` (28 Prüfungen) läuft davor und danach |
| Neue Pflichtprüfung bei der Einteilung blockiert gültige Fälle | Disposition steht | Bewilligte Abwesenheit blockiert, beantragte warnt; die Meldung nennt Person und Zeitraum |
| Reinigungsplan-Modell entwertet bestehende Checklisten | Datenverlust | `JobChecklistItem` bleibt führend für den einzelnen Einsatz; der Plan erzeugt sie, ersetzt sie nicht |
| Dokumentation altert wieder | Dieselbe Lage in vier Wochen | `npm run docs` läuft in der CI; dieses Dokument und `README.md` gehören in dieselbe Änderung wie der Code |
