# Hydration — der Befund aus Wave 9.1 und was daraus folgte

> Stand: 22. September 2026 · Zuverlässigkeitstor vor Wave 10.

---

## 1. Der Befund

Seit Wave 1 meldete die Browserreihe gelegentlich **19 von 20** — jedes Mal an
einer anderen Stelle, in verschiedenen Dateien, mit derselben Zeile:

```
pageerror: Minified React error #418  (args[]=HTML&args[]=)
  → Hydration failed because the server rendered HTML didn't match the client.
    As a result this tree will be regenerated on the client.
```

Danach lief die Reihe wieder mehrfach 20/20 durch. Beide Beobachtungen
stimmten, und keine war eine Aussage. `retries: 0` heisst: Ein solcher Zufall
macht die Auslieferung rot.

Wave 9 hat den Punkt als offen festgehalten und den Weg dorthin benannt, der
nicht gangbar war: Die Meldung ist im Produktionsbau minifiziert, und ein
Entwicklungsbau überschrieb dasselbe `.next`, in dem der Produktionsbau lag,
den die Reihe fährt.

---

## 2. Was zuerst gebaut wurde: Messbarkeit

Ein Fehler, der sich alle paar hundert Seitenaufrufe zeigt, lässt sich nicht
herbeirufen. Also musste der Lauf selbst mitschreiben.

| Werkzeug | Ort | Was es leistet |
|---|---|---|
| Hydrationswache | `tests/e2e/helpers/diagnose.ts` | Hängt an **jedem** Browserfall. Erkennt die React-Fehler 418/419/421/422/423/425 minifiziert wie im Klartext, sichert im Augenblick des Fehlers DOM-Abzug, Bildschirmfoto, Konsolen- und Netzbefunde, schreibt sie als Artefakt und lässt den Fall fehlschlagen |
| Redigierung | dieselbe Datei | Jeder Text läuft vor dem Schreiben durch `redigieren()`: 64-stellige Hexwerte (die Tokenform dieser Anwendung), `#t=`-Fragmente, JWT-förmige Zeichenketten, E-Mail-Adressen, lange Datenadressen. Ein DOM-Abzug der Unterzeichnungsseite wäre sonst ein Geheimnis, das den Umweg über einen Testlauf genommen hat |
| Verschiebbares Bauverzeichnis | `next.config.ts` (`NEXT_DIST_DIR`) | Entwicklungs- und Produktionsbau können nebeneinander stehen. Damit ist die Sackgasse aus Wave 9 aufgelöst |
| Diagnoseserver | `scripts/diagnose-server.ts`, `npm run diagnose:server` | Entwicklungsbau gegen die Testdatenbank auf Port 3002, eigenes Bauverzeichnis, eigenes Zählerverzeichnis. React meldet dort im Klartext |
| Diagnoselauf | `npm run e2e:diagnose` | Dieselben Fälle gegen diesen Server. **Ersetzt die Auslieferungsprüfung nicht** — ein Befund von dort wird am Produktionsbau nachgewiesen, nicht umgekehrt |
| Stressreihe | `npm run e2e:stress` | n vollständige Läufe, jeder gegen einen neu gestarteten Testserver, mit Tabelle und Bericht |

> **Eine Nebenwirkung, die man kennen muss:** Ein Bau mit `NEXT_DIST_DIR`
> schreibt `tsconfig.json` um — Next trägt dort die Typen des jeweiligen
> Bauverzeichnisses ein und formatiert die Datei dabei neu. Nach einem
> Diagnosebau gehört `git checkout -- tsconfig.json`, sonst wandert ein
> `.next-diagnose/types/**`-Eintrag in einen Commit, der nichts damit zu tun
> hat.

**Die Hydrationswache hängt bewusst an jedem Fall.** Vorher fiel ein
Hydrationsfehler nur dort auf, wo ein Fall ausdrücklich `konsole.keineFehler()`
aufrief — also in etwa der Hälfte. Genau deshalb sah der Befund über Waves
hinweg nach „mal hier, mal dort" aus: Er trat häufiger auf, als die Reihe ihn
meldete.

---

## 3. Die Messung

Reproduziert wurde ausserhalb der Testreihe, mit einem Skript, das dieselbe
Seite hunderte Male lädt und jede Browsermeldung mitschreibt.

| Umgebung | Seite | Ergebnis |
|---|---|---|
| Produktionsbau, Port 3001 | `/portal/einsaetze` | **2 von 30**, **1 von 40**, **2 von 200**, **7 von 400** |
| Produktionsbau | `/portal/profil` | **1 von 200** |
| Entwicklungsbau (Diagnoseserver) | `/portal/einsaetze` | 0 von 10, 0 von 8 — **der Entwicklungsbau zeigt ihn nicht** |
| Produktionsbau, CPU 8-fach gedrosselt | `/portal/einsaetze` | 0 von 8 |

Zwei Dinge sagen diese Zahlen sofort:

1. **Es ist ein Wettlauf**, kein Zustandsfehler. Drosselt man die CPU, ist er
   weg — nicht weil er behoben wäre, sondern weil die Hydration dann später
   beginnt als das letzte Stück des Datenstroms eintrifft.
2. **Der Entwicklungsbau kann ihn nicht zeigen.** Er ist zu langsam; dieselbe
   Verschiebung wie beim Drosseln. Damit war die Klartextmeldung, die ihn
   benannt hätte, grundsätzlich nicht erreichbar — eine Sackgasse, die man
   erst sieht, wenn man sie gemessen hat.

---

## 4. Die Ursache

Ermittelt mit drei Werkzeugen, die nacheinander nötig waren.

### 4.1 Reihenfolge — Reacts eigene Stromskripte abgefangen

React definiert die Funktionen `$RC` (Grenze vollständig), `$RS` (Abschnitt
vollständig) und `$RV` (einblenden) als globale Namen. Über
`Object.defineProperty(window, '$RC', { set })` liessen sie sich umhüllen und
mit Zeitstempel protokollieren:

