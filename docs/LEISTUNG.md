# Leistung (Wave 19)

Stand 2026-09-23, Grössenbudgets ergänzt 2026-09-29 (Abschnitt „Grössenbudgets
als Tor"). Status: **COMPLETE** für die Messung und den einen
gefundenen Ausreisser; **EXTERNAL VERIFICATION REQUIRED** für jede Aussage
über die Produktion (andere Maschine, anderes Netz, echter Datenbestand).

## Wie gemessen wird

`scripts/leistungsmessung.ts` gegen den Produktionsbau auf dem Testserver
(`npm run test:server`, :3001): zwei Aufwärmrunden, dann 15 Proben je Ziel,
Wanduhr beim Client; Endpunkte liefern zusätzlich `Server-Timing: app;dur=…`.
Proben, die in ein Rate-Limit liefen, werden verworfen.

Bewusst **keine Testreihe mit Zeitbudget** — eine Millisekundenschwelle hängt
an Maschine und Datenbestand und wird auf dem nächsten Rechner rot oder nie.
Das Skript ist für den Vergleich vorher/nachher auf derselben Maschine.

**Umgebung der Zahlen unten:** Entwicklungsrechner (Windows 11), PostgreSQL
lokal, Client auf derselben Maschine — also ohne Netzlatenz und ohne TLS.
Datenbestand der Testdatenbank nach vielen Testläufen: 14 436 Einsätze,
893 Offerten, 300 Rechnungen, 59 Kundschaften, 36 515 Protokolleinträge,
3 974 Benachrichtigungen.

## Messwerte (nach der Behebung, 15 Proben)

| Rolle | Ziel | Median ms | p95 ms | Server ms | KB |
|---|---|---:|---:|---:|---:|
| admin | `/admin` | 64 | 72 | — | 153 |
| admin | `/admin/kalender` | 46 | 53 | — | 84 |
| admin | `/admin/buchungen` | 117 | 138 | — | 139 |
| admin | `/admin/einsaetze` | 131 | 146 | — | 166 |
| admin | `/admin/kunden` | 130 | 241 | — | 157 |
| admin | `/admin/rechnungen` | 103 | 135 | — | 152 |
| admin | `/admin/offerten` | 53 | 109 | — | 134 |
| admin | `/admin/lohn` | 42 | 55 | — | 132 |
| admin | `/admin/suche?q=Reinigung` | 32 | 39 | — | 92 |
| admin | `/admin/fuehrung` | 60 | 79 | — | 219 |
| admin | `/admin/auswertungen` | 49 | 57 | — | 126 |
| admin | `/api/customers` | 18 | 30 | 9 | 26 |
| admin | `/api/invoices` | 16 | 23 | 9 | 30 |
| admin | `/api/jobs?pageSize=50` | 26 | 33 | 17 | 95 |
| admin | `/api/search?q=Reinigung` | 18 | 23 | 10 | 2 |
| admin | `/api/notifications/count` | 15 | 22 | 5 | 0 |
| employee | `/portal` | 27 | 33 | — | 48 |
| employee | `/portal/einsaetze` | 72 | 87 | — | 218 |
| customer | `/konto` | 34 | 45 | — | 67 |
| customer | `/konto/rechnungen` | 26 | 31 | — | 43 |
| — | `/` | 8 | 24 | — | 152 |
| — | `/offerte` | 9 | 17 | — | 98 |

Die Streuung zwischen zwei Läufen lag bei rund Faktor 1.5 (ein Lauf direkt
nach dem Bau war durchgehend langsamer) — Einzelwerte sind Grössenordnungen,
keine Zusagen.

Client-JavaScript (`next build`, First Load JS): gemeinsam 103 kB, die
grössten Seiten `/admin/website` 250 kB, `/admin/einstellungen` 242 kB, die
Profilseiten 241 kB, `/buchen` 234 kB. Kein Handlungsbedarf festgestellt.

## Befund und Behebung

| Ziel | Vorher | Nachher | Ursache |
|---|---|---|---|
| `/portal/einsaetze` | 298 ms Median, 457 ms p95, **1 396 KB** HTML | 72 ms, 87 ms, 218 KB | 60 Tage Einsätze ohne Grenze gerendert (317 Karten im Prüfbestand). Jetzt 40 je Reiter mit „Alle anzeigen" (`?alle=1`), die Reiter nennen die volle Zahl, Erledigtes neueste zuerst |

### Obergrenzen (Phase 23, 2026-09-27)

Eine Durchsicht des aktuellen Codes (nicht der Messwerte oben) nach
ungebremsten Abfragen. Behoben, geprüft in `tests/api/grenzen.test.ts`:

| Stelle | Vorher | Jetzt |
|---|---|---|
| `GET /api/jobs/calendar` | jeder Zeitraum, jeder Einsatz mit Kundschaft, Adresse, Team | höchstens 62 Tage (Monatsansicht braucht 42), sonst 422 |
| Exporte (`/api/exports/*`, Buchhaltung) | jeder Zeitraum, alles im Speicher | höchstens ein (Schalt-)Jahr, sonst 422 |
| `/admin/benutzer`, `GET /api/users` | alle Konten samt gelöschten, getrennt im Speicher; wächst mit der registrierten Kundschaft | Suche, Rollenfilter und Seiten in der Datenbank (50 je Seite, höchstens 100), `meta` mit Gesamtzahl |
| `/portal/einsaetze?alle=1` | Grenze ganz aufgehoben | höchstens 300, danach Verweis auf den Kalender |
| `/admin/papierkorb` | eine Abfrage je gelisteter Zeile (bis 700) | Beschriftung aus der Listenabfrage |
| Zeitfreigabe (bis 200 Erfassungen) | eine Lohnabfrage je Erfassung | eine Abfrage über die betroffenen Monate |
| `GET /api/properties`, `/api/reviews`, `/api/absences` | ohne Grenze | 200 / 200 / 500, Reihenfolge wie bisher |

Bewusst nicht geändert, mit Begründung:

- **Lohnlauf und Veröffentlichung** rechnen je Person nacheinander (bis 500
  Personen, beim Veröffentlichen mit PDF). Ohne Auswahl läuft ohnehin jede
  aktive Personalakte; bei 6–15 Mitarbeitenden eines Reinigungsbetriebs sind
  das Sekunden. Wächst der Betrieb um eine Grössenordnung, gehört der Lauf in
  eine Warteschlange statt in die Anfrage.
- **Kundenexport** (`/api/exports/kunden`) hat keinen Zeitraum, weil er den
  Stamm beschreibt; er wächst mit der Kundschaft, nicht mit der Zeit.
- **Liquiditätsvorschau** und **KI-Namensschwärzung** lesen offene Posten
  bzw. alle Namen je Aufruf. Beides ist durch die Sache begrenzt (offene
  Posten; der Assistent ist Verwaltung und hat ein eigenes Kontingent).
- Seiten mit Personalbestand (`/admin/personal`, Saldo je Person) — begrenzt
  durch die Zahl der Mitarbeitenden.

Die Indizes der gemessenen Abfragen sind vorhanden (`jobs(organizationId,
status, scheduledStart)`, `job_assignments(employeeId)`,
`invoices(organizationId, status, dueDate)`, `customers(organizationId,
deletedAt)` u. a.); kein Endpunkt braucht serverseitig mehr als 20 ms.

## Grössenbudgets als Tor (seit 2026-09-28 / 2026-09-29)

Die Millisekunden oben bleiben eine Beobachtung. Als **Tor** dienen Grössen,
weil sie auf jeder Maschine dieselbe Zahl ergeben: `scripts/leistungsbudget.ts`
gegen `scripts/leistungsbudget.json`, Budget = Messung + 10 %, auf 5 kB
aufgerundet, Erhöhung nur mit Begründung im Commit.

- **JavaScript je Route** (gzip, aus dem Bau) — seit 2026-09-28 im Prüfweg
  direkt nach dem Bau (`verify:full`, CI-Stufe „Leistungsbudget").
- **HTML je Seite** (ungepackt, angemeldet, gegen den Testserver) — seit
  2026-09-29 im Prüfweg vor den Prüfreihen (`--nur-html`), solange der Bestand
  der Demobestand ist. Gemessen am Release-Kandidaten mit gebrauchtem
  Testbestand: Startseite 192 kB, `/buchen` 102 kB, `/admin/vertraege` 153 kB,
  `/admin/personal` 138 kB, `/admin/einsaetze` 167 kB, `/portal/einsaetze`
  126 kB (vorher 1.4 MB, siehe oben).

Beobachtung ohne Tor, am selben Tag und auf derselben Maschine (Median aus
fünf Abrufen nach einer Aufwärmrunde, Client lokal): `/admin/vertraege` 88 ms,
`/admin/personal` 90 ms, `/buchen` 69 ms.

## Nicht gemessen

- **Last:** gleichzeitige Nutzer, Verbindungspool, Verhalten unter
  Rate-Limit-Druck. Die Messung ist seriell.
- **Grössere Bestände:** die Suche arbeitet mit `contains`/`insensitive`
  ohne Trigramm-Index — bei einem Vielfachen des heutigen Bestands zuerst
  prüfen (`pg_trgm`).
- **Browser-Kennzahlen** (LCP, INP, CLS) und das Verhalten auf einem
  Mobilgerät über Mobilfunk.
- Produktion (Hetzner, Proxy, TLS) — **EXTERNAL VERIFICATION REQUIRED**.
