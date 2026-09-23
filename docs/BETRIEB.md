# Betrieb: Reklamationen, Material, Geräte

> Stand: 23. September 2026 (Wave 11).

Qualitätskontrolle (`/admin/qualitaet`, Begehungen mit Punktzahl gegen den
Vertragszielwert) bestand bereits und ist in `docs/SIGNATUR_GATE4A.md` und im
Qualitätsdienst beschrieben. Wave 11 ergänzt die drei Teile des laufenden
Betriebs, die fehlten.

---

## 1. Statusinventar

| Teil | Status | Beleg |
|---|---|---|
| Qualitätskontrolle (Begehung, Zielwert, Nachkontrolle) | COMPLETE (bestehend) | `tests/api/qualitaet*.test.ts` |
| SLA: Reaktionszeit aus der Vertragsfassung | COMPLETE + VERIFIED | `tests/api/betrieb.test.ts` |
| Reklamation/Vorfall/Schaden mit Lebenslauf | COMPLETE + VERIFIED | dito |
| Kundenmeldung im Kundenbereich | COMPLETE + VERIFIED | dito, Eigentümerschaft in der Abfrage |
| Korrekturmassnahme aus Reklamation | COMPLETE | Verknüpfung zu `CorrectiveAction` (Unternehmensführung) |
| Material mit Bestand aus Bewegungen | COMPLETE + VERIFIED | Summe, nie negativ, Zeilensperre, Trigger |
| Entnahme für Einsätze (Nachkalkulation) | COMPLETE + VERIFIED | eine Transaktion; Lagerzeilen überleben „Material ersetzen" |
| Geräte: Inventar, Zuteilung, Wartung, Ausmusterung | COMPLETE + VERIFIED | Wartungsbeleg unveränderlich (Trigger) |
| Eskalation überfälliger Fristen per Nachtlauf | NOT IMPLEMENTED | Liste „überfällig" und Benachrichtigung beim Erfassen vorhanden |
| Bestellwesen/Lieferanten-Bestellung | NOT IMPLEMENTED | Meldebestand zeigt „nachbestellen" |
| Mitarbeitende sehen „ihre" Geräte im Portal | NOT IMPLEMENTED | Zuteilung ist in der Verwaltung sichtbar |

---

## 2. Reklamationen und Reaktionsfrist

- **Die Frist kommt aus dem Vertrag.** Beim Erfassen wird unter den
  laufenden Verträgen (aktiv/gekündigt, nicht über das Ende hinaus) die
  Fassung gesucht, die am Meldetag gilt; objektgebundene vor allgemeinen; bei
  mehreren gilt die **engste** Zusage. `responseHours` wird als
  Momentaufnahme übernommen, `responseDueAt = reportedAt + responseHours`.
  Ohne Zusage: keine Frist (`KEINE_ZUSAGE`) — nicht „überfällig".
- **Kein Feld setzt die Frist.** Der Meldezeitpunkt darf nicht in der Zukunft
  liegen und höchstens 30 Tage zurück.
- **Reaktion = erster Schritt aus „Offen"**, einmal festgehalten, danach nie
  verschoben (CHECK: nie vor der Meldung). Spätes Bestätigen heilt eine
  verpasste Frist nicht.
- **Übergänge:** Offen → Bestätigt/In Bearbeitung/Erledigt/Abgelehnt;
  Bestätigt → In Bearbeitung/Erledigt/Abgelehnt; In Bearbeitung →
  Erledigt/Abgelehnt; Erledigt → Abgeschlossen/wieder öffnen. Erledigen und
  Ablehnen verlangen eine für die Kundschaft sichtbare Begründung. Bedingtes
  Schreiben auf den bisherigen Status: gleichzeitige Übergänge ergeben genau
  einen (der zweite 422).
- **Kundschaft:** meldet nur zu eigenen Objekten/Einsätzen (Fremdes 404),
  sieht nur eigene Meldungen und nur kundensichtbare Felder (die interne
  Notiz steht nicht in der Abfrage).
- **Stand der Frist** (`LAEUFT`, `EINGEHALTEN`, `VERPASST`, `KEINE_ZUSAGE`)
  wird gerechnet, nie gespeichert. Die Übersicht zeigt die Quote der letzten
  90 Tage.

## 3. Material und Lager

- Bestand = **Summe der Bewegungen** (`StockMovement`), kein Bestandsfeld.
- Bewegungen: Eingang (+), Entnahme (−), Rückgabe (+), Inventurkorrektur (±,
  Begründung Pflicht). Vorzeichen per CHECK an die Art gebunden.
- **Nur anfügen** (Trigger `stock_movements_nur_anfuegen`); einzig das Lösen
  eines Verweises auf einen gelöschten Einsatz ist erlaubt. Berichtigung =
  Gegenbuchung.
- **Nie negativ;** gleichzeitige Entnahmen laufen über `SELECT … FOR UPDATE`
  auf dem Material nacheinander.
- **Entnahme für einen Einsatz** (`/api/jobs/:id/material-issue`):
  Verbrauchszeile, Bewegung und Materialaufwand in einer Transaktion; Preis
  aus dem Stamm; nach der Vor-Ort-Abnahme gesperrt. „Material ersetzen" am
  Einsatz lässt Lagerzeilen stehen.

## 4. Geräte

Inventarnummer `GR-JJJJ-NNNNN` vom Server; Zuteilung setzt `IN_USE`,
Rücknahme `AVAILABLE`; Wartungsbeleg unveränderlich, nächste Fälligkeit =
Wartungstag + Intervall; keine Wartung in der Zukunft; Ausmustern mit Grund,
endgültig.

## 5. Rechte

| Berechtigung | Rollen |
|---|---|
| `complaint:read/create/update` | MANAGER, ADMIN, SUPER_ADMIN |
| `complaint:read_own`, `complaint:create_own` | CUSTOMER |
| `inventory:read/manage`, `equipment:read/manage` | MANAGER, ADMIN, SUPER_ADMIN |

Alle Abfragen filtern nach `organizationId`; `tests/api/betrieb.test.ts`
belegt mit der fremden Prüforganisation, dass deren Material weder gezeigt
noch gebucht wird.