```
 Fehlerhafter Lauf              Unauffälliger Lauf
 ────────────────────           ──────────────────
 444 ms  $RC ["B:0","S:0"]      366 ms  $RC ["B:0","S:0"]
 447 ms  $RV                    370 ms  $RV
 591 ms  FEHLER #418            556 ms  $RS ["S:2","P:2"]
 665 ms  $RS ["S:2","P:2"]      557 ms  $RC ["B:1","S:1"]
 666 ms  $RS → parentNode-Fehler 557 ms  DOMContentLoaded
 666 ms  DOMContentLoaded        558 ms  load
```

Im unauffälligen Lauf sind **alle** Einblendungen vorbei, bevor die Hydration
beginnt. Im fehlerhaften fällt eine mitten hinein.

### 4.2 Der Folgefehler, der wie ein zweiter Fehler aussah

```
TypeError: Cannot read properties of null (reading 'parentNode')
    at $RS (/portal/einsaetze:2:561228)
```

Das ist **keine** zweite Ursache. Nach dem 418er verwirft React den gesamten
Baum und baut ihn neu; dabei verschwinden die Platzhalter, die ein später
eintreffendes `$RS` sucht. Wer diesen Fehler zuerst untersucht, untersucht die
Folge.

### 4.3 Das DOM im Augenblick des Verwerfens

Ein `MutationObserver` mit `subtree: true` hält die **entfernten** Knoten fest.
Der Abzug, den React verworfen hat, liess sich damit Knoten für Knoten gegen
das ausgelieferte HTML halten:

```
 … identisch bis Knoten 250 (die gesamte Seitenleiste und Kopfzeile) …

 SERVER   : main#inhalt  <!--$?-->  <template id="B:0">  …"Übersicht wird geladen"…
 VERWORFEN: main#inhalt  <!--$-->   <!--$?-->  <template id="B:1">  …"Liste wird geladen"…
```

Der Rahmen war **zeichengleich**. Der Unterschied sitzt genau dort, wo
`loading.tsx` eine Suspense-Grenze anlegt: Die äussere Grenze war zwischen dem
Ausliefern und der Hydration von *wartend* auf *eingeblendet* gewechselt.

### 4.4 Reacts Einblendung, aus dem ausgelieferten HTML gelesen

```js
$RC = function (a, b) {
  if (b = document.getElementById(b))
    (a = document.getElementById(a))
      ? (a.previousSibling.data = "$~",            // sofort: „bereit, noch nicht sichtbar"
         $RB.push(a, b),
         2 === $RB.length && (…setTimeout($RV, $RT + 300 - jetzt)…))   // erst später sichtbar
      : b.parentNode.removeChild(b);
};
```

Die Einblendung ist **absichtlich gedrosselt**: Reacts Fenster von rund 300 ms
verhindert, dass ein Skelett für einen Wimpernschlag aufblitzt. Genau diese
Verzögerung schiebt den DOM-Umbau in das Zeitfenster, in dem die Hydration
läuft. `$RV` entfernt dann die Ersatzknoten und setzt neue ein — unter einem
Baum, den React gerade abläuft.

**Das ist ein Fehler in der React-Fassung, die Next 15.5.25 mitbringt**
(`19.2.0-canary-0bdb9206-20250818`; die in `package.json` stehende 19.0.0 wird
im App-Router nicht verwendet — der Auslieferungsbündel trägt die Canary-Nummer).
Die Anwendung kann ihn nicht beheben, nur meiden. Ein Versionswechsel war keine
Abhilfe: 15.5.25 **ist** die letzte 15.5er, und Next 16 wäre ein Hauptsprung
mitten im Zuverlässigkeitstor.

---

## 5. Die Gegenprobe

Behauptung: Jede Suspense-Grenze im ausgelieferten Dokument kann den Wettlauf
auslösen. Geprüft in eigenen Bauverzeichnissen, damit der Produktionsbau stehen
blieb:

| Bau | Grenzen auf `/portal/einsaetze` | Ergebnis |
|---|---|---|
| Ausgangslage | zwei (`portal/loading.tsx` **und** `portal/einsaetze/loading.tsx`) | 1–7 % |
| Probe 1 | **keine** | **0 von 300** |
| Probe 2 | eine (nur `portal/einsaetze/loading.tsx`) | **7 von 400** |

Probe 2 ist der Grund, warum die kleine Lösung ausschied: Es genügt **eine**
Grenze. Das Verschachteln verstärkt nur.

---

## 6. Was geändert wurde

**Die 55 `loading.tsx`-Dateien der drei angemeldeten Bereiche sind entfallen**
(`(app)/admin`, `(app)/portal`, `(app)/konto`), zusammen mit
`src/components/app/page-skeletons.tsx`, das ausschliesslich von ihnen benutzt
wurde. Die öffentliche Website hatte nie welche und ist unberührt.

### Warum das kein schlechter Handel ist

Die Skelette kosteten in 1–7 % aller Seitenaufrufe einen vollständigen
Neuaufbau des gesamten Baums samt einer unbehandelten Ausnahme in der Konsole.
Ein Ladeeffekt, der jeden zwanzigsten Aufruf teurer macht als das Warten, das
er verdeckt, ist kein Gewinn.

### Was an die Stelle trat

`src/components/app/navigation-progress.tsx` — ein Fortschrittsbalken am oberen
Rand, der bei **jeder** Navigation anspringt. Drei Eigenschaften, die
festgehalten gehören:

- **Der erste Rendervorgang ergibt `null`, auf dem Server wie im Browser.**
  Sonst brächte ausgerechnet die Abhilfe den Hydrationsfehler zurück.
- **Gehört wird am Dokument**, in der Erfassungsphase, nicht an einzelnen
  Links. `useLinkStatus()` aus Next 15.3 gilt nur innerhalb eines `<Link>`;
  man müsste jede Liste und jede Tabellenzeile anfassen und könnte jede
  vergessen.
- **Er greift weiter als die Skelette.** Die gab es nur für Routen mit eigener
  `loading.tsx`; `/portal/profil`, `/portal/wissen`, `/admin/sicherheit` und
  ein gutes Dutzend weitere hatten nie eine Rückmeldung.

