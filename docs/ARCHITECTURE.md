# Architektur

Dieses Dokument erklärt, *warum* die Plattform so gebaut ist. Was sie kann,
steht im [README](../README.md); wie das Datenmodell aussieht, in
[DATABASE.md](./DATABASE.md); welche Endpunkte es gibt, in [API.md](./API.md).

---

## Der Rahmen

```
┌──── Eigener Server (Production V2): Nginx → Next.js unter PM2, Loopback ───┐
│                                                                            │
│  Middleware (Edge)          Route Handler (Node)      Server Components    │
│  ├ Rollen-Wegweiser         ├ defineRoute-Fabrik      ├ direkte Prisma-    │
│  ├ Sicherheits-Header       ├ Zod-Validierung         │   Abfragen         │
│  └ Sitzungsprüfung          ├ Rate-Limit              └ React.cache        │
│                             └ Fehlerabbildung                              │
│                                     │                                      │
│                             server/services/*  ← die gesamte Fachlogik     │
│                                     │                                      │
└─────────────────────────────────────┼──────────────────────────────────────┘
                                      │
      ┌───────────┬───────────┬───────┴────┬───────────┬───────────┐
   Postgres     Redis      Supabase      Stripe      Resend     Anthropic
   (Prisma)   (optional)   Storage      + TWINT      Twilio      Claude
```

Alles, was einen Zustand ändert, geht durch einen Dienst in
`src/server/services/`. Route Handler übersetzen HTTP in Aufrufe, Server
Components lesen direkt — schreiben aber nie.

