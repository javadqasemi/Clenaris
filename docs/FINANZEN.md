# Finanzbelege: Unveränderlichkeit, Storno, Gutschrift

> Stand: 23. September 2026 (Wave 13).

## 1. Statusinventar

| Punkt | Status | Beleg |
|---|---|---|
| Lückenlose Rechnungsnummern (Art. 957a OR), Vergabe beim Ausstellen in der Transaktion | COMPLETE + VERIFIED | `numbering.service.ts`; `tests/api/finanzbelege.test.ts` |
| Ausgestellte Rechnung: Inhalt unveränderlich — Dienst **und Datenbank** | COMPLETE + VERIFIED | Trigger `rechnung_unveraenderlich` |
| Positionen ausgestellter Rechnungen gesperrt | COMPLETE + VERIFIED | Trigger `rechnungsposition_unveraenderlich` |
| Kein Löschen ausgestellter Rechnungen (auch nicht weich) | COMPLETE + VERIFIED | Trigger + `trash.service.ts` |
| Gutschrift erstellen (vorher: Dienst ohne Route/UI) | COMPLETE + VERIFIED | `/api/invoices/:id/credit-note`, `/api/credit-notes` |
| Gutschrift: nie mehr als der Rechnungsbetrag, gleiche Kundschaft, keine Entwürfe | COMPLETE + VERIFIED | Zeilensperre, 422 |
| Gutschrift unveränderlich, nicht löschbar | COMPLETE + VERIFIED | Trigger `gutschrift_unveraenderlich` |
| Zahlung: Storno statt Löschen, Saldo/bezahlter Betrag/Kundenwert zurück | COMPLETE + VERIFIED | `DELETE /api/payments/:id`, Trigger `zahlung_unveraenderlich` |
| Mahnungen unveränderlich | COMPLETE | Trigger `mahnung_unveraenderlich` |
| Datenbereinigung (Demo/Test) weiterhin möglich | COMPLETE + VERIFIED | `SET LOCAL clenaris.bereinigung = 'on'`, `tests/api/purge.test.ts` |
| Buchhaltungsexport, MWST-Abrechnung, Jahresabschluss | wie bisher (Export vorhanden) · EXTERNAL VERIFICATION REQUIRED für steuerliche Korrektheit | — |

## 2. Was nach dem Ausstellen änderbar bleibt

Der **Lebenslauf**, nicht der **Inhalt**: Status (nie zurück zu `DRAFT`),
Versand-, Ansichts-, Zahlungs- und Stornozeitpunkte, bezahlter Betrag,
Saldo, Mahnstufe, interne Notiz, PDF-Adressen, Stripe-Verweise und der
Verweis auf die Kundschaft (Zusammenführen doppelter Akten). Der
Empfänger-Schnappschuss (`billTo*`), Nummer, Daten, Texte, Beträge,
Währung, QR-Referenz und Herkunft (Buchung, Offerte, Vertrag, Periode)
sind fest.

## 3. Positionen beim Sofortausstellen

`createInvoice` mit `issueImmediately` legt die Rechnung gleich als
`ISSUED` an und schreibt die Positionen in derselben Transaktion. Der
Positions-Trigger erlaubt das Einfügen deshalb, wenn die Rechnungszeile von
der laufenden Transaktion geschrieben wurde und jünger als zehn Minuten ist
(Prisma setzt `@default(now())` im Abfragemotor, daher kein exakter
Zeitvergleich). Eine früher ausgestellte Rechnung erfüllt das nie.

## 4. Datenbereinigung

Die Datenbereinigung (`/admin/datenbereinigung`, nur Systemverantwortung,
protokolliert) leert Demo- und Testbestände. Sie setzt in ihrer Transaktion
`SET LOCAL clenaris.bereinigung = 'on'`; die Trigger erlauben dann das
**Löschen** — nie das Ändern. Kein anderer Codepfad setzt die Einstellung.
`session_replication_role` wäre die Alternative, verlangt aber eine
Superuser-Rolle, die die Anwendung in der Produktion nicht hat.

## 5. Prüfreihe

`tests/api/finanzbelege.test.ts` greift direkt in die Testdatenbank und
erwartet die Ablehnung durch die Trigger; über HTTP prüft sie Storno,
Gutschrift mit Obergrenze, PDF und Rollen. Ihre Belege räumt sie unter
`session_replication_role = 'replica'` weg (nur Testdatenbank).