### Was dafür verloren geht — benannt, nicht verschwiegen

Beim **ersten** Aufruf einer Adresse (getippt oder neu geladen) erscheint jetzt
nichts, bis die Seite fertig ist; vorher stand nach rund 150 ms ein Skelett.
Bei jeder Navigation *innerhalb* der Anwendung — dem weit häufigeren Fall —
ersetzt der Balken die Rückmeldung.

Sollte die React-Fassung den Fehler beheben, sind die Skelette aus der
Versionsgeschichte zurückzuholen; die Messreihe in Abschnitt 5 ist der Test,
der die Entscheidung dann erneut beantwortet.

---

## 7. Testisolation (§ 4 des Auftrags)

Der Befund aus Wave 1 — ein gemeldeter „Hydrationsfehler", der in Wahrheit ein
429 aus erschöpften Rate-Limit-Zählern war — hat gezeigt, dass die Umgebung
selbst zur Fehlerquelle wird, wenn sie nicht festgelegt ist.

| Massnahme | Ort |
|---|---|
| Zähler vor **jedem** Browserfall leeren | `tests/e2e/helpers/basis.ts` |
| Nachweis, dass der antwortende Server **dieses** Zählerverzeichnis benutzt | `tests/e2e/helpers/global-setup.ts` — eine Anmeldung mit erfundener Adresse muss dort eine Datei hinterlassen; sonst bricht die Reihe mit Begründung ab |
| Jeder Stresslauf gegen einen **neu gestarteten** Server | `scripts/e2e-stress.ts` |
| Prozessbaum sauber beenden (Windows: `taskkill /T`) | ebenda — `kill()` beendet sonst nur die `tsx`-Hülle, und der nächste Lauf trifft den alten Server |
| Läufe nacheinander, `workers: 1`, `retries: 0` | `playwright.config.ts` |

**Kein Produktionslimit wurde abgesenkt.** Die Semantik der Limits prüft
weiterhin `tests/api/rate-limit.test.ts` gegen die echten Werte.

---

## 8. Was ausdrücklich **nicht** getan wurde

| Nicht getan | Warum |
|---|---|
| `retries` erhöhen | Ein Fall, der erst im zweiten Anlauf grün wird, hat etwas gefunden |
| `waitForTimeout` einstreuen | Verschiebt den Wettlauf, statt ihn zu entscheiden |
| Hydrationsfehler filtern | Die Wache macht das Gegenteil: Sie lässt sie in **jedem** Fall fehlschlagen |
| Am Anwendungsrahmen raten | Die Änderung dort ist der Balken, und der steht erst nach der Messung |
| Konsolenfehler dulden | Unverändert null Toleranz, Ausnahmen einzeln und benannt |

---

## 9. Der Rest — offen, aber eingekreist

Die Suspense-Grenzen waren die grosse, aber **nicht die einzige** Quelle. Nach
ihrem Wegfall meldete dieselbe Messreihe weiterhin Treffer, mit einer Rate um
0,3–0,5 %. Die Bisektion hat den Ort bestimmt, nicht die Ursache.

### 9.1 Was ausgeschlossen ist — alles gemessen, nichts vermutet

| Messung | Ergebnis | Was sie ausschliesst |
|---|---|---|
| Streaming-Marker im ausgelieferten HTML nach dem Wegfall der `loading.tsx` | `$RC`, `$RS`, `<!--$?-->` je **0** | Die Einblendung ist es nicht mehr |
| Der von React **verworfene** Teilbaum gegen das ausgelieferte HTML (per `MutationObserver` gesichert) | **zeichengleich**: 225 095 = 225 095 Zeichen, 5 351 = 5 351 Knoten | Niemand hat das DOM angefasst — die Abweichung entsteht im Client-Render |
| `document.readyState` im Fehlermoment, sechs Treffer | jedes Mal **`complete`** | Kein Wettlauf mit dem Parsen des Dokuments |
| `/auth/anmelden` — kein Anwendungsrahmen, aber dieselben Provider, derselbe Toaster, **derselbe Farbschema-Umschalter** | **0 von 500** | Wurzellayout, `Providers`, `Toaster`, `ThemeToggle` |
| `/` — öffentliche Startseite, **142 KB HTML**, kein Anwendungsrahmen | **0 von 1000** | Seitengrösse und Baumtiefe. Es ist der Rahmen, nicht das Volumen |
| `/portal/profil` — Anwendungsrahmen, sehr einfacher Inhalt | **4 von 800**, **4 von 800**, **3 von 1000** | Der Seiteninhalt. Es ist der Rahmen |
| `/api/notifications/count` **blockiert** | **4 von 800** — unverändert | Der Glockenzähler |
| Rahmenstruktur unabhängig vom Pfad gemacht (aktive Markierung, Brotkrumen) | **2 von 234**, **4 von 1200** | `usePathname()`-abhängige Elementzahl |
| Radix-`ScrollArea` durch `overflow-y-auto` ersetzt | **3 von 1000** | Das einzige messende Bauteil im Rahmen |
| Entwicklungsbau | **0 von 120** | — dort nicht beobachtbar (dieselbe Zeitverschiebung wie beim Drosseln) |

Bleibt: Der Fehler sitzt im **Anwendungsrahmen**, tritt auf Elementebene auf
(der minifizierte Aufrufpfad endet in Reacts `throwOnHydrationMismatch` aus der
Behandlung einer Host-Komponente, `beginWork case 5`), und das DOM ist dabei
unverändert. Also rendert der Browser beim **ersten** Durchgang gelegentlich
etwas anderes als der Server — bei identischen Eingaben.

### 9.2 Was trotzdem geändert wurde, und warum ehrlich bleibt, dass es nicht half

Drei Änderungen am Rahmen bleiben bestehen, obwohl die Messung sie **nicht**
als Ursache bestätigt hat. Sie setzen einen Grundsatz durch, der unabhängig
davon richtig ist:

> **Die Struktur des Anwendungsrahmens darf nicht von Client-Zustand abhängen —
> nur Attribute und Text dürfen es.**

