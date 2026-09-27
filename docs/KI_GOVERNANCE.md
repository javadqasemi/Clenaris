# KI-Governance und Datensparsamkeit

> Stand: 27. September 2026 (Korrektur des Inventars, siehe Abschnitt 2; Nutzlast der Freitext-Funktionen, F-15). Anbieter: Anthropic (Auftragsverarbeiter
> im Ausland). Ohne `ANTHROPIC_API_KEY` sind alle KI-Funktionen aus.

## 1. Grundsätze

1. **Die KI entwirft, sie entscheidet nicht.** Kein KI-Endpunkt schreibt
   Geschäftsdaten: Offerten, E-Mails, Berichte, Routen und Zuteilungen sind
   Vorschläge, die eine Person übernimmt oder verwirft. (Geprüft: keine der
   sieben KI-Routen enthält einen Schreibzugriff.) Die eine Ausnahme ist die
   automatische Anfrage-Einschätzung: Sie schreibt einen Punktwert und eine
   Begründung an die Anfrage — eine Empfehlung für die Reihenfolge der
   Bearbeitung, die nichts auslöst.
2. **Zentraler Ausgangsfilter.** Jede Anfrage läuft im KI-Client durch
   `ausgangsfilter` (`src/lib/ai/governance.ts`): E-Mail-Adressen,
   Telefonnummern, IBAN, AHV-Nummern und Datenbankkennungen werden durch
   Platzhalter ersetzt, bevor sie das Haus verlassen. Protokolliert wird die
   Anzahl, nie der Inhalt.
3. **Namen nur, wo das Ergebnis sie braucht — und dann als Platzhalter.**
   E-Mail-Entwurf (`{{EMPFAENGER}}`, `{{ABSENDER}}`) und Einsatzbericht
   (`{{KUNDE}}`, `{{TEAM_n}}`) setzen die Namen erst im eigenen Prozess ein.
4. **Kürzel statt Kennungen.** Personaldisposition (P1/A1) und
   Routenplanung (E1…) senden keine Datenbankkennungen; erfundene Kürzel
   werden verworfen.
5. **Nachweis der Nutzung.** Jede erfolgreiche Nutzung steht im
   Prüfprotokoll (`entity = KiNutzung`: wer, wann, welche Funktion) — ohne
   Eingabe und Ergebnis.
