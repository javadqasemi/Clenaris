# Testabschluss und Merkmalsprüfung (Wave 23)

Stand 2026-09-23.

## 1. Der datenabhängige `skip`

Jeder volle Lauf von `npm test` endete mit genau einem übersprungenen Fall:
`website-ops.test.ts` › „löscht kein Angebot mit Bewerbungen". Er suchte ein
Stellenangebot mit Bewerbungen im Demobestand und übersprang sich, wenn keines
da war — die Löschsperre wurde also nie geprüft.

**Jetzt deterministisch:** Der Fall legt ein eigenes Angebot über die API an,
eine Bewerbung direkt in der Datenbank, erwartet 422 beim Löschen (und dass
das Angebot noch existiert), entfernt die Bewerbung und erwartet dann 204 —
die Gegenprobe, dass die Sperre an den Bewerbungen hängt. Aufgeräumt wird
vorher und in `finally`. Status: **COMPLETE + VERIFIED** (44/44 in der Datei,
0 übersprungen).

Die übrigen `skip`-Stellen der Reihe greifen nur ohne Testdatenbank, ohne
dateibasierte Zähler (`rate-limit.test.ts`) oder in den ersten drei Stunden nach
Mitternacht Zürcher Zeit (`betrieb.test.ts`) — Umgebungsbedingungen, keine Datenlücken.

## 2. Merkmalsprüfung (`npm run audit:merkmale`, nur Warnung)

Die Prüfung sucht Modelle ohne Schreibpfad, Schreibzugriffe am Dienst vorbei
und schreibende Endpunkte ohne Aufruf aus der Oberfläche. Sie ist eine
Textsuche — sie findet Kandidaten, keine Urteile. Jeder Befund wurde deshalb
einzeln nachgesehen.

### Behoben in dieser Wave — Endpunkt ohne Maske

| Endpunkt | Seit | Jetzt | Beweis |
|---|---|---|---|
| `PUT /api/payroll/profiles/:employeeId` | Wave 9 (Feldliste lag fertig, unbenutzt) | Abschnitt „Lohnvereinbarungen" in `/admin/personal/[id]`, nur mit `payslip:create` | `wave23-masken.spec.ts` gegen die Datenbank |
| `POST /api/time/approve` | Wave 8 | Abschnitt „Offene Zeiten" in `/admin/lohn` — dasselbe Monatsfenster wie der Lohnlauf, höchstens 200 wie der Endpunkt | ebenda |
| `POST /api/jobs/:id/material-issue` | Wave 11 | „Aus dem Lager" im Materialabschnitt des Einsatzes, nur mit `inventory:manage` | ebenda |

Die Browser-Prüfung fand dabei einen **Produktfehler**: Der Materialeditor
des Einsatzes übernahm die Zeilen einmal in seinen Zustand; nach einer
Entnahme lud die Seite neu, zeigte die neue Zeile aber erst nach einem harten
Neuladen. Behoben mit einem Schlüssel aus den Zeilenkennungen.

### Falsch-positiv — Aufruf mit zusammengesetztem Pfad

| Endpunkt | Tatsächlicher Aufruf |
|---|---|
| `/api/{bookings,customers,invoices,jobs,leads,properties,quotes}/[id]/restore` | `/admin/papierkorb` über `RESTORE_PATH[…]/${id}/restore` |
| `/api/time/clock-in`, `/api/time/clock-out` | `features/portal/time-clock.tsx`, Pfad aus der Richtung zusammengesetzt |
| `/api/files/upload-url`, `/api/files/finalize` | `src/lib/upload.ts` (ausserhalb der von der Prüfung durchsuchten Komponenten) |

### Offen — PARTIAL, bewusst nicht in dieser Wave

> **Nachtrag 2026-09-27:** Alle Zeilen dieser Tabelle sind inzwischen
> geschlossen — Freigabe aufheben in der Einsatzakte, Tarifimport,
> Bestätigen sowie Profil ändern und beenden in `/admin/lohn`, Signatur
> „Erneut senden"/„Abbrechen", „Heute festschreiben" im Cockpit, und die
> Schreibzugriffe liegen in `message`-, `supplier`-, `expense`-, `content`-
> und `website.service`. Die Tabelle bleibt als Stand der damaligen Wave
> stehen; Belege in `security/merkmale-geprueft.json` und
> `docs/FINAL_REMEDIATION_MATRIX.md`.

| Befund | Bewertung |
|---|---|
| `POST /api/time/:id/reopen` ohne Maske | Freigabe aufheben geht nur über die API. Selten gebraucht, aber ohne Maske muss für eine Korrektur nach der Freigabe jemand mit Schnittstellenzugang ran |
| `/api/payroll/withholding/rates` (+ `/verify`) ohne Maske | Quellensteuertarife einlesen und bestätigen nur über die API. Ohne eingelesenen Tarif rechnet der Lauf keine Quellensteuer, sondern verlangt eine Prüfung (fail-closed) — sicher, aber umständlich |
| `PATCH/DELETE /api/payroll/withholding/profiles/:id` ohne Maske | Erfassen geht in `/admin/lohn`, Ändern und Beenden nicht |
| `/api/signatures/:id/send`, `/api/bi/cockpit/health`, `/api/bi/kpis/weights` | Aus früheren Gates, nicht in dieser Mission entstanden; nicht weiter untersucht |
| Schreibzugriffe im Endpunkt statt im Dienst (`Message`, `Supplier`, `Expense`, `SeoMeta`, `JobApplication`) | Bestand aus der Zeit vor der Dienstregel; Schutz (Berechtigung, Schema, Organisation im `where`) ist vorhanden, die Regel „nur Dienste schreiben" ist verletzt |
| `PipelineStage`, `Tag`, `Building` ohne Schreibpfad | Im Schema und in der Oberfläche erwähnt, nie beschreibbar — halbe Merkmale aus der Anfangszeit |

Die Prüfung bleibt in der Pipeline eine Warnung (`deploy.yml`, Stufe
„Merkmalsprüfung"): Ein Befund blockiert nicht, der Bericht hängt am Lauf.