| Änderung | Warum sie bleibt |
|---|---|
| Aktive Navigationsmarkierung und Brotkrumen: immer dieselbe Zahl Elemente, nur andere Klassen | `usePathname()` ist der einzige Wert im Rahmen, der nicht aus Server-Eigenschaften stammt |
| Farbschema-Umschalter: alle drei Symbole im Baum, zwei ausgeblendet | Vorher tauschte er 278–311 ms nach dem Laden ein `<div>` gegen einen `<button>` — mitten in dem Fenster, in dem die Fehler auftreten (303–494 ms) |
| Glockenzähler: `enabled: eingehaengt` statt nur die Anzeige zu unterdrücken | Bis zum Einhängen gibt es jetzt **keine Anfrage und kein Speicherereignis**, nicht nur keine sichtbare Zahl |

**Eine Änderung wurde zurückgenommen:** der Ersatz der Radix-`ScrollArea` durch
einen einfachen Bildlauf. Sie war eine Probe, sie half nicht, und eine
Gestaltungsänderung ohne Begründung bleibt nicht stehen.

### 9.3 Zwei Sackgassen, damit sie niemand zweimal geht

**Der Entwicklungsbau kann diesen Fehler nicht zeigen.** Er ist zu langsam;
dieselbe Verschiebung wie beim Drosseln der CPU (0 von 120 gegenüber 3 von
400). Die Klartextmeldung, die das Element benennen würde, ist damit auf dem
üblichen Weg grundsätzlich nicht erreichbar.

**„Produktionsbündel mit unminifiziertem React" ist nicht herstellbar.**
Versucht über eine Modulersetzung (`react-dom*.production.js` →
`*.development.js`) und einen Loader, der das in den Entwicklungsbündeln
eingebackene `process.env.NODE_ENV !== "production"` vorher auflöst — sonst
entfernt webpack den gesamten Rumpf als toten Code. Drei Versuche, drei
verschiedene Abbrüche: `default.createContext is not a function`,
`hydrateRoot is not a function`, `Cannot read properties of undefined (reading
'push')`. Reacts Entwicklungs- und Produktionsdateien teilen interne
Verabredungen, die einen teilweisen Tausch nicht überstehen. Die Maschinerie
ist wieder entfernt; die Begründung steht in `scripts/diagnose-umgebung.ts`.

### 9.4 Der Stand, ohne Schönfärberei

- Die Rate ist von **1–7 %** auf **rund 0,3–0,5 %** gefallen.
- Über die Browserreihe gemessen: **zwei von sechzehn** vollständigen Läufen
  rot (Abschnitt 10) — vorher war es in derselben Grössenordnung, aber die
  Hälfte der Fälle meldete es gar nicht, weil nur die Hälfte auf die Konsole
  schaute.
- **Das Tor „fünf aufeinanderfolgende 20/20 ohne Hydrationsfehler" ist einmal
  erreicht und zweimal verfehlt worden.** Es gilt damit nicht als bestanden.
- Was bleibt, ist ein Fehler mit bekanntem Ort, bekanntem Zeitfenster,
  bekanntem Aufrufpfad — und einer Beweissicherung, die ihn beim nächsten
  Auftreten vollständig festhält, statt ihn als Zeile im Terminal
  vorbeiziehen zu lassen.

Der nächste Schritt ist die Fortsetzung der Bisektion **im Rahmen**, Bauteil
für Bauteil: Kopfzeile ohne Radix-Auslöser (`Sheet`, `Popover`,
`DropdownMenu`), dann `PersonAvatar`, dann `Logo`. Jede Runde kostet einen Bau
und rund 1000 Ladevorgänge. Das ist der Weg — nicht Raten.

---

## 10. Nachweis — die tatsächlichen Läufe

`npm run e2e:stress`, `retries: 0`, jeder Lauf gegen einen **neu gestarteten**
Testserver.

| Reihe | Läufe | Ergebnis |
|---|---|---|
| 1 | 5 | **20/20 · 20/20 · 20/20 · 20/20 · 20/20** — 0 Hydrationsartefakte, 100/89/87/87/87 s |
| 2 | 5 | 20/20 · 20/20 · **19/20** · **19/20** (1 Hydrationsartefakt) · 20/20 |
| 3 | 6 | 20/20 · 20/20 · **19/20** (1 Hydrationsartefakt) · 20/20 · 20/20 · 20/20 |

**Zusammen 16 Läufe, 13 grün, 3 rot.** Das Tor aus dem Auftrag — fünf
aufeinanderfolgende 20/20 ohne Hydrationsfehler — ist in Reihe 1 erreicht und
in Reihe 2 und 3 verfehlt worden. Es gilt damit **nicht als bestanden**, und
die Zahlen stehen hier so, wie sie gemessen wurden.

Der eingefangene Befund aus Reihe 3 benennt Fall, Adresse und Zeitpunkt:

```
gate4d-sperre.spec.ts › gibt das Gerät nicht frei, wenn der Vorgang abläuft
  pageerror auf /portal/einsaetze/‹id›
  readyState=complete · Reaktionswurzeln=0
  hydrationsbefunde/gibt-das-gerat-nicht-frei-…json  (123 067 Zeichen Beweise)
```

Die HTTP-Reihe ist unverändert: **1082 Prüfungen, 1079 bestanden, 0
Fehlschläge**, 3 übersprungen.

> **Eine Lehre über die Beweissicherung selbst.** Der erste eingefangene
> Befund war nach dem nächsten Lauf weg: Playwright leert `test-results/` zu
> Beginn jedes Laufs. Bei einem Fehler, der sich alle paar hundert Aufrufe
> zeigt, ist ein Beweis, den der nächste Lauf löscht, wertlos. Die Befunde
> liegen deshalb in `hydrationsbefunde/` — ausserhalb von Playwrights
> Ausgabeverzeichnis und in `.gitignore`.

---

## 11. Die Bisektion — durchgeführt, nicht geplant

