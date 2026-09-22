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
