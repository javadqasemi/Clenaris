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
| O-01 | Einteilung und Verschieben prüfen keine bewilligte Abwesenheit *(behoben in Phase 2 — `assignment.service.ts`)* | `job.service.ts:411`, `:1019` | **hoch** |
| O-02 | `moveJob` prüfte beim Ziehen im Kalender weder Abwesenheit noch Überschneidung noch aktives Personal und legte beim Spaltenwechsel eine ungeprüfte Zuteilung an *(behoben in Phase 2)* | `job.service.ts moveJob` | **hoch** |
| O-03 | Die Routendokumentation versprach eine Abwesenheitsprüfung, die es nicht gab *(behoben in Phase 2)* | `scripts/openapi-routes.ts` | mittel |
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
| ~~D-01~~ | ~~**P1: Production PostgreSQL backup before schema migrations**~~ — *erledigt in `f0e70d4`.* `scripts/deploy.sh` führt vor `prisma migrate deploy` erst `migration-preflight.ts` (nur lesend, prüft die Eindeutigkeiten gegen die vorhandenen Daten) und dann `db-backup.ts` aus (`pg_dump --format=custom`, danach vier Prüfungen inklusive `pg_restore --list`). Beides fail-closed. Der Rückweg ist mit `db-restore-verify.ts` gegen `clenaris_preview` geprobt: 894 Archiveinträge, alle vierzehn Tabellen mit übereinstimmender Zeilenzahl | `scripts/deploy.sh`, `scripts/db-backup.ts` | **erledigt** |
| S-08 | `src/lib/crypto.ts` kennt keine Schlüsselrotation: Ein Wert mit Präfix `enc:v1:`, der sich mit dem aktuellen Schlüssel nicht entschlüsseln lässt, wirft. Es gibt keinen Zweitschlüssel-Lesepfad (`ENCRYPTION_KEY_PREVIOUS`) und kein Umschlüsselungsskript. Solange der Schlüssel **vor** dem ersten verschlüsselten Wert steht, ist das folgenlos — danach wird jeder Wechsel zu einem eigenen Vorhaben | `src/lib/crypto.ts` | mittel |
| S-09 | Die Host-Schlüssel-Abweichung bei `46.62.175.39` — **aufgeklärt, siehe unten**. Die Adresse ist nicht der Clenaris-Server, sondern gehört einem Dritten; der Wirtsschlüssel des aktuellen Servers ist am 2026-09-21 über die Hetzner-Konsole erhoben. Offen bleibt allein, wie weit frühere Auslieferungsläufe kamen (`SECRET EXPOSURE STATUS UNKNOWN`) | Betrieb | **geklärt, Restfrage Geheimnisabfluss** |
| S-10 | Der Auslieferungs-Workflow auf `origin/main` enthält einen `ssh-keyscan`-Rückfall: Fehlt `SERVER_SSH_KNOWN_HOSTS`, nimmt er den Schlüssel entgegen, den der Gegenüber gerade anbietet. Wäre je ein Lauf gestartet, hätte er damit den fremden Host vertraut und ihm `SERVER_SSH_KEY`, `DATABASE_URL`, `JWT_SECRET`, `CRON_SECRET` und `ENCRYPTION_KEY` übergeben. Der Rückfall ist lokal in `625cfc2` entfernt, aber **noch nicht gepusht** | `.github/workflows/deploy.yml` auf `origin/main` | **hoch bis zum nächsten Push** |

### S-09 im Einzelnen — das veraltete Auslieferungsziel

Untersucht am 2026-09-21, ausschliesslich lesend: Hetzner Cloud API (`GET`),
Repository, Git-Historie, lokale `known_hosts`, öffentliches DNS und TLS. Kein
SSH, keine Schreibaktion.

**Was belegt ist.**

