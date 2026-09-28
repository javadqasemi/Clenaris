# Sicherheitsstandard Clenaris

Stand 2026-09-27 (Abschlussmatrix am Ende). **Verbindlich** für jede Änderung am Code, an der
Datenbank, an Abhängigkeiten und an der Auslieferung. Er beschreibt nicht,
was „gute Praxis" ist, sondern was **in dieser Codebasis** gilt, wo es
durchgesetzt wird und woran man einen Verstoss erkennt.

Was dieser Standard nicht behauptet: dass Clenaris sicher „ist". Er legt
fest, welche Klassen von Fehlern durch Bauweise ausgeschlossen, welche durch
Prüfungen erkannt und welche nur durch Durchsicht gefunden werden. Die
automatischen Prüfungen (`npm run security:check`, `docs/SECURITY_AUTOMATION.md`)
finden bekannte Muster; sie finden keine Logikfehler, keine fehlende
Eigentümerbedingung in einer neuen Abfrage und keine unbekannte Lücke in
einer Abhängigkeit.

## So wird der Standard benutzt

- **Beim Schreiben**: Jeder Abschnitt nennt die Stelle im Code, die die Regel
  umsetzt. Neuer Code benutzt diese Stelle — keine zweite Umsetzung daneben.
- **Bei der Durchsicht**: Die Prüffragen am Ende jedes Abschnitts sind die
  Checkliste. Eine mit „nein" beantwortete Frage blockiert die Übernahme,
  bis sie begründet oder behoben ist.
- **Vor einer Freigabe**: `npm run security:check` muss ohne
  *blockierenden* Befund enden; Hinweise werden gelesen, nicht nur gezählt.
  Der vollständige Freigabeweg ist `npm run verify:release` (sauberer
  `git worktree` des Commits, frische Testdatenbank, Geheimnisprüfung,
  `npm audit`, Sicherheitsreihen, ganze Prüfreihe, Browser-Reihe ohne
  Wiederholungen); das CI ruft dieselben Schritte auf
  (`.github/workflows/deploy.yml`).
- **Abweichungen** sind erlaubt, wenn sie im Code an der Stelle begründet
  sind (Kommentar mit dem verworfenen Weg und dem Grund) und — bei
  Musterprüfungen — in `security/unterdrueckungen.json` mit Begründung stehen.

Stufen: **MUSS** blockiert, **SOLL** verlangt eine Begründung bei Abweichung.

---

## C1 Authentisierung

- **MUSS** jede geschützte Seite und jeder geschützte Endpunkt die Sitzung
  auf dem Server prüfen: `defineRoute` (`src/lib/api/handler.ts`) bzw.
  `requireSession`/`requirePermission`/`requirePagePermission`
  (`src/lib/auth/session.ts`). Die Middleware (`src/middleware.ts`) ist
  Vorfilter auf Edge, keine Autorisierung.
- **MUSS** Passwörter mit dem bestehenden Hash (`src/lib/auth/password.ts`)
  behandeln; nie selbst hashen, nie loggen.
- **MUSS** Zugangstoken kurzlebig bleiben (15 min), Auffrischung über die
  Rotationsfamilie (`RefreshToken.family`), Leerlaufabmeldung serverseitig
  (`SESSION_IDLE_TTL`). Widerruf (`sessionsRevokedAt`) wirkt auf alle Tokens
  mit älterem `iat`.
- **MUSS** Zwei-Faktor, Sperren und Rate-Limits der Anmeldewege
  (`login`, `otpVerify`, `passwordReset`) unverändert gelten.
- **MUSS** die Gerätesperre (Gate 4D) respektiert werden: neue Endpunkte sind
  während der Übergabe gesperrt (`allowDuringHandoff` bleibt `false`, ausser
  der Endpunkt gehört zur Übergabe selbst).

Nachweis: `session-refresh`, `two-factor`, `rate-limit`, `vor-ort-abnahme`,
`rbac` (Prüfreihe). Prüffragen: Braucht der neue Weg eine Sitzung, und wo
wird sie *auf dem Server* geprüft? Läuft er während einer Übergabe?

## C2 Autorisierung

- **MUSS** jeder Endpunkt seine Rechte in `permissions` (und falls nötig
  `roles`) deklarieren; die Registry `scripts/openapi-routes*.ts` muss
  denselben Schutz nennen (`npm run openapi` bricht sonst ab).
- **MUSS** jede Seite `requirePermission` (hat Lesemodus) oder
  `requirePagePermission` (reine Bearbeitungsmaske, 404) aufrufen, und die
  vier Schichten müssen übereinstimmen: Middleware (`ROUTE_GUARDS`),
  `PERMISSION_ROUTES`, Navigation (`filterNavigation`), Seite.
- **MUSS** eine Schaltfläche nur gerendert werden, wenn `can()` auf dem
  Server sie erlaubt — und der Endpunkt prüft trotzdem erneut.
- **MUSS** datensatzbezogene Rechte (`*:read_own`, `job:read_assigned`,
  `property:read`, `document:read_own`) **in der Prisma-Abfrage** einschränken
  (`propertyVisibilityWhere`, `documentVisibilityWhere`, Zuteilung im
  `where`), nie in der Darstellung.
- **MUSS** `SUPER_ADMIN_ONLY`-Rechte (`role:assign`, `audit:read`,
  `user:impersonate`, Update- und Sicherheitszentrale) bei der
  Systemverantwortung bleiben.

Nachweis: `rbac`, `ownership`, `zugriffsgrenzen`, `sicherheitsluecken`,
`crud-audit`, `suche`, `scan`, `release-center`, `sicherheitszentrum`. Prüffragen: Welche Rolle darf das,
und woran scheitert eine andere? Gibt es einen Fall in `ownership.test.ts`,
wenn die Daten rollenbezogen sind?

## C3 Mandantentrennung

- **MUSS** jede Abfrage `organizationId` im `where` tragen — auch bei Zugriff
  über eine ID aus der URL (`findFirst({ where: { id, organizationId } })`,
  nie `findUnique({ where: { id } })` für Fachdaten aus einer Anfrage).
- **MUSS** eine fremde ID wie eine unbekannte behandelt werden (404 oder leere
  Antwort, keine unterscheidbare Meldung).
- **MUSS** jeder Suchbegriff, Filter (`?customerId=`, `?status=`) und jede
  Zeitachse denselben Schnitt tragen wie die Liste selbst. Die Befunde vom
  2026-09-27 lagen genau dort: Zahlungssuche, Objektfilter der Kundschaft,
  Entwürfe von Qualitätskontrollen, Zeitachse der Ziele — die Liste war
  richtig eingeschränkt, der Nebenweg nicht.
- **MUSS** ein öffentlicher Token, eine öffentliche Datei und ein
  Einsatzrapport nur in der Organisation dieser Installation auflösen.
