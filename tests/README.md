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

   ```powershell
   $test = 'postgresql://…/clenaris_test?schema=public'
   $env:DATABASE_URL = $test
   $env:DIRECT_URL   = $test
   npm run build                                    # einmal nach Codeänderungen
   node node_modules\next\dist\bin\next start -p 3001
   ```

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
| `pages/smoke.test.ts` | Antwortet jede Seite und jeder Endpunkt je Rolle? |
| `pages/tables.test.ts` | Läuft irgendeine Tabelle oder Liste aus ihrem Rahmen? |
| `pages/sorting.test.ts` | Wirkt die Sortierung — und überlebt sie das Blättern? |
| `pages/public-site.test.ts` | Ist jede öffentliche Seite verlinkt und erreichbar? |

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

**Nichts wird aus der Anwendung importiert, wo der Test genau das prüfen soll.**
`helpers/totp.ts` rechnet TOTP unabhängig aus dem RFC nach, statt
`src/lib/auth/totp.ts` aufzurufen. Sonst prüfte der Test dieselbe Funktion mit
sich selbst, und ein Fehler im Format käme in beiden Richtungen gleich heraus.

Die zwei Ausnahmen (`bi-rechenkerne`, `verschluesselung`) widersprechen dem
nicht: Dort ist der Gegenstand die Rechnung selbst, nicht ihr Weg durch die
Anwendung. Ob eine Abschreibung stimmt, lässt sich über HTTP nur mit einem
Datenbestand prüfen, der die Rechnung verdeckt; ob ein Chiffrat an seine Spalte
gebunden ist, lässt sich von aussen überhaupt nicht beobachten.

**Die Zugangsdaten in `helpers/accounts.ts` stehen im Klartext.** Sie sind
Demodaten aus `prisma/seed.ts` und gehören nie in die Nähe einer produktiven
Umgebung.