| Befund | Beleg |
|---|---|
| Das Hetzner-Projekt enthält genau **einen** Server: `164144336` „CX26", `cx23`, hel1, angelegt 2026-08-31, Status `running` | Hetzner API, `GET /v1/servers` |
| Seine IPv4 ist **`2.29.18.45`**, IPv6 `2a01:4f9:c015:2b4e::/64` | dieselbe Antwort |
| `46.62.175.39` gehört **keinem** Server und keiner Primary IP dieses Projekts | `GET /v1/servers`, `GET /v1/primary_ips` |
| Der PTR von `46.62.175.39` lautet heute `mail1.domainmarket.gr` | öffentliches DNS |
| `2.29.18.45` liefert unter SNI `clenaris.qasemi.ch` ein Let's-Encrypt-Zertifikat auf **`CN=clenaris.qasemi.ch`**, gültig ab 2026-09-07 | TLS-Handshake von aussen |
| `https://clenaris.qasemi.ch` steht hinter Cloudflare und antwortet mit `status: ok`, `datenbank: ok`, **`migrationen: 12`** | öffentlicher Health-Endpunkt |
| Die lokale `known_hosts` enthält genau eine Zeile — den **alten** Schlüssel zu `46.62.175.39` — und wurde seit **2025-10-01** nicht mehr verändert | Dateizeitstempel, `ssh-keygen -F` |

**Was daraus folgt.** `2.29.18.45` ist der Ursprung hinter Cloudflare und damit
der Produktionsserver; das ist über zwei unabhängige Wege bestätigt (Hetzner-API
und das ausgelieferte Zertifikat). Die historische Adresse `46.62.175.39` ist
**stale production target** — sie gehört heute einem Dritten. Die
Schlüsselabweichung vom 2026-09-19 ist damit vollständig durch ein veraltetes
Ziel erklärbar.

**Was ausdrücklich nicht folgt.** Dass der frühere Server nicht kompromittiert
war, ist damit **nicht** gezeigt — es ist nur nicht mehr nötig, es anzunehmen.
Ebenso wenig ist bewiesen, wann genau die Adresse neu vergeben wurde. Beides
bleibt Interpretation.

**Der unveränderte Zeitstempel der `known_hosts` ist der wertvollste Einzelbefund.**
Hätte jemand von diesem Arbeitsplatz aus den geänderten Schlüssel akzeptiert —
etwa mit `ssh-keygen -R` und einer neuen Verbindung —, trüge die Datei ein
neues Datum. Sie trägt seit elf Monaten dasselbe. Von hier aus ist also nach
dem Adresswechsel keine SSH-Verbindung zustande gekommen.

**Der gültige Wirtsschlüssel ist am 2026-09-21 erhoben — über die
Hetzner-Konsole des Servers `164144336`, nicht über SSH und nicht über
`ssh-keyscan`.** Er lautet
`SHA256:LqwwARXhcVf1Md+wPBEUiurjML0s1+nIpvTMUeU2YDI` (ed25519, Kommentar
`root@ubuntu-4gb-hel1-1`). Der fertige `SERVER_SSH_KNOWN_HOSTS`-Wert steht in
`DEPLOYMENT.md` 13.4a.

**Drei Schlüssel, und nur einer gilt.** Die Nachrechnung hat eine
Ungenauigkeit dieses Dokuments aufgedeckt: Hier stand, der Fingerabdruck
`SHA256:xiMHcWWxo4UVb4JmYzwremYJdN1lXoGxw+UEZK7+1k4` sei „der alte
Vergleichswert". Das trifft nicht zu. Die lokale `known_hosts` pinnt unter
`46.62.175.39` einen **anderen** Schlüssel,
`SHA256:k2mQx1lDuD9kURdFAGxbKxznHfGqvvqHwJWJRmWTuPQ`. Da beim Konflikt vom
2026-09-19 genau zwei Schlüssel im Spiel waren — der gepinnte und der
angebotene — und der gepinnte nachweislich `k2mQ…` ist, war `xiMHc…` der
**angebotene**: der Schlüssel des fremden Hosts. Er ist kein veralteter
Sollwert, sondern der Schlüssel eines Dritten.

| Fingerabdruck | Gehört zu | Verwendung |
|---|---|---|
| `SHA256:Lqww…U2YDI` | `2.29.18.45`, aufgesetzt 2026-08-31 | **der einzige Sollwert** |
| `SHA256:k2mQ…WTuPQ` | dem früheren Clenaris-Server, gepinnt 2025-10-01 | historisch, Maschine existiert nicht mehr |
| `SHA256:xiMH…7+1k4` | dem **Fremdhost** hinter `46.62.175.39` | nie pinnen |

