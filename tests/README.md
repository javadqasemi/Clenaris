# Prüfungen

Die Tests fahren die **laufende Anwendung** über echtes HTTP an. Es gibt keine
Unit-Tests der Dienste, und das ist eine Entscheidung, keine Lücke: Geprüft
werden Berechtigungen, Statuscodes, Cookies und ausgeliefertes HTML — also
genau die Schichten, die ein direkter Funktionsaufruf überspringt. Ein Test,
der `createBooking()` aufruft, sagt nichts darüber, ob der Endpunkt davor die
Rechte prüft, und die Rechteprüfung ist hier das Wesentliche.

Ausgeführt wird mit dem Testläufer von Node (`node:test`) über `tsx`. Keine
zusätzliche Abhängigkeit, keine Konfigurationsdatei.

## Die Datenbanken sind getrennt — und das ist keine Förmlichkeit

| Umgebung | Zweck | Demo-Seed | Zurücksetzen |
|---|---|---|---|
| **Produktion** | echte Daten | nie | nie |
| **Entwicklung** (`clenaris`) | örtliches Arbeiten im Browser | nein | von Hand, bewusst |
| **Test** (`clenaris_test`) | die Prüfreihe | ja | jederzeit (`--frisch`) |
| **CI** | ein Lauf, dann weg | ja | mit dem Container |

Warum die Prüfungen nicht mehr gegen die Entwicklungsdatenbank laufen sollen,
hat zwei Gründe, und beide haben einmal Geld gekostet:

**Rechnungsnummern sind endlich.** Der Demo-Seed und `flows.test.ts` stellen
Rechnungen aus. Deren Nummern zieht `NumberSequence`, und die Folge muss nach
Art. 957a OR lückenlos sein. Eine im Test vergebene `RE-2026-00042` lässt sich
nicht zurückgeben — deshalb steht weiter unten auch, dass eine ausgestellte
Rechnung stehen bleibt. In einer eigenen Datenbank ist die Folge eine eigene,
und die Frage stellt sich nicht mehr.

**Die Prüfungen verändern den Bestand.** Sie legen an, ändern, setzen die
Rolle der Betriebsleitung kurzzeitig herab. Wer daneben im Browser arbeitet,
sieht Zustände, die er nicht erzeugt hat, und sucht Fehler, die keine sind.

Ein Schutzschalter (`prisma/seed-guard.ts`) bricht den Demo-Seed ab, sobald
die Zieldatenbank nicht als Testdatenbank erkennbar ist. Er lässt sich mit
`ALLOW_DEMO_SEED=ja` übersteuern — bewusst, laut und einzeln.

## Voraussetzungen

1. **Testdatenbank einrichten** — einmal, danach nur bei Schemaänderungen:

   ```
   npm run db:test:setup             # legt <name>_test an, migriert, seedet
   npm run db:test:setup -- --frisch # wirft sie vorher weg
   ```

   Das Skript leitet die Adresse aus `DATABASE_URL` ab (derselbe Server,
   Name mit `_test`), weigert sich, wenn der Zielname nicht nach Testdatenbank
   aussieht, und rührt die Entwicklungsdatenbank nicht an. `TEST_DATABASE_URL`
   übersteuert die Adresse.

   Es seedet mit den **Demo-Zugangsdaten**, nicht mit denen aus Ihrer `.env`.
   Sonst hinge die Reproduzierbarkeit der Prüfungen daran, wie die jeweilige
   Maschine konfiguriert ist — und genau das ist einmal passiert: Wer in
   seiner `.env` ein eigenes `SEED_ADMIN_PASSWORD` gesetzt hatte, sah rund
   vierzehn Dateien an „E-Mail-Adresse oder Passwort ist falsch" scheitern und
   suchte den Fehler im Produkt.

2. **Server gegen die Testdatenbank starten**, auf einem eigenen Port, damit
   der Entwicklungsserver auf 3000 weiterlaufen kann:

   ```
   npm run build          # einmal nach Codeänderungen, bei gestopptem Server
   npm run test:server    # Port 3001; PORT=3002 für einen anderen
   ```

   `scripts/test-server.ts` leitet die Adresse der Testdatenbank ab (wie
   `db:test:setup`), verweigert jeden Namen, der nicht nach Testdatenbank
   aussieht, und legt die Umgebung fest, in der die Reihe die Anwendung
   sieht — **deterministisch, nicht aus der persönlichen `.env`**:

   - `TRUSTED_PROXY_MODE=NONE`: Vor dem Testserver steht kein Proxy, also
     tut die Anwendung nicht so, als stünde einer da. Alle Aufrufer teilen
     sich damit den Adressschlüssel `unbekannt`.
   - `CLENARIS_TEST_CACHE_DIR`: Die Rate-Limit-Zähler liegen als Dateien im
     Temp-Verzeichnis. `loginAll()` leert sie beim Start jeder Datei
     (`helpers/rate-limit.ts`), und `rate-limit.test.ts` prüft die Limits
     selbst gegen die unveränderten Werte. Ein Server ohne die Variable
     funktioniert weiterhin — die Reihe wartet dann Fenstergrenzen ab und
     überspringt `rate-limit.test.ts`.

   Der Entwicklungsserver (`npm run dev`) geht auch, ist aber langsamer und
   liefert Seiten teils anders aus als der Produktionsbau — geprüft werden
   sollte, was ausgeliefert wird.

   **Prüfen Sie, welche Datenbank der Testserver bedient**, bevor Sie die
   Reihe starten. Der billigste Nachweis: `admin@clenaris.ch` mit
   `Admin#2026Clenaris` anmelden. Geht das auf 3001 und nicht auf 3000, sind
   die beiden getrennt.

