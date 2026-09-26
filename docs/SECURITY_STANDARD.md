# Sicherheitsstandard Clenaris

Stand 2026-09-26. **Verbindlich** für jede Änderung am Code, an der
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
  Im CI laufen zusätzlich Geheimnisprüfung, `npm audit` und die ganze
  Prüfreihe (`.github/workflows/deploy.yml`).
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

Nachweis: `rbac`, `ownership`, `crud-audit`, `suche`, `scan`,
`release-center`, `sicherheitszentrum`. Prüffragen: Welche Rolle darf das,
und woran scheitert eine andere? Gibt es einen Fall in `ownership.test.ts`,
wenn die Daten rollenbezogen sind?

## C3 Mandantentrennung

- **MUSS** jede Abfrage `organizationId` im `where` tragen — auch bei Zugriff
  über eine ID aus der URL (`findFirst({ where: { id, organizationId } })`,
  nie `findUnique({ where: { id } })` für Fachdaten aus einer Anfrage).
- **MUSS** eine fremde ID wie eine unbekannte behandelt werden (404 oder leere
  Antwort, keine unterscheidbare Meldung).
- **SOLL** jede neue Prüfreihe mit Fachdaten einen Fall gegen
  `fremdeOrganisation()` (`tests/helpers/testdb.ts`) enthalten.

Nachweis: `mandanten`, `suche`, `scan`, `datei-zugriff`. Prüffrage: Was
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

Nachweis: Musterprüfung in `security:check` (Kategorien `sql-unsafe`,
`prozess`, `eval`). Prüffrage: Kann ein Wert aus der Anfrage Teil eines
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

Nachweis: `auslieferung-absicherung`, `cms`, `scan` (E2E: Markup bleibt
Text). Prüffrage: Wo wird ein fremder Text als HTML, Adresse oder Stil
eingesetzt?

## C7 CSRF und Origin

- **MUSS** jede schreibende Anfrage durch `assertTrustedOrigin`
  (`src/lib/api/handler.ts`) laufen — sie steckt im Routenfactory, ein neuer
  Endpunkt bekommt sie automatisch.
- **MUSS** Sitzungscookies `HttpOnly`, `Secure` (ausser lokal), `SameSite=Lax`
  oder strenger bleiben.
- **MUSS** GET lesen. Kein GET, der schreibt — auch nicht „nur einen Code
  erzeugen" (Beispiel: die Etikettseite erzeugt keinen Code beim Aufrufen).

Nachweis: `auslieferung-absicherung`, `rbac`. Prüffrage: Schreibt dieser
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
- **MUSS** die Geheimnisprüfung `scripts/ci-secret-scan.sh` im CI laufen;
  sie ist massgebend. Lokal ohne Bash meldet `security:check` sie als
  „NICHT GEPRÜFT", nicht als bestanden.
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

Nachweis: `dateisicherheit`, `datei-integritaet`, `datei-zugriff`,
`clamd-protokoll`, `pdf-auslieferung`.

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

Nachweis: `zugriffstokens`, `oeffentlicher-zugang`, `oeffentliche-links`,
`signatur`, `offertannahme`.

## C14 Finanzielle Integrität

- **MUSS** Geld als `Decimal(12,2)` gespeichert und erst an der Anzeige mit
  `toNumber()` umgewandelt werden.
- **MUSS** Preise nur auf dem Server berechnet werden
  (`src/lib/pricing/engine.ts`); ein Preis aus dem Formular wird nie
  übernommen.
- **MUSS** eine Rechnung aus einer Buchung aus deren gespeicherter
  Herleitung entstehen (`rechnungsgrundlageAusBuchung`), nicht neu gerechnet.
- **MUSS** eine ausgestellte Rechnung unveränderlich sein; Korrektur per
  Gutschrift. Belegnummern lückenlos in derselben Transaktion (Art. 957a OR).
- **MUSS** Lagerbewegungen und Signaturereignisse nur anfügen (Trigger).

Nachweis: `finanzbelege`, `buchung-integritaet`, `datenintegritaet`,
`vertraege-integritaet`.

## C15 Fachliche Invarianten

- **MUSS** eine Invariante in der Datenbank erzwungen werden, wenn zwei
  gleichzeitige Anfragen sie brechen können: Teilindex, Sperre
  (`pg_advisory_xact_lock`, `FOR UPDATE`) oder eindeutiger Index — nicht die
  Oberfläche. Beispiele: eine offene Annahme je Offerte, ein aktiver
  Etikettcode je Datensatz, Kapazität je Organisation beim Buchen und
  Bearbeiten.
- **MUSS** eine handgeschriebene SQL-Regel (Teilindex, Trigger) in der
  Migration mit Begründung stehen; ein späteres `migrate dev`, das sie
  löschen will, wird abgelehnt.
- **MUSS** jede neue Invariante einen Gleichzeitigkeitsfall in der
  Prüfreihe haben (`Promise.all` zweier Anfragen → genau ein Erfolg).

Nachweis: `mehrere-leistungen`, `buchung-integritaet`, `scan`,
`release-center`, `offertannahme`.

## C16 Prüfprotokoll

- **MUSS** jede fachlich bedeutsame Änderung protokolliert werden
  (`audit.created/updated/deleted`, `src/lib/audit.ts`): wer, was, wann,
  ohne Geheimnis und geschwärzt.
- **MUSS** ein Protokoll keine Rohtokens, Etikettcodes, Passwörter oder
  vollständigen Personendaten enthalten.
- **SOLL** reines Lesen nicht protokolliert werden, ausser Downloads
  vertraulicher Dokumente und Exporte.

Nachweis: `protokoll-und-schranken`, `protokoll-schwaerzung`, `scan`.

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

Nachweis: `beobachtbarkeit`, `protokoll-und-schranken`.

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