Der mittlere Eintrag steht weiterhin in `~/.ssh/known_hosts` und pinnt einen
Schlüssel für eine fremde Adresse. Er ist mit `ssh-keygen -R 46.62.175.39` zu
entfernen — nicht dringend, aber irreführend.

Kein `ssh-keyscan` als Vertrauensquelle — weder für die alte noch für die neue
Adresse.

### Kam je eine Auslieferung bis zum Geheimnistransfer?

**Status: `SECRET EXPOSURE STATUS UNKNOWN`** — mit starken Anhaltspunkten
dagegen, aber ohne den einen Beleg, der die Frage schliessen würde.

Was dafür spricht, dass nichts abgeflossen ist:

1. Der Auslieferungs-Workflow existiert auf `origin/main` erst seit dem Push am
   **2026-09-14 23:06** (Commit `4d07be0`). Danach gab es genau **einen**
   weiteren Push: **2026-09-19 13:59** (`0b9fec2`).
2. Die Fassung des Workflows auf `origin/main` enthält
   `url: ${{ secrets.API_URL }}` unter `jobs.<id>.environment.url`. Der
   `secrets`-Kontext ist dort nicht zulässig; GitHub verwirft eine solche Datei
   beim Parsen. Der Lauf entsteht und scheitert in derselben Sekunde — **mit
   null Jobs**. Weder das Qualitätstor noch die Auslieferung liefen je an.
3. Die lokale `known_hosts` ist seit 2025-10-01 unverändert (siehe oben).
4. Die laufende Produktion meldet `version: null`. `scripts/deploy.sh` setzt
   diesen Wert; sein Fehlen passt zu einer Instanz, die **nicht** über die
   Pipeline ausgeliefert wurde.

Was fehlt, um daraus `NO EVIDENCE OF SECRET DISCLOSURE VIA OLD HOST` zu machen:

- **Die Lauf-Historie von GitHub Actions selbst.** `gh` ist auf dem
  Arbeitsplatz nicht installiert und es liegt kein GitHub-Token vor; die
  Schlussfolgerung oben ist aus dem Dateiinhalt abgeleitet, nicht an den
  Läufen beobachtet.
- **Der Wert von `SERVER_HOST`.** GitHub gibt Secretwerte technisch nicht
  heraus. Ob dort je `46.62.175.39` stand, ist von hier aus nicht feststellbar.
- **Auslieferungen von anderen Maschinen.** Die `known_hosts`-Aussage gilt nur
  für diesen Arbeitsplatz.

**Der Beinahe-Unfall gehört dazu.** Die Fassung auf `origin/main` enthält den
`ssh-keyscan`-Rückfall (siehe S-10). Wäre der Workflow gültig gewesen, hätte
der erste Lauf gegen ein veraltetes Ziel den fremden Schlüssel gepinnt und
anschliessend `SERVER_SSH_KEY`, `DATABASE_URL`, `JWT_SECRET`, `CRON_SECRET` und
`ENCRYPTION_KEY` dorthin übertragen. Verhindert hat das ein **unabhängiger
YAML-Fehler**, keine Sicherheitsmassnahme. Der Rückfall ist lokal in `625cfc2`
entfernt; bis dieser Commit gepusht ist, steht er weiterhin auf `origin/main`.

### Wie die Adressen künftig zu behandeln sind

- `46.62.175.39` — **historisch, nie wieder Auslieferungsziel.** In
  Sicherheitsdokumentation darf die Adresse stehen, immer als
  *stale production target* gekennzeichnet.
- `2.29.18.45` — aktueller Produktionsserver. **Nicht** hartkodieren: Die
  Quelle der Wahrheit ist das GitHub-Secret `SERVER_HOST`; die Adresse steht in
  der Dokumentation nur als Prüfwert.

---

## 6. Fertige Fachlogik ohne Zugang

Der billigste Fortschritt im Projekt: Dienst geschrieben, Endpunkt fehlt.

Stand nach Phase 2 — nachgeprüft am Code, nicht aus der Liste fortgeschrieben:

| Dienst | Aktuelle API | Fehlende API | Berechtigung | Nötige Prüfungen |
|---|---|---|---|---|
| `createJob` / `listJobs` | ✅ `POST`/`GET /api/jobs` | — | `job:create` / `job:read`, `job:read_assigned` | ✅ `dispatch.test.ts` |
| `createBooking` (Büro) | ✅ `POST /api/bookings` | — | `booking:create` | ✅ `dispatch.test.ts` |
| `createCreditNote` | keine | `POST /api/invoices/[id]/credit-note` + Schaltfläche | `invoice:create` (vorhanden) | Summen, Bezug zur Ursprungsrechnung, Nummernfolge, keine Gutschrift auf Entwurf |
| `generatePayslip` | keine | `POST /api/employees/[id]/payslips` + Oberfläche | `payslip:create` (vorhanden) | Abzüge gegen feste Erwartungswerte, Doppelerzeugung je Monat, Sichtbarkeit |
| `anonymizeCustomer` | keine | `POST /api/customers/[id]/anonymize` + Bestätigung | `customer:delete` (vorhanden) | Belege bleiben, Personendaten verschwinden, Unumkehrbarkeit |
| Zeitkorrektur / Freigabe | nur `clock-in`/`clock-out` | Dienst **und** Endpunkt **und** Oberfläche | `timetracking:approve` (vorhanden, ohne Konsument) | alter/neuer Wert, Grund, Person, Zeitpunkt |
| `createInvoiceFromJobs` | ✅ `POST /api/bookings/[id]/invoice` | — | `invoice:create` | teilweise (`flows.test.ts`) |
| `createInvoiceFromQuote` | ✅ über `quote.service.ts:840` | — | `quote:convert` | teilweise |

Die vier offenen Punkte haben je einen fertigen Dienst und brauchen eine dünne
Route. Sie gehören trotzdem nicht in eine Phase über Disposition: Gutschrift
und Lohnabrechnung sind geldnahe Vorgänge mit eigener Prüfstrategie, die
Anonymisierung ist unumkehrbar und braucht eine eigene Bestätigungsführung,
und die Zeitkorrektur ist die Grundlage der Lohnrechnung.

---

## 7. Erforderliche Datenbankänderungen

Nach Phase geordnet. Alle vorwärts, keine destruktiven Schritte
(`prisma migrate diff` → SQL → `prisma db execute` → `migrate resolve`, siehe
`CLAUDE.md`).

| Phase | Änderung | Grund |
|---|---|---|
| 1 | keine | Die Sicherheitsphase kommt ohne Schemaänderung aus; die Verschlüsselung nutzt dieselben `String`-Spalten mit Präfix `enc:v1:` |
| 2 | **keine** | Alles Nötige stand schon im Schema: `Absence` mit `status`, `Availability` je Wochentag, `JobAssignment` mit `@@unique([jobId, employeeId])`, `Job.bookingId`, `Booking.source`, `Booking.internalNote`. Die Lücke war nirgends ein fehlendes Feld, sondern eine fehlende Abfrage — deshalb keine Migration. Eine Ausschlussbedingung gegen überschneidende Zuteilungen (`EXCLUDE USING gist` über Person und Zeitraum) wäre die einzige echte Schemaverbesserung; sie verlangt `btree_gist` und eine materialisierte Zeitspalte am `JobAssignment` und bekommt eine eigene Migration mit eigener Begründung |
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

### Phase 2 — Buchung → Einsatz → Zuteilung · **umgesetzt am 2026-09-19**

Der Ausschnitt, den diese Phase geschlossen hat, ist der Übergang vom Auftrag
zur Arbeit. Statusmatrix vor der Phase:

| Bereich | Stand vorher | Gemacht |
|---|---|---|
| `POST /api/bookings` (authentifiziert) | **fehlte** | angelegt; das Büro musste zuvor die öffentliche Route benutzen |
| `GET /api/jobs` | **fehlte** (Dienst fertig) | angelegt, mit Eigentümergrenze für Mitarbeitende |
| `POST /api/jobs` | **fehlte** (Dienst fertig) | angelegt, mit Fremdschlüsselprüfung gegen Mandant *und* Kundschaft |
| Abwesenheit bei der Zuteilung | **fehlte ganz** | zentrale Regel, blockiert bewilligte Abwesenheiten |
| Überschneidungsprüfung | doppelt vorhanden, 2 von 5 Stellen | eine Regel, alle 5 Stellen |
| `moveJob` (Ziehen im Kalender) | **prüfte nichts** | prüft das Team gegen die neue Zeit |
| `updateJob` (Termin im Formular) | prüfte nichts | ebenso |
| Buchung → Einsatz, Idempotenz | Zählung ohne Sperre | Zeilensperre `FOR UPDATE` |
| Alarmcode im Einsatz | Chiffrat in jeder Antwort | nur auf Anforderung, nur auf dem Rapport |
| Einsatz anlegen in der Oberfläche | fehlte | Dialog auf `/admin/einsaetze` |

**Gefunden und behoben, ohne dass es auf der Liste stand:**

- **`moveJob` war die grösste Lücke der Disposition.** Ein Einsatz liess sich
  per Ziehen auf einen Tag legen, an dem das eingeteilte Team in den Ferien
  war oder bereits woanders stand — und die Zuteilung blieb bestehen. Weder
  Abwesenheit noch Überschneidung noch aktives Personal wurden geprüft; beim
  Wechsel der Ressourcenspalte entstand sogar eine völlig ungeprüfte neue
  Zuteilung.
- **Die Routendokumentation war unwahr.** `scripts/openapi-routes.ts`
  versprach bei `POST /api/jobs/{id}/assign` ausdrücklich „Prüft
  Überschneidungen und **Abwesenheiten**". Die Abwesenheitsprüfung gab es
  nicht. Das ist derselbe Fehlertyp wie das Schemafeld, das seine
  Verschlüsselung behauptete, ohne dass es das Modul dazu gab (S-02).
- **Eine Grid-Spur ohne `minmax(0,…)`** in der Nachkalkulation
  (`job-costing-editor.tsx`). Gefunden von `tables.test.ts`, sobald es
  Einsätze **ohne Buchung** gab: Erst dann rendert die Herleitung den Zweig
  „kein Auftrag", und die Seite geriet überhaupt in die Stichprobe.

**Was bewusst offen blieb** (gehört in eine spätere Phase, nicht hierher):
Gutschrift, Lohnabrechnung erzeugen, Kundenanonymisierung, Zeitkorrektur und
Freigabe. Alle vier haben einen fertigen Dienst und brauchen eine dünne
Route — aber jede hängt an einem eigenen Arbeitsablauf mit eigener
Prüfstrategie (Geld, Lohn, DSG-Löschbegehren, Lohnbasis), und die gehören
nicht in eine Phase über Disposition. Abschnitt 6 führt sie weiter.

**Werkzeuglauf nach Phase 2** (gegen `clenaris_test`, Port 3001):
`npm run typecheck` → 0 · `npm run lint` → 0 · `npm run docs` → **377
Endpunkte**, Schutz stimmt überein · `npm run build` → erfolgreich ·
`npm test` → **631 Prüfungen, 627 bestanden, 0 fehlgeschlagen, 4
übersprungen**. `clenaris` unverändert: 3 Konten, 0 Geschäftsdaten,
Nummernfolge weiterhin `invoice = 9`, `lead = 1`.

**Ein Befund, der als Befund stehen bleibt** (nicht behoben, weil die
Behebung teurer wäre als der Nutzen): Eine Seite mit `loading.tsx` schickt die
Hülle mit **HTTP 200** ab, bevor die Server Component fertig ist. Wirft diese
danach `notFound()`, kommt die Nicht-gefunden-Darstellung als Nachtrag im
Strom — der Statuscode bleibt 200. Das betrifft jede gestreamte Seite der
Anwendung, nicht nur den Einsatzrapport. **Preisgegeben wird dabei nichts**:
nachgemessen enthält die Antwort weder Einsatznummer noch Alarmcode. Wer den
Statuscode korrigieren wollte, müsste das Streaming aufgeben und damit die
wahrgenommene Ladezeit jeder Detailseite verschlechtern. `dispatch.test.ts`
prüft deshalb den Inhalt statt des Codes und sagt im Kommentar warum.

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
