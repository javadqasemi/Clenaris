# Browser-Prüfungen (Gate 4D.1)

Diese Reihe fährt die Anwendung in echten Browsern — Chromium für alle Fälle,
Firefox und WebKit für die Fälle, die von der Engine abhängen (Abschnitt
„Engines"). Sie **ergänzt** die HTTP-Prüfungen unter `tests/api` und
`tests/pages` und ersetzt keine einzige davon.

## Wozu eine zweite Ebene

Die HTTP-Reihe prüft, was der Server ausliefert: Statuscodes, Kopfzeilen,
Cookies, HTML. Drei Aussagen liegen ausserhalb ihrer Reichweite, und alle drei
sind sicherheitsrelevant:

| Frage | Warum HTTP dafür nicht genügt |
|---|---|
| Rendert PDF.js unter der ausgelieferten CSP? | Dass Worker und wasm vom eigenen Ursprung kommen, ist über HTTP prüfbar. Ob der Browser den Worker dann auch startet, ist eine Aussage über eine Laufzeit. |
| Entsteht aus einer Handbewegung eine Unterschrift? | Ein `imageDataUrl` im Anfragekörper beweist, dass der Server ein PNG annimmt — nicht, dass das Unterschriftenfeld eines erzeugt. |
| Hält die Gerätesperre den Browser? | 423 auf einem Cookie-Kopf ist die halbe Antwort. Zweiter Tab, Zurück-Taste, Neuladen, geschlossener Tab, gelöschte Cookies und ein zweites Gerät sind die andere. |
| **Gibt es die Maske wirklich — und schreibt sie?** | Seit Wave 10. Eine HTTP-Reihe prüft den Endpunkt; sie sagt nichts darüber, ob eine Schaltfläche ihn je aufruft. Genau dieses Muster — Schema, Berechtigung und Seite vorhanden, aber kein Weg dorthin — ist in diesem Projekt dreimal aufgefallen und jedes Mal erst beim Durchklicken. |

## Ausführen

```powershell
npm run e2e:install        # einmal: Chromium, Firefox und WebKit herunterladen
npm run build              # bei gestopptem Server
npm run e2e                # startet den Testserver selbst, falls keiner läuft
npm run e2e -- gate4d      # nur eine Gruppe
npm run e2e:ui             # mit Oberfläche
```

Gefahren wird gegen **dieselbe** Umgebung wie die HTTP-Reihe:
`scripts/test-server.ts` auf Port 3001, gegen `clenaris_test`, mit
`TRUSTED_PROXY_MODE=NONE` und dateibasierten Rate-Limit-Zählern. Läuft bereits
ein Testserver, wird er verwendet; sonst startet Playwright ihn und wartet auf
`/api/auth/session` — kein blindes `sleep`.

`tests/e2e/helpers/global-setup.ts` bricht vor dem ersten Browser ab, wenn die
Datenbank nicht als Testdatenbank erkennbar ist, der Postausgang fehlt oder
**irgendeine produktive Integration konfiguriert ist**. Diese Reihe versendet
Offerten und nimmt Einsätze ab; mit eingerichtetem Resend ginge eine echte
E-Mail an `nicole.wyss@example.ch` hinaus.

## Aufbau

| Datei | Gegenstand |
|---|---|
| `gate3-pdf-viewer.spec.ts` | Ein eigens erzeugtes dreiseitiges PDF rendert; Worker und Hilfsdateien kommen vom eigenen Ursprung mit 200; kein fremder Ursprung, keine Ablagekennung im HTML; eingebettetes PDF-JavaScript wird nicht ausgeführt; Blättern, Seiteneingabe, Zoom, Anpassen, Herunterladen, Tastatur, Vollbild; Zugänglichkeit der Werkzeugleiste |
| `gate4c-offertannahme.spec.ts` | Der versendete Offertlink aus dem Postausgang → Annahme → Tausch → saubere Adresse → Zustimmung → getippt bzw. **auf dem Canvas gezeichnet** → Abschluss → Offerte ACCEPTED → Ergebnislink aus der Abschlussnachricht; Tokenhygiene nach jedem Schritt |
| `gate4d-abnahme.spec.ts` | Der vollständige Weg über das übergebene Gerät — getippt, gezeichnet und auf einem Smartphone-Bildschirm mit Berührung; Rückgabe und Entsperren mit falschem und richtigem Passwort |
| `gate4d-sperre.spec.ts` | Zweiter Tab, Zurück/Vorwärts/Neuladen, direkt eingetippte Adressen, geschlossener Tab, entfernte Cookies, zweites Gerät, abgelaufener Vorgang, Entsperren ohne Neuanmeldung |
| `wave10-vertraege.spec.ts` | Die Vertragswege A–F im Browser, gegen die Datenbank geprüft: Vertrag aus angenommener Offerte → Plan im Dialog → Einsätze mit ihrer Fassung; Antrag → Übernahme → Fassung 2 zum Stichtag; V1 → V2 → V3 ohne doppelten Termin; vergangene Periode nach der damals geltenden Fassung; Unterzeichnung, danach eingefroren und nicht stornierbar; Pause sagt ab, Fortsetzen plant ab heute |
| `scan.spec.ts` | Scanplattform (2026-09-26) mit nachgebildeter Kamera und nachgebildetem `BarcodeDetector`: Etikett erkannt → Treffer, **nichts gebucht, Seite nicht gewechselt, Kamera wieder aus** → Wareneingang in der Maske → Bestand, Lagerbewegung und Protokolleintrag in der Datenbank; feindliche Inhalte (`javascript:`, Markup, fremde Adresse) öffnen, rendern und rufen nichts auf; unbekannte EAN → „Neuen Artikel erfassen" nur mit dem Strichcode vorbelegt. Beweist nicht, dass ein echter Detektor einen gedruckten Code liest |
| `wave23-masken.spec.ts` | Drei Masken, die die Merkmalsprüfung als fehlend meldete, gegen die Datenbank: Lohnvereinbarungen in der Personalakte, offene Zeiten auf der Lohnseite freigeben, Material aus dem Lager für einen Einsatz entnehmen — und dass die neue Materialzeile ohne hartes Neuladen erscheint |
| `wave18-barrierefreiheit.spec.ts` | axe-core (WCAG 2.1 A/AA) auf öffentlichen Seiten, Verwaltung, Portal und Kundenbereich; `critical`/`serious` lassen den Fall scheitern, alles andere liegt als Anhang bei. Misst, was maschinell messbar ist — keine Konformitätsaussage (`docs/BARRIEREFREIHEIT.md`) |
| `phase21-oberflaeche.spec.ts` | Oberfläche und Barrierefreiheit **aus der Navigation abgeleitet** (2026-09-27): je Rolle jeder Eintrag der Seitenleiste erreichbar, ohne Fehlergrenze, genau dort `aria-current`, axe ohne `critical`/`serious`; Sprunglink als erster Tabstopp in allen Rahmen; kein seitliches Scrollen in sieben Fenstergrössen und bei 200 % Zoom; mobile Navigation mit denselben Einträgen, Escape und Fokusrückgabe; Scanner-Dialog und Suche (Fokus, Escape, Pfeile bis „Alle Treffer"); reduzierte Bewegung; öffentliche Seiten auf dem Telefon mit axe |
| `angemeldet.webkit.spec.ts` | Nur WebKit, über die HTTPS-Vorschaltung (`scripts/test-https-vorschaltung.ts`, W-02): Anmeldung und Übersicht, Rabattauswahl in der Offertmaske, Suche und Scanner mit Handeingabe, Abmelden |
| `abmelden.spec.ts` | Abmelden mit einer zurückgehaltenen Abfrage des Rahmens: kein Sprung zur Anmeldung „abgelaufen", keine Erneuerung, Ziel Startseite (2026-09-29) |
| `ki-textassistent.spec.ts` | Textassistent mit dem Prüfanbieter (`src/lib/ai/pruefanbieter.ts`, keine echte KI): Original/Vorschlag, Verwerfen, Erneut generieren, Übernehmen, kein Autospeichern, Personal 403 |
| `zustaende.spec.ts` | Fehler- und Leerzustände (RC-06): Nachrichtenliste und -verlauf mit Netzabbruch, Preisberechnung der Buchung mit Netzabbruch, Lohnjahr ohne Satzversion — jeweils mit Weg zurück zum Erfolg |
| `besuchsauswertung.spec.ts` | Website-Besuche mit eigenem Bestand: Zeitraum, Leerzustand, keine IP und kein Token, kein Zugang für Personal |
| `besuchsmessung.browser.spec.ts` | Drei Engines: ohne Einwilligung und mit „Nur notwendige" keine einzige Zeile (auch beim `tel:`-Klick), mit Einwilligung „Statistik" gespeichert — Pfad ohne Abfrage, Kampagne getrennt, kein Token —, ein Werbeblocker sperrt den Endpunkt ohne Seitenfehler; seit 2026-10-01 der **Widerruf** über „Einstellungen zurücksetzen": danach keine Zeile mehr, das Banner fragt neu (TA-03; geschrieben, erster Lauf im `verify:release` des Härtungskandidaten). Misst nur, weil der Prüfserver `CLENARIS_BESUCHSMESSUNG=an` setzt (der Diagnoseserver ebenfalls) |
| `bilder.browser.spec.ts`, `vor-hydration.browser.spec.ts`, `preisrechner.browser.spec.ts` | Drei Engines: jedes Websitebild dekodiert und sichtbar (kalt, warm, Linkwechsel, langsames Netz, Telefon); vor der Hydration Eingetipptes geht nicht verloren; eine späte Antwort überschreibt den aktuellen Preis nicht (`tests/README.md`, Browserabschnitt) |
| `offerte-rabatt.spec.ts`, `sitzung-tabs.spec.ts`, `produktsprint-2026-09-26.spec.ts` | Rabattauswahl ohne verschwindende Navigation; zwei Tabs als eine Sitzung; die sechs Abläufe des Produktsprints (`tests/README.md`, Browserabschnitt) |
| `inhaltsrichtlinie.browser.spec.ts` | Drei Engines (2026-09-30; geschrieben, nur in `node:vm` nachgestellt — erster Lauf im `verify:release` des Härtungskandidaten): unter der Produktionsrichtlinie ohne `'unsafe-eval'` wird `eval` verweigert, WebAssembly kompiliert (PDF.js braucht `'wasm-unsafe-eval'`), ein `blob:`-Rahmen lädt (Druckrahmen des PDF-Viewers), die Seite lädt ohne Verstoss. Gestartet wird die Prüfung erst auf ein Signal nach `addScriptTag` — sonst fiele `eval` noch in die Ausnahme, mit der jede Engine die Richtlinie für einen Protokollaufruf aussetzt (kein Verstoss, der Fall bewiese nichts), und in Firefox bräche `addScriptTag` am erwarteten Verstoss ab (beides aus dem Quelltext hergeleitet, Kopfkommentar der Datei). Mit `E2E_DIAGNOSE=1` (Diagnoseserver unter `next dev`, mit `'unsafe-eval'`) gilt die umgekehrte Erwartung. **Beweist nicht** den Druckdialog selbst (P2H-34) |
| `sitzung-leerlauf.spec.ts` | Chromium und Firefox (2026-10-01; geschrieben, erster Lauf im `verify:release` des Härtungskandidaten), mit der Playwright-Uhr: ohne Eingabe Warnung zwei Minuten vorher, dann Abmeldung `grund=inaktiv`; eine Eingabe vor der Warnung schiebt den Ablauf; „Angemeldet bleiben" ohne Warnung nach zwanzig Minuten, mit Warnung kurz vor sieben Tagen (`fastForward`); eine vom Server wegen Leerlaufs beendete Sitzung (Token in der Testdatenbank zurückdatiert) führt zur Anmeldung `grund=abgelaufen`; die automatische Abmeldung in einem Tab nimmt den anderen mit (angehaltene Uhr, `grund=abgemeldet`). Kopflose Engines melden das Zurückkehren eines Tabs nicht verlässlich — der Zwei-Tab-Fall löst `visibilitychange` deshalb selbst aus, der Weg danach ist der des Produkts |
| `hydration-wiederholung.spec.ts` | RB-001 deterministisch: die **von Next mitgelieferte** React-Fassung spielt ein angehaltenes `<main>` während der Hydration wieder ab (Flight-artiger `lazy`-Knoten). Verlangt, dass das Wiederabspielen eintritt, und dass dabei keine Abweichung entsteht. Scheitert ohne `scripts/react-hydrationskorrektur.mjs` (`docs/HYDRATION.md` §16) |

Die Helfer liegen in `helpers/`: Prüfbestand über die Schnittstelle
(`bestand.ts`), Konsolen- und Netzwächter, Anmeldung, Tokenhygiene und die
beiden Zeichenwege (`browser.ts`; `imBrowserAnmelden(page, konto, ziel, optionen)`
nimmt seit 2026-10-01 statt des Rücksprungziels auch `{ weiter, angemeldetBleiben }`
und kreuzt dann „Angemeldet bleiben" an), kontrollierte PDF-Prüfobjekte
(`pdf-fixtures.ts`), axe-Messung (`axe.ts`), der gemeinsame Rahmen jedes Falls
(`basis.ts`) und die Hydrationswache samt Lebenslauf (`diagnose.ts`).

**Lebenslauf je Arbeiter (RC-21, seit 2026-10-01).** Der Rahmen schreibt immer
`test-results/rc21-<pid>.jsonl`: `browser.beobachtet`, `fall.beginn`,
`fall.ende` (Status, Fehler, Dauer, offene Seiten, Browser verbunden, Speicher,
offene und abgewartete Körperlesungen, Urteil der Hydrationswache),
`fixture.abgebaut`, `page.close`, `page.crash`, `context.close`,
`browser.disconnected`, `arbeiter.ende` — jede Zeile mit Zeit, Prozess und
freiem Speicher, Token in Adressen geschwärzt. Er lässt keinen Fall scheitern.
Vor dem Abbau wartet der Rahmen höchstens 2 s auf offene Körperlesungen der
Hydrationswache (`diagnose.ausstehendeAbwarten`). Playwright leert
`test-results/` zu Beginn jedes Laufs; rote Läufe sichern `e2e-stress.ts`
(`hydrationsbefunde/stress-lauf-<n>-<ts>/`) und `verify:release`
(`hydrationsbefunde/release-…/test-results/`), grüne nicht (P2H-58). Geprüft
mit Attrappen in `tests/api/pruefwerkzeug-lebenslauf.test.ts`.

## Grundsätze

**Vorbereiten über die Schnittstelle, prüfen im Browser.** Offerten und
Einsätze entstehen über HTTP — die HTTP-Reihe prüft diesen Weg bereits
vollständig, und ihn nachzuklicken machte jeden Fall gegen jede
Formularänderung brüchig. Die Grenze ist scharf: Worüber eine Aussage getroffen
wird, läuft im Browser. Kein `imageDataUrl` wird eingesetzt, keine Zustimmung
per API gegeben, kein Vorgang per API abgeschlossen.

**Jeder Fall meldet sich frisch an.** Die Gerätesperre hängt an der
Rotationsfamilie der Sitzung; ein wiederverwendeter Cookie-Vorrat wäre über
mehrere Fälle hinweg dieselbe Familie und zerstörte genau die Aussage, um die
es geht. Weil die Anmeldung auf acht Versuche je fünf Minuten und Adresse
begrenzt ist, leert `helpers/basis.ts` vor jedem Fall die Zähler des
Testservers — dieselbe Massnahme, die `loginAll()` in der HTTP-Reihe je Datei
ergreift. Die Limits selbst bleiben unverändert und werden weiterhin von
`tests/api/rate-limit.test.ts` bewiesen.

**Nacheinander, ein Worker.** Alle Fälle teilen eine Datenbank, dieselben fünf
Demokonten und dasselbe Anmeldekontingent. Nebenläufigkeit wäre nicht
schneller, sondern unzuverlässig.

**Konsolenfehler sind Testfehler.** Vorgabe ist null Toleranz. Die einzige
Ausnahme ist die Zeile, die Chromium selbst für jede Antwort ≥ 400 schreibt;
sie wird je Fall einzeln und mit dem erwarteten Status zugelassen — und beim
abgelehnten Entsperrversuch sogar als Zusicherung *abgeholt*
(`konsole.erwartet`). Ein pauschales Ignorieren gibt es nicht.

**Spuren nur bei Fehlschlag, und nie im Repository.** Eine Spur der
Unterzeichnungsseite trägt den rohen Zugangstoken aus dem Fragment und Namen
aus dem Demobestand. `test-results/` und `playwright-report/` stehen deshalb in
`.gitignore`.

## Was empirisch bewiesen ist — und was nicht

Diese Trennung ist Absicht; eine Prüfung, die mehr behauptet als sie misst, ist
schlimmer als keine.

**Bewiesen:**

- PDF.js startet seinen Worker aus `/pdfjs/<Version>/` unter der ausgelieferten
  CSP und rastert Seiten sichtbar auf eine Leinwand (gemessen an den Bildpunkten,
  nicht am Vorhandensein eines `<canvas>`).
- Kein Abruf verlässt den eigenen Ursprung.
- Eine Mausbewegung auf dem Unterschriftenfeld erzeugt eine Unterschrift, die
  Maske gibt daraufhin frei, und der Vorgang wird als `DRAWN` mit abgelegtem
  Artefakt festgehalten.
- Die Gerätesperre hält gegen zweiten Tab, Zurück, Vorwärts, Neuladen,
  geschlossenen Tab, direkt eingetippte Adressen und entfernte Cookies — geprüft
  am Statuscode eines angemeldeten Endpunkts, nicht an einer Umleitung.
- Ein zweiter `BrowserContext` derselben Person bleibt benutzbar.

**Nicht bewiesen, ausdrücklich:**

- **Ein physischer Digitizer.** Die Berührungen auf dem Telefonbildschirm sind
  echte Touch-Ereignisse der Browser-Engine (`Input.dispatchTouchEvent` über
  CDP), aus denen Chromium Pointer-Events ableitet. Druck, Radius, Vorhersage
  und das Zusammenfassen mehrerer Bewegungen eines echten Geräts sind damit
  nicht geprüft.
- **Andere Browser — nur teilweise.** Die Gate-Fälle (Signatur, Gerätesperre,
  PDF) laufen nur in Chromium. Seit 2026-09-28 fährt Firefox die
  `*.browser.spec.ts` sowie Rabattauswahl, Scanner und Sitzungstabs, seit
  2026-10-01 auch den Leerlauf (`MEHRERE_ENGINES` in `playwright.config.ts`);
  WebKit fährt die `*.browser.spec.ts` und — über die HTTPS-Vorschaltung —
  `angemeldet.webkit.spec.ts`. Über `http://127.0.0.1` schickt WebKit die
  `Secure`-Cookies nicht mit (`docs/PENDENZEN.md`, W-02), deshalb laufen die
  übrigen angemeldeten Fälle dort nicht.

## Engines und Bilanz

| Projekt | Fährt |
|---|---|
| `chromium` | alle Dateien ausser `*.webkit.spec.ts` |
| `firefox` | `*.browser.spec.ts`, `offerte-rabatt`, `scan`, `sitzung-tabs`, `sitzung-leerlauf` |
| `webkit` | `*.browser.spec.ts`, `*.webkit.spec.ts` (über `scripts/test-https-vorschaltung.ts`) |

Seit 2026-09-30 zählt der Prüfweg die Browserreihe **je Engine** aus dem
JSON-Bericht (`test-results/playwright-bericht.json`): übersprungen, wackelig,
unerwartet oder kein Bericht ist ein Fehlschlag, und in der vollen Reihe
braucht jede der drei Engines mindestens einen bestandenen Fall. Die
Stressreihe (`npm run e2e:stress`) zählt ebenso aus dem Bericht, je Lauf und
je Engine, und sichert jeden roten Lauf.
- **PDF-JavaScript in jeder Form.** Geprüft ist ein Prüfobjekt mit
  `/OpenAction` und benanntem `/JavaScript`-Baum. Dass PDF.js nichts davon
  ausführt, ist an zwei unabhängigen Stellen gemessen (kein Dialog, keine
  Anfrage nach der Skript-Sandbox). Eine erschöpfende Untersuchung aller
  PDF-Aktionstypen ist das nicht.

## CI (erledigt)

Hier stand bis Gate 4D.1, `npm run e2e` sei ein lokaler Befehl und die
Pipeline bewusst unverändert. Das ist überholt: Der Auftrag „Prüfung" in
`.github/workflows/deploy.yml` installiert die drei Engines (Schritt „Browser
installieren"), startet den Testserver gegen eine Datenbank als Dienst und
fährt die Browserreihe in `verify:tests` mit derselben Bilanz je Engine; ein
Fehlschlag blockiert die Auslieferung (`needs: qualitaet`). Bei einem
Fehlschlag wird der Bericht als Artefakt `playwright-bericht` abgelegt. Die
Stressreihe läuft nur örtlich über `verify:release`.
