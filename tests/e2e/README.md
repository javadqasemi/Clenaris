# Browser-Prüfungen (Gate 4D.1)

Diese Reihe fährt die Anwendung in einem echten Chromium. Sie **ergänzt** die
809 Prüfungen unter `tests/api` und `tests/pages` und ersetzt keine einzige
davon.

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
npm run e2e:install        # einmal: Chromium herunterladen
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
| `wave10-vertraege.spec.ts` | Die Vertragsmasken (Wave 10) — fünf Wege: Einsatzplan im Dialog → Inkraftsetzung → Einsätze **mit ihrer Fassung**; Fassung zur Unterschrift → im Browser gezeichnet → angenommen → danach eingefroren (Maske weg *und* Endpunkt 422); zweimal durch die Abrechnungsmaske ergibt **eine** Rechnung; Antrag → Freigabe → neue Fassung, bestehender Einsatz bleibt bei Fassung 1; Pause hält den Planer an, Fortsetzen lässt ihn weiterplanen |

Die Helfer liegen in `helpers/`: Prüfbestand über die Schnittstelle
(`bestand.ts`), Konsolen- und Netzwächter, Anmeldung, Tokenhygiene und die
beiden Zeichenwege (`browser.ts`), kontrollierte PDF-Prüfobjekte
(`pdf-fixtures.ts`).

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
- **Andere Browser.** Gefahren wird Chromium. Firefox und WebKit sind nicht
  Teil dieser Reihe.
- **PDF-JavaScript in jeder Form.** Geprüft ist ein Prüfobjekt mit
  `/OpenAction` und benanntem `/JavaScript`-Baum. Dass PDF.js nichts davon
  ausführt, ist an zwei unabhängigen Stellen gemessen (kein Dialog, keine
  Anfrage nach der Skript-Sandbox). Eine erschöpfende Untersuchung aller
  PDF-Aktionstypen ist das nicht.

## Offener Punkt: CI

`npm run e2e` ist ein lokaler Befehl. Die Auslieferungs-Pipeline
(`.github/workflows/`) wurde bewusst **nicht** verändert: Ein Browserlauf in CI
braucht `playwright install --with-deps chromium` in einem Runner-Image, eine
Datenbank als Dienst und eine Entscheidung darüber, ob ein Fehlschlag die
Auslieferung blockiert. Das gehört in einen eigenen Schritt und nicht in einen
Nebensatz dieses Gates.