Abschnitt 9.4 endete mit einem Vorhaben. Dieser Abschnitt hält fest, was
daraus wurde. Jede Runde folgt derselben Form: **Hypothese, kontrollierte
Änderung, Produktionsbau, genügend Ladevorgänge, Ergebnis, Entscheidung.**
Gemessen wurde auf `/portal/profil`, angemeldet als Mitarbeiterin, je
**900 Ladevorgänge** gegen einen Produktionsbau auf Port 3003
(`NEXT_DIST_DIR=.next-probe`).

### 11.1 Das Werkzeug: eine Sonde, die Server und Browser gleich sieht

Ein Bauteil versuchsweise wegzulassen ist nur dann eine Messung über die
Hydration, wenn **Server und Browser dieselbe Fassung sehen**. Ein Schalter im
Browser wäre wertlos — er erzeugte den Unterschied, den er messen soll.

Die Sonde ist deshalb ein Cookie, den das Layout **serverseitig** liest
(`src/lib/shell-probe.ts`, nur aktiv bei `SHELL_PROBE=1`). `app-shell.tsx`
lässt die genannten Bauteile dann auf beiden Seiten weg. Nachgewiesen an der
ausgelieferten Länge: leerer Cookie → 77 889 Zeichen, neun Bauteile
abgeschaltet → 63 642 Zeichen.

> Diese Sonde ist **Untersuchungsgerät, kein Produktmerkmal**. Sie wird vor dem
> Abschluss entfernt; ohne `SHELL_PROBE=1` ist sie ohnehin wirkungslos.

### 11.2 Runde 1 — der ganze Rahmen

**Hypothese.** Der Fehler steckt in einem Bauteil der Kopf- und Seitenleiste:
Radix-Auslöser (`Sheet`, `DropdownMenu`), Themenumschalter, Glocke,
Personenbild, `SessionKeepalive`, `ThemeSync`, Fortschrittsbalken.

**Kontrollierte Änderung.** Alle neun gleichzeitig abgeschaltet — die
grosszügigste Variante der Hypothese. Bleibt der Fehler, sind alle neun
ausgeschlossen, und eine Runde ersetzt neun.

| Variante | Treffer |
|---|---|
| nichts abgeschaltet | 7 von 900 |
| `sidebar, sheet, breadcrumbs, theme, bell, usermenu, keepalive, themesync, navprogress` | **18 von 900** |

**Ergebnis.** Ohne den Rahmen ist die Rate **nicht niedriger, sondern höher.**

**Entscheidung.** Die neun Bauteile sind als Ursache **ausgeschlossen**. Dass
der Wert steigt, ist kein Widerspruch: Weniger Inhalt heisst ein schnelleres
Dokument und damit ein anderes Zeitfenster für die Hydration. Genau das ist der
Unterschied zwischen Ursache und Zeitverstärker — und der erste harte Beleg
dafür, dass hier ein Zeitproblem und kein Bauteilproblem gemessen wird.

### 11.3 Runde 2 — Rahmen gegen Seiteninhalt

**Hypothese.** Wenn nicht der Rahmen, dann der Seiteninhalt in `<main>`.

| Variante | Treffer |
|---|---|
| nichts abgeschaltet (Kontrolle) | 2 von 900 |
| nur `main` abgeschaltet — voller Rahmen, kein Seiteninhalt | **0 von 900** |

**Ergebnis.** Ohne Seiteninhalt kein Fehler, bei vollem Rahmen.

**Entscheidung.** Der auseinanderlaufende Knoten liegt **im Teilbaum der
Seite**, nicht im Rahmen. Zugleich zeigt die Kontrolle (2 statt 7 bei
identischer Fassung), wie stark die Messung streut: Bei einer Rate um 0,5 %
sind 900 Ladevorgänge gerade genug für eine Richtungsaussage, nicht für einen
Prozentwert auf die Nachkommastelle. Jede Zahl hier ist so zu lesen.

### 11.4 Die Messung, die die bisherige Erklärung widerlegt

Nach Runde 2 stand die Frage, ob die Einblendung (`$RC`/`$RV`) überhaupt noch
beteiligt sein *kann*. Das lässt sich ohne Wahrscheinlichkeiten beantworten —
man muss nur nachsehen, was der Server ausliefert:

| Seite | `<!--$?-->` offen | `<!--$-->` fertig | `$RC` | `$RS` | `$RV` |
|---|---|---|---|---|---|
| `/portal/profil` | 0 | 2 | 0 | 0 | 0 |
| `/portal` | 0 | 2 | 0 | 0 | 0 |
| `/portal/einsaetze` | 0 | 2 | 0 | 0 | 0 |

**Kein einziger offener Platzhalter, kein einziger Einblendeaufruf.** Die
angemeldeten Seiten kommen seit dem Entfernen der `loading.tsx` in *einem*
Stück; die beiden fertigen Grenzen stammen aus dem Rahmen und stehen schon
geschlossen im HTML.

**Damit ist die gedrosselte Einblendung als Ursache des Restes ausgeschlossen.**
Der Befund aus Abschnitt 4 war richtig — für den damals gemessenen Anteil von
1–7 %. Für den Rest von 0,2–0,8 % ist er es nicht: Was nicht im Dokument steht,
kann nichts verschieben. Abschnitt 4 beschreibt einen **Auslöser**, der
abgestellt wurde; der Rest hat eine andere Ursache.

### 11.5 Was der eingefangene Befund über die Art des Fehlers sagt

React 19 wirft aus `throwOnHydrationMismatch(fiber, fromText)`. Das erste
Argument der verdichteten Meldung ist `"text"`, wenn ein **Textknoten**
auseinanderlief, und `"HTML"` bei einem **Element**. Der eingefangene Befund
lautet `args[]=HTML`.

Das schliesst die naheliegendste Erklärungsfamilie aus: eine zeitabhängige
*Beschriftung* — „vor 3 Minuten", eine Uhrzeit, eine gerundete Dauer — erzeugt
`text`, nicht `HTML`. Gesucht ist etwas, das im ersten Browserdurchgang ein
**anderes Element oder eine andere Anzahl Elemente** ergibt als im HTML.

### 11.6 Der Stand nach der Bisektion

