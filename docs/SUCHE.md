# Globale Suche (Wave 17)

Stand 2026-09-23. Status: **COMPLETE + VERIFIED** (`tests/api/suche.test.ts`,
Rauchtest `/admin/suche`).

## Weg

`GET /api/search?q=…` (mindestens 2, höchstens 80 Zeichen) und die Seite
`/admin/suche` rufen dieselbe Funktion `globaleSuche()` in
`src/server/services/search.service.ts`. Die Seite ist ein schlichtes
GET-Formular, serverseitig gerendert — keine Clientsuche, die Treffer über den
Draht schickt, die die Seite danach ausblendet.

## Regeln

- **Jeder Bereich nur mit seiner Leseberechtigung.** Fehlt `invoice:read`,
  wird der Bereich Rechnungen gar nicht abgefragt — nicht abgefragt und
  weggefiltert. Mitarbeitende finden deshalb keine Rechnungen, Offerten,
  Verträge oder Personalakten; die Kundschaft hat keine globale Suche (403).
- **Die Organisation steht in jeder Abfrage** im `where`. Ein Datensatz einer
  fremden Organisation ist nicht „versteckt", sondern nie gefunden.
- **Höchstens fünf Treffer je Bereich**, sortiert nach Aktualität. Die Suche
  ist ein Sprungbrett zur Liste, keine zweite Liste.
- **Keine sensiblen Felder als Treffergrund:** kein Lohn, keine IBAN, keine
  AHV-Nummer, keine internen Notizen. Wer nach `756.` sucht, findet keine
  Person — sonst liesse sich über die Trefferliste eine AHV-Nummer erraten,
  ohne sie je zu sehen.
- Gesucht wird mit `contains`/`insensitive` auf Namen, Nummern und Titeln.
  Das genügt beim Bestand eines Betriebs; ein Volltextindex wäre die nächste
  Stufe, wenn die Antwortzeit es verlangt (Wave 19).