- **SOLL** jede neue Prüfreihe mit Fachdaten einen Fall gegen
  `fremdeOrganisation()` (`tests/helpers/testdb.ts`) enthalten.

Nachweis: `mandanten`, `sicherheitsluecken` (IDOR), `suche`, `scan`,
`datei-zugriff`. Prüffrage: Was
geschieht mit der ID eines Datensatzes der fremden Prüforganisation?

## C4 Eingabeprüfung

- **MUSS** jede Eingabe durch ein Zod-Schema aus `src/lib/validation/`
  laufen (`body`, `query`, `params` im Routenfactory) — keine Inline-Schemas
  in Routen, keine ungeprüften `request.json()`.
- **MUSS** jede Zeichenkette eine Obergrenze haben; Zahlen Bereiche;
  Aufzählungen `z.enum`.
- **MUSS** Validierungsfehler 422 ergeben, Fachregelverstösse
  `BusinessRuleError` (422), fehlerhafte Anfragen 400.
- **MUSS** Eingaben aus Scans, Dateien, Webhooks und QR-Codes als fremd
  gelten: einordnen, nicht ausführen (`src/lib/scan/kennung.ts` als Muster).

Nachweis: `protokoll-und-schranken`, `scan-kennung`, `scan`. Prüffrage:
Was geschieht mit 10 000 Zeichen, einem Steuerzeichen, einem Objekt statt
einer Zahl?

## C5 Injection

- **MUSS** Datenbankzugriff über Prisma oder `Prisma.sql`/Tagged Templates
  (`$queryRaw\`…${wert}\``, `$executeRaw`) erfolgen.
  `$queryRawUnsafe`/`$executeRawUnsafe` sind nur mit konstantem Text erlaubt
  und stehen in `security/unterdrueckungen.json`.
- **MUSS** kein Anwendungscode `child_process`, `eval`, `new Function` oder
  `vm` benutzen. Skripte unter `scripts/` dürfen Prozesse starten; sie sind
  nie von einer Anfrage aus erreichbar.
- **MUSS** keine Browser- oder Dashboardroute eine Shell, `npm`, `git`, SSH,
  einen Neustart oder `prisma migrate deploy` auslösen (Update- und
  Sicherheitszentrale zeigen, planen und protokollieren nur).
- **MUSS** Dateipfade aus Anfragen nie zusammengesetzt werden; Ablagepfade
  entstehen serverseitig (`src/lib/storage/`).
- **MUSS** jeder Tabellenexport Formelanfänge (`=`, `+`, `-`, `@`) in
  Freitext entschärfen: CSV über `csvZeile`, XLSX über `mappeSchreiben`
  (`src/server/services/export.service.ts`), beides mit `formelsicher`
  (`src/lib/csv.ts`). Seit 2026-09-27 laufen auch die Excel-Berichte der
  Führung (`bi-report.service.ts`) über diesen Schreibweg.

Nachweis: Musterprüfung in `security:check` (Kategorien `sql-unsafe`,
`prozess`, `eval`); Formeln: `finanzbelege`, `sicherheitsluecken`. Prüffrage: Kann ein Wert aus der Anfrage Teil eines
Befehls, einer Abfrage oder eines Pfads werden?

## C6 XSS und Content-Security-Policy

- **MUSS** Ausgabe über React erfolgen. `dangerouslySetInnerHTML` nur für
  vorher maskierten Markdown (`src/components/markdown.tsx`) und JSON-LD
  (`src/lib/json-ld.ts`, mit `<`-Maskierung); jede weitere Stelle steht in den
  Unterdrückungen mit Begründung.
- **MUSS** gescannte, hochgeladene oder von aussen kommende Adressen nie als
  Link, `src` oder Weiterleitung benutzt werden, ohne gegen eine Erlaubnis zu
  prüfen (Weiterleitungen nur auf eigene Pfade: `weiter=` beginnt mit `/`,
  nicht `//`).
- **MUSS** die CSP in `next.config.ts` bleiben; eine neue Quelle braucht eine
  Begründung dort. Keine `unsafe-eval`.
- **MUSS** HTML-Vorschauen der CMS-Bearbeitung die Markierungen nur im
  Vorschaumodus erzeugen (byte-gleiche Ausgabe für Besucher).
- **MUSS** eine Freigabeliste nur **eigene** Schlüssel prüfen
  (`Object.hasOwn`, `src/lib/cms/assets.ts`). `in` oder ein Indexzugriff
  liessen `constructor` und `__proto__` als „freigegeben" durch.

Nachweis: `auslieferung-absicherung`, `cms`, `sicherheitsluecken`, `scan`
(E2E: Markup bleibt Text). Prüffrage: Wo wird ein fremder Text als HTML, Adresse oder Stil
eingesetzt?

## C7 CSRF und Origin

- **MUSS** jede schreibende Anfrage durch `assertTrustedOrigin`
  (`src/lib/api/handler.ts`) laufen — sie steckt im Routenfactory, ein neuer
  Endpunkt bekommt sie automatisch.
- **MUSS** Sitzungscookies `HttpOnly`, `Secure` (ausser lokal), `SameSite=Lax`
  oder strenger bleiben.
- **MUSS** GET lesen. Kein GET, der schreibt — auch nicht „nur einen Code
  erzeugen" (Beispiel: die Etikettseite erzeugt keinen Code beim Aufrufen).
  Das gilt auch für Seiten hinter einem Link aus einer E-Mail: Bis
  2026-09-27 bestätigten bzw. kündigten `/newsletter/bestaetigen` und
  `/newsletter/abmelden` schon beim Seitenaufruf — Mailfilter rufen Links
  vorab auf. Seither lesen die Seiten nur, und erst der Klick schickt ein
  POST an `/api/public/newsletter/bestaetigen` bzw. `…/abmelden`.

Nachweis: `auslieferung-absicherung`, `rbac`, `newsletter-links`. Prüffrage: Schreibt dieser
Endpunkt mit GET? Kommt er ohne Origin-Prüfung aus?

## C8 SSRF

- **MUSS** jede ausgehende Anfrage an eine konfigurierbare Adresse
  (Webhooks, Automationen, Alarmziele) durch `pruefeZiel`/`istPrivateAdresse`
  (`src/lib/automation/webhook.ts`) laufen: nur `https`, keine privaten,
  Loopback- oder Link-Local-Adressen, keine Weiterleitungen, Zeitlimit.
- **MUSS** keine Adresse aus einer Anfrage, einem Scan oder einer Datei
  serverseitig abgerufen werden.

Nachweis: `automatisierungen`. Prüffrage: Kann ein Mensch oder eine Datei
bestimmen, wohin der Server eine Verbindung aufbaut?

## C9 Rate-Limits

- **MUSS** jeder Endpunkt `rateLimit` deklarieren; Anmelde-, Token- und
  öffentliche Wege ein enges Kontingent (`src/lib/rate-limit.ts`).