Eingekreist, jeweils gemessen und nicht vermutet:

- **nicht** der Anwendungsrahmen (Runde 1),
- **im** Teilbaum der Seite (Runde 2),
- **nicht** Reacts gedrosselte Einblendung (11.4 — es gibt keine),
- ein **Element**-Unterschied, kein Textunterschied (11.5),
- zeitabhängig: rund fünf von tausend Ladevorgängen derselben Seite mit
  identischem Datenbestand.

Der nächste Schritt ist keine weitere Runde am Produktionsbau, sondern der
**Entwicklungsbau** (`npm run diagnose:server`): Er gibt die vollständige
Gegenüberstellung samt Komponentennamen aus, wo der Produktionsbau nur
`#418` sagt. Ein Treffer dort benennt die Stelle, statt sie einzukreisen.

---

## 12. Die 55 entfernten `loading.tsx` — was sie gekostet haben

Abschnitt 6 hat die Entfernung begründet und die Kosten in einem Absatz
benannt. Dieser Abschnitt geht die Liste durch, Punkt für Punkt, und trennt
dabei **gemessen** von **abgeschätzt**.

### 12.1 Was tatsächlich verloren ging

**Das Streaming.** Das ist der einzige technisch harte Verlust. Eine
`loading.tsx` ist für Next eine Suspense-Grenze; mit ihr kann der Server den
Rahmen ausliefern, bevor die Abfragen der Seite fertig sind. Ohne sie wartet
das ganze Dokument auf die langsamste Abfrage. Gemessen an den ausgelieferten
Dokumenten (Abschnitt 11.4): **null offene Platzhalter** — es wird nichts mehr
gestreamt, die Seiten kommen in einem Stück.

Für die angemeldeten Bereiche ist das ein anderer Handel als für eine
öffentliche Seite: Sie sind ohnehin `dynamic = 'force-dynamic'`, die Abfragen
laufen gegen eine Datenbank im selben Netz, und es gibt keine Suchmaschine, der
ein früher erster Byte etwas nützte. Ein Verlust bleibt es trotzdem, und er
wird hier nicht kleingeredet: Wer eine Liste mit achthundert Zeilen öffnet,
wartet jetzt auf das vollständige Dokument statt auf den Rahmen.

**Das Gerüst beim Seitenwechsel.** Statt eines Skeletts bleibt die alte Seite
stehen, bis die neue fertig ist. Das ist nicht in jeder Hinsicht schlechter —
lesbarer alter Inhalt schlägt graue Balken —, aber es ist eine andere
Rückmeldung, und wer das Skelett gewohnt war, vermisst es.

### 12.2 Was dafür besser wurde

Der Ersatz (`NavigationProgress`) greift bei **jeder** Navigation über einen
Link. Die Skelette gab es nur für Routen mit eigener Datei; `/portal/profil`,
`/portal/wissen`, `/admin/sicherheit` und ein gutes Dutzend weitere hatten nie
eine Rückmeldung. Gemessen an der Zahl der Routen mit Rückmeldung ist das eine
Verbesserung, keine Verschlechterung.

### 12.3 Die Punkte aus der Prüfliste, einzeln

| Punkt | Befund |
|---|---|
| **Sprung im Aufbau** (Layout Shift) | Keiner. Der Balken ist `fixed`, zwei Pixel hoch, ausserhalb des Flusses und ohne Zeigerereignisse. Die Skelette erzeugten ebenfalls keinen — unentschieden |
| **Balken bleibt hängen** | Ausgeschlossen: Deckel bei zwölf Sekunden. Ein Balken, der lügt, ist schlechter als keiner |
| **Fehlernavigation beendet den Balken nicht** | Beendet: Der Pfad ändert sich auch zur Fehlerseite hin. Bleibt der Pfad gleich, greift der Deckel |
| **Umleitungen** | Beendet: `/a` → `/b` ändert den Pfad |
| **Abgebrochene Navigation** | Der Balken läuft bis zum Deckel weiter. Kleiner Schönheitsfehler, kein falscher Zustand |
| **Vor und Zurück** | **Kein Balken.** `popstate` löst keinen Klick aus, und ein `popstate`-Zuhörer feuerte *nach* der Navigation — also genau dann, wenn nichts mehr zu warten ist. Für diese Wege hält Next den Clientcache vor |
| **Navigation aus dem Programm** | **Kein Balken** (`router.push` nach einer Handlung). In diesen Fällen hat gerade eine Schaltfläche mit Ladezustand gewartet; eine Rückmeldung gab es also |
| **Barrierefreiheit** | War **fehlerhaft und ist behoben.** Der erste Entwurf fügte den `aria-live`-Bereich gemeinsam mit seinem Inhalt ein — die eine Art, einen Live-Bereich zu benutzen, die nicht funktioniert, weil vorlesende Programme Änderungen *innerhalb* eines vorhandenen Bereichs beobachten. Der Bereich steht jetzt immer im Dokument, leer und ohne Höhe; erst sein Inhalt wechselt |

### 12.4 Die Entscheidung

**Die `loading.tsx` kommen nicht zurück** — und zwar aus einem Grund, der sich
seit Abschnitt 6 geändert hat.

Damals war die Begründung: Sie verursachen den dominierenden Anteil des
Fehlers. Das stimmt weiterhin, die Gegenprobe steht in Abschnitt 5.

Neu hinzu kommt aber Abschnitt 11.4: Die angemeldeten Seiten liefern heute
**null** Suspense-Grenzen aus. Ihre Rückkehr wäre also keine Feinjustierung,
sondern die Wiedereinführung genau des Mechanismus, dessen Wegfall 1–7 % auf
0,2–0,8 % gedrückt hat. Solange der Rest nicht erklärt ist, wäre das ein Handel
gegen die eigene Messung.

Wenn der Rest gefunden und behoben ist, ist die Frage neu zu stellen — dann
aber gezielt: **eine** Grenze auf der teuersten Liste, gemessen gegen
denselben Aufbau, und nicht 55 auf einmal. Die Messreihe aus Abschnitt 5 (zwei
Grenzen 1–7 %, eine Grenze 7/400, null Grenzen 0/300) zeigt, dass die Zahl der
Grenzen und nicht ihre Art den Ausschlag gibt.