3. **Die Reihe dagegen fahren:**

   ```
   $env:TEST_BASE_URL = 'http://127.0.0.1:3001'
   npm test
   ```

## Ausführen

```
npm test                  # alles
npm run test:api          # nur die Endpunkte
npm run test:pages        # nur die ausgelieferten Seiten
npx tsx --test tests/api/two-factor.test.ts    # eine einzelne Datei
```

## Was wo geprüft wird

| Datei | Gegenstand |
|---|---|
| `api/rbac.test.ts` | Die Rechtematrix über alle fünf Rollen, der Rundlauf eines Handlungsaufrufs, die Fachregeln des Papierkorbs, der Selbstschutz der Rechteverwaltung |
| `api/two-factor.test.ts` | Einrichtung, zweistufige Anmeldung, Wiederherstellungscodes, Ausschalten, Zurücksetzen von aussen, sofort wirksamer Sitzungswiderruf |
| `api/flows.test.ts` | Die Wege, die Geld erzeugen: Anfrage → Kundschaft → Offerte → Rechnung → Dokument; dazu der Nachrichtenverlauf, der Zugriffsschutz und die Online-Buchung (Personal muss die Kundschaft angeben, ein Kundenkonto bucht auf das eigene Profil) |
| `api/cms.test.ts` | Redaktion und Suchmaschinenangaben — ändern, auf der Website nachsehen, zurücksetzen |
| `api/catalog.test.ts` | Ob eine Katalogänderung die statisch erzeugten Seiten und die Preisberechnung erreicht |
| `api/website-ops.test.ts` | Fragen, Galerie, Navigation, Rechtstexte, Einsatzgebiet, Stellen, Automatisierungen, Firmendaten |
| `api/ownership.test.ts` | Mit *wessen* Daten ein Endpunkt antwortet: Objekte je Rolle, Rollenvergabe über die Personalakte, Herkunftsprüfung, Platzhalter im HTML |
| `api/session-refresh.test.ts` | Stille Sitzungserneuerung: Seitenaufruf ohne Zugangstoken geht zur Erneuerung, nicht zur Anmeldung; neue Cookies und Rücksprung; verbrauchter Token sperrt; kein fremdes Ziel |
| `api/employees.test.ts` | Personal: Rechte je Rolle, Anlegen (Datum als JJJJ-MM-TT, Doppel), Bearbeiten aller Felder samt `null` für geleerte, Eindeutigkeit von E-Mail und Personalnummer, Lohnhistorie, **Lohn-, AHV- und Bankfelder für die Betriebsleitung gesperrt** (lesen *und* schreiben), Rundlauf der verschlüsselten AHV-Nummer, Konto-Handlungen (Zugangslink, Passwortzwang, Sperre, Foto), Stilllegen |
| `api/jobs.test.ts` | Einsätze: bearbeiten (Rechte, Termin, Notiz leeren, Ende vor Beginn), Team mit mehreren Personen und Rollen, Materialverbrauch als Materialaufwand, Herleitung der Lohnkosten aus Team und Plan |
| `api/dispatch.test.ts` | Der Weg Buchung → Einsatz → Zuteilung: Erfassung im Büro (Rechte, serverseitiger Preis, fremde Kundschaft), `GET`/`POST /api/jobs` samt Mandanten- und Eigentümergrenzen, Eignungsprüfung beim Zuteilen (aktives Personal, bewilligte Abwesenheit blockiert, beantragte nicht, Überschneidung, Verschieben in die Ferien), Zugangsdaten am Objekt (nie in Liste oder Schnittstelle, nur auf dem Rapport der zugeteilten Person), keine doppelten Einsätze aus einer Buchung |
| `api/crud-audit.test.ts` | Feiertage als vollständige Datensatzart (Rechte je Rolle, anlegen, ändern, Doppel, löschen), Zurückziehen eigener Abwesenheitsanträge samt Fremdzugriff, Papierkorb-Seite und Wiederherstellen |
| `api/bi-fuehrung.test.ts` | Unternehmensführung: Rechtegrenzen je Rolle, Sichtbarkeit von Zielen und Dokumenten, die fachlichen Regeln (Genehmigung friert ein, Wirksamkeit erst nach Abschluss, abgelöste Tafeln bleiben), Berichte in drei Formaten |
| `api/purge.test.ts` | Datenbereinigung: Seite und Endpunkt nur für die Systemverantwortung, Vorschau je Bereich, Bestätigungssatz, unbekannte Bereiche, Kundschaft nur zusammen mit den Finanzen — die Sperren, nicht das Löschen selbst |
| `api/bi-rechenkerne.test.ts` | Abschreibung, Gesundheitswert, Budgetabweichung, Szenario und Perioden mit festen Zahlen — importiert Anwendungscode direkt, weil die Rechenkerne reine Funktionen sind |
| `api/verschluesselung.test.ts` | Feldverschlüsselung (AES-256-GCM): Rundlauf, frischer Initialisierungsvektor je Aufruf, Bindung ans Feld, erkannte Manipulation, Klartext-Altbestand bleibt lesbar — importiert ebenfalls direkt, aus demselben Grund |
| `api/zugriffstokens.test.ts` | Öffentliche Zugriffstokens, die reine Rechnung: 256 Bit aus dem CSPRNG, **kein gemeinsamer Präfix** (der Unterschied zu cuid, gemessen über 200 Werte), keine Wiederholungen, stabiles Einweg-Hashing — importiert direkt, weil sich Unerratbarkeit von aussen nicht beobachten lässt |
| `api/oeffentliche-links.test.ts` | Dieselben Links über HTTP: geratene und missgebildete Werte bekommen dieselbe nichtssagende Antwort, ein Offert-Token öffnet keine Rechnung, **vier gleichzeitige Annahmen ergeben genau eine** (der behobene Rennzustand), keine nachträgliche Ablehnung, Versand stellt einen Link aus, Altbestandslinks funktionieren weiter |
| `api/oeffentlicher-zugang.test.ts` | Der vollständige Weg von aussen: **der Versand stellt den Zweck aus, den die Routen erwarten** (die Lücke, an der Gate 1 scheiterte), `QUOTE_RESPOND` öffnet Seite und PDF, `QUOTE_VIEW` darf nicht antworten, `INVOICE_VIEW` nicht zahlen, `INVOICE_PAY` beides ansehen; Ressourcen- und Zweckbindung über Kreuz; abgelaufen, widerrufen, missgebildet; **alte cuid-Links öffnen ohne ausdrückliche Freigabe nichts und beantworten auch mit Freigabe keine Offerte**; Kundenkonto und Verwaltung kommen ohne Capability aus |
| `api/pdf-viewer-mathematik.test.ts` | Die Rechnung hinter dem PDF-Viewer: Zoomgrenzen und Stufen (1.37 → 1.5, nicht 1.62), „an Breite" mit Rand, „ganze Seite" bei Hoch- und Querformat, Seitenzahl im Dokument — importiert direkt, weil reine Rechnung; was im Browser passiert (Klick, Tastatur, Rendern), hat hier keinen Prüfstand |
| `api/pdf-auslieferung.test.ts` | Was der Viewer vom Server bekommt: PDF-Endpunkte mit `application/pdf`, `nosniff`, nie `public`, Dateiname, `%PDF-`-Signatur; der Content-Endpunkt der Dokumentfassungen mit `X-Document-Version`, `inline` nur für PDF, Kundschaft und Anonyme abgewiesen; die Einbettung auf den Seiten mit autorisierter Adresse und **ohne Ablagekennung**; PDF.js-Worker und wasm aus dem eigenen Ursprung |
| `api/stripe-rueckkehr.test.ts` | Was an Stripe geht: Die Rückkehradressen tragen **keinen** Clenaris-Token, keine Einsetzstelle und keinen Rechnungspfad mehr; die Erfolgsadresse nutzt Stripes eigene Sitzungskennung, die Abbruchadresse gar keine — importiert direkt, weil sich die übermittelten Werte ohne eingerichteten Stripe-Zugang über HTTP nicht beobachten lassen |
| `api/datei-integritaet.test.ts` | Die Byteprüfung beim Upload: PNG/JPEG/WebP/PDF werden angenommen, **HTML als PDF, JPEG als PDF, PDF als JPEG, GIF als PNG und Zufallsbytes nicht**, leere Dateien nicht; gleiche Bytes ergeben gleiche Prüfsumme, ein Byte Unterschied eine andere; der Abschluss ist die Grenze (ohne ihn kein Asset und kein Abruf), er ist wiederholbar und bei drei gleichzeitigen Aufrufen entsteht genau ein Asset; fremde Tickets sind tabu; **der Client kann weder Pfad noch Typ noch Grösse noch `isPublic` behaupten** |
| `api/datei-zugriff.test.ts` | Wer welche Datei bekommt: öffentliche Assets (Galerie, Teambild) ohne Anmeldung und mit langem Zwischenspeicher, private nur mit Sitzung und passender Rolle und nie `public`/`immutable`; **die Kennung der Ablage allein öffnet nichts** — der behobene Befund; fremde und nicht vorhandene Dateien antworten gleich, damit die Route kein Orakel ist; Kopfzeilen (`nosniff`, Content-Disposition, kein Einschleusen über den Dateinamen) |
| `api/lohnabrechnung.test.ts` | Die Beitragsrechnung mit festen Zahlen (Wave 9) — `Payslip` stand seit der ersten Migration im Schema, und kein Codepfad hat je eine Abrechnung erzeugt: AHV/ALV/UVG auf den Bruttolohn, der **koordinierte Lohn** in allen vier Fällen (unter der Eintrittsschwelle nicht versichert, Mindestbetrag fängt knappe Fälle auf, Regelfall, Kappung an der Obergrenze), die Altersbänder ab ihrem Anfang, **ohne Geburtsdatum keine Altersgutschrift** samt Begründung, die ALV-Grenze auf den Monat, ein wieder eingeführter Solidaritätsbeitrag, und dass die Summe die Summe der angezeigten Zeilen ist; dazu über HTTP: die Sätze entstehen beim ersten Zugriff, **über 50 % Arbeitnehmeranteil am BVG wird abgewiesen** (Art. 66 BVG), ein **laufender Monat** wird nicht abgerechnet, freigegebene Zeiten ergeben eine Abrechnung und offene werden gemeldet statt bezahlt, die Herleitung liegt bei, ein zweiter Lauf ist unbedenklich; die **Betriebsleitung sieht keine Löhne**, und für die eigene Person existiert ein unveröffentlichter Entwurf nicht |
| `api/zeiterfassung.test.ts` | Die Zeiterfassung als Lohngrundlage (Wave 8) — bis dahin gab es nur ein- und ausstempeln, `approved` wurde von keinem Codepfad je geschrieben, `timetracking:approve` von nichts geprüft: Die **Dauer rechnet der Server** (ein mitgeschicktes `minutes` bleibt wirkungslos), Ende vor Beginn, Pause so lang wie die Zeit und mehr als 24 Stunden werden abgewiesen (die Obergrenze fängt das vergessene Ausstempeln), **Überschneidungen derselben Person** ebenso — sie ergäben doppelten Lohn für dieselbe Stunde, eine anschliessende Zeit dagegen nicht; eine **freigegebene Zeit ist eingefroren** (Korrektur und Löschen → 422), nach dem Aufheben der Freigabe geht beides wieder, ein zweiter Freigabelauf überschreibt nichts; die Summe der Minuten hängt **nicht von der Seitengrösse ab**; ohne `timetracking:read_all` keine Liste, ohne `timetracking:approve` kein Erfassen für andere |
| `api/personalstammdaten.test.ts` | Qualifikationen und Arbeitszeiten (Wave 7) — beide wurden gelesen (Personalakte, Eignungsprüfung, Personalvorschlag) und liessen sich **nicht ändern**: Das Ersetzen als Ganzes (die zweite Liste löscht die erste, eine leere Liste löscht alle), doppelte Namen werden abgewiesen und benannt statt als 409 aus dem Index zu kommen, **zwei Fenster am selben Tag bleiben beide** (der geteilte Dienst, für den die Maske eine freie Liste ist), sich überschneidende Fenster werden abgewiesen (der Index deckt nur gleiche Startzeiten ab), Ende vor Beginn und unbrauchbare Uhrzeiten ebenso; Mitarbeitende und Kundschaft dürfen nichts setzen, und am Ende wird die Ausgangslage wiederhergestellt |
| `api/automatisierungen.test.ts` | Die Automatisierungsmaschine (Wave 6): die Bedingungssprache mit allen Vergleichen, `exists` als Unterscheidung von „kein Wert" und „leerer Wert", der gutmütige Vergleich von `"5"` und `5` (ein strenger liesse eine Regel stillschweigend nie greifen) und dass ein Zahlenvergleich auf Text `false` ergibt statt zu werfen; Vorlagen ersetzen und werten **nicht aus** (`{{#if}}` bleibt stehen), maskieren HTML auch bei eigenen Daten und melden fehlende Platzhalter; die Aktionskonfiguration weist Unvollständiges ab und nennt das Feld, lässt **nichts Finanzielles** als Statusziel zu, verlangt beim Webhook `https` und kennt keine freie Empfängeradresse; die Adressprüfung erkennt private Bereiche einschliesslich `169.254.169.254` und `::ffff:127.0.0.1` und weist **einen öffentlichen Namen ab, der auf die Rückschleife zeigt**; dazu über HTTP und mit Blick in `automation_runs`: **ein echter Geschäftsvorgang erzeugt genau einen Lauf** — die Prüfung, ohne die diese Wave nicht von ihrem Vorzustand zu unterscheiden wäre —, ein zweiter Lauf scheitert am Teilindex, eine abgeschaltete Regel erzeugt keinen, und eine Buchung mit neuer Adresse lässt genau **eine** Standard- und Rechnungsadresse zurück (der Produktfehler, den diese Reihe gefunden hat) |
| `api/beobachtbarkeit.test.ts` | Anfragekennung und Kennzahlen (Wave 5): die Routenvorlage macht aus `/api/jobs/clx…/team` ein `/api/jobs/:id/team` — **50 Datensätze ergeben eine Reihe, nicht fünfzig**; die Registrierung zählt Statusklassen und Dauer, das Quantil unterschätzt nie und antwortet über der letzten Klasse mit `null`, die Grenze von 500 Reihen hält und sagt es, und die Erhebung wirft auch bei Unsinn nicht; dazu über HTTP: **jede** Antwort trägt `X-Request-Id` — auch ohne Anmeldung und gerade bei 401 —, jede Anfrage eine eigene, eine **mitgeschickte wird nicht übernommen** (sie ist eine Behauptung wie `X-Forwarded-For`), `Server-Timing` nennt die Dauer; der Kennzahlenendpunkt öffnet sich nur der Systemverantwortung, zählt nachweislich mit, trägt **keine Datensatzkennung** in einer Reihe und keine Personenangabe in der Antwort; eine 500er nennt die Kennung im Rumpf, eine Absage ausdrücklich nicht |
| `api/schluesselrotation.test.ts` | Schlüsselrotation (Wave 4): das Format trägt eine **Schlüsselkennung**, die weder Präfix noch Teil des Schlüssels ist; ein unter A verschlüsselter Wert bleibt lesbar, wenn B aktiv wird, und trägt nach dem Umschlüsseln B's Kennung; fehlt der alte Schlüssel, **nennt die Meldung welcher** — und niemals einen Schlüssel selbst; mehrere ausgemusterte Schlüssel gleichzeitig, derselbe Schlüssel in beiden Variablen zählt einmal; die abgeleiteten Geheimnisse (Bestätigungscode, Unterzeichnungssitzung) werden unter **allen** Schlüsseln geprüft und nur mit dem aktiven geschrieben — sonst bräche eine Rotation mitten im Unterzeichnungsvorgang; dazu über HTTP und mit einem Blick in die Spalte: die Auszahlungs-IBAN liegt **verschlüsselt** im Ruhezustand und im Klartext in der Oberfläche, und die Aggregation über `hourlyRate` läuft weiterhin in der Datenbank — die Gegenprobe zur Entscheidung aus SEC-021 |
| `api/sicherheitszentrum.test.ts` | Das Sicherheitszentrum (Wave 3): der Ereigniskatalog als Tabelle — jede Art mit Kategorie, Schwere und **deutscher** Bezeichnung, die Bestätigungspflicht genau an `CRITICAL`, und die tragenden Einstufungen festgenagelt (Zweitfaktor aus, Kontosperre, Tokenwiederverwendung, Rollenwechsel und Schadsoftwarefund verlangen eine Entscheidung, ein einzelner Fehlversuch nicht); dazu über HTTP: **nur die Systemverantwortung** kommt an Strom und Seite, für alle anderen gibt es beides nicht und nichts scheint durch; die Ereignisse entstehen tatsächlich — Fehlversuch, geglückte Anmeldung, acht Fehlversuche bis zur Sperre samt Folgeversuch auf das gesperrte Konto und dem Aufheben der Sperre; **weder roher Token noch Hash noch Passwort** stehen im Strom oder im HTML (geprüft wird die ganze Antwort als Text, nicht Feld für Feld); bestätigen setzt Zeitpunkt und Person und **löscht nichts**, ein zweites Bestätigen überschreibt das erste nicht; die Filter zeigen, was draufsteht, und `nurOffen=false` ist ein Eingabefehler statt einer stillen Wahrheit |
| `api/dateisicherheit.test.ts` | Die Schadsoftwarekette (Wave 2): die Dateipolitik (gefährliche Endung **irgendwo** im Namen, makrofähige Office-Typen unabhängig von der Schreibweise, Archive, Endung gegen nachgewiesenen Typ, Vollständigkeit gegen `UPLOAD_PROFILES`); der Testprüfer mit EICAR — auch eingebettet — und den beiden Fehlerwegen, **und dass er sich in der Produktion ohne Prüfumgebung nicht erzeugen lässt** (im Kindprozess mit gesetzter Umgebung nachgewiesen); die Auslieferungssperre über alle Zustände × Herkünfte, Altbestand standardmässig gesperrt und nur bei exakt `CLENARIS_LEGACY_FILES=allow` frei; dazu über HTTP: eine saubere Datei ist abrufbar, eine EICAR-Datei schliesst mit 201 ab, ihre Bytes aber antworten 404 — **auch der Systemverantwortung**, verbotene Endungen scheitern schon an der Politik, und drei gleichzeitige Abschlüsse ergeben weiterhin genau ein Asset |
| `api/signatur-rechenkerne.test.ts` | Die reine Rechnung der Unterzeichnung: Adressermittlung je `TRUSTED_PROXY_MODE` (**gefälschte `CF-Connecting-IP` und `X-Forwarded-For` landen nirgends**), Positionsprüfung gegen die tatsächliche Seite, Erkennen von AcroForm-`/Sig`-Feldern und `/ByteRange`-Strukturen in einem programmatisch erzeugten PDF, Zustimmungstext und -hash, Sitzungscookie-Optionen — importiert direkt |
| `api/signatur.test.ts` | Der ganze Weg über HTTP: Rechte je Rolle, Anlegen bindet **Bytes** (Hash A aus dem Upload), Tausch nur im Körper und nur einmal sichtbar, Cookie eng (HttpOnly, Pfad `/api/public/signatures`), Antworten ohne 64-Hex-Wert, Fassung N bleibt gebunden nach N+1, Code: kein Klartext, Argon2, Versuche gezählt, Sperre, Einmaligkeit; Zustimmung serverseitig mit Snapshot und Hash; **vier gleichzeitige Abschlüsse ergeben genau einen**; manipulierte Originalbytes → 422 und `INTEGRITY_FAILED`; EMBEDDED mit sichtbarer Position und Signaturseite (B ≠ A), DETACHED lässt das Original unangetastet; Protokoll (C) nie gleich A oder B; Ereignisse lassen sich in der Datenbank weder ändern noch löschen (Trigger); Abbrechen widerruft Sitzungen sofort; Ablehnen terminal; Ergebnislink mit eigenem Zweck; Bereinigung mit Beweisen gesperrt; Wortlaut ohne QES/ZertES |
| `api/offertannahme.test.ts` | Die Offertannahme auf dem Signaturkern (Gate 4C), vom **tatsächlich versendeten** Link aus dem Postausgang: `ACCEPT` entscheidet nicht, sondern friert die Offerte als PDF ein (Hash A) und antwortet mit `/signieren#t=…`; getippt und gezeichnet je bis A/B/C und Ergebnislink; `REJECT` bleibt direkt und erzeugt keinen Vorgang; **vier gleichzeitige Annahmestarts ergeben einen Vorgang** (Teilindex), vier gleichzeitige Abschlüsse nehmen genau einmal an; Annahme gegen Ablehnung ergibt immer genau ein terminales Ergebnis, nie „abgelehnt **und** gültig unterzeichnet"; eine Änderung der Offerte bricht den offenen Vorgang ab und lässt den alten Snapshot bytegenau stehen; manipulierte Originalbytes → 422 und die Offerte bleibt offen; abgelaufene Offerte: kein Start, und läuft sie zwischen Start und Abschluss ab, gibt es kein COMPLETED ohne Annahme; Kundenkonto über Sitzung und Eigentümerschaft (`AUTHENTICATED_CUSTOMER` im Protokoll), fremde Offerte 404; Altbestand bleibt lesbar und bekommt keine erfundenen Beweise; `QUOTE_VIEW` darf ansehen, nicht annehmen, und keine Sitzung greift seitwärts; der rohe Zugang steht nur im Fragment und im Tauschkörper — nie in Pfad, Abfrage, HTML, Ereignis, Prüfprotokoll oder Offert-E-Mail |
| `api/vor-ort-abnahme.test.ts` | Die Abnahme auf dem übergebenen Gerät (Gate 4D) — der Fall, in dem zwei Personen hintereinander an **derselben** Sitzung sitzen: Start nur durch die tatsächlich zugeteilte Person und nur auf einem abgeschlossenen Einsatz; Rapport wird beim Start eingefroren (Hash A), der Kundenmodus sieht bytegenau A; während der Übergabe antwortet **jeder** angemeldete Endpunkt 423 — auch aus einem zweiten Tab, auch auf Seiten, und **auch nachdem das Zugangstoken gelöscht und erneuert wurde** (die Sperre steht in der Datenbank, nicht nur im Token); ein zweites Gerät derselben Person bleibt benutzbar (Bindung an die Rotationsfamilie); Rapportänderungen sind auch für die Verwaltung gesperrt, der Abbruch gibt sie wieder frei und lässt den alten Snapshot bytegenau stehen; manipulierte Originalbytes → 422 und `INTEGRITY_FAILED`; vier gleichzeitige Starts ergeben einen Vorgang und eine Sperre, vier gleichzeitige Abschlüsse nehmen genau einmal ab; ein abgesagter Einsatz wird nicht mehr abgenommen (kein COMPLETED ohne Abnahme); Ablehnung lässt das Gerät gesperrt; das Personal erscheint im Beweis nur als „Gerät bereitgestellt durch", nie als Unterzeichner, und kein Text behauptet QES, geprüfte Identität oder Vollmacht; Entsperren mit dem eigenen Passwort — dieselbe Rotationsfamilie vor- und nachher, fremdes Passwort und fremde Sitzung scheitern; Altbestand bleibt lesbar ohne erfundenen Beweis |
| `api/rate-limit.test.ts` | Die Rate-Limits gegen die echten Werte: Anmeldung 8 je Adresse → der neunte 429 mit `Retry-After` im Fenster; Schreibkontingent je **Benutzer** (die Verwaltung erschöpft 90, die Betriebsleitung nicht); Signaturtausch 20 je Adresse; nach dem kontrollierten Zurücksetzen beginnt das Kontingent neu, Sitzungen und Daten bleiben — braucht den dateibasierten Zähler aus `test:server`, sonst übersprungen |
| `api/protokoll-und-schranken.test.ts` | Was protokolliert wird und was eine Schranke hat: jeder Benachrichtigungsendpunkt mit `rateLimit`, die Ausstellung eines Zugangslinks im Prüfprotokoll (**ohne** rohen Token und ohne Hash), die Kennungen der zugeteilten Personen im Zuteilungseintrag, Objektänderungen protokolliert mit redigiertem Alarmcode, keine Klarnamen im KI-Prompt für den Personalvorschlag samt Rückübersetzung unbekannter Kürzel; dazu über HTTP: `/admin/protokoll` nur für die Systemverantwortung, für Administration und Betriebsleitung eine Umleitung ohne Inhalt |
| `api/auslieferung-absicherung.test.ts` | Der Auslieferungsweg als Text statt als Prosa: `SERVER_USER`, `DIRECT_URL` und der gepinnte Wirtsschlüssel fail-closed, kein `ssh-keyscan`, kein Rückfall auf `root`, `StrictHostKeyChecking=yes`, kein `secrets`-Kontext unter `environment.url`; **Pull Requests durchlaufen das Qualitätstor und liefern nie aus** (kein `pull_request_target`, `DEPLOY_ENABLED` fail-closed, das Qualitätstor ohne ein einziges Secret); die Client-Adresse nur aus `client-ip.ts`; die Muster der Geheimnis-Suche mit Tokengrenze — synthetische Schlüssel werden erkannt, `signature_requests…` nicht mehr, und die Prüfdatei löst die Suche nicht an sich selbst aus. Braucht weder Server noch Datenbank |
| `api/vertraege-rechenkern.test.ts` | Die reine Serienrechnung (Wave 10): Wochen-, Zweiwochen- und Monatsrhythmus, „alle n Wochen", **Vertragsbeginn zwischen zwei Serientagen** (der Fehler, den diese Reihe gefunden hat — der erste Termin wäre entfallen), Monatsletzter ohne Überlauf in Februar und Schaltjahr, Feiertagsbehandlung in allen vier Formen, Ausnahmen, Kündigungsfristen mit und ohne automatische Verlängerung; dazu die **Ortszeit**: 06:00 bleibt über beide Zeitumstellungen 06:00, die UTC-Stunde unterscheidet sich dabei um eine, und der Kalendertag rutscht nicht — importiert direkt, weil reine Funktionen |
| `api/vertraege.test.ts` | Verträge über HTTP (Wave 10): der Zustandsautomat samt unzulässiger Übergänge (es gibt kein `status`-Feld); **eine geltende Fassung ist unveränderlich** — Konditionen, Leistungsumfang *und* Einsatzplan enden je in 422, eine Ausnahme dagegen bleibt erlaubt; der **Versions-Schnappschuss am Einsatz** (ein Einsatz unter Fassung 1 zeigt nach Fassung 2 weiterhin auf 1); Idempotenz des Planers einschliesslich gleichzeitiger Läufe, Probelauf, Vier-Augen-Prinzip; die **Vertragsrechnung**: eine Periode ergibt genau eine Rechnung, der zweite Aufruf antwortet 200 statt 201, zwei gleichzeitige Läufe erzeugen einen Beleg, zwei Stichtage derselben Periode ebenfalls, eine ausgestellte Rechnung trägt die Fassung von damals auch nach einer Preisanpassung; Rechte und Sichtbarkeit für die Kundschaft |
| `api/qualitaet-rechenkern.test.ts` | Die reine Rechnung der Qualitätskontrolle (Wave 11): Gewichtung — und dass sich eine schlechte Note nicht durch viele gute Kleinigkeiten schönrechnen lässt (75 % gegen 42,9 % bei denselben Punkten); `weight: 0` als **„nicht beurteilbar"** statt als null Punkte; `null` statt 0, wenn nichts beurteilbar war; gekappte Fehleingaben statt Abbruch; die Toleranzgrenze in beide Richtungen; **kein Urteil ohne vereinbarten Zielwert**; Fälligkeit ab der letzten Kontrolle (wer früher kontrolliert, staut keine Termine auf); Reaktionsfrist als Kalender- und nicht als Arbeitszeit |
| `api/qualitaet.test.ts` | Die Begehung über HTTP (Wave 11): **der Server rechnet** — ein mitgeschicktes `scorePercent`, `outcome`, `targetScore` oder `status` prallt ab und die Werte entstehen aus den Positionen; der **Massstab ist ein Schnappschuss** und bleibt es über eine Fassungsänderung hinweg; abgeschlossen ist unveränderlich (Ändern, Verwerfen, zweiter Abschluss je 422), Korrektur nur über **genau eine** Nachkontrolle, und eine Nachkontrolle zu einem Entwurf gibt es nicht; kein Abschluss ohne beurteilbare Position; Fälligkeit mit und ohne vereinbartes Intervall, wobei ein Entwurf nicht als Kontrolle zählt; Mitarbeitende ohne Zugang; **die Kundschaft sieht nur abgeschlossene Begehungen der eigenen Objekte und nie die interne Notiz — geprüft an der Antwort als Text, nicht am Statuscode** |
| `pages/smoke.test.ts` | Antwortet jede Seite und jeder Endpunkt je Rolle? |
| `pages/tables.test.ts` | Läuft irgendeine Tabelle oder Liste aus ihrem Rahmen? |
| `pages/sorting.test.ts` | Wirkt die Sortierung — und überlebt sie das Blättern? |
| `pages/public-site.test.ts` | Ist jede öffentliche Seite verlinkt und erreichbar? |

