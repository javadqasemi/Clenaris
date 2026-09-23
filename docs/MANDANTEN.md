# Mandantentrennung

> Stand: 23. September 2026 (Wave 16). Betrieb: einmandantig (fester Slug,
> `getOrganizationId()`); Datenmodell: mehrmandantig (`organizationId`).

## 1. Beweisführung

Mit nur einer Organisation im Bestand ist ein fehlender Mandantenfilter
unsichtbar. Die Prüfreihe legt deshalb eine **fremde Organisation** an
(`fremdeOrganisation()` in `tests/helpers/testdb.ts`) und prüft gegen sie:

| Prüfung | Datei | Ergebnis |
|---|---|---|
| Kundschaft, Objekte, Anfragen, Offerten, Einsätze, Rechnungen, Ausgaben, Lieferanten: nicht in der Liste, einzeln 404, Ändern/Löschen 404, Datensatz unverändert | `tests/api/mandanten.test.ts` | VERIFIED |
| Offerte/Rechnung/Besichtigung/Reklamation an fremde Kundschaft; fremdes Objekt an eigener Offerte | `tests/api/mandanten.test.ts` | VERIFIED |
| Kundenkonto sieht keine fremden Objekte/Rechnungen | `tests/api/mandanten.test.ts` | VERIFIED |
| Lohn: fremde Satzversion und Position weder gezeigt noch verrechnet, fremder Quellensteuertarif greift nicht | `tests/api/lohnabrechnung.test.ts` | VERIFIED |
| Material einer fremden Organisation weder gelistet noch buchbar | `tests/api/betrieb.test.ts` | VERIFIED |

## 2. Befunde und Korrekturen dieser Waves

| Befund | Wirkung | Stand |
|---|---|---|
| `createQuote` übernahm Kundschaft, Anfrage und Objekt ungeprüft | Offerte mit Bezug auf fremde (oder nicht existierende) Daten; ihr PDF hätte fremde Adressen gedruckt | behoben (Wave 12), Prüfung in der Transaktion |
| Prüfreihe und zwei Skripte nahmen „die erste Organisation" (`findFirst()` ohne Slug) | mit einer zweiten Organisation die falsche | behoben (Wave 9): `eigeneOrganisationId()`, Skripte über den Slug |
| Mediathek konnte Signatur- und Lohnbelege löschen/umordnen | Zugriff von `payslip:read_all` auf `media:read` lockerbar | behoben (Wave 9) |
| `EmailLog`/`SmsLog` ohne `organizationId` | im Mehrmandantenbetrieb sähe jede Organisation alle Versände | OFFEN — im einmandantigen Betrieb ohne Wirkung; vor einem Mehrmandantenbetrieb nachzurüsten |
| `Payment` ohne `organizationId` | Filter über Rechnung oder Kundschaft (bestehend, beide Wege) | bewusst so, dokumentiert in der Zahlungsroute |
| `getOrganization()` fällt ohne passenden Slug auf „die erste Organisation" zurück | falsch konfigurierter Slug trifft irgendeine Organisation | OFFEN — für den Mehrmandantenbetrieb durch Auflösung je Domain ersetzen |

## 3. Was „mehrmandantig" hier nicht heisst

Kein Mandantenwechsel, keine Auflösung je Domain, keine Zeilen-Sicherheit in
der Datenbank (RLS). Die Trennung beruht auf dem `where` jeder Abfrage und
ist durch die Prüfreihe für die Kernbereiche belegt, nicht für jede der
rund 520 Operationen. Vor einem echten Mehrmandantenbetrieb: RLS oder
Abfrage-Middleware, Mandant je Domain, Protokolltabellen mit Mandant.