- **MUSS** ein Weg, der fortlaufende Nummern oder Tokens prüft, ein eigenes,
  enges Kontingent haben (Beispiel `scanResolve`, `publicTokenRead`).
- **SOLL** das Kontingent angemeldeter Wege je Person statt je IP zählen,
  wenn Büros sich eine Adresse teilen (`rateLimitKey`).
- Ohne `REDIS_URL` gelten Limits je Prozess — im Mehrprozessbetrieb ist Redis
  Pflicht (`docs/PRODUCTION_V2.md`).

Nachweis: `rate-limit`, `scan` (Kontingent). Prüffrage: Wie viele Versuche
pro Minute bekommt jemand, der rät?

## C10 Geheimnisse

- **MUSS** kein Geheimnis im Repository stehen: keine Schlüssel, Tokens,
  Passwörter, Verbindungszeichenketten mit Passwort. `.env*` ausser
  `.env.example` ist ausgeschlossen.
- **MUSS** Geheimnisse nur über Umgebungsvariablen kommen (`serverEnv()`,
  `src/lib/env.ts`), serverseitig bleiben (kein `NEXT_PUBLIC_` für
  Geheimnisse) und in keinem Log, Prüfprotokoll, Fehlertext oder
  Kundenschreiben erscheinen.
- **MUSS** die Geheimnisprüfung vor jeder Freigabe laufen:
  `npm run security:secrets` (`scripts/security/geheimnisse.ts`). Seit
  2026-09-27 gibt es davon **eine** Umsetzung in TypeScript, die örtlich
  (`verify:static`) wie im CI läuft; `scripts/ci-secret-scan.sh` ist nur
  noch die Hülle, die sie aufruft. Die frühere Meldung „NICHT GEPRÜFT ohne
  Bash" gilt nicht mehr.
- Schlüsselrotation: `docs/KEY_MANAGEMENT.md`.

Nachweis: `schluesselrotation`, `verschluesselung`, CI-Geheimnisprüfung.

## C11 Personendaten

- **MUSS** sensible Felder (Lohn, AHV-Nummer, IBAN, Geburtsdatum,
  Notfallkontakt, Zugangscodes) bei Protokoll und Ausgabe geschwärzt werden:
  `istSensiblerSchluessel`, `freitextSchwaerzen` (`src/lib/sensitive-fields.ts`),
  `redact` (`src/lib/audit.ts`).
- **MUSS** kein sensibles Feld Treffergrund einer Suche sein (`suche`-Test).
- **MUSS** kein QR-Code, Etikett, Link oder Dateiname Personendaten tragen —
  nur undurchsichtige Kennungen (`ScanCode`, `PublicAccessToken`).
- **MUSS** kein Personendatum an die KI gehen (`docs/KI_GOVERNANCE.md`).
- **SOLL** Löschfristen über den bestehenden Löschlauf (`purge.service.ts`)
  laufen, nicht über Einzelskripte.

Nachweis: `protokoll-schwaerzung`, `suche`, `ki-governance`, `purge`.

## C12 Dateien

- **MUSS** jeder Upload über Ticket und Abschluss laufen
  (`file.service.ts`): gespeicherte Bytes zurücklesen, Grösse, Signatur und
  Typ gegen das Profil prüfen, Dateipolitik (Name, Endung), Prüfsumme,
  Malware-Prüfung (`src/lib/security/malware/`, `docs/MALWARE_PROTECTION.md`).
- **MUSS** die Berechtigung auf der fachlichen Ebene (`FileAsset`) entstehen;
  eine Kennung öffnet nichts.
- **MUSS** die Auslieferung mit `Content-Disposition`, `nosniff` und
  passendem Typ erfolgen (`src/lib/api/binary-response.ts`).
- **MUSS** kein Kamerabild und kein gescanntes Bild hochgeladen werden, wenn
  nur der erkannte Text gebraucht wird.
- **MUSS** eine Datei genau einmal gebunden werden; die Adresse eines
  privaten Anhangs wird nie zum Website-Bild.

Nachweis: `dateisicherheit`, `datei-integritaet`, `datei-zugriff`,
`sicherheitsluecken` (Dateibindung), `clamd-protokoll`, `pdf-auslieferung`.

## C13 Öffentliche Tokens

- **MUSS** jeder Zugang ohne Anmeldung über `PublicAccessToken`
  (`access-token.service.ts`) laufen: Zweck, Ressource, Ablauf, Widerruf,
  nur der Hash in der Datenbank.
- **MUSS** ein Roh-Token nur im URL-Fragment und im Austauschrumpf erscheinen
  — nie in Pfad, Abfrage, HTML, Ereignis, Protokoll oder E-Mail-Protokoll.
- **MUSS** ein neuer Zweck die Aufzählung `PublicTokenPurpose` per Migration
  erweitern; kein Wiederverwenden eines fremden Zwecks.
- **MUSS** ein interner Etikettcode (`ScanCode`) **kein** Zugang ohne
  Anmeldung sein.
- **MUSS** ein Token nur in der Organisation dieser Installation auflösen —
  ein gültiger Link einer fremden Organisation antwortet 404.