## Die zweite Ebene: der Browser

Seit Gate 4D.1 gibt es daneben eine Browser-Reihe (`tests/e2e`, Playwright,
`npm run e2e`). Sie **ersetzt nichts** von der obigen Tabelle; sie beantwortet
die drei Fragen, die über HTTP grundsätzlich offenbleiben: Startet der
PDF.js-Worker unter der ausgelieferten CSP? Erzeugt eine Handbewegung auf dem
Unterschriftenfeld tatsächlich eine Unterschrift? Und hält die Gerätesperre
auch gegen zweiten Tab, Zurück-Taste, Neuladen, geschlossenen Tab und gelöschte
Cookies?

Sie läuft gegen denselben Testserver und dieselbe Testdatenbank. Einzelheiten
— und vor allem die Trennung zwischen dem, was empirisch bewiesen ist, und dem,
was nur emuliert wurde — stehen in `tests/e2e/README.md`.

## Grundsätze

**Die Prüfungen räumen hinter sich auf.** Was sie anlegen, entfernen sie; was
sie ändern, setzen sie zurück. Sie räumen ausserdem *vor* sich auf, wo ein
abgebrochener Lauf etwas hinterlassen haben könnte — ein 409 „gibt es schon"
sagt nichts über das Produkt.

**Sie laufen nacheinander, nicht nebeneinander** (`--test-concurrency=1`). Alle
Dateien teilen sich eine Datenbank und dieselben fünf Konten: Während
`two-factor.test.ts` die Rolle der Betriebsleitung kurzzeitig herabsetzt, sähe
`rbac.test.ts` daneben eine Betriebsleitung mit falschen Rechten und meldete
einen Fehler, den es nicht gibt. Parallelität wäre hier nicht schneller,
sondern unzuverlässig — der Lauf dauert dafür einige Minuten.

