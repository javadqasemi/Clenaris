# Prüfungen

Die Tests fahren die **laufende Anwendung** über echtes HTTP an. Es gibt keine
Unit-Tests der Dienste, und das ist eine Entscheidung, keine Lücke: Geprüft
werden Berechtigungen, Statuscodes, Cookies und ausgeliefertes HTML — also
genau die Schichten, die ein direkter Funktionsaufruf überspringt. Ein Test,
der `createBooking()` aufruft, sagt nichts darüber, ob der Endpunkt davor die
Rechte prüft, und die Rechteprüfung ist hier das Wesentliche.

Ausgeführt wird mit dem Testläufer von Node (`node:test`) über `tsx`. Keine
zusätzliche Abhängigkeit, keine Konfigurationsdatei.

## Voraussetzungen

1. Eine Datenbank mit den Demodaten:

   ```
   npm run db:deploy
   npm run db:seed
   ```

2. Ein laufender Server:

   ```
   npm run build
   npm run start:built
   ```

   Der Entwicklungsserver (`npm run dev`) geht auch, ist aber langsamer und
   liefert Seiten teils anders aus als der Produktionsbau — geprüft werden
   sollte, was ausgeliefert wird.

Läuft der Server woanders, setzen Sie `TEST_BASE_URL`:

```
$env:TEST_BASE_URL = 'http://localhost:4000'
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
| `api/flows.test.ts` | Die Wege, die Geld erzeugen: Anfrage → Kundschaft → Offerte → Rechnung → Dokument; dazu der Nachrichtenverlauf und der Zugriffsschutz |
| `api/cms.test.ts` | Redaktion und Suchmaschinenangaben — ändern, auf der Website nachsehen, zurücksetzen |
| `api/catalog.test.ts` | Ob eine Katalogänderung die statisch erzeugten Seiten und die Preisberechnung erreicht |
| `api/website-ops.test.ts` | Fragen, Galerie, Navigation, Rechtstexte, Einsatzgebiet, Stellen, Automatisierungen, Firmendaten |
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
Entwicklungsdatenbank; ein Test, der die Regel umginge, prüfte etwas anderes
als die Anwendung tut.

**Ein 429 ist kein Fehlschlag.** Die Anmeldewege liegen hinter einem strengen
Limit. Eine Testreihe fährt sie schneller an, als ein Mensch es je täte, und
läuft hinein — das ist der Beweis, dass die Bremse greift. Der Klient in
`helpers/client.ts` wartet die vom Server genannte Zeit ab und macht weiter.

**Nichts wird aus der Anwendung importiert, wo der Test genau das prüfen soll.**
`helpers/totp.ts` rechnet TOTP unabhängig aus dem RFC nach, statt
`src/lib/auth/totp.ts` aufzurufen. Sonst prüfte der Test dieselbe Funktion mit
sich selbst, und ein Fehler im Format käme in beiden Richtungen gleich heraus.

**Die Zugangsdaten in `helpers/accounts.ts` stehen im Klartext.** Sie sind
Demodaten aus `prisma/seed.ts` und gehören nie in die Nähe einer produktiven
Umgebung.