Nachweis: `zugriffstokens`, `oeffentlicher-zugang`, `oeffentliche-links`,
`signatur`, `offertannahme`, `mandanten` („Öffentliche Links").

## C14 Finanzielle Integrität

- **MUSS** Geld als `Decimal(12,2)` gespeichert, **dezimal gerechnet**
  (`src/lib/money.ts`, `src/lib/rechnungsbetraege.ts`) und erst an der
  Anzeige mit `toNumber()` umgewandelt werden. Kein Produkt, Prozentsatz oder
  Summe eines Betrags in binärem `number` — auch nicht mit anschliessender
  Rundung (gemessene Rappenfehler, `tests/api/geldrechnung.test.ts`).
- **MUSS** Preise nur auf dem Server berechnet werden
  (`src/lib/pricing/engine.ts`); ein Preis aus dem Formular wird nie
  übernommen.
- **MUSS** eine Rechnung aus einer Buchung aus deren gespeicherter
  Herleitung entstehen (`rechnungsgrundlageAusBuchung`), nicht neu gerechnet.
- **MUSS** eine ausgestellte Rechnung unveränderlich sein; Korrektur per
  Gutschrift. Belegnummern lückenlos in derselben Transaktion (Art. 957a OR).
- **MUSS** Lagerbewegungen und Signaturereignisse nur anfügen (Trigger).
- **MUSS** eine von Hand erfasste Zahlung den offenen Saldo nicht
  übersteigen (422, seit 2026-09-27).

Nachweis: `finanzbelege`, `buchung-integritaet`, `datenintegritaet`,
`vertraege-integritaet`, `geldrechnung`, `zahlungsbuch`, `nebenlaeufigkeit`,
`sicherheitsluecken`.

## C15 Fachliche Invarianten

- **MUSS** eine Invariante in der Datenbank erzwungen werden, wenn zwei
  gleichzeitige Anfragen sie brechen können: Teilindex, Sperre
  (`pg_advisory_xact_lock`, `FOR UPDATE`) oder eindeutiger Index — nicht die
  Oberfläche. Beispiele: eine offene Annahme je Offerte, ein aktiver
  Etikettcode je Datensatz, Kapazität je Organisation beim Buchen und
  Bearbeiten; seit 2026-09-27 auch: eine Kundenakte je E-Mail-Adresse
  (Sperre auf allen fünf Anlagewegen), keine überlappende Zeiterfassung je
  Person, eine Umwandlung je Anfrage, eine offene Anfrage je Kontaktanfrage,
  Bewilligung einer Abwesenheit nicht neben einer Zuteilung, lückenlose
  Fassungsnummern je Dokument.
- **MUSS** eine handgeschriebene SQL-Regel (Teilindex, Trigger) in der
  Migration mit Begründung stehen; ein späteres `migrate dev`, das sie
  löschen will, wird abgelehnt.
- **MUSS** jede neue Invariante einen Gleichzeitigkeitsfall in der
  Prüfreihe haben (`Promise.all` zweier Anfragen → genau ein Erfolg).

Nachweis: `nebenlaeufigkeit`, `mehrere-leistungen`, `buchung-integritaet`,
`dispatch`, `scan`, `release-center`, `offertannahme`.

## C16 Prüfprotokoll

- **MUSS** jede fachlich bedeutsame Änderung protokolliert werden
  (`audit.created/updated/deleted`, `src/lib/audit.ts`): wer, was, wann,
  ohne Geheimnis und geschwärzt.
- **MUSS** ein Protokoll keine Rohtokens, Etikettcodes, Passwörter oder
  vollständigen Personendaten enthalten.
- **MUSS** jede Einzelhandlung ihren eigenen Eintrag haben — nicht ein
  Sammeleintrag für viele: Freigabe je Zeiterfassung, Veröffentlichen je
  Baustein, Mahnung je Rechnung (so seit 2026-09-27; vorher fehlten Mahnlauf,
  Zeitfreigabe je Eintrag, Eröffnen eines Nachrichtenverlaufs,
  Anfrageverknüpfung und CMS-Veröffentlichung je Baustein).
- **SOLL** reines Lesen nicht protokolliert werden, ausser Downloads
  vertraulicher Dokumente und Exporte.

Nachweis: `protokollpflicht`, `protokoll-und-schranken`,
`protokoll-schwaerzung`, `zugriffsgrenzen` (Zwei-Faktor), `scan`.

## C17 Webhooks

- **MUSS** jeder eingehende Webhook die Signatur des Absenders prüfen, mit
  Zeitfenster gegen Wiederholung: Stripe (`constructWebhookEvent`), Resend
  (Svix, fünf Minuten), Twilio (`X-Twilio-Signature` über die öffentliche
  Adresse).
- **MUSS** die Verarbeitung idempotent sein (eindeutige Anbieter-ID).
- **MUSS** ein Webhook ohne gesetztes Geheimnis abweisen, nicht annehmen.

Nachweis: `kommunikation`, `stripe-rueckkehr`.

## C18 Abhängigkeiten

- **MUSS** jede neue Laufzeitabhängigkeit in `docs/LIEFERKETTE.md` begründet
  werden (Zweck, Lizenz, Pflegezustand, Grösse, Alternative).
- **MUSS** `npm audit --omit=dev` ohne *kritischen* Befund bleiben (CI
  blockiert); *hohe* Befunde werden in `security:check` gemeldet und binnen
  einer Freigabe bewertet.
- **MUSS** Installation reproduzierbar sein (`npm ci`, `package-lock.json`
  eingecheckt). Kein `npm install` aus einer Anwendungsroute.
- **SOLL** eine SBOM je Freigabe erzeugt werden (`npm run security:sbom`).

Nachweis: CI, `security:check` (Abhängigkeiten).

## C19 Fehlerbehandlung

- **MUSS** jeder Fehler über `toErrorResponse` (`src/lib/api/response.ts`)
  gehen: typisierte Klassen aus `src/lib/errors.ts`, deutsche Meldung für
  Menschen, **nie** Stacktrace, SQL, Pfad oder Bibliotheksmeldung nach aussen.
- **MUSS** „nicht gefunden" und „nicht berechtigt" dort gleich aussehen, wo
  die Unterscheidung die Existenz eines Datensatzes verriete.
- **MUSS** unerwartete Fehler mit Korrelations-ID protokolliert werden
  (`docs/OBSERVABILITY.md`), ohne Anfragerumpf mit Personendaten.
- **MUSS** eine Eindeutigkeitsverletzung (`P2002`) 409 **ohne Feldnamen**
  ergeben (das Ziel steht nur im Protokoll), und ein Schreibkonflikt oder
  eine Verklemmung (`P2034`, roh `40P01`/`40001`) 409 statt 500 — ein
  erneuter Versuch gelingt (`src/lib/api/response.ts`, 2026-09-27).
- Nachrichtenverläufe folgen dieser Regel seit 2026-09-27: ein fremder oder
  nicht zugeteilter Verlauf antwortet 404, nicht 403.

Nachweis: `beobachtbarkeit`, `protokoll-und-schranken`, `zugriffsgrenzen`,
`nebenlaeufigkeit` (keine 500 unter Gleichzeitigkeit).

## C20 Prüfanforderungen

Eine Änderung ist nicht fertig ohne:

| Änderung | Pflichtfall |
|---|---|
| neuer Endpunkt | Recht erlaubt / verweigert (403), Validierung (422), OpenAPI-Eintrag, Rate-Limit |
| rollen- oder datensatzbezogene Daten | Fall in `ownership.test.ts` oder in der Fachreihe mit einer Rolle ohne Zugriff |
| Fachdaten mit ID aus der Anfrage | Fall gegen `fremdeOrganisation()` |
| Invariante gegen Gleichzeitigkeit | zwei gleichzeitige Anfragen → genau ein Erfolg |
| öffentlicher Weg | Token abgelaufen, widerrufen, falscher Zweck, Rate-Limit |
| Datei | falscher Typ, falsche Signatur, zu gross, Malware-Befund |
| Ausgabe fremder Texte | Markup bleibt Text (HTML-Prüfung oder E2E) |
| neue Seite | Rauchtest je Rolle (`tests/pages/smoke.test.ts`) |
| Oberfläche mit Zustand im Rahmen | Hydrationsreihe grün (`e2e:stress`) |

Verboten, um eine Reihe grün zu bekommen: mehr Wiederholungen, Fälle
überspringen, Fehler herausfiltern, Zusicherungen entfernen.

---

## Durchsichtsliste (Kurzform)

1. Sitzung auf dem Server geprüft? Gerätesperre beachtet? (C1)
2. Rechte deklariert, Registry gleich, Seite + Knopf + Endpunkt einig? (C2)
3. `organizationId` im `where`, fremde ID = unbekannt? (C3)
4. Zod-Schema aus `src/lib/validation/`, Obergrenzen? (C4)
5. Kein Unsafe-SQL, kein Prozess, kein Pfad aus der Anfrage? (C5)
6. Fremder Text nur als React-Text, keine fremde Adresse als Link? (C6)
7. Kein schreibender GET? (C7)
8. Keine ausgehende Verbindung an eine fremdbestimmte Adresse ohne `pruefeZiel`? (C8)
9. Rate-Limit passend zum Rateproblem? (C9)
10. Kein Geheimnis im Code, Log, Protokoll? (C10)
11. Personendaten geschwärzt, nicht in Codes/Links? (C11)
12. Dateien über Ticket und Abschluss? (C12)
13. Öffentlicher Zugang nur über `PublicAccessToken`? (C13)
14. Geld als Decimal, Preis vom Server, Belege unveränderlich? (C14)
15. Invariante in der Datenbank, mit Gleichzeitigkeitsfall? (C15)
16. Protokolliert, ohne Geheimnis? (C16)
17. Webhook signiert, idempotent? (C17)
18. Neue Abhängigkeit begründet, `npm audit` ohne kritisch? (C18)
19. Fehler über `toErrorResponse`, nichts Internes nach aussen? (C19)
20. Pflichtfälle aus C20 vorhanden? (C20)

---

## Abschlussmatrix (2026-09-27)

Stand: `HEAD fb0202e` (zuvor `5760e88`, `34b3484`). Grundlage:

- `npm run verify:release` an `5760e88` — sauberer, losgelöster
  `git worktree`, frische Testdatenbank: **1905 / 1905** Fälle, 0
  übersprungen, Sicherheitsreihen und statische Prüfungen grün, Browser-Reihe
  **53 / 53** mit `retries = 0`.
- `npm run verify:release` an `34b3484`: PASS — **1969 / 1969**, 0
  übersprungen, Browser-Reihe **57 / 57**, Wiederholungen 0.
- HTTP-Reihe auf dem Bau von `8bcc88c` … `fb0202e`: **2033** Fälle, alle
  bestanden, 0 übersprungen (nach Korrektur von 7 Fehlern im Testcode).
- RELEASE-ERGEBNIS fb0202e: FAIL (2032/2033 - Standardadresse gleichzeitig, Verklemmung -> 500; behoben in 0023556). verify:release auf 0023556: PASS - saubere Worktree-Kopie, frische Datenbank, 2038/2038 Tests, 0 übersprungen, Browser 57/57 ohne Wiederholungen, 0 übersprungen, 0 wackelig; CI-Lauf 36332513820 grün, Auslieferung übersprungen
- CI-Lauf **36319443611** (an `5760e88`): grün, Auslieferungsauftrag
  übersprungen.
- `security/testmatrix.json`: 23 Funktionen × 9 Dimensionen = **205
  abgedeckt / 0 Lücken / 2 nicht zutreffend** (an `34b3484` noch 196 / 9 /
  2); `security/sicherheitsmatrix.json`: **15 / 15** Klassen abgedeckt.
  Beide prüft `scripts/testmatrix-pruefen.ts` (Datei und wörtlicher
  Testtitel müssen existieren).
- Stressreihe: STRESS-ERGEBNIS: 5 von 5 grün auf 0023556 — je 57/57 Browserfälle, 0 gescheitert, 0 übersprungen, 0 Hydrationsartefakte, ohne Wiederholungen, jeder Lauf gegen einen frisch gestarteten Testserver (Bericht test-results/stress-2026-09-27T17-10-28-542Z.json).

Spalten: **CODE** ist PASS nur mit einer automatischen Prüfung, die in der
genannten Datei unter dem genannten Titel steht (per Suche bestätigt). Was
innerhalb des Bereichs trotzdem ungeprüft ist, steht als **Prüflücke** —
eine Lücke in der Prüfung, kein bekannter Fehler im Code. **EXTERNER
NACHWEIS** nennt den genauen fehlenden Beleg ausserhalb des Repositorys oder
„keiner". Ein Bereich, dem nur ein externer Beleg fehlt, ist nicht PARTIAL,
sondern PASS + EXTERNER NACHWEIS.

| Bereich | CODE | Beleg (Datei — Testtitel) | Prüflücke (intern) | EXTERNER NACHWEIS |
|---|---|---|---|---|
| AUTH | **PASS** | `session-refresh` — „fünfzig gleichzeitige Erneuerungen: genau eine gelingt, die Familie bleibt heil"; `two-factor` — „verwirft ein Token, das älter ist als der Widerruf"; `zugriffsgrenzen` — Block „A) Ohne gültige Anmeldung antworten … mit 401"; `sicherheitsluecken` — „ein rotierter Token, nach der Kulanzfrist erneut vorgelegt, macht auch den neuesten ungültig"; `vor-ort-abnahme` — „sperrt jeden angemeldeten Endpunkt — auch aus einem zweiten Tab"; E2E `gate4d-sperre` — „sperrt den zweiten Tab desselben Browsers — serverseitig, nicht nur als Umleitung"; `two-factor` — „derselbe Ersatzcode fünfmal gleichzeitig eingelöst: genau eine Sitzung, vier 401, ein Code weniger im Vorrat" | kein Test, dass Tokenwiederverwendung ein `TOKEN_REUSE`-Ereignis erzeugt | keiner |
| RBAC | **PASS** | `rbac` — „Rechtematrix", „Menüpunkte verschwinden, statt auszugrauen", „zwei gleichzeitige gegenseitige Herabstufungen lassen eine Systemverantwortung übrig"; `zugriffsgrenzen` — Block „B) Mitarbeitende und Kundschaft legen keine Offerten an, ändern und versenden keine (403)"; `ownership` — „die Kundschaft kann fremde Objekte weder lesen noch ändern"; `protokoll-und-schranken` — „die Systemverantwortung sieht das Protokoll" | Abwesenheiten anderer Mitarbeitender über die Portal-Sitzung ohne IDOR-Fall (Sicherheitsmatrix `idor`) | keiner |
| TENANT | **PASS** | `mandanten` — „Zahlung: nicht in der Liste — auch nicht mit Suchbegriff —, nicht korrigierbar, nicht stornierbar", „Unterzeichnungslink tauschen (SIGNATURE_ACCESS): 404, keine Signatursitzung, kein Protokolleintrag", „der Rapport eines fremden Einsatzes wird nicht erzeugt (404)", „öffentliche Datei der fremden Organisation wird hier nicht ausgeliefert (404) — weder angemeldet noch anonym"; `sicherheitsluecken` — „die Kundschaft listet mit ?customerId= keine Objekte einer anderen Kundschaft", „die Kundschaft sieht mit ?status=DRAFT keine Entwürfe von Qualitätskontrollen", „Mitarbeitende sehen in der Zeitachse keine fremden persönlichen Ziele"; `suche` — „eine fremde Organisation bleibt unsichtbar"; `zahlungsbuch` — „eine korrekt signierte Zahlung auf die Rechnung einer fremden Organisation bucht nichts, wird vermerkt, gemeldet und nicht endlos wiederholt"; `newsletter-links` — „der Token einer fremden Organisation ist unbekannt (404) und ändert nichts" | Führungsberichte, Einsatzplan eines fremden Vertrags, öffentliche Buchung mit fremder Leistung (Sicherheitsmatrix `fremder-mandant`); `EmailLog`/`SmsLog` tragen seit F-02 eine Organisation, geprüft ist nur das E-Mail-Zustellprotokoll, kein SMS-Fall | keiner (einmandantiger Betrieb) |
| VALIDATION | **PASS** | `scan` — „zu lang: 422 vor jedem Dienst; leer: 422"; `settings` — „weist einen unbekannten Schlüssel ab", „weist einen Wert ausserhalb der Grenzen ab"; `sicherheitsberichte` — „ungültige Inhalte: 422 — unbekannte Quelle, zu viele Befunde, zu lange Texte, Zeit in der Zukunft"; `sicherheitsluecken` — „Namen aus der Prototypenkette bestehen die Freigabeliste nicht (Absage, kein 500)", „keine Zelle ist eine Formel, und = + @ am Anfang eines Freitexts sind entschärft"; `finanzbelege` — „der Buchhaltungsexport enthält keine Zelle, die mit einer Formel beginnt" | missgebildeter Anmelderumpf (422) nicht eigens geprüft; XLSX-Exporte von Rechnungen und Zeiten sowie die Excel-Berichte der Führung laufen über denselben entschärfenden Schreibweg (`mappeSchreiben`), sind aber nicht eigens geprüft | keiner |
| CSRF | **PASS** | `ownership` — „lehnt ändernde Anfragen mit fremdem Origin ab"; `sicherheitsluecken` — „clenaris_at und clenaris_rt sind HttpOnly und SameSite=Lax oder Strict", „PATCH und öffentlicher POST mit fremdem Origin: 403, ohne Wirkung"; `laufzeit-konfiguration` — „ein übergeschobenes X-Forwarded-Host macht eine fremde Herkunft nicht vertrauenswürdig" | — | keiner |
| XSS | **PASS** | `sicherheitsluecken` — „Kundendetail: Name und Notiz erscheinen maskiert, nie als Markup", „Offertdetail: Position und Titel erscheinen maskiert, nie als Markup", „Nachrichten: Seite ohne Markup, Endpunkt als JSON mit nosniff und Text unverändert"; E2E `scan` — „feindliche Inhalte: nichts wird geöffnet, ausgeführt oder als Markup dargestellt"; E2E `gate3-pdf-viewer` — „führt in ein PDF eingebettetes JavaScript nicht aus"; `dateisicherheit` — „weist SVG und HTML als MIME-Typ zurück" | CMS-Texte, Anfragen und E-Mail-Vorlagen mit Skriptnutzlast nicht geprüft | keiner |
| SSRF | **PASS** | `automatisierungen` — „DNS Rebinding: erst öffentlich, beim Verbinden privat — die Verbindung wird verweigert", „weist eine Regel mit privater Webhook-Adresse ab"; `sicherheitsluecken` — „${status} nach ${ort} wird nicht verfolgt — genau eine Anfrage, Ergebnis ein Fehlschlag" | — (einziger konfigurierbarer ausgehender Weg ist der Automations-Webhook) | keiner |
| RATE LIMIT | **PASS** | `rate-limit` — „Anmeldung: acht Versuche je Adresse, der neunte bekommt 429 mit Retry-After im Fenster", „Schreibkontingent zählt je Benutzer: die Verwaltung erschöpft ihres, die Betriebsleitung nicht", „Signaturtausch: zwanzig Versuche je Adresse, dann 429 — …"; `protokoll-und-schranken` — „jede Route unter /api/notifications deklariert ein rateLimit"; Musterprüfung „Rate-Limit je Route" in `security:check` | — | `REDIS_URL` im Produktionsbetrieb mit mehreren Prozessen (ohne Redis zählt jeder Prozess für sich); echte Client-Adresse hinter Cloudflare nach Nachmessung und erst dann `TRUSTED_PROXY_MODE=CLOUDFLARE` (E-6) |
| SECRETS | **PASS** | `npm run security:secrets` in `verify:static` (grün in `verify:release` an 5760e88) und im CI-Lauf 36319443611; `schluesselrotation` — „die Übersicht gibt Kennungen heraus, niemals Schlüsselmaterial", „in der Spalte steht ein Chiffrat, kein Klartext"; `datenbanksicherung` — „nennt in der Beschreibung niemals Benutzer oder Passwort"; `ueberwachung-vorlagen` — „kein CRON_SECRET auf dem Überwachungsrechner" | Reichweite der Geheimnisprüfung ist der verfolgte Bestand, nicht die Historie (diese einmalig am 2026-09-21) | Ablage der Produktionsgeheimnisse (`shared/.env`, GitHub-Umgebung) und gelebte Schlüsselrotation (`docs/KEY_MANAGEMENT.md`) — ausserhalb des Repositorys nicht einsehbar |
| PII | **PASS** | `protokoll-schwaerzung` — „ersetzt IBAN, AHV-Nummer und JWT im Freitext", „eine Änderung der Personalakte hinterlässt Schlüssel, aber keine Werte"; `ki-governance` — „ersetzt E-Mail, Telefon, IBAN, AHV-Nummer und Datenbankkennung"; `protokoll-und-schranken` — „der Personalvorschlag setzt keinen Namen in den Prompt"; `beobachtbarkeit` — „enthält keine Personenangaben"; `ki-nutzlast` — „nur aggregierte Daten: keine Kundschaft aus der Detailzeile, keine Namen, Codes, Gesundheit, Kontakt- oder Lohnangaben aus Freitext", „Frau/Herr, Anrede und Grussformel: der Name geht nicht hinaus — auch nicht an anderer Stelle im Text" | KI-Schwärzung ist seit F-15 (`4a18dba`) je Funktion ein Nutzlastbauer, bleibt aber eine Heuristik: Namen ohne Namensstelle und Codes ohne Schlüsselwort gehen hinaus — „sparsam, nicht anonym" (`docs/KI_GOVERNANCE.md` §3); geprüft sind die Bauer direkt, nicht die Routen | Auftragsverarbeitungsvertrag mit dem KI-Anbieter (rechtlich) |
| FILES | **PASS** | `datei-integritaet` — „gleichzeitige Übertragungen auf ein Ticket: genau eine gelingt, ausgeliefert wird, was geprüft wurde"; `datei-zugriff` — „eine fremde Datei antwortet genauso wie eine nicht vorhandene"; `dateisicherheit` — „die Dateipolitik greift schon beim Abschluss"; `sicherheitsluecken` — „die Adresse eines privaten Anhangs wird nicht zum Website-Bild", „der Upload einer anderen Person lässt sich nicht als Anhang binden"; `ablage-vertrag` — „veränderte Bytes im Bucket → „abweichung", keine Bytes (fail closed)", „die Bytes gehen mit Dienstschlüssel in den privaten Bucket; zurück kommen Pfad, Grösse und SHA-256 — keine öffentliche Adresse" | Profilbild der Personalakte (letzte Stelle, die eine `fileId` aus der Anfrage annimmt) ohne Umbindungsfall; der Supabase-Treiber ist nur gegen einen Nachbau geprüft, die Blob-Route mit Supabase nicht über HTTP | Lauf von `scripts/abnahme/supabase-ablage.ts` gegen einen echten, privaten Supabase-Bucket (E-8, F-09 c) — nur nötig, wenn Supabase eingesetzt wird (Schadsoftware: Zeile MALWARE) |
| TOKENS | **PASS** | `oeffentlicher-zugang` — „ein widerrufener Token wird abgewiesen", „ein abgelaufener Token wird abgewiesen"; `signatur` — „speichert nur einen Argon2id-Hash, zählt Versuche, sperrt den Neuversand und gilt einmal"; `mandanten` — „Offerte annehmen und ablehnen (QUOTE_RESPOND): 404 — Offerte und Signaturvorgang unverändert"; `protokoll-und-schranken` — „der rohe Token landet in keinem Protokolleintrag" | — | keiner |
| FINANCE | **PASS** | `nebenlaeufigkeit` — „fünf Entwürfe gleichzeitig ausgestellt — fünf verschiedene, lückenlos aufeinanderfolgende Nummern", „sechs gleichzeitige Gutschriften zu je 32.43 — genau drei, und nie mehr als die Rechnung"; `sicherheitsluecken` — „Betrag 0, negativ, unter einem Rappen und über dem offenen Saldo: 422, keine Zahlungszeile"; `zahlungsbuch` — „eine dreimal zugestellte Zahlung bucht einmal"; `geldrechnung` — „0.1 + 0.2: zwei Positionen ergeben genau 0.30"; `zahlungsbuch` — „eine Zahlung in EUR auf eine CHF-Rechnung wird nicht als CHF gebucht — Rechnung bleibt offen, Ereignis vermerkt, Büro gemeldet", „eine Rückerstattung scheitert bei Stripe — Stand, Saldo und Kundenwert kehren zurück, genau einmal über alle drei Ereignistypen", „Büro-Zahlung und Rechnungsstorno gleichzeitig — nie beides, und der Saldo passt zum Gewinner" | Büro-Zahlung gleichzeitig mit dem Stripe-Webhook derselben Rechnung nicht eigens geprüft | steuerliche Prüfung von Buchhaltungsexport und MWST (Treuhand); RB-009 Lohnprüfung durch eine Fachperson |
| BUSINESS INVARIANTS | **PASS** | `nebenlaeufigkeit` — „sechs gleichzeitige, sich überlappende Erfassungen derselben Person — genau eine wird angenommen", „dieselbe Kundschaft fünfmal gleichzeitig angelegt — eine Akte, die übrigen 409", „eine Anfrage sechsmal gleichzeitig umgewandelt — genau eine Kundschaft, überall dieselbe", „dieselbe Kontaktanfrage doppelt abgeschickt — eine offene Anfrage, beide Nachrichten daran", „Zuteilung und Bewilligung gleichzeitig — nie beides, fünfmal", „fünf Fassungen gleichzeitig hochgeladen — eindeutige, lückenlose Nummern, die höchste gilt"; `datenintegritaet` — „keine Regelverletzung in Finanzen, Nummern, Lager, Mandantenbezug, Annahmen und Zeiten"; `flows` — „Antworten gegen Abschliessen, fünf Runden: nach dem Abschluss steht keine Antwort mehr im Verlauf, jede Absage ist 422 ohne Nachricht", „die umgewandelte Anfrage von A in einer Offerte für B: 422, keine Offerte, die Anfrage bleibt gewonnen"; `cms` — „fünf gleichzeitige Freigaben desselben Entwurfs: genau eine Fassung und eine Protokollzeile", „zweimal veröffentlichen ohne Änderung: keine zweite Fassung, keine zweite Protokollzeile"; `automatisierungen` — „Status, Aufgabe, Meldung und Platzhalter treffen nur die auslösende Buchung — auch mit der Kennung einer anderen in der Konfiguration" | gleichzeitiges `moveJob` auf eine belegte Person; eine doppelt abgeschickte Nachrichtenantwort ergibt zwei Nachrichten (kein Idempotenzschlüssel); CRM-Bezug bei der Umwandlung in eine unpassende Akte; Automationen nur am Auslöser Buchung (Hinweise der Testmatrix) | keiner |
| AUDIT | **PASS** | `protokollpflicht` — „Rechnung mahnen (Tageslauf): Protokollzeile an Rechnung oder Mahnung, als System", „Zeit freigeben: UPDATE an genau dieser Erfassung, auffindbar über ihre Kennung", „Nachricht eröffnen (Kundschaft): CREATE am Verlauf, mit dem Kundenkonto als Person", „Anfrage umwandeln (bestehende Kundschaft): Protokollzeile, die Anfrage und Verwaltung nennt", „Text veröffentlichen: UPDATE, das den veröffentlichten Baustein nennt"; `zugriffsgrenzen` — „Einschalten schreibt einen Protokolleintrag und das Sicherheitsereignis TWO_FACTOR_ENABLED"; `protokollpflicht` — „Gastbuchung: CREATE an der Buchung, ohne Person", „Kontaktformular: CREATE an der neuen Anfrage, eine weitere Anfrage derselben Person UPDATE daran", „Offertablehnung über den Link: UPDATE an der Offerte, ohne Person, mit der Browser-Angabe"; `newsletter-links` — „der Klick bestätigt, entwertet den Token, protokolliert ohne Person — ein zweiter Klick ist 404" | Storno, Mahnung und Zeitfreigabe: nur das Vorhandensein der Zeile geprüft, nicht das gemeinsame Scheitern (F-14); Antworten und Abschliessen eines Nachrichtenverlaufs ohne Protokollfall | keiner |
| WEBHOOKS | **PASS** | `sicherheitsluecken` — „ohne stripe-signature: 400, keine Zahlung", „korrekt signiert, aber zehn Minuten alt: 400, keine Zahlung"; `kommunikation` — „Svix: gültig, falsches Geheimnis, veralteter Zeitstempel, manipulierter Text", „Twilio ohne Token oder ohne Signatur: abgewiesen"; `nebenlaeufigkeit` — „dasselbe Zahlungsereignis sechsmal gleichzeitig zugestellt — eine Zahlung, einmal Kundenwert"; `release-center` — „ohne Token, ohne gültige Signatur, mit alter Zeit oder anderem Pfad: 401 — nichts übernommen"; `zahlungsbuch` — „eine korrekt signierte Zahlung auf die Rechnung einer fremden Organisation bucht nichts, wird vermerkt, gemeldet und nicht endlos wiederholt" | — | echte Anbieterzustellung an die Produktionsadresse: Stripe-Webhook-Geheimnis und abonnierte Rückerstattungsereignisse (`refund.updated`/`refund.failed`/`charge.refund.updated`), Twilio mit echtem Konto (`docs/KOMMUNIKATION.md`) |
| DEPENDENCIES | **PASS** | `npm audit --omit=dev --audit-level=critical` in `verify:static` und im CI-Lauf 36319443611; `sicherheitsbewertung` — „critical blockiert immer, auch mit Bewertung", „sind höchstens ${HOECHSTFRIST_TAGE} Tage befristet"; fremde Aktionen auf Commits festgelegt (`docs/GITHUB_GOVERNANCE.md`) | hohe Befunde sind bewertet und befristet (Warnung ab 2026-12-01, Blockade ab 2027-01-01) | keiner |
| ERROR HANDLING | **PASS** | `zugriffsgrenzen` — „Kundschaft: GET /api/messages/:id auf den Verlauf einer anderen Kundschaft → 404 (wie „nicht vorhanden", C19), ohne Inhalt"; `datei-zugriff` — „eine fremde Datei antwortet genauso wie eine nicht vorhandene"; `beobachtbarkeit` — „eine abgewiesene Anfrage nennt die Kennung nicht im Rumpf", „auch ohne Anmeldung und auch bei einem Fehler"; `scan` — „kaputte Codes, Steuerzeichen und Markup: 200 ohne Treffer, nie ein Fehler 500"; `nebenlaeufigkeit` — „dieselbe Kundschaft fünfmal gleichzeitig angelegt — eine Akte, die übrigen 409" | Meldungstext von P2002 (ohne Feldnamen) und 409 bei Verklemmung (`40P01`/`40001`/`P2034`) stehen im Code (`src/lib/api/response.ts`), aber keine Prüfung erzwingt eine Verklemmung oder liest den Meldungstext | keiner |
| CI | **PASS** | CI-Lauf 36319443611 grün, Auslieferungsauftrag übersprungen; `verify:release` an 5760e88 und 34b3484 grün (Abschnitt oben); `react-hydrationskorrektur` — „--pruefen meldet eine fehlende Korrektur mit Exit 1 und schreibt nichts"; `pruefbilanz` — „ein übersprungener Fall (TAP) ist ein Fehlschlag — auch ohne gescheiterten Fall und mit Exitcode 0" | — (Bilanz der Browserreihe seit `fb0202e` und nachgezogen: `browserBilanzPruefen`, geprüft in `pruefbilanz` — „ein übersprungener Browserfall ist ein Fehlschlag — auch wenn alle übrigen bestehen") | Sichtbarkeit des Repositorys — Entscheid der Inhaberschaft (E-9, `docs/GITHUB_GOVERNANCE.md`); `main` ist seit 2026-09-27 durch den Regelsatz „main schützen" (ID 24071027, aktiv) geschützt; der Auslieferungsauftrag ist nie gelaufen |
| MONITORING | **PASS** | `beobachtbarkeit` — „jeder Lauf hinterlässt ein Protokoll — mit Dauer, Teilaufgaben und ehrlichem Statuscode", „ein ausgebliebener Lauf ergibt 503 und genau einen Alarm", „der Statusendpunkt verlangt das Geheimnis und nennt keine Inhalte"; `sicherheitsberichte` — „ein grüner Bericht, der zu alt ist, heisst „Ausgeblieben""; `ueberwachung-vorlagen` — „nur lesende Anfragen an die Anwendung — ausser dem einen Bericht" | `ops/security-monitor/*.sh` nur statisch gegen den Vertrag geprüft, nie ausgeführt | Überwachungsrechner aufsetzen, `shellcheck`, Probelauf, Alarmwege (E-4); externer Dienst, der `/api/cron/status` abfragt (RB-014) |
| BACKUP | **PASS** | `datenbanksicherung` — „bei einer Datenbank, die es nicht gibt", „löscht die neue Sicherung nie — auch nicht bei einer Obergrenze von null", „findet die drei Teilindizes der Signaturmigrationen"; `sicherheitsberichte` — „… liest aber den Betriebszustand für die Überwachung: Läufe, Schadsoftwareprüfer, Sicherung, Wiederherstellung" | Wiederherstellungsprobe `scripts/db-restore-verify.ts` nur örtlich gelaufen | BK-1…BK-7, RS-1…RS-3, MO-1…MO-3 (`docs/BACKUP_DR.md` §6), B-DR-1…3, RPO/RTO-Entscheid der Geschäftsleitung (E-5, E-8) |
| MALWARE | **PASS** | `dateisicherheit` — „erkennt EICAR auch eingebettet", „eine erkannte Datei wird angenommen, aber nicht ausgeliefert", „auch die Systemverantwortung bekommt eine erkannte Datei nicht", „verweigert den Dienst in einer echten Produktionsumgebung"; `clamd-protokoll` — „ein Dienst, der nicht antwortet, endet im Zeitlimit — nicht in „sauber"", „eine unverständliche Antwort gilt nie als sauber" | `clamd` nur als Nachbau | Abnahme gegen einen echten `clamd` in zwölf Schritten (`docs/MALWARE_PROTECTION.md` §10; E-3, RB-013) |

**Zählung:** CODE 22 PASS / 0 FAIL. EXTERNER NACHWEIS erforderlich in 10
Bereichen (RATE LIMIT, SECRETS, PII, FILES, FINANCE, WEBHOOKS, CI,
MONITORING, BACKUP, MALWARE), „keiner" in 12. Die Testmatrix hat seit der
dritten Nachprüfung keine Lücke mehr; die Prüflücken hier sind die Hinweise
von Test- und Sicherheitsmatrix, je Bereich eingeordnet; N-08 (CI) ist inzwischen geschlossen.
Keine davon ist ein bekannter Fehler.

Was diese Matrix nicht sagt: dass Clenaris sicher ist. Sie sagt, welche
Regel dieses Standards durch welche Prüfung belegt ist — und wo die Prüfung
aufhört.