6. **Freitext nach Zusammenhang schwärzen, Strukturfelder nur aus einer
   Erlaubnisliste** (F-15, 2026-09-27). Funktionen, die beliebigen Freitext
   senden, bauen ihre Nutzlast in `src/lib/ai/nutzlast.ts` und schwärzen dort
   zusätzlich zum Ausgangsfilter (`freitextSchwaerzen`,
   `mitSchutzplatzhaltern` in `governance.ts`):
   - **Zugangswerte** — der Wert nach Alarm, Code, PIN, Schlüssel(-safe),
     Tresor, Kombination (mit mindestens einer Ziffer) und das Wort nach
     Passwort/Kennwort → `[ZUGANGSCODE]`;
   - **Lohnbeträge** — ein Betrag nach oder vor Lohn, Gehalt, Salär,
     verdient, Bonus → `[LOHNBETRAG]`;
   - **Gesundheit** — der ganze Satz mit krank, Arztzeugnis, Diagnose,
     schwanger, Unfall, Medikament, arbeitsunfähig u. a. →
     `[GESUNDHEITSANGABE]` (Orte wie Arztpraxis oder Spital bleiben: Sie
     sind Kundschaft);
   - **bekannte Namen**, wo die Funktion sie kennt → `[NAME]`.

   Die Regeln erkennen Zusammenhang, nicht Bedeutung: Ein Code ohne
   Schlüsselwort („die Zahl an der Tür ist 4711") bleibt stehen. Geprüft wird
   die ausgehende Nutzlast je Funktion in `tests/api/ki-nutzlast.test.ts`.
   Der Ausgangsfilter des Clients filtert seit demselben Tag auch Textblöcke
   im Verlauf; Blöcke, die er nicht lesen kann (Bild, Dokument), gehen nicht
   hinaus.

## 2. Inventar

| Funktion | Endpunkt | Was an den Anbieter geht | Sparsamkeit | Status |
|---|---|---|---|---|
| Offertentwurf | `/api/ai/quote-draft` | Erlaubnisliste: Leistungs-/Objektart und Turnus nur als Katalogschlüssel, Fläche/Zimmer/Fenster als begrenzte Zahlen, Ort nur als Ortsname, Kundentyp, Stundenansatz aus dem Katalog; dazu der Anfragetext | `offertentwurfNutzlast`: Anfragetext nach Zusammenhang geschwärzt (Zugangswerte, Lohn, Gesundheit), Name und Firma der Anfrage → `[NAME]`, + Ausgangsfilter | COMPLETE + VERIFIED (Nutzlast) |
| E-Mail-Entwurf | `/api/ai/email` | Zweck, Kontext, Tonalität | Platzhalter für Namen + Filter | COMPLETE + VERIFIED (Regeln) |
| Zusammenfassung | `/api/ai/summarize` | der eingefügte Text, der Fokus | `zusammenfassungNutzlast`: geschwärzt ohne Rückweg (Zugangswerte, Lohn, Gesundheit) + Ausgangsfilter; Namen im Freitext bleiben | COMPLETE + VERIFIED (Nutzlast); Namen offen |
| Übersetzung | `/api/ai/translate` | der eingefügte Text | `uebersetzungNutzlast`: Zugangswerte, Lohn, Gesundheitssätze, AHV, IBAN, E-Mail, Telefon als `{{GESCHUETZT_x}}` mit Rückweg — sie erscheinen im Ergebnis wieder, aber unübersetzt; Namen im Freitext bleiben | COMPLETE + VERIFIED (Nutzlast); Namen offen |
| Routenplanung | `/api/ai/dispatch` | Adressen, Zeitfenster, Dauer | Kürzel statt Kennungen; Adressen sind nötig | COMPLETE |
| Blogentwurf | `/api/ai/blog-draft` | Thema, Stichworte | keine Personendaten | COMPLETE |
| Führungsassistent | `/api/bi/assistant` | Kennzahlen, Ziele (aggregiert); je nach Auswertung Bewertungstexte, Check-in-Kommentare, Sitzungsnotizen | bekannte Namen → `[NAME]` (`namenErsetzen`) + Filter; Freitext bleibt nicht anonym | PARTIAL (Freitext) |
| Anfrage-Einschätzung | automatisch bei jeder Anfrage (`crm.service` → `scoreLead`) | Anfragetext, Leistungsart, Fläche, Kundentyp, Quelle | Name und Firma der Anfrage → `[NAME]` + Filter; schreibt einen Punktwert mit Begründung an die Anfrage (Empfehlung) | COMPLETE |
| Antwortentwurf Bewertung | `/api/reviews/[id]/reply-draft` | Bewertungstext | Ausgangsfilter | PARTIAL (Freitext) |
| Personaldisposition | (Dienst) | Qualifikationen, Fenster, Auslastung | Kürzel (bestehend) | COMPLETE |
| Einsatzbericht | `/api/jobs/[id]/report/draft` | Checkliste, Material, Notizen | Platzhalter für Kunde/Team + Filter | COMPLETE |
| Website-Chat | öffentlich | Besucherfragen samt Verlauf der Sitzung | Ausgangsfilter auf Frage und Verlauf; bei uns nicht gespeichert — beim Anbieter gilt dessen Aufbewahrung | COMPLETE |

**Korrektur 2026-09-27.** Das Inventar nannte den Führungsassistenten „keine
Personendaten", und Oberfläche wie Code sprachen von „anonymisierten"
Bewertungstexten. Die Texte gingen roh hinaus. Seither ersetzt
`namenErsetzen` (`src/lib/ai/governance.ts`, geprüft in
`tests/api/ki-governance.test.ts`) jeden Namen, den die Datenbank kennt;
Oberfläche und Datenschutzerklärung sagen „sparsam, nicht anonym". Die
automatische Anfrage-Einschätzung fehlte im Inventar ganz, und die
Datenschutzerklärung behauptete „ohne Kundenstammdaten".

## 3. Was bewusst offen bleibt

- **Keine Anonymisierung.** Namen im Freitext, Adressen für die Route und
  fachliche Merkmale bleiben erkennbar. Die Übermittlung ist sparsam, nicht
  anonym.
- **Schwärzung nach Zusammenhang ist eine Heuristik** (Stand 2026-09-27).
  Sie greift in Zusammenfassung, Übersetzung und Offertentwurf; der
  E-Mail-Entwurf, der Einsatzbericht, der Antwortentwurf zu Bewertungen und
  der Führungsassistent haben weiterhin nur Ausgangsfilter und Platzhalter
  bzw. `namenErsetzen`. Ein Wert ohne Schlüsselwort und ein Gesundheitsbegriff
  ausserhalb der Liste bleiben stehen.
- **Der Systemtext wird nicht gefiltert.** Er stammt aus dem Code und dem
  Katalog (Leistungen, Öffnungszeiten, die Telefonnummer der Firma im
  Website-Chat) — ein Filter darauf ersetzte die eigene Firmennummer.
- **Auftragsverarbeitungsvertrag, Datenstandort, Aufbewahrung beim
  Anbieter:** EXTERNAL VERIFICATION REQUIRED (rechtlich, nicht technisch).
- **Qualität der Antworten** wird nicht automatisiert geprüft; jede Antwort
  ist ein Entwurf.