**Eine ausgestellte Rechnung bleibt stehen.** Art. 957a OR verlangt eine
lückenlose Nummernfolge. Was `flows.test.ts` ausstellt, bleibt in der
Testdatenbank; ein Test, der die Regel umginge, prüfte etwas anderes als die
Anwendung tut. Genau deshalb gehört das in eine Datenbank, die weggeworfen
werden darf.

**Ein 429 ist kein Fehlschlag.** Die Anmeldewege liegen hinter einem strengen
Limit. Eine Testreihe fährt sie schneller an, als ein Mensch es je täte, und
läuft hinein — das ist der Beweis, dass die Bremse greift. Der Klient in
`helpers/client.ts` wartet die vom Server genannte Zeit ab und macht weiter.

**Die 34 Fehlschläge vom 2026-09-20 — und warum sie nicht wiederkommen.**
Einmal scheiterte `website-ops.test.ts` komplett mit 401, in einem Lauf, der
eine Minute später grün war. Kein Produktfehler, sondern zwei Dinge, die
zusammenfielen: (1) Alle Dateien schreiben als dieselbe Verwaltung, und ihr
Kontingent `apiWrite` (90 je Minute, gezählt je Benutzer, im Serverprozess)
war nach `settings`, `signatur` und `two-factor` voll — `POST /api/faq`
bekam 429 mit `Retry-After: 36`. (2) Das Verwaltungs-Cookie stammte aus dem
Sitzungs-Cache eines *früheren* Laufs und war 14 Minuten 40 Sekunden alt;
während der Wartezeit lief das Zugangstoken (15 Minuten) ab, der wiederholte
Aufruf und alle folgenden Aufrufe der Datei bekamen 401. Belegt über die
Zeitstempel des Cache (Neuanmeldung der nächsten Datei exakt bei Ablauf).
Seither: `loginAs` verwirft Cookies mit weniger als fünf Minuten
Restlaufzeit, und `loginAll` leert die Zähler des Testservers zu Beginn jeder
Datei. Die Limits selbst sind unverändert; `rate-limit.test.ts` beweist sie.

