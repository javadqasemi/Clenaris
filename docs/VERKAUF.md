# Verkauf: Besichtigung → Berechnung → Offerte

> Stand: 23. September 2026 (Wave 12).

## 1. Statusinventar

| Punkt | Status | Beleg |
|---|---|---|
| Anfrage (Lead), Pipeline, Umwandlung in Kundschaft | COMPLETE (bestehend) | `crm.service.ts`, `tests/api/flows.test.ts` |
| Offerte (Entwurf, Versand, Annahme über den Signaturkern) | COMPLETE + VERIFIED (bestehend) | `offertannahme.test.ts` |
| Besichtigung / Objektaufnahme | COMPLETE + VERIFIED | `tests/api/besichtigung.test.ts` |
| Kalkulation über die Preisberechnung des Katalogs | COMPLETE + VERIFIED | gleiche Zahl wie die Online-Sofortofferte |
| Offerte aus Besichtigung (einmal, gesperrt, neu gerechnet) | COMPLETE + VERIFIED | gleichzeitige Klicks → eine Offerte |
| Offerten-Bezug nur innerhalb der Organisation | COMPLETE + VERIFIED | `createQuote` prüft Kundschaft/Anfrage/Objekt (vorher ungeprüft) |
| Frei erfasste Offerte (Positionen von Hand) | wie bisher — Preise aus dem Editor, Katalogvorschlag clientseitig | bewusst: Sonderleistungen |
| Zusatzleistungen in der Besichtigungsmaske | PARTIAL | Schnittstelle nimmt sie (geprüft), die Maske noch nicht |

## 2. Regeln

- **Ein Weg zum Preis.** Jede Fläche geht durch `calculatePrice` — Objektart,
  Fläche/Räume/Fenster, Turnus, Zusatzleistungen, Postleitzahl (Anfahrt;
  Objekt → Besichtigung → Anfrage), Haustiere, Dauerrabatt der Kundschaft.
  Kein Preisfeld in Maske oder Schnittstelle.
- **Neu rechnen beim Offerieren.** Die gespeicherte Berechnung ist Vorschau;
  die Offerte entsteht aus einer frischen Berechnung, die wieder
  festgehalten wird.
- **Eine Offerte je Besichtigung**, verknüpft in derselben Transaktion unter
  Zeilensperre (`FOR UPDATE`); CHECK: Offerte nur bei `DONE`.
- **Danach gesperrt:** Flächen, Stammdaten und Absage einer offerierten
  Besichtigung werden abgewiesen (422).
- **Preis auf Anfrage wird nicht geraten** — solche Flächen verhindern die
  automatische Offerte (422) und werden von Hand offeriert.
- **Positionen:** eine je Fläche, Menge 1, Einheit „Pauschal" bzw.
  „Einsatz" (wiederkehrend, Preis je Einsatz), Nettopreis und MWST-Satz aus
  der Berechnung, Herleitung in der Beschreibung.
- Rechte: die der Offerte (`quote:read/create/update`).
