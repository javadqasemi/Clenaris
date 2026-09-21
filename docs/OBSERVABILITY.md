# Beobachtbarkeit

> Stand: 21. September 2026 (Wave 5). Im Prozess, **ohne Anbieter**.

---

## 1. Die Abgrenzung zuerst

Was hier entsteht, ist die **Erhebung** an der richtigen Stelle — nicht ein
Beobachtungssystem. Kein Prometheus, kein Datadog, kein Sentry, keine
Ausleitung, keine Zeitreihe.

Das ist eine Entscheidung und kein Zwischenstand. Ein Kennzahlendienst ist eine
Betriebsentscheidung mit Kosten, Datenschutzfragen und einem zweiten System,
das laufen muss — und sie gehört dem Betrieb, nicht dem Code. Was der Code
beitragen kann, ist:

- an jeder Anfrage eine **Kennung**, die sich durch das Protokoll zieht,
- an jedem Endpunkt eine **Messung**, die nicht vergessen werden kann,
- eine **Ausgabe**, die ein späterer Sammler lesen könnte.

Alles drei steht jetzt da. Die Entscheidung über einen Sammler bleibt offen.

---

## 2. Die Anfragekennung

### Das Problem

Bis Wave 5 stand in jeder Protokollzeile ein Bereich, eine Meldung und ein paar
Felder. Was fehlte, war die Klammer: *Welche Zeilen gehören zu derselben
Anfrage?* Unter Last liegen die Zeilen zweier gleichzeitiger Anfragen
verschränkt im Protokoll, und keine von ihnen sagt, zu welcher sie gehört.

Damit war die häufigste Frage im Betrieb nicht beantwortbar. Jemand meldet „bei
mir kam ein Fehler, so gegen halb drei" — und man hat den Fehler im Protokoll,
aber nicht, was davor geschah.

### Die Lösung

| Wo | Was |
|---|---|
| Antwortkopfzeile | `X-Request-Id: <uuid>` an **jeder** Antwort, auch bei 401 und 500 |
| Antwortkopfzeile | `Server-Timing: app;dur=<ms>` — im Browser-Werkzeug sichtbar |
| Protokollzeile | `requestId` in der JSON-Zeile; in der Entwicklung die ersten acht Zeichen vor der Meldung |
| Fehlerrumpf (nur 500) | `Kennung: <uuid>` in der Meldung **und** als Feld `requestId` |

Die Kennung im Rumpf steht **nur bei 500**. Die Kopfzeile liest niemand, wenn
etwas schiefgeht — man sieht die Meldung auf dem Bildschirm und schreibt eine
Nachricht. Steht die Kennung in der Meldung, steht sie in dieser Nachricht.
Bei einem abgelehnten Zugriff oder einer ungültigen Eingabe fehlt sie
absichtlich: Die brauchen keine Nachforschung, und eine Kennung an jeder Absage
lädt dazu ein, sie zu sammeln.

### Zwei Entscheidungen dahinter

**`AsyncLocalStorage`, nicht Weitergabe von Hand.** Die Alternative wäre, die
Kennung durch jede Funktion zu reichen — hunderte Signaturen, und die eine, die
es vergisst, ist genau die, in der der Fehler auftritt. Der Preis: ein Modul,
das nur unter Node läuft, nicht in der Edge-Middleware. Hinnehmbar, weil die
Middleware ein Vorfilter ist und die Kennung im Handler entsteht, durch den
jede Anfrage ohnehin läuft.

**Eine mitgeschickte Kennung wird nicht übernommen.** Viele Proxys setzen
`X-Request-Id`, und es ist verlockend, sie zu übernehmen. Sie ist aber eine
*Behauptung* — genau wie `X-Forwarded-For`. Wer sie übernähme, liesse jemanden
beliebig viele Protokollzeilen unter einer Kennung seiner Wahl ablegen, etwa
unter der einer echten Anfrage, die er stören will. Eine Prüfung hält das fest.

Die Kennung kommt aus dem CSPRNG, nicht aus einem Zähler: Eine fortlaufende
Nummer verriete, wie viele Anfragen die Anwendung bekommt.

---

## 3. Kennzahlen

### Wo gemessen wird

