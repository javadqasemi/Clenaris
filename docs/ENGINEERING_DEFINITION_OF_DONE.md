# Definition of Done — Clenaris

> Stand: 27. September 2026. Verbindlich für **jede** Änderung an Clenaris —
> Funktion, Fehlerbehebung, Umbau, Migration. Entstanden aus der
> Nachbesserung nach dem Codex-Audit (Mission 6), in der fast jeder Befund
> auf einen dieser Punkte zurückging: eine Prüfung vor statt in der
> Transaktion, eine fehlende Organisation in der `where`-Klausel, ein
> UTC-Tag statt eines Zürcher Tages, ein Versprechen in der Oberfläche, das
> der Code nicht hielt.

Eine Änderung ist **fertig**, wenn jeder zutreffende Punkt unten mit einem
Nachweis abgehakt ist. „Nicht zutreffend" ist eine Antwort, aber eine
begründete. „Fertig" ohne Nachweis ist keine.

Die Maschine prüft, was sie prüfen kann: `npm run verify:full` (Abschnitt
„Automatisiert"). Was sie nicht prüfen kann — etwa ob die richtige
Navigationsebene gewählt ist —, prüft die Person, die die Änderung macht,
und schreibt es in die Beschreibung des Commits oder Pull Requests.

---

## Checkliste A — Vor dem Programmieren

| | Punkt | Wie in diesem Repository |
|---|---|---|
| [ ] | Bestehende Architektur verstanden | `docs/ARCHITECTURE.md`, `CLAUDE.md`; für die Unterzeichnung `docs/SIGNATUR_GATE4A.md` |
| [ ] | Nach einer bestehenden Umsetzung gesucht, bevor eine zweite entsteht | `grep` über `src/server/services/`, `src/lib/`; zwei Wege zum selben Ziel sind zwei Sicherheitsstufen |
| [ ] | Die eine Quelle der Wahrheit bestimmt | Preis: `lib/pricing/engine.ts`; Saldo: `saldoNeuBilden`; Zuteilung: `assignment.service.ts`; Kalendertag: `lib/zuerich.ts` |
| [ ] | Mandantengrenze bestimmt | Welche Spalte trägt `organizationId`? Steht sie in **jeder** Abfrage? |
| [ ] | Rechtebedarf bestimmt | Katalog `lib/auth/permissions.ts`, Rollen `lib/auth/rbac.ts` |
| [ ] | Sensible Daten bestimmt | `lib/sensitive-fields.ts`; Lohn, AHV, IBAN, Gesundheit, Zugangscodes |
| [ ] | Geschäftsinvarianten bestimmt | z. B. lückenlose Belegnummern, „Offerte ACCEPTED ⇔ abgeschlossene Annahme", „nie die letzte Systemverantwortung" |
| [ ] | Nebenläufigkeitsrisiken bestimmt | Zwei gleichzeitige Klicks, zwei Personen, zwei Webhooks: Was darf nur einmal geschehen? |
| [ ] | Idempotenzbedarf bestimmt | Webhooks, Cron-Läufe, Automationen, Wiederholungen nach Zeitüberschreitung |
| [ ] | Nachgelagerte Abläufe bestimmt | Automationen (Ausgangsschlange), PDF, Benachrichtigung, Kennzahlen, Export |
| [ ] | Auswirkung auf Oberfläche und Bedienung bestimmt | Welche Seiten, welche Rollen, welche Navigationsebene? |
| [ ] | Auswirkung auf Barrierefreiheit bestimmt | Tastatur, Fokus, Beschriftungen, Kontrast |
| [ ] | Auswirkung auf Leistung bestimmt | Neue Abfragen auf grossen Tabellen? Index? Seitenweise? |
| [ ] | Auswirkung auf Migrationen bestimmt | Additiv? Rückfüllung? Handgeschriebenes SQL, das `migrate dev` verwerfen würde? |

## Checkliste B — Backend

| | Punkt | Wie in diesem Repository |
|---|---|---|
| [ ] | Der Server entscheidet | Preise, Summen, Punktzahlen, Fristen rechnet der Server; ein mitgeschickter Wert ist eine Behauptung |
| [ ] | Zod-Schema | In `src/lib/validation/`, nie in der Route; es speist auch OpenAPI |
| [ ] | Anmeldung | `defineRoute` / `definePublicRoute` / `defineCronRoute` — eine Route ohne erklärten Schutz gibt es nicht |
| [ ] | Rechte | `permissions` (und wo die Oberfläche nur einer Rolle gehört: `roles`) an der Route |
| [ ] | Berechtigung am Datensatz | `*VisibilityWhere` bzw. Eigentum in der Prisma-Abfrage — nie erst in der Darstellung |
| [ ] | Mandantentrennung | `organizationId` im `where`; Verweise (Kundschaft, Objekt, Datei, Person) gegen die Organisation geprüft |
| [ ] | Transaktion, wo nötig | Prüfen **und** schreiben in derselben Transaktion; Nummer im selben Commit wie der Beleg |
| [ ] | Nebenläufig sicher | Bedingte `updateMany`, `SELECT … FOR UPDATE`, `pg_advisory_xact_lock`, Teilindizes |
| [ ] | Idempotent, wo nötig | Ereignis-ID eindeutig (`ProviderWebhookEvent`), Zustand je Aktion (`AutomationActionRun`) |
| [ ] | Prüfprotokoll | `audit.*`; für Vorgänge, die es ohne Eintrag nicht geben darf, `recordAuditInTx` |
| [ ] | Sichere Fehlerbehandlung | Typisierte Fehler aus `lib/errors.ts`; 422 für „geht im jetzigen Zustand nicht", 400 für „falsch geformt"; keine Interna |
| [ ] | Rate-Limit, wo anwendbar | Klasse in `lib/rate-limit.ts`; Seiten, die einen Dienst direkt aufrufen, zählen mit (`checkRateLimit`) |
| [ ] | Keine Geheimnisse im Protokoll | Rohe Tokens nur im Link und im Austauschkörper; `redact`/`freitextSchwaerzen` |
| [ ] | Keine unnötigen Personendaten | KI: `ausgangsfilter`, `namenErsetzen`; Suche: keine sensiblen Felder als Treffergrund |

## Checkliste C — Datenbank

| | Punkt | Wie in diesem Repository |
|---|---|---|
| [ ] | Richtige Beziehung | Fremdschlüssel statt freier Kennung, `onDelete` bewusst gewählt |
| [ ] | Richtige Mandantenbeziehung | Eigene `organizationId`, wo eine Zeile ohne Bezug entstehen kann (Verlauf, Aufgabe, Protokoll) |
| [ ] | Indizes | Für jede Liste und jeden Filter, der auf wachsenden Tabellen läuft |
| [ ] | Eindeutige Geschäftsidentität | `@@unique` bzw. Teilindex für „höchstens ein offener …" |
| [ ] | Historische Unveränderlichkeit | Ausgestellte Belege, Signaturereignisse, Lagerbewegungen: Trigger in der Datenbank |
| [ ] | Gültigkeitsdaten | Fassungen mit `effectiveFrom`/`effectiveUntil` statt Überschreiben |
| [ ] | Geld als `Decimal` | `Decimal(12,2)`; Summen mit `lib/money.ts`, Rundung am Ende mit `lib/runden.ts` |
| [ ] | Additive Migration, wo möglich | Nie `prisma migrate reset`; Weg: `migrate diff` → SQL → `db execute` → `migrate resolve` |
| [ ] | Rückfüllung vor NOT NULL | Und bei Mehrdeutigkeit abbrechen statt raten (Beispiel: `…_kommunikation_mandant`) |
| [ ] | Nebenläufigkeitsinvariante in der Datenbank, wo praktikabel | Teilindex, Ausschlussbedingung, eindeutiger Schlüssel |
| [ ] | Migration auf frischer Datenbank geprüft | `npm run db:test:setup -- --frisch` |

## Checkliste D — Sicherheit

| | Punkt | Wie in diesem Repository |
|---|---|---|
| [ ] | Anmeldung | 401 ohne Sitzung; Sitzung nur für die Organisation dieser Installation |
| [ ] | Rechte | `tests/api/rbac.test.ts` (Matrix), 403 für fehlendes Recht |
| [ ] | Mandant | `tests/api/mandanten.test.ts` — fremder Datensatz nicht in Liste, nicht einzeln, nicht änderbar — auch nicht über Suchbegriff, Filter oder öffentlichen Link |
| [ ] | IDOR | `tests/api/ownership.test.ts`, `datei-zugriff.test.ts` |
| [ ] | CSRF | Herkunftsprüfung in der Routenfabrik (`assertTrustedOrigin`) |
| [ ] | XSS | Kein `dangerouslySetInnerHTML` mit fremdem Inhalt; CSP |
| [ ] | SSRF | `lib/automation/webhook.ts`: Ziel **und** Verbindung geprüft (DNS-Rebinding) |
| [ ] | Injection | Prisma bzw. `$queryRaw` mit Platzhaltern; Tabellenexporte entschärfen Formeln: CSV über `csvZeile`, XLSX über `mappeSchreiben` (beide mit `formelsicher` aus `lib/csv.ts`) |
| [ ] | Rate-Limiting | Anmeldung, öffentliche Links, Suche, Scanner, Uploads |
| [ ] | Geheimnisse | `npm run security:secrets`; `.env*` ignoriert |
| [ ] | Personendaten | Schwärzung in Protokollen, Minimierung vor der KI |
| [ ] | Dateien | Eine Bindung (`dateienBinden`), Scan-Tor vor der Auslieferung, Byte-Schreiben einmalig |
| [ ] | Öffentliche Tokens | Nur Hash in der Datenbank, Zweck, Ablauf, Widerruf (`access-token.service.ts`) |
| [ ] | Webhooks | Signatur, Zeitfenster, Ereignis-ID einmalig |
| [ ] | Replay | Einmalcodes atomar verbraucht; Webhook-Ereignisse dedupliziert |
| [ ] | Abhängigkeiten | `npm audit` gegen `security/akzeptierte-befunde.json`; Aktionen auf Commits gepinnt |
| [ ] | Schwärzung im Protokoll | Jeder Weg ins Prüfprotokoll über `auditDaten` |
| [ ] | Geschäftsinvarianten | Mit Gleichzeitigkeitsprüfung belegt, nicht nur mit einem Durchlauf |
| [ ] | Fehlerbehandlung | Keine Stacktraces, keine SQL-Fehler, keine internen Kennungen nach aussen |

## Checkliste E — Oberfläche und Bedienung

| | Punkt | Wie in diesem Repository |
|---|---|---|
| [ ] | Bestehendes Designsystem wiederverwendet | `PageHeader`, `KpiTile`, `DetailSection`, `ResourceForm`, `ActionButton`, `STATUS_MAP` |
| [ ] | Richtige Ebene: Seiten-, Kopf-, Unternavigation | Navigation im Layout, gefiltert mit `filterNavigation` |
| [ ] | Rollenbewusste Oberfläche | `can()` auf dem Server entscheidet, welche Knöpfe es gibt; der Endpunkt prüft noch einmal |
| [ ] | Desktop | |
| [ ] | Tablet | |
| [ ] | Telefon | Kein horizontales Scrollen; Tabellen in `TableScroll` |
| [ ] | Tastatur | Jede Aktion ohne Maus erreichbar |
| [ ] | Fokus | Sichtbar, nach Dialogen zurück an den Auslöser |
| [ ] | Ladezustand | `NavigationProgress` im App-Rahmen; keine `loading.tsx` — sie entfielen in Wave 9.1 wegen Hydrationsfehlern (`docs/HYDRATION.md`) |
| [ ] | Leerzustand | `EmptyState` mit Handlungsvorschlag |
| [ ] | Fehlerzustand | Deutsche Meldung aus dem Server, am Feld (`ResourceForm`) |
| [ ] | Erfolgszustand | |
| [ ] | Validierung | Dieselbe Zod-Regel wie auf dem Server |
| [ ] | Bestätigung vor zerstörenden Aktionen | `ActionButton` mit Bestätigungsdialog |
| [ ] | Einheitliche Formulare | Bearbeiten nutzt das Anlegeformular (`…/[id]/bearbeiten`) |
| [ ] | Einheitliche Tabellen | `data-list`, Sortierung über `lib/sort.ts` |
| [ ] | Keine toten Links | Kein Link in einen Bereich, den die Rolle nicht betreten darf |
| [ ] | Keine doppelte Navigation | |
| [ ] | Kein horizontales Überlaufen | `tests/e2e/phase21-oberflaeche.spec.ts` (acht Fenstergrössen inkl. 200 % Zoom), `tests/pages/tables.test.ts` |
| [ ] | Barrierefreiheit geprüft | axe in der Browser-Prüfreihe: `phase21-oberflaeche.spec.ts` misst jeden Eintrag der Seitenleiste je Rolle — eine neue Seite in der Navigation wird damit automatisch gemessen; Stand der Bereiche in `docs/PREPRODUCTION_READINESS.md`, „UI/UX-Prüfmatrix" |

## Checkliste F — Prüfungen

| | Punkt | Wie in diesem Repository |
|---|---|---|
| [ ] | Einheit | Reine Rechenkerne direkt importiert (`bi-rechenkerne`, `geldrechnung`, `zuercher-kalender`, `qualitaet-rechenkern`) |
| [ ] | Dienst/Integration | Über HTTP gegen den laufenden Server — Dienste werden bewusst nicht einzeln geprüft (`tests/README.md`) |
| [ ] | API | `tests/api/*` |
| [ ] | Normalfall | |
| [ ] | Validierung | 422 mit Feld |
| [ ] | Ohne Anmeldung | 401 |
| [ ] | Ohne Recht | 403 |
| [ ] | Falscher Mandant | 404 — nicht einmal die Existenz verraten |
| [ ] | Nebenläufigkeit | `Promise.all` mit mehreren gleichzeitigen Anfragen, Ergebnis in der Datenbank geprüft |
| [ ] | Idempotenz | Zweiter Lauf / zweites Ereignis ändert nichts |
| [ ] | Prüfprotokoll | Eintrag vorhanden **und** geschwärzt |
| [ ] | Browser (E2E) | `tests/e2e`, ohne Wiederholungen |
| [ ] | Barrierefreiheit | axe |
| [ ] | Regressionsprüfung für jeden behobenen Fehler | Zuerst rot gegen den alten Stand, dann grün — siehe „Fehlerregel" |

## Checkliste G — Auslieferung

| | Punkt | Befehl |
|---|---|---|
| [ ] | Typen | `npm run typecheck` |
| [ ] | Linter | `npm run lint` |
| [ ] | Prisma-Schema | `npx prisma validate` |
| [ ] | Dokumentation | `npm run docs` und kein Unterschied in `docs/` |
| [ ] | OpenAPI | Teil von `npm run docs` (bricht bei undokumentierter Route oder abweichendem Schutz ab) |
| [ ] | Build | `npm run build` |
| [ ] | Testreihe | `npm test` gegen `npm run test:server` |
| [ ] | Sicherheitsprüfung | `npm run security:check` |
| [ ] | Geheimnisprüfung | `npm run security:secrets` |
| [ ] | Frische Datenbank | `npm run db:test:setup -- --frisch` |
| [ ] | Bau aus einem sauberen, losgelösten Worktree des Commits | `npm run verify:release` |
| [ ] | Browser-Prüfreihe ohne Wiederholungen | `npm run verify:e2e` |
| [ ] | Last | `npm run e2e:stress` |
| [ ] | Hydration | `node scripts/react-hydrationskorrektur.mjs --pruefen` und die Browser-Prüfreihe |
| [ ] | CI grün | Lauf auf dem Arbeitszweig |
| [ ] | Keine Auslieferung versehentlich ausgelöst | `DEPLOY_ENABLED` nicht gesetzt; Auslieferungsauftrag im Lauf „übersprungen" |

---

## Automatisiert

| Befehl | Was er tut |
|---|---|
| `npm run verify:static` | Alles ohne Datenbank und Server: Hydrationskorrektur, `npm audit` (kritisch blockiert), Linter, Typen, Prisma-Schema, Geheimnisse (`security:secrets`, ohne Bash), statische Sicherheitsprüfung, Lohn-Prüfpaket passt zum Code (`lohn-pruefpaket.ts --pruefen`, seit 2026-09-27), Dokumentation aktuell (kein Unterschied in `docs/` und `README.md`), Merkmalsprüfung (beratend) |
| `npm run verify:full` | `verify:static`, dann Migrationen auf die Testdatenbank, Build, Testserver, Sicherheitsreihen, vollständige Testreihe (0 übersprungen, `node:test`-Bilanz), Browser-Prüfreihe mit Bilanz (seit 2026-09-27: übersprungen, wackelig, unerwartet oder kein JSON-Bericht ist ein Fehlschlag) — und der Server wird am Ende sicher beendet |
| `npm run verify:security` | `security:check` im Umfang `voll` (braucht den laufenden Testserver) |
| `npm run verify:e2e` | Browser-Prüfreihe ohne Wiederholungen **mit Bilanz** (`verify.ts browser`, gegen einen laufenden Server über `TEST_BASE_URL`): übersprungen, wackelig, gescheitert oder kein JSON-Bericht ist ein Fehlschlag — dieselbe Regel wie im vollen Weg (`browserBilanzPruefen`, geprüft in `pruefbilanz.test.ts`) |
| `npm run verify:release` | `verify:full` auf einer **frischen** Testdatenbank und aus einem sauberen, losgelösten `git worktree` des aktuellen Commits (nicht `git archive`: ohne `.git` scheitern Geheimnissuche und Doku-Vergleich) |

CI ruft dieselben Befehle auf (`.github/workflows/deploy.yml`); es gibt keinen
zweiten, versteckten Prüfweg.

## Fehlerregel

Jeder gefundene Fehler:

1. zuerst nachstellen,
2. Regressionsprüfung schreiben,
3. zeigen, dass sie gegen den alten Stand scheitert, wo das möglich ist,
4. die kleinste Korrektur an der Ursache — nicht am Symptom,
5. zeigen, dass die Prüfung jetzt besteht,
6. die verwandten Prüfreihen laufen lassen.

Keine schnelle Korrektur ohne Prüfung. Eine Prüfung, die ein falsches
Verhalten festschreibt, wird korrigiert, nicht der erwartete Wert an den
Fehler angepasst — und die Korrektur steht mit Begründung im Kommentar.

## Keine Scheinfunktionen

Eine Funktion ist nicht fertig, weil es ein Modell, ein Recht, einen
Menüeintrag, eine Seite, einen Knopf oder eine Route gibt. Fertig ist sie,
wenn der Geschäftsablauf von Anfang bis Ende benutzbar ist und eine Prüfung
ihn fährt. `npm run audit:merkmale` sucht das Muster „Schema + Recht +
Oberfläche, aber kein Schreibweg".

## Externe Nachweise

Was sich nur ausserhalb des Repositories belegen lässt — Auftragsverarbeitungsverträge,
ein echter `clamd`, ein Produktionsserver, Einstellungen bei GitHub oder einem
Anbieter —, wird **nicht** als geprüft gemeldet. Es steht als
„EXTERNER NACHWEIS ERFORDERLICH" im Bericht, mit dem genauen fehlenden Beleg.