**Nichts wird aus der Anwendung importiert, wo der Test genau das prüfen soll.**
`helpers/totp.ts` rechnet TOTP unabhängig aus dem RFC nach, statt
`src/lib/auth/totp.ts` aufzurufen. Sonst prüfte der Test dieselbe Funktion mit
sich selbst, und ein Fehler im Format käme in beiden Richtungen gleich heraus.

Die Dateien, die trotzdem direkt importieren, widersprechen dem nicht: Dort ist
der Gegenstand die Rechnung oder die Entscheidungstabelle selbst, nicht ihr Weg
durch die Anwendung. Ob eine Abschreibung stimmt (`bi-rechenkerne`), lässt sich
über HTTP nur mit einem Datenbestand prüfen, der die Rechnung verdeckt; ob ein
Chiffrat an seine Spalte gebunden ist (`verschluesselung`), lässt sich von aussen
überhaupt nicht beobachten; der Ereigniskatalog (`sicherheitszentrum`) ist eine
Zuordnungstabelle, und an manche ihrer Zeilen — Tokenwiederverwendung, fehlender
Prüfer — käme man über HTTP nur, indem man den Server beschädigt; ob ein
Zugangstoken unerratbar ist
(`zugriffstokens`), ist eine Aussage über eine Verteilung, nicht über eine
Antwort. `dateisicherheit` prüft beides nebeneinander und aus genau diesem
Grund: Die **Entscheidung**, welcher Zustand ausgeliefert werden darf, ist eine
Tabelle und wird als Tabelle geprüft — über HTTP käme man an die sechs Zustände
mal fünf Herkünfte nur mit erfundenen Datenbankzuständen heran. Die
**Durchsetzung** derselben Entscheidung wird daneben über HTTP geprüft, denn
dass eine Tabelle stimmt, heisst noch nicht, dass jemand sie fragt.

**Die Zugangsdaten in `helpers/accounts.ts` stehen im Klartext.** Sie sind
Demodaten aus `prisma/seed.ts` und gehören nie in die Nähe einer produktiven
Umgebung.