In der Handlerfabrik (`src/lib/api/handler.ts`) — derselben Stelle, an der
schon Herkunftsprüfung, Sitzung, Gerätesperre, Rechte und Rate-Limit sitzen.
Die Begründung ist dieselbe: **Eine Messung in den einzelnen Handlern wäre eine
Messung, die in dem einen vergessen wird, der sie gebraucht hätte.** Alle drei
Fabriken sind umschlossen, auch `defineCronRoute` — gerade der nächtliche Lauf
ist die Anfrage, die am ehesten stillschweigend scheitert.

### Was gemessen wird

Je **Route-Vorlage und Methode**:

| Feld | Bedeutung |
|---|---|
| `anfragen` | Anzahl |
| `status` | Verteilung auf 2xx / 3xx / 4xx / 5xx |
| `dauerMittelMs`, `dauerMaxMs` | Mittelwert und Maximum |
| `p50Ms`, `p95Ms` | Quantile, geschätzt aus Zeitklassen |

Zeitklassen: 5, 25, 50, 100, 250, 500, 1000, 2500, 5000 ms, darüber offen. Die
Werte sind an der Anwendung ausgerichtet, nicht an einer Norm: 5 ms ist ein
Zwischenspeichertreffer, 250 ms eine Listenseite mit Verknüpfungen, 1 s die
Schwelle, ab der ein Mensch wartet, 5 s ein PDF-Aufbau.

**Das Quantil ist die Obergrenze der Klasse** — ein Wert, der die Wahrheit nie
unterschätzt. Das ist die richtige Richtung für eine Zahl, nach der jemand
entscheidet: „p95 unter 250 ms" darf nicht in Wahrheit 400 ms heissen. Liegt
das Quantil in der offenen Klasse, kommt `null`; eine erfundene Obergrenze wäre
schlimmer als die Auskunft „darüber".

### Die Vorlage ist der Kern

`/api/jobs/clx123/team` wird zu `/api/jobs/:id/team`.

Ohne diesen Schritt entstünde eine Reihe **je Datensatz**: Bei zehntausend
Einsätzen zehntausend Reihen, von denen keine genug Beobachtungen für eine
Aussage hätte — und die Registrierung wüchse mit den Daten. Das ist der
klassische Fehler bei Kennzahlen, und er fällt erst im Betrieb auf, als
Speicherverbrauch.

Ersetzt wird über den **Wert**, nicht über die Position: Ein Parameter kann an
jeder Stelle stehen. Werte unter drei Zeichen bleiben stehen — ein
einzeichiger Wert käme sonst in jedem zweiten Pfadsegment vor.

Eine Prüfung durchsucht die laufenden Kennzahlen nach cuids und Hexwerten:
Findet sie eine, ist die Vorlagenbildung kaputt.

### Die Grenzen — sie stehen in der Antwort

**Je Prozess.** Zwei Instanzen sehen je ihre eigenen Anfragen. Deshalb liefert
die Antwort `prozessId` und `prozessStartzeit`: Wer zwei Antworten vergleicht,
soll sehen, ob sie vergleichbar sind — statt einen Rückgang zu deuten, der nur
eine Auslieferung war.

**Kein Neustart überlebt.** Für „was ist gerade langsam" reicht das; für „war
das letzten Monat auch so" nicht. Diese zweite Frage beantwortet nur ein
Sammler.

**Höchstens 500 Reihen.** Danach wird nichts mehr aufgenommen und `ueberlauf`
gezählt — die Ausgabe sagt dann, dass sie unvollständig ist, statt es zu
verschweigen. Ohne die Grenze wäre eine fehlerhafte Vorlagenbildung ein
Speicherleck, das mit den Daten wächst.

**Die Erhebung wirft nie.** Eine Kennzahlenerhebung, die eine Anfrage scheitern
lassen kann, ist selbst ein Ausfallgrund — dieselbe Regel wie beim
Prüfprotokoll und beim Sicherheitsstrom.

---

## 4. `GET /api/metrics`

`security:read` — dieselbe Berechtigung wie das Sicherheitszentrum.

Die übliche Bauart eines Kennzahlenendpunkts ist offen, dafür nur im internen
Netz erreichbar. Das setzt ein internes Netz voraus, und in dieser Betriebsform
gibt es keines: Die Anwendung liegt hinter einem Reverse Proxy am offenen
Internet.