---

## 13. Eine Ursache gefunden — die erste, die diesen Namen verdient

Abschnitt 11 hat eingekreist. Dieser Abschnitt benennt.

### 13.1 Das Werkzeug: die Reihenfolge der Veränderungen

Der Baum **nach** dem Fehler hilft nicht. Er ist bereits neu gebaut, und jeder
Unterschied darin kann die Ursache oder ihre Folge sein — beide sehen gleich
aus. Der erste Versuch, ausgeliefertes HTML gegen das DOM zu stellen, lieferte
genau das: einen Haufen echter Unterschiede, von denen keiner beweisbar der
gesuchte war (andere `useId`-Werte, ein nachgeladener Glockenzähler, versetzte
Skripte — alles Folgen des Neuaufbaus).

Was hilft, ist ein `MutationObserver`, der ab dem allerersten Skript läuft und
jede Entfernung mit Zeitstempel mitschreibt. Läuft die Hydration glatt,
verändert sie die Struktur nicht. Läuft sie auf, fasst React den betroffenen
Teilbaum an — und der Pfad der ersten Veränderung zeigt auf die Stelle.

> **Eine Falle, die einen halben Lauf gekostet hat.** Der Beobachter hing
> zuerst an `document.documentElement`. Playwrights Init-Skript läuft, bevor
> der Parser irgendetwas erzeugt hat — das Wurzelelement gibt es da noch
> nicht. Der Beobachter wurde nie eingehängt und meldete brav „0
> Entfernungen", was wie ein Befund aussah und keiner war. Beobachtet wird
> `document`.

### 13.2 Der Befund

Auf `/portal/einsaetze/‹id›`, zwei Treffer, identischer Pfad:

```
main#inhalt > div.space-y-6 > div.space-y-8 > section.space-y-4
  > ul.divide-y.divide-border.overflow-hidden > li > label.flex.cursor-pointer.items-start
```

Das ist die **Abhakliste des Einsatzrapports** — und in jedem `<label>` steht
eine Radix-Checkbox.

### 13.3 Die Ursache

Radix rendert zu jeder Checkbox, jedem Schalter und jedem Optionsfeld ein
verstecktes `<input>`, damit ein Formular auch ohne JavaScript etwas
abschickt. Ob es gebraucht wird, entscheidet es so
(`@radix-ui/react-checkbox`, `dist/index.mjs`):

```js
const isFormControl = control
  ? !!form || !!control.closest('form')
  // We set this to true by default so that events bubble to forms without JS (SSR)
  : true;
```

Auf dem **Server** gibt es kein `control` — der Wert ist `true`, und das
`<input>` steht im ausgelieferten HTML. Im **Browser** setzt der Ref-Rückruf
`control`; steht das Feld in keinem Formular, wird das `<input>` wieder
**entfernt**.

Genau diese Entfernung fällt in das Zeitfenster der Hydration. React 19
hydriert nebenläufig und schreibt Teilbäume einzeln fest; der Ref eines frühen
Feldes kann laufen, während spätere noch hydriert werden. Dann findet React
ein Element weniger vor, als das HTML hatte — und das ist ein **Element**-,
kein Textunterschied, genau wie `args[]=HTML` es sagt (§11.5).

**Der Nachweis ohne Wahrscheinlichkeiten**, gemessen am Produktionsbau:

| | ausgeliefertes HTML | DOM nach dem Laden |
|---|---|---|
| `button[role=checkbox]` | 5 | 5 |
| `input[type=checkbox]` | **5** | **0** |
| `<form>` | 0 | 0 |

Fünf Elemente verschwinden bei jedem Ladevorgang. Ob daraus ein Fehler wird,
entscheidet allein, wann sie verschwinden.

### 13.4 Die Behebung

In `src/components/ui/controls.tsx` bekommen `Checkbox`, `RadioGroupItem`,
`OptionCard` und `Switch` ein `form`, wenn der Aufrufer keines angibt. Damit
ist der erste Term `!!form` wahr, Server und Browser rendern **dieselbe**
Elementmenge, und nichts wird mehr entfernt.

Die Kennung zeigt absichtlich auf kein Formular: Ein `<input>` mit `form="…"`
gehört zu genau diesem einen Formular; gibt es keines, gehört es zu keinem und
schickt nirgends etwas mit. Die Schreibwege dieser Anwendung laufen ohnehin
über `fetch`.

Verworfen: jede Liste in ein `<form>` zu hüllen (eine Formularsemantik, die es
nicht gibt, und die Lücke bliebe überall offen, wo es jemand vergisst); ein
eigener Baustein statt Radix (der gründlichste Weg — und er kostet
Tastaturverhalten, Zustände und Zugänglichkeit, die hier bereits stimmen).

### 13.5 Die Wirkung, gemessen

Je 400 Ladevorgänge, Produktionsbau, angemeldet, gleicher Browser:

| Seite | vorher | nachher |
|---|---|---|
| `/portal/einsaetze/‹id›` (fünf Checkboxen) | 13 (3,25 %) | **2 (0,50 %)** |
| `/portal/einsaetze` (Liste) | 2 (0,50 %) | **1 (0,25 %)** |
| `/portal/profil` (keine) | 0 | 1 (0,25 %) |

Auf der Seite mit den Checkboxen sinkt die Rate um rund vier Fünftel. Das ist
die erste Ursache in dieser Untersuchung, die benannt, bewiesen und behoben
ist — und nicht nur eingekreist.

---

## 14. Was bleibt — und warum es ein Release-Blocker ist

**Diese Wave ist nicht abgeschlossen.** Der folgende Rest ist nicht erklärt,
und er wird hier nicht als Randnotiz geführt.

### 14.1 Häufigkeit

Je 400 Ladevorgänge auf dem Produktionsbau, angemeldet als Mitarbeiterin:

