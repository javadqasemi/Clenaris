# Terminverfügbarkeit und Buchungsintegrität

Stand 2026-09-26. Code: `src/lib/scheduling/verfuegbarkeit.ts` (reiner Kern),
`src/server/services/availability.service.ts` (Daten), `booking.service.ts`
(Anlegen, Verschieben, Bearbeiten). Prüfungen:
`tests/api/verfuegbarkeit-rechenkern.test.ts`,
`tests/api/mehrere-leistungen.test.ts`, `tests/api/buchung-integritaet.test.ts`.

## Eine Prüfung für alles

Angebotene Zeitfenster, Abschluss einer Buchung, Verschieben und Bearbeiten im
Büro gehen durch dieselbe Funktion (`pruefeZeitraum`). Anlegen, Verschieben
und Bearbeiten prüfen **innerhalb der schreibenden Transaktion** hinter einer
Transaktionssperre je Organisation; zwei Anfragen für den letzten Platz ergeben
genau eine Buchung.

| Frage | Quelle der Wahrheit |
|---|---|
| Wann finden Einsätze statt? | `OpeningHours` — Einsatzzeiten, sonst Öffnungszeiten; kein fester Rückfall |
| Welche Tage sind gesperrt? | `Holiday`; `recurring` nur für feste Daten (Neujahr, Bundesfeier …) |
| Wie lange dauert die Auswahl? | Preis-Engine (`estimateBookingEffort`): Summe der Leistungen |
| Vorlauf, Horizont | `Organization.settings` (`bookingMinNoticeHours`, `bookingLeadDays`); das Büro ist nicht daran gebunden |
| Wer kann arbeiten? | aktive Mitarbeitende, ihre `Availability`, bewilligte `Absence` |
| Was ist belegt? | `Job` (nicht storniert) + `Booking` ohne Einsatz (offen/bestätigt), samt „Puffer zwischen Einsätzen" |

## Befunde vom 2026-09-26 und ihre Einordnung

| Befund | Einordnung | Stand |
|---|---|---|
| Rechnung aus Einsatz verliert Grundpauschale, Zusatzleistungen, Anfahrt, Rabatte | **Fehler** (Finanzintegrität) | behoben: Die Rechnung übernimmt die gespeicherte Preisherleitung der Buchung (`rechnungsgrundlageAusBuchung`); `Rechnung.netTotal = Buchung.netTotal` ist geprüft |
| Abgewiesene Gastbuchung legt Kundenakte an | **Fehler** (Datenintegrität) | behoben: Die Akte entsteht in der Transaktion der Buchung |
| `updateBooking` ändert Termin/Dauer/Team ohne Verfügbarkeitsprüfung | **Fehler** | behoben: dieselbe Prüfung in der Transaktion; ausdrückliches, protokolliertes Übersteuern wie bei der Erfassung im Büro |
| Bewegliche Feiertage als „wiederkehrend" gespeichert | **Fehler** (Daten, sichtbar geworden durch die Verfügbarkeit) | behoben: Seed rechnet Osterfeiertage je Jahr, Migration `20260926120000_bewegliche_feiertage` korrigiert Bestände |
| Leistungen kennen keine erforderlichen Qualifikationen | **fehlende Funktion** | offen — `Service` hat kein Qualifikationsfeld (nur `ContractService.requiredSkills`). Die öffentliche Kapazität zählt alle verfügbaren Personen; die Eignung prüft die Zuteilung (`assignment.service.ts`) |
| Kapazität als Personenpool | **technische Schuld**, zeitlich vorsichtig | offen — Belegungen werden vom Pool abgezogen, nicht einer Person zugeordnet. Zeitlich kann das nicht überbuchen (wer zu einer Minute gebunden ist, zählt die ganze Zeit), es kann aber einen Termin ablehnen, den eine exakte Personenplanung zuliesse |
| Einsatzfenster über Mitternacht (22:00–02:00) | **definierte Produktgrenze** | nicht unterstützt und ausdrücklich abgewiesen (Einstellungen: „Ende nach Beginn"). Ein Fenster gehört zu genau einem Kalendertag; ein Nachteinsatz über Mitternacht wird im Büro erfasst |
| `e2e:stress` nach dem Sprint nicht gelaufen | Prüflücke | im Abschluss dieser Mission gelaufen (siehe `docs/RELEASEBEREITSCHAFT.md`) |

## Einsatzfenster über Mitternacht — warum nicht jetzt

Ein Fenster 22:00–02:00 gehört zu zwei Kalendertagen: Feiertag, Arbeitszeit,
Abwesenheit und Belegung müssten je Teil gegen den richtigen Tag geprüft
werden, an Umstellungstagen hat die Nacht 23 oder 25 Stunden, und die
Arbeitszeiten der Mitarbeitenden (`Availability`) kennen ebenfalls kein
„bis morgen". Halb umgesetzt würde das falsche Termine anbieten. Solange kein
Betrieb es verlangt, bleibt es eine benannte Grenze: Die Einstellungsmaske
weist ein Ende vor dem Beginn ab, der Kern rechnet je Tag.

## Rechnung aus Einsätzen

Die Rechnung übernimmt die Preisherleitung der Buchung: Positionen, Zusätze,
Anfahrt als Zeilen, Rabatte als Rechnungsrabatt, Zuschläge (Preisregeln,
Express, Mindestauftragswert) als benannte Zeilen oder — wo die Herleitung sie
nicht einzeln hergibt — als eine Differenzzeile. Die MwSt. rechnet die
Rechnung je Position (MWSTG); gegenüber der auf dem Total gerundeten
Buchungs-MwSt. kann das um einen Rappen je Position abweichen.

Eine von Hand bearbeitete Buchung (`pricing:update`) trägt die Beträge der
Bearbeitung; das ist die ausdrückliche Übersteuerung der Engine durch die
Verwaltung, nicht eine zweite Formel.

Offene technische Schuld: Rechnungsbeträge werden als Zahlen gerechnet und je
Schritt auf Rappen gerundet (`round2`), gespeichert als `Decimal(12,2)` — nicht
durchgehend mit einem Dezimaltyp. Für Beträge dieser Grössenordnung ist das
nach jeder Rundung exakt; eine Umstellung wäre eine eigene Änderung des ganzen
Finanzmoduls.
