# Architektur

Dieses Dokument erklärt, *warum* die Plattform so gebaut ist. Was sie kann,
steht im [README](../README.md); wie das Datenmodell aussieht, in
[DATABASE.md](./DATABASE.md); welche Endpunkte es gibt, in [API.md](./API.md).

---

## Der Rahmen

```
┌─────────────────────────── Vercel (Region fra1) ───────────────────────────┐
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

---

## Die zwölf Entscheide

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

Bei 96 Endpunkten ist das der Unterschied zwischen „jeder Endpunkt ist
geschützt" und „die meisten sind es wahrscheinlich". Ein Endpunkt kann nicht
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

Passwörter mit Argon2id über `@node-rs/argon2` (19 MiB, t=2, p=1, OWASP 2024).

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

### 10. Dateien laufen am Server vorbei

Der Server erstellt eine signierte Upload-Adresse, der Browser lädt direkt zu
Supabase Storage. Das umgeht das 4.5-MB-Limit für Function-Bodies, spart
Bandbreite und hält den Upload auch bei zwölf Baustellenfotos schnell.

Die Kontrolle bleibt beim Server: er bestimmt Profil, Pfad, Grössen- und
Typgrenze und legt den `FileAsset`-Datensatz erst *nach* dem Upload an. Ohne
Anmeldung sind nur die Profile des Buchungs- und Bewerbungsformulars erlaubt.

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

Beträge als `Decimal(12,2)`. Fliesskomma hat in einer Buchhaltung nichts
verloren; `toNumber()` wandelt erst an der Anzeigekante um.

### Prüfprotokoll

Jeder ändernde Vorgang schreibt in `AuditLog`: wer, wann, an welchem Objekt,
mit Vorher-Nachher-Vergleich der geänderten Felder. Das verlangt das Schweizer
DSG bei Personendaten, und es ist das Erste, wonach man greift, wenn eine
Kundin fragt, warum ihr Termin verschoben wurde.

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

- **Automatisierte Tests.** Es gibt keine Unit- oder Integrationstests. Die
  Prüfung erfolgte bisher über `tsc`, einen Produktionsbuild und Rauchtests
  gegen den laufenden Server. Die ersten Tests gehören in die Preis-Engine, die
  QR-Referenz-Prüfziffer und die Token-Rotation.
- **Mehrsprachigkeit.** Datenmodell und Endpunkte kennen DE/FR/IT/EN, die
  Oberfläche ist ausschliesslich deutsch. Die Texte liegen noch inline, nicht
  in Wörterbüchern.
- **Mehrmandantenfähigkeit.** Das Schema trägt sie, die Auflösung nicht: die
  Organisation wird über einen festen Slug ermittelt. Für den Mehrmandanten-
  betrieb braucht es Auflösung über Subdomain plus Row-Level Security.
- **Buchhaltungsexport.** Erzeugt CSV im gängigen Format; eine geprüfte
  Schnittstelle zu Abacus oder Bexio besteht nicht.