Der Rahmen hiess hier lange „Vercel, Region fra1" — ein früherer Betriebsweg
(`docs/DEPLOYMENT.md`, „HISTORICAL — Vercel"); heute ist es ein eigener
Server hinter Cloudflare und Nginx. Die Middleware läuft weiterhin in der Edge-Runtime
von Next — das ist eine Eigenschaft von Next, nicht des Anbieters, und der
Grund, warum sie weder Prisma noch Node-Module benutzt (Entscheid 4).
Ausgeliefert wird nie ein Bau vom Server, sondern das in der CI gebaute und
geprüfte Artefakt (`docs/PRODUCTION_V2.md`): Ein zweiter Bau desselben
Commits wäre ein zweiter, ungeprüfter Baum.

---

## Die vierzehn Entscheide

### 1. Server Components zum Lesen, Route Handler zum Schreiben

Listen und Detailseiten fragen Prisma direkt in der Server Component ab. Das
spart den Umweg über eine API, die nur der eigene Client aufruft, und die
Daten kommen bereits fertig gerendert beim Browser an.

Geschrieben wird ausschliesslich über Route Handler. Dort — und nur dort —
sitzen Berechtigungsprüfung, Validierung, Rate-Limit und Prüfprotokoll. Wäre
Schreiben auch aus Server Actions möglich, gäbe es zwei Wege mit zwei
Sicherheitsniveaus.

React Query verwaltet nur das, was sich *während* des Betrachtens ändert:
Kalender, Preisvorschau, Nachrichten, Benachrichtigungen.

### 2. Eine Fabrik für alle Endpunkte

`src/lib/api/handler.ts` stellt `defineRoute`, `definePublicRoute` und
`defineCronRoute` bereit. Jeder Endpunkt deklariert, was er braucht:

```ts
export const POST = defineRoute({
  permissions: ['invoice:write'],
  body: createInvoiceSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => created(await createInvoice(…)),
});
```

Bei über fünfhundert Endpunkten (die genaue Zahl schreibt
`scripts/kennzahlen.ts` in die README) ist das der Unterschied zwischen
„jeder Endpunkt ist geschützt" und „die meisten sind es wahrscheinlich". Ein Endpunkt kann nicht
versehentlich ungeschützt bleiben, weil es keinen Weg gibt, einen zu schreiben,
ohne den Schutz zu deklarieren.

Der Typtrick dahinter: das Schema ist als `ZodType<Out, Def, unknown>` typisiert
statt als `ZodSchema<T>`. Nur so bekommt der Handler den *Ausgabe*typ — sonst
gälten Felder mit `.default()` im Handler weiterhin als möglicherweise
undefiniert.

### 3. Berechtigungen als flache Zeichenketten

`resource:action`, pro Rolle statisch aufgelöst (`src/lib/auth/rbac.ts`). Keine
Berechtigungstabelle, kein Datenbankzugriff bei jeder Prüfung, und die
Rechtevergabe lässt sich in einer Datei lesen.

Dazu kommt immer Eigentümerschaft: `booking:read_own` liest ausschliesslich die
eigenen Buchungen, und die Einschränkung steht in der Datenbankabfrage, nicht
in der Darstellung. Ausgeblendetes HTML ist im Netzwerkprotokoll trotzdem
sichtbar.

Erweiterbar bleibt es trotzdem: benutzerdefinierte Rollen wären eine andere
Auflösung hinter derselben `can(role, permission)`-Fassade.

### 4. Sitzungen in httpOnly-Cookies mit Rotationserkennung

Access-Token 15 Minuten, Refresh-Token 30 Tage, beide httpOnly. Für
JavaScript nicht lesbar — ein XSS-Fund erlaubt damit keinen Token-Diebstahl.
Signiert mit `jose`, weil das in der Edge-Runtime der Middleware läuft.

Vom Refresh-Token liegt nur der SHA-256-Hash in der Datenbank, dazu eine
Familien-ID. Wird ein bereits verbrauchter Token erneut vorgelegt, ist er
gestohlen: die gesamte Familie wird verworfen und alle Geräte fliegen raus.
Das ist unbequem — und genau richtig, denn der Alternativfall ist ein
Angreifer, der beliebig lange weiterarbeitet.

**Erneuert wird still, beendet wird nach Leerlauf.** Der Zugangstoken läuft
nach fünfzehn Minuten ab; erneuert wird er auf drei Wegen: die Middleware
schickt einen Seitenaufruf mit abgelaufenem Token über `GET /api/auth/refresh`
und zurück, der API-Klient wiederholt einen 401 nach einer Erneuerung, und ein
Aktivitätswächter im Rahmen der Anwendung erneuert vorbeugend, solange
gearbeitet wird. Der Refresh-Token lässt sich aber nur einlösen, wenn er
jünger ist als `SESSION_IDLE_TTL` (fünfzehn Minuten) — das Fenster wandert
mit jeder Erneuerung. Wer eine Viertelstunde nichts tut, wird abgemeldet und
sieht auf der Anmeldeseite den Grund; die dreissig Tage des Refresh-Tokens
sind nur noch die absolute Obergrenze.

**Sitzungscookies, ausser „Angemeldet bleiben" (seit 2026-09-28).** Ohne die
Wahl tragen beide Cookies keine Laufzeit und enden mit dem Browser; mit ihr
bekommt der Erneuerungscookie `JWT_REFRESH_TTL` und das Leerlauffenster
`SESSION_REMEMBER_IDLE_TTL`. Die Wahl steht signiert im Token (`rem`). Alle
Tabs teilen die Aktivität, zwei Minuten vor Ablauf warnt ein Dialog, und eine
Abmeldung erreicht jeden Tab. Das Schliessen des Browsers wird bewusst nicht
per `beforeunload` erkannt — Begründung und Grenzen in `docs/SITZUNG.md`.

Passwörter mit Argon2id über `@node-rs/argon2` (19 MiB, t=2, p=1, OWASP 2024).

Gegen fremd ausgelöste Anfragen (CSRF) stehen zwei Linien: `SameSite=Lax` auf
beiden Cookies, und in der Endpunkt-Fabrik eine Herkunftsprüfung — bei `POST`,
`PUT`, `PATCH` und `DELETE` muss ein mitgeschickter `Origin`-Kopf zu dieser
Anwendung gehören. Ohne Kopf (Tests, Cron, Webhooks) wird nicht geblockt; für
diese Klienten ist CSRF kein Vektor, sie tragen kein fremdgesteuertes Cookie.

### 5. Preise entstehen ausschliesslich auf dem Server

`src/lib/pricing/engine.ts` rechnet in sieben Stufen:

```
Grundpreis (Stunden / Fläche / Pauschal)
  + Zusatzleistungen
  + Anfahrt (nach Postleitzahl)
  × Preisregeln (Wochenende, Grösse, Dringlichkeit)
  − Abo-Rabatt (wöchentlich 15 %, 14-täglich 10 %, monatlich 5 %, quartalsweise 3 %)
  − Gutschein und Kundenrabatt
  = Mindestbetrag prüfen, MWST aufschlagen
```

Das Buchungsformular zeigt dieselbe Rechnung, ruft aber bei jeder Änderung
`/api/public/pricing/estimate` auf. Der Browser rechnet nie mit, was verrechnet
wird — er zeigt nur an, was der Server gerechnet hat. Die vollständige
Herleitung reist als `priceBreakdown` mit und wird an der Buchung gespeichert:
Wer in einem halben Jahr fragt, warum es 340 Franken waren, bekommt eine
Antwort.

Preisregeln tragen ihre Bedingung als JSON (`{"frequency":["WEEKLY"]}`,
`{"minSqm":150}`). Ein Wochenendzuschlag ist damit eine Datenänderung, keine
Auslieferung.

### 6. Belegnummern innerhalb der Geschäftstransaktion

`NumberSequence` wird per Upsert-Increment in derselben Transaktion erhöht wie
der Beleg entsteht. Bricht die Transaktion ab, ist auch die Nummer nicht
vergeben. Ein vorgezogener Zähler oder eine Postgres-Sequenz würde bei jedem
Rollback ein Loch reissen — und Art. 957a OR verlangt eine lückenlose Folge.

Deshalb vergibt auch erst das *Ausstellen* die Rechnungsnummer, nicht das
Anlegen des Entwurfs.

### 7. Finanzbelege sind fortschreibend

Eine ausgestellte Rechnung wird nie geändert und nie gelöscht. Korrekturen
entstehen als Gutschrift, Stornos ebenfalls. Empfängeranschrift, Bezeichnungen
und Ansätze stehen als Momentaufnahme im Beleg — zieht die Kundschaft um oder
ändert sich der Katalog, bleibt der Beleg lesbar, wie er ausgestellt wurde.

### 8. Schweizer QR-Rechnung von Hand gebaut

`src/lib/pdf/swiss-qr.ts` erzeugt den normierten 31-zeiligen SPC-Block der
SIX-Norm v2.3, inklusive rekursiver Modulo-10-Prüfziffer und Erkennung von
QR-IBAN (Institut 30000–31999). Der Zahlteil misst im PDF exakt 105 mm — das
ist die Perforationslinie, nicht Geschmackssache.

Die Bibliothekslage für Schweizer QR-Rechnungen ist dünn und teils veraltet;
die Norm dagegen ist knapp und eindeutig. Sie selbst umzusetzen war weniger
Aufwand als eine fremde Umsetzung zu prüfen.

### 9. PDFs mit `@react-pdf/renderer`, nicht mit Headless Chrome

Ein serverloser Kontext verträgt keine 300 MB Chromium. `@react-pdf/renderer`
ist ein reines JavaScript-Paket, kaltstartfähig und in derselben Sprache
geschrieben wie der Rest. Der Preis: kein volles CSS. Für Offerten, Rechnungen
und Einsatzberichte reicht das Flexbox-Modell.

Entschieden wurde das, als die Plattform noch serverlos laufen sollte. Auf
dem eigenen Server gilt es weiter: Ein Chromium je PDF-Anfrage wäre ein
zweiter Prozess mit eigenem Speicherhunger neben jedem PM2-Arbeiter, und er
müsste im Release-Artefakt mitreisen.

### 10. Dateien laufen am Server vorbei — geprüft werden sie trotzdem

Der Server stellt ein Upload-Ticket aus, der Browser lädt direkt zu Supabase
Storage. Das umgeht das 4.5-MB-Limit für Function-Bodies, spart Bandbreite und
hält den Upload auch bei zwölf Baustellenfotos schnell. Ohne Anmeldung sind nur
die Profile des Buchungs- und Bewerbungsformulars erlaubt.

**Der Preis dieses Entscheids war lange unbezahlt.** Wenn die Datei nie durch
die Anwendung läuft, sieht der Server sie nie — und bis Gate 2 sah er sie
tatsächlich nicht. `mimeType` und `sizeBytes` kamen aus dem Formular, `path`,
`url`, `scope` und `isPublic` standen frei im Körper von `POST /api/media`, und
alles davon wurde übernommen, wie es kam. Eine beliebige Datei als PDF
anzumelden kostete nichts.

Der fehlende Schritt heisst **Abschluss** (`POST /api/files/finalize`). Der
Upload-Weg bleibt wie er war; danach liest der Server das *gespeicherte* Objekt
einmal zurück, prüft die tatsächliche Grösse, die Signatur der ersten Bytes und
den angemeldeten Typ gegen das Profil des Tickets, bildet den SHA-256 und legt
erst dann das `FileAsset` an. Vorher existiert die Datei fachlich nicht: kein
Asset, keine Verknüpfung, kein Abruf.

Die Prüfung sagt nur, dass die Datei ist, was sie zu sein behauptet.
`Signatur gültig` ist nicht `Datei sicher` — ein PDF kann JavaScript und
eingebettete Dateien enthalten, und davon sieht man in den ersten acht Bytes
nichts.

### 10a. Zwei Dateiebenen, zwei Aufgaben

`StoredFile` ist die **physische** Ebene: Treiber (`LOCAL` oder `SUPABASE`),
Pfad, Bytes oder Speicherverweis, tatsächliche Grösse, Prüfsumme, Upload-Profil,
Ablauf. Es ist zugleich das Ticket — die Zeile entsteht beim Anfordern der
Adresse und ist die Aufzeichnung, gegen die der Abschluss prüfen kann, ob dieser
Pfad je genehmigt wurde. `FileAsset` ist die **fachliche** Ebene: Organisation,
Bereich, Beziehung zum Geschäftsobjekt, Dateiname, öffentlich oder nicht.

Die Trennung ist nicht historisch gewachsen, sie trägt: Die Berechtigung
entsteht ausschliesslich fachlich, über die Kette

```
StoredFile → FileAsset → FileScope/Fachobjekt → Rolle
```

`FileAsset.isPublic` ist die einzige Quelle der Public/Private-Entscheidung;
`StoredFile` trägt sie bewusst nicht, weil zwei Kopien derselben Aussage
auseinanderlaufen können. `FileAsset.checksum` ist eine Momentaufnahme von
`StoredFile.checksum` — beim Anlegen identisch, danach nie unabhängig geändert.

**Eine Kennung ist keine Berechtigung.** `GET /api/files/blob/:id` gab bis
Gate 2 jede Datei heraus, deren `cuid` jemand nannte, mit der Begründung, die
sei „nicht erratbar". Sie ist es nicht: Von 25 Zeichen sind acht der
Erstellungszeitpunkt, vier ein Zähler, vier ein pro Prozess konstanter
Fingerabdruck. Heute liefert die Route nur aus, was ein `FileAsset` hat — und
nur an den, der laut Fachbeziehung darf.

Extern geteilte Dateien sind keine dritte Speicherklasse, sondern ein
Zugriffsweg: Die Datei bleibt privat, und der `PublicAccessToken` aus Gate 1
autorisiert an der Fachroute. Eine zweite, schwächere Tür daneben gibt es nicht.

### 10b. PDFs werden im Browser gezeigt — die Berechtigung bleibt auf dem Server

Eine Komponente (`src/components/app/pdf-viewer.tsx`) für jede Stelle, an der
ein PDF erscheint: Rechnung und Offerte in Verwaltung und Kundenkonto, die
öffentlichen Seiten mit Capability-Link, die Dokumentfassungen der
Unternehmensführung. Sie bekommt eine bereits autorisierte Adresse und lädt
von dort; ob dahinter eine Sitzung, eine Eigentümerprüfung oder ein
`PublicAccessToken` steht, weiss sie nicht und darf es nicht wissen.
`canDownload` und `canPrint` blenden Schaltflächen aus — sie sind Bedienung,
keine Sperre. Wer die Bytes hat, kann sie kopieren; ein Viewer, der etwas
anderes verspräche, löge.

**Warum der Viewer die Bytes selbst holt** statt PDF.js die Adresse zu geben:
Erst so lässt sich unterscheiden, *warum* nichts erscheint. 403 ist etwas
anderes als 404, und beides ist etwas anderes als eine Datei, die PDF.js
nicht lesen kann. Eine gültige Signatur (Gate 2) heisst nicht, dass das
Dokument lesbar ist — was hier scheitert, wird als beschädigt gemeldet, nicht
als unbedenklich durchgereicht.

**PDF.js kommt aus dem eigenen Ursprung.** Worker, WebAssembly-Decoder,
CJK-Zeichensätze und Standardschriften liegen unter `/pdfjs/<Version>/`,
kopiert aus dem installierten Paket (`scripts/copy-pdfjs-assets.ts`, vor
`dev` und `build`). Kein CDN: Die Version muss exakt passen, die CSP bleibt
bei `'self'`, und kein Dritter erfährt, welche Dokumente hier angesehen
werden. Eine Quelle braucht PDF.js trotzdem: `'wasm-unsafe-eval'` in
`script-src` — seine JPEG-2000-, JBIG2- und Farbprofil-Decoder sind
WebAssembly, und der Worker bekommt die Richtlinie seiner eigenen Antwort.
`'unsafe-eval'` dagegen gibt es im Produktionsbau nicht mehr; die Richtlinie
entsteht in `src/lib/security/inhaltsrichtlinie.ts`, die Next-Phase
entscheidet, und nur der Entwicklungsserver bekommt `'unsafe-eval'`
(`docs/SECURITY_STANDARD.md` C6). Der Druck läuft über einen Rahmen mit
`blob:`-Adresse, deshalb `frame-src 'self' blob:`. `react-pdf` pinnt `pdfjs-dist` fest, deshalb gibt es keine zweite
Versionsangabe, die auseinanderlaufen könnte.

**Was ein hochgeladenes PDF hier nicht kann.** `enableScripting: false` —
eingebettetes JavaScript wird nicht ausgeführt; das ist die PDF.js-Vorgabe,
ausdrücklich gesetzt, damit sie niemand versehentlich kippt.
`isEvalSupported: false` — auch für PostScript-Funktionen in
Schriftprogrammen kein `eval`. Verknüpfungen aus dem Dokument öffnen mit
`noopener noreferrer nofollow` in einem neuen Fenster; Launch-Actions und
automatische Navigation setzt PDF.js nicht um.

**Die Fassung steht in der Adresse.** `?fassung=N` bei Dokumenten; der
Content-Endpunkt antwortet mit `X-Document-Version`. Gate 4 wird eine
Signatur an genau eine Fassung binden — ein Viewer, der stillschweigend „die
aktuelle" zeigt, wäre dafür die falsche Grundlage.

### 11. Zahlungen werden über den Webhook gebucht, nicht über die Rückkehr-URL

Wer den Tab nach der Zahlung schliesst, sieht die Rückkehrseite nie. Gebucht
wird deshalb im Stripe-Webhook: Signaturprüfung gegen den Rohkörper, dann eine
idempotente Buchung über die eindeutige `providerPaymentId`.

Schlägt die Verarbeitung fehl, antwortet der Endpunkt mit 500, damit Stripe
erneut zustellt. Eine stille 200 würde die Zahlung verlieren.

TWINT läuft über Stripe (`payment_method_types: ['twint']`) und steht in der
Auswahl an erster Stelle — bei Schweizer Privatkundschaft ist es das
meistgenutzte digitale Zahlungsmittel.

### 12. KI schlägt vor, führt aber nichts aus

Alle KI-Endpunkte liefern Entwürfe: Offertpositionen, E-Mail-Texte,
Berichtstexte, Antworten auf Bewertungen, Tourenvorschläge. Nichts davon wird
gespeichert oder versendet, bevor ein Mensch es gesehen hat.

Der Offertentwurf bekommt den Stundenansatz aus dem Leistungskatalog
mitgegeben: das Modell verteilt Aufwand auf Positionen, es erfindet keine
Tarife. Verwendet werden `claude-opus-5` für anspruchsvolle Aufgaben und
`claude-haiku-4-5` für schnelle, mit adaptivem Denken statt fester Budgets.
Der Website-Chat streamt über Server-Sent-Events.

### 13. Eine Regel entscheidet, wer eingeteilt werden darf

Ob eine Person zu einer bestimmten Zeit auf einen Einsatz darf, beantwortet
ausschliesslich `src/server/services/assignment.service.ts`.

Vorher gab es die Frage an fünf Stellen und vier verschiedene Antworten:
`assignJob` und `setJobTeam` prüften Doppelbelegung mit zwei wortgleichen
Kopien, `createJob` prüfte nur, ob die Person zum aktiven Personal gehört,
`moveJob` und `updateJob` prüften **gar nichts** — obwohl beide den Termin
unter einem bereits eingeteilten Team wegschieben können. **Abwesenheiten
prüfte keine der fünf Stellen**, und die Routendokumentation versprach genau
das seit jeher.

Die Regel unterscheidet zwei Schweregrade, weil nicht jeder Befund gleich
schwer wiegt:

| Befund | Verhalten |
|---|---|
| Person unbekannt oder nicht im aktiven Personal | blockiert |
| Bewilligte Abwesenheit | blockiert |
| Überschneidender Einsatz | blockiert |
| Beantragte, noch nicht entschiedene Abwesenheit | warnt |
| Ausserhalb der hinterlegten Arbeitszeit | warnt |

Gewarnt statt blockiert wird dort, wo die Sperre mehr kaputt machte als sie
verhindert: Ein unbeantwortetes Ferienbegehren darf die Planung nicht
aufhalten, und `Availability` ist eine Planungshilfe, keine Zusage — ein
Samstagseinsatz nach Absprache ist normal, und ihn zu verbieten hiesse, das
Büro zu zwingen, zuerst ein Stammdatum zu ändern.

Die Prüfung läuft **innerhalb der Transaktion**, in der auch geschrieben wird.
Vorher lag sie davor: lesen, entscheiden, später schreiben — zwei gleichzeitige
Zuteilungen sahen beide eine freie Person. Vollständig dicht wäre nur eine
Ausschlussbedingung in der Datenbank (`EXCLUDE USING gist`); der Fensterschluss
hier deckt den Fall ab, der in der Praxis auftritt: zweimal klicken.

Geworfen wird ein `BusinessRuleError` (422) mit maschinenlesbaren Kennungen in
`details.conflicts` — `EMPLOYEE_ABSENT`, `ASSIGNMENT_OVERLAP`,
`EMPLOYEE_NOT_ACTIVE`, `EMPLOYEE_NOT_FOUND`, `OUTSIDE_AVAILABILITY`,
`ABSENCE_REQUESTED` — und einem fertigen deutschen Satz als Meldung. Die
Gegenrichtung gilt ebenso: `decideAbsence` verweigert die Bewilligung, solange
im Zeitraum Einsätze zugeteilt sind. Erst umplanen, dann bewilligen.

### 14. Zugangsgeheimnisse verlassen den Dienst nur auf Anforderung

Der Alarmcode eines Objekts liegt verschlüsselt in der Spalte
(`src/lib/crypto.ts`). Entschlüsselt wird er an genau einer Stelle:
`getJobDetail` liefert ihn nur mit `includeAccessSecrets`, und die einzige
Seite, die das setzt, ist der Einsatzrapport im Mitarbeitendenportal — dort
steht die Person vor der Tür. Für Mitarbeitende hat dieselbe Funktion den
Einsatz zuvor bereits auf die eigenen Zuteilungen eingegrenzt; die
Entschlüsselung erbt die Schranke, statt sie ein zweites Mal zu formulieren.

Die Einsatzliste enthält das Feld gar nicht, und das Einsatzdetail der
Schnittstelle liefert es nicht mit. Vorher zog ein `property: true` die ganze
Objektzeile samt Chiffrat in jede Antwort — unlesbar zwar, aber in einer
Nutzlast, die es nicht braucht, hat es nichts verloren. Ins Prüfprotokoll
gelangt der Code nie; `src/lib/audit.ts` redigiert das Feld ohnehin.

---

## Querschnittsthemen

### Validierung an genau einer Stelle

Alle Zod-Schemas liegen in `src/lib/validation/`. Sie validieren zur Laufzeit,
erzeugen über `z.infer` die TypeScript-Typen der Fachlogik und speisen die
OpenAPI-Spezifikation. Drei Verwendungen, eine Quelle — eine Doku, die von der
Validierung abweichen *kann*, weicht früher oder später ab.

Route-eigene Schemas gibt es deshalb nicht mehr: auch `bodySchema` einer
einzelnen Route steht im Validierungsmodul und wird importiert.

### Fehler als Typen

`src/lib/errors.ts` definiert eine Klasse je Fehlerart mit Code und
HTTP-Status. `toErrorResponse` bildet sie zusammen mit Prisma- und
Zod-Fehlern auf den einheitlichen Umschlag ab.

`BusinessRuleError` liefert bewusst 422 und nicht 400: 400 gehört der
Eingabevalidierung. Teilten sich beide denselben Status, liesse sich nicht mehr
unterscheiden, ob die Eingabe falsch war oder der Vorgang im aktuellen Zustand
unmöglich ist — und genau das entscheidet, ob eine Wiederholung Sinn hat.

Nach aussen dringen nie interne Details; die Meldung ist deutschsprachig und
für die Anzeige gedacht.

### Rate-Limits mit optionalem Redis

Feste Zeitfenster, Schlüssel ist die Benutzer-ID bzw. die IP. Ohne `REDIS_URL`
greift ein prozesslokaler Speicher: in der Entwicklung völlig ausreichend, in
der Produktion pro Instanz statt global — die Klassen sind so bemessen, dass
auch das noch schützt.

Statt CAPTCHAs schützen öffentliche Formulare ein Honeypot-Feld und ein
strenges Limit. Ein CAPTCHA kostet jede ehrliche Anfrage Zeit und schliesst
Menschen mit Einschränkungen aus; ein Honeypot kostet niemanden etwas.

### Zeit und Geld

Zeitstempel als `timestamptz` in UTC, Anzeige in Europe/Zurich. Sommerzeit ist
im Kanton Bern real: ein Einsatz um 07:00 ist im März ein anderer Moment als im
Juli, und `DateTime` ohne Zone hätte das verschluckt.

Beträge als `Decimal(12,2)` — gespeichert **und gerechnet**. Fliesskomma hat
in einer Buchhaltung nichts verloren: Rechnungen, Gutschriften und Salden
(`src/lib/rechnungsbetraege.ts`), die Preis-Engine, die Auftragssummen und
die Lohnabrechnung rechnen seit 2026-09-27 mit `Prisma.Decimal`
(`src/lib/money.ts`: `produkt`, `prozentVon`, `summeZahl`) und runden einmal
kaufmännisch auf Rappen. Auslöser waren gemessene Rappenfehler: CHF 30.15 ×
1.5 Std. ergab binär 45.22 statt 45.23, AHV 5.3 % von CHF 1085.00 57.50 statt
57.51 (`tests/api/geldrechnung.test.ts`). `toNumber()` wandelt erst an der
Anzeigekante um. Auswertungen und Kennzahlen (`lib/bi`) rechnen weiterhin in
`number` — sie zeigen an, sie buchen nicht.

### Prüfprotokoll

Jeder ändernde Vorgang schreibt in `AuditLog`: wer, wann, an welchem Objekt,
mit Vorher-Nachher-Vergleich der geänderten Felder. Das verlangt das Schweizer
DSG bei Personendaten, und es ist das Erste, wonach man greift, wenn eine
Kundin fragt, warum ihr Termin verschoben wurde.

**Fortschreibend wie die Finanzbelege — und in der Datenbank erzwungen**
(seit 2026-09-30, Migration `20260930120000_protokoll_nur_anfuegen`, wie
schon `signature_events` und `stock_movements`). Ein Protokoll, das die
Anwendung ändern kann, beweist nur, was die Anwendung gerade behauptet.
UPDATE, DELETE und TRUNCATE auf `audit_logs` enden mit P0001. Drei
Ausnahmen, je eng gefasst: die Kaskade, wenn eine ganze Organisation
gelöscht wird; `ON DELETE SET NULL` von `userId`, wenn ein Konto gelöscht
wird (nur diese Spalte); und die Schwärzung von `changes`/`summary` unter dem
transaktionslokalen Schalter `clenaris.audit_schwaerzung`, den nur
`scripts/security/audit-schwaerzung.ts` setzt. P0001 wird bewusst nicht auf
einen HTTP-Status abgebildet: Ein feuernder Schutztrigger ist ein Fehler im
Code, kein Zustand, den eine Anfrage legitim erreicht. Die Grenze: Die
Datenbankrolle der Anwendung besitzt heute die Tabellen und könnte den
Trigger abschalten — das erkennt das Datenbanktor
(`scripts/datenbank-schranken.ts`), verhindern kann es erst eine getrennte
Eigentümerrolle (Betriebsentscheid, `docs/PENDENZEN.md` P2H-42).

### Unternehmensführung

Das Führungsmodul (`/admin/fuehrung`, Dienste `kpi`, `health`, `insight`,
`objective`, `budget`, `investment`, `scenario`, `governance`, `document`,
`knowledge`, `meeting`, `bi-report`, `bi-assistant`) folgt den Bauplänen in
`docs/bi/`. Vier Entscheide tragen es:

- **Der Kennzahlverlauf wird gespeichert, nicht gerechnet.** `KpiSnapshot`
  hält je Periode einen festgeschriebenen Wert samt Herleitung; die laufende
  Periode ist `provisional`. Eine live gerechnete Kurve schriebe die
  Vergangenheit um, sobald eine Buchung storniert wird. Die Rechner stehen in
  `KPI_CALCULATORS`, der Nachtlauf schreibt, die Seiten lesen nur.
- **Strategie, Ziel und Initiative sind ein Modell.** `Objective` mit
  Selbstbezug; die Roadmap ist eine Ansicht. Der Fortschritt kommt aus den
  Schlüsselergebnissen, bei denen ein Bezug auf eine Kennzahl die
  Selbsteinschätzung ersetzt.
- **Die Sichtbarkeit der Ablage steht in der `where`-Klausel.**
  `documentVisibilityWhere()` — `EMPLOYEE_PRIVATE` heisst Geschäftsleitung
  und betroffene Person, nie „alle Mitarbeitenden". Jeder Download landet im
  Prüfprotokoll.
- **Die KI liefert Entwürfe mit Begründung, Datenquelle und Vertrauensgrad.**
  Jede Antwort des Assistenten trägt die drei Felder; übernommen wird über
  die gewöhnlichen Endpunkte. Personendaten werden nicht übermittelt.

Die reinen Rechenkerne (Gesundheitswert, Abschreibung, Budgetabweichung,
Szenario, Perioden in Europe/Zurich) liegen in `src/lib/bi/` ohne
Datenbankzugriff und werden direkt geprüft (`tests/api/bi-rechenkerne.test.ts`).
Sie waren die erste Stelle, an der Prüfungen Code importieren; inzwischen
gibt es weitere reine Prüfungen (siehe „Was fehlt").

---

## Gestaltung

Die Oberfläche ist nicht generisch, sondern für diesen Betrieb entworfen.

**Farbe.** Ein glaziales Blaugrün als Leitfarbe — die Aare bei Bern — mit
Berner Gold als Akzent. Kein Reinigungsmittel-Türkis, kein
SaaS-Standardblau.

**Struktur.** Wiederkehrendes Element ist die *Protokollzeile*: Haarlinie plus
schmale Beschriftungsspalte, dem Schweizer Abnahmeprotokoll entlehnt. Sie
trägt Detailseiten, Preisherleitungen und Checklisten und macht Struktur
sichtbar, statt sie zu dekorieren.

**Typografie.** Bricolage Grotesque für Überschriften, Archivo für Fliesstext
und Zahlen — mit Tabellenziffern, damit Beträge in Spalten untereinander
stehen.

**Diagramme.** Die Palette wurde nicht nach Gefühl gewählt, sondern gegen
Helligkeitsband, Sättigungsminimum, Farbsehschwäche-Abstand und Kontrast
geprüft — in hellem und dunklem Modus. Beim Umsatz nach Leistung ersetzt eine
einfarbige Abstufung die kategoriale Palette, weil die Achsenbeschriftung die
Identität bereits trägt.

**Zurückhaltung.** Glas nur in Kopfzeile und schwebenden Leisten. Bewegung nur
dort, wo sie eine Handlung beantwortet — keine Einblendanimation pro Abschnitt.

---

## Was fehlt

Ehrlich benannt, statt stillschweigend übergangen:

- **Unit-Tests der Dienste.** Es gibt bewusst keine — geprüft wird die
  laufende Anwendung über echtes HTTP (`tests/`, Prüfungen zu Rechtematrix,
  Abläufen, Eigentümerschaft, Redaktion und ausgelieferten Seiten; siehe
  `tests/README.md`). Die reinen Rechenkerne, die hier früher als ungeprüft
  standen, haben inzwischen eigene Prüfungen mit festen Erwartungswerten
  ohne Server: Geldrechnung der Preis-Engine (`geldrechnung.test.ts`),
  QR-Referenz (`scan-kennung.test.ts`), die `*-rechenkern.test.ts`-Dateien
  (Verträge, Verfügbarkeit, Qualität, SEO, Besuchsmessung, Visitenkarte,
  Signatur) und die Werkzeuge des Release-Wegs (Artefakt, Identität,
  Rücksprung, Bauvergleich). Die Token-Rotation bleibt über HTTP geprüft
  (`session-refresh.test.ts`, `sitzung-leerlauf.test.ts`) — sie ist an
  Datenbank und Cookies gebunden, und ein Nachbau ohne beides prüfte die
  Attrappe.
- **Mehrsprachigkeit.** Datenmodell und Endpunkte kennen DE/FR/IT/EN, die
  Oberfläche ist ausschliesslich deutsch. Die Texte liegen noch inline, nicht
  in Wörterbüchern.
- **Mehrmandantenfähigkeit.** Das Schema trägt sie, die Auflösung nicht: die
  Organisation wird über einen festen Slug ermittelt. Für den Mehrmandanten-
  betrieb braucht es Auflösung über Subdomain plus Row-Level Security.
- **Buchhaltungsexport.** Erzeugt CSV im gängigen Format; eine geprüfte
  Schnittstelle zu Abacus oder Bexio besteht nicht.
