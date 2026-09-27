# Mandantentrennung

> Stand: 27. September 2026 (Wave 16, Prüfreihe erweitert). Betrieb: einmandantig (fester Slug,
> `getOrganizationId()`); Datenmodell: mehrmandantig (`organizationId`).

## 1. Beweisführung

Mit nur einer Organisation im Bestand ist ein fehlender Mandantenfilter
unsichtbar. Die Prüfreihe legt deshalb eine **fremde Organisation** an
(`fremdeOrganisation()` in `tests/helpers/testdb.ts`) und prüft gegen sie:

| Prüfung | Datei | Ergebnis |
|---|---|---|
| Kundschaft, Objekte, Anfragen, Offerten, Einsätze, Rechnungen, Ausgaben, Lieferanten, Nachrichten, Aufgaben: nicht in der Liste, einzeln 404, Ändern/Löschen 404, Datensatz unverändert | `tests/api/mandanten.test.ts` | VERIFIED |
| Buchungen, Verträge, Führungsdokumente, Automatisierungsregeln, Galerie: dasselbe, die Liste mit Suchbegriff (sonst hiesse „nicht in der Liste" nur „nicht auf der ersten Seite") | `tests/api/mandanten.test.ts` | VERIFIED (2026-09-27) |
| Offerte/Rechnung/Besichtigung/Reklamation an fremde Kundschaft; fremdes Objekt an eigener Offerte | `tests/api/mandanten.test.ts` | VERIFIED |
| Buchungen: Bestätigen, Stornieren, Wiederherstellen, PDF 404; Kundenkonto sieht die fremde Buchung nicht | `tests/api/mandanten.test.ts` | VERIFIED (2026-09-27) |
| Verträge: Pause, Kündigung, Storno, neue Fassung, Aktivierung, Annahme einer Fassung 404; kein Vertrag für fremde Kundschaft | `tests/api/mandanten.test.ts` | VERIFIED (2026-09-27) |
| Zeiterfassung: nicht in der Liste (auch gefiltert), nicht änderbar, löschbar, wieder zu öffnen oder freizugeben; keine Zeit für eine fremde Person | `tests/api/mandanten.test.ts` | VERIFIED (2026-09-27) |
| Zahlungen (auch mit Suchbegriff) und Gutschriften: nicht gelistet, nicht korrigier- oder stornierbar, kein PDF; keine Zahlung auf fremde Rechnung, keine Gutschrift auf fremde Rechnung oder an fremde Kundschaft | `tests/api/mandanten.test.ts` | VERIFIED (2026-09-27) |
| Dateien: private weder ausgeliefert noch in der Mediathek, nicht umbenenn- oder löschbar; öffentliche der fremden Organisation hier 404 | `tests/api/mandanten.test.ts` | VERIFIED (2026-09-27) |
| Automatisierung: ein fälliger Lauf der fremden Regel wird vom stündlichen Lauf nicht ausgeführt | `tests/api/mandanten.test.ts` | VERIFIED (2026-09-27) |
| Führungsdokumente: Download, Inhalt, Signaturvorgänge, Dateiroute 404, keine neue Fassung; kein eigenes Dokument mit fremder Datei oder Person | `tests/api/mandanten.test.ts` | VERIFIED (2026-09-27) |
| Website-Inhalte: fremde Fassungen weder gelistet noch wiederherstellbar, fremdes Galeriebild nicht überschreibbar, fremder Text nicht auf der Website | `tests/api/mandanten.test.ts` | VERIFIED (2026-09-27) |
| Signaturvorgänge und Offertannahme: nicht lesbar, versend- oder abbrechbar; fremde Offerte nicht erneut versendbar, vom Kundenkonto nicht annehmbar | `tests/api/mandanten.test.ts` | VERIFIED (2026-09-27) |
| Vor-Ort-Abnahme: keine Übergabe, kein Signaturcookie, keine Sitzungssperre an fremdem Einsatz; Rapport und Abnahmevorgang 404; kein Nachrichtenverlauf an fremdem Einsatz | `tests/api/mandanten.test.ts` | VERIFIED (2026-09-27) |
| Öffentliche Links der fremden Organisation (QUOTE_VIEW, QUOTE_RESPOND, INVOICE_VIEW, INVOICE_PAY, BOOKING_MANAGE, SIGNATURE_ACCESS) lösen hier nichts auf | `tests/api/mandanten.test.ts` | VERIFIED (2026-09-27) |
| Benutzerkonten: nicht gelistet, nicht sperrbar, kein Zugangslink; Zwei-Faktor-Rücksetzung durch die Systemverantwortung 404 | `tests/api/mandanten.test.ts` | VERIFIED (2026-09-27) |
| Konten der fremden Organisation melden sich nicht an; ein Organisationswechsel beendet die laufende Sitzung | `tests/api/mandanten.test.ts` | VERIFIED |
| Kundenkonto sieht keine fremden Objekte, Rechnungen und Verträge | `tests/api/mandanten.test.ts` | VERIFIED |
| Lohn: fremde Satzversion und Position weder gezeigt noch verrechnet, fremder Quellensteuertarif greift nicht | `tests/api/lohnabrechnung.test.ts` | VERIFIED |
| Material einer fremden Organisation weder gelistet noch buchbar | `tests/api/betrieb.test.ts` | VERIFIED |

Nicht eigens geprüft (Stand 2026-09-27, siehe `security/testmatrix.json`):
Berichte der Führung, der Einsatzplan eines fremden Vertrags, ein gültig
signiertes Stripe-Ereignis zu einer fremden Rechnung, Leistungs- und
Blogbilder über `/api/content/asset` und eine öffentliche Buchung oder
Preisberechnung mit einer Leistung der fremden Organisation.

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
Operationen (Zahl: README, von `scripts/kennzahlen.ts` gezählt). Vor einem echten Mehrmandantenbetrieb: RLS oder
Abfrage-Middleware, Mandant je Domain, Protokolltabellen mit Mandant.