Offen wäre der Endpunkt eine Auskunft über den Betrieb — wie viele Anfragen,
welche Endpunkte, wie viele Fehler, wie lange dauert was. Harmlos klingende
Aufklärung mit konkretem Nutzen für jemanden, der einen Angriff plant: Er sieht
in Echtzeit, ob er auffällt.

**Die Antwort enthält keine Personenangaben.** Keine Benutzer, keine Adressen,
keine Nutzlasten, keine Pfade mit Datensatzkennungen. Eine Kennzahl beantwortet
„wie oft und wie lange", nie „von wem". Eine Prüfung durchsucht die ganze
Antwort nach E-Mail-Adressen, IP-Adressen und Hexwerten.

---

## 5. Was im Protokoll landet

| Fall | Stufe | Warum |
|---|---|---|
| Antwort ≥ 500 | `error` | Etwas ist kaputt |
| Antwort ≥ 400 | `debug` | Ein abgelehnter Zugriff ist der **Normalfall** einer funktionierenden Rechteprüfung. Auf `warn` bestünde das Protokoll aus abgewiesenen Anfragen, und niemand läse es |
| Unbehandelter Fehler durch die Hülle | `error` + als 500 gezählt | Selten — ein Fehler in der Fehlerbehandlung selbst. Soll nicht spurlos durchgehen |

Die Maskierung aus `lib/logger.ts` gilt unverändert: E-Mail-Adressen,
Telefonnummern, IBAN, AHV-Nummern und lange Zufallszeichenketten werden
maskiert, bevor eine Zeile hinausgeht.

---

## 6. `GET /api/health`

Unverändert seit Gate 3, hier der Vollständigkeit halber:

- `SELECT 1` prüft Verbindung und Pool, nicht die Daten.
- Die Zahl der angewandten Migrationen beweist, dass das Schema zur
  ausgelieferten Fassung passt.
- **Bei einem Fehler 503, nicht 200 mit einem Feld.** Ein Health Check, dessen
  Aussage im Rumpf statt im Statuscode steht, wird von jedem Load Balancer und
  jedem `curl -f` falsch gelesen.
- `Cache-Control: no-store` — ein zwischengespeicherter Health Check meldet
  „gesund" weiter, während die Instanz längst steht.

---

## 7. Was bewusst fehlt

| Punkt | Wohin | Warum |
|---|---|---|
| Ausleitung an einen Sammler | Betriebsentscheidung | Zweites System, Kosten, Datenschutz. Die Ausgabe ist vorbereitet |
| Zeitreihe über Neustarts hinweg | dito | Ohne Sammler nicht möglich, und ein eigener wäre ein eigenes Produkt |
| Kennzahlen der Dateiprüfung (`ERROR`-Quote, Verweildauer in `SCANNING`) | Wave 6 | Sie hängen an einem wiederkehrenden Lauf, den es noch nicht gibt |
| `ACCESS_DENIED` als Zähler je Konto | Wave 6 | Gehört als Zähler hierher, nicht als Zeile in den Sicherheitsstrom — die Mengenfalle ist dieselbe wie beim geratenen Zugangslink |
| Ablaufverfolgung über Dienstgrenzen (Tracing) | — | Es gibt nur einen Dienst. Die Anfragekennung leistet für einen Prozess dasselbe |

---

## 8. Wo was steht

| Datei | Inhalt |
|---|---|
| `src/lib/observability/context.ts` | Anfragekontext, Kennung, `routenVorlage` |
| `src/lib/observability/metrics.ts` | Registrierung, Zeitklassen, Quantile — rein, direkt prüfbar |
| `src/lib/api/handler.ts` | `mitBeobachtung` um alle drei Fabriken |
| `src/lib/logger.ts` | Zieht die Kennung selbst aus dem Kontext |
| `src/lib/api/response.ts` | Kennung im Rumpf einer 500er-Antwort |
| `src/app/api/metrics/route.ts` | Der Endpunkt |
| `tests/api/beobachtbarkeit.test.ts` | 23 Prüfungen — Registrierung direkt, Verdrahtung über HTTP |