| Bau | `/portal/profil` | `/portal` |
|---|---|---|
| A (vor der Behebung aus §13) | 0 (0 %) | 4 (**1,00 %**) |
| B (mit der Behebung) | 1 (0,25 %) | 23 (**5,75 %**) |
| B, zweite Reihe | — | 42 (**10,50 %**) |
| C (Behebung zurückgenommen, sonst gleich) | 1 (0,25 %) | 53 (**13,25 %**) |

Die entscheidende Zeile ist C: **Ohne** die Behebung ist `/portal` nicht
besser, sondern schlechter als mit ihr. Die Behebung aus §13 ist damit
entlastet — und zugleich steht fest, dass die Rate auf dieser Seite zwischen
1 % und 13 % schwankt, **ohne dass sich der Quelltext ändert**. Was sie
bewegt, ist die Aufteilung der Bündel und damit die Ankunftszeit der Skripte;
jeder Bau würfelt neu.

Eine Zahl wie „0,3 %" aus Abschnitt 9.4 ist damit als Kennwert wertlos. Was
gilt, ist: **auf dem Übersichtsbildschirm des Portals bis zu jeder achte
Erstaufruf.**

### 14.2 Betroffener Rahmen

Nicht der Anwendungsrahmen (§11.2, gemessen), sondern der Seiteninhalt
(§11.3). Am stärksten `/portal` (Übersicht), messbar auch auf
`/portal/einsaetze/‹id›` und `/portal/einsaetze`, nicht auf `/portal/profil`.

### 14.3 Reproduktion

```powershell
npm run build                 # bei gestopptem Server
npm run test:server
# Rate je Seite, 400 Ladevorgänge:
npx tsx <scratchpad>/seiten-rate.ts 3001 400 /portal/profil /portal
```

Die Browserreihe reproduziert ihn ebenfalls, nur seltener: In der Stressreihe
vom 22.09.2026 war 1 von 5 Läufen rot (Lauf 5, ein Hydrationsbefund).

### 14.4 Beweise

- `hydrationsbefunde/entsperrt-mit-dem-eigenen-passwort-…json` (124 KB):
  `pageerror` mit `#418 args[]=HTML` auf `/portal/einsaetze/‹id›`, dazu
  ausgeliefertes HTML, DOM und Bildschirmfoto.
- Die Mitschrift des `MutationObserver`: **keine** Veränderung im `<body>` vor
  dem Fehler; unmittelbar danach entfernt React vier `<script>`-Knoten direkt
  unter `<body>` — mehr nicht. Auf `/portal` bleibt der Inhalt von `<main>`
  unangetastet.

### 14.5 Verbleibende Hypothesen

1. **Verschiebung der Skripte.** React 19 räumt `<script>`- und
   `<link>`-Knoten während der Hydration um (Float/Resource-Hoisting). Die
   einzige beobachtete Veränderung im `<body>` sind genau solche Knoten. Wenn
   diese Umräumung in das Hydrationsfenster fällt, ändert sich die Zahl der
   Kindknoten von `<body>` — derselbe Mechanismus wie in §13, nur eine Ebene
   höher und nicht von uns verursacht.
2. **Ein zweites Bauteil mit demselben Muster wie Radix' Checkbox**: etwas,
   das serverseitig ein Element rendert und es im Browser nach dem ersten
   Ref-Rückruf entfernt. Auf `/portal` kommen dafür `Progress`, `KpiTile` und
   `PersonAvatar` in Frage; keines ist bisher gemessen.
3. **Ein Zusammenspiel mit der Bündelaufteilung.** Dass dieselbe Quelle je
   nach Bau zwischen 1 % und 13 % liegt, passt zu einem Fehler, der nur bei
   einer bestimmten Ankunftsreihenfolge der Kapitel auftritt.

Hypothese 1 ist die wahrscheinlichste und zugleich die unangenehmste: Sie
läge in Next/React selbst, und die Abhilfe wäre keine Zeile in diesem
Projekt, sondern eine Fassung.

### 14.6 Produktionsrisiko

**Was passiert:** React verwirft den Baum und baut ihn im Browser neu. Der
Zustand ist danach korrekt; es gehen keine Daten verloren, und eine
Sicherheitswirkung gibt es nicht.

**Was man sieht:** ein Flackern beim ersten Aufbau und eine verlorene
Hydration — die Seite ist einen Wimpernschlag später bedienbar. Auf einem
Telefon im Mobilfunknetz ist dieser Wimpernschlag länger.

**Was es kostet:** Die Arbeit des Servers für das HTML ist in diesen Fällen
verschenkt.

### 14.7 Einstufung

> **RELEASE-BLOCKER.**

Begründung — und ausdrücklich gegen die bequemere Lesart:

Die bequeme Lesart wäre: „React fängt es ab, der Zustand stimmt, also ist es
ein Schönheitsfehler." Dagegen stehen zwei Tatsachen aus dieser Messreihe.

**Erstens die Häufigkeit.** Bis zu 13 % der Erstaufrufe des
Übersichtsbildschirms. Das ist keine Randerscheinung, sondern der Regelfall
für einen Teil der Nutzenden.

**Zweitens die Unerklärtheit.** Ein Fehler, dessen Rate sich ohne
Quelltextänderung verdreizehnfacht, ist nicht abgeschätzt, sondern unbekannt.
Solange Hypothese 2 offensteht, ist nicht ausgeschlossen, dass derselbe
Mechanismus eine Stelle trifft, an der der Neuaufbau **nicht** folgenlos ist —
etwa eine Maske mit bereits eingegebenen Werten.

Die Behebung aus §13 bleibt richtig und im Bau: Sie entfernt eine bewiesene
Ursache und senkt die Rate dort, wo sie wirkt, um vier Fünftel. Sie schliesst
das Tor aber nicht.

**Nächster Schritt**, in dieser Reihenfolge: (a) Hypothese 1 prüfen, indem die
Zahl der `<script>`-Knoten unter `<body>` vor und nach der Hydration gemessen
wird — dasselbe Vorgehen wie in §13.3, das dort in einer Messung entschieden
hat; (b) `/portal` bauteilweise leeren, wie in §11 den Rahmen.
