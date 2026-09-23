# KI-Governance und Datensparsamkeit

> Stand: 23. September 2026 (Wave 15). Anbieter: Anthropic (Auftragsverarbeiter
> im Ausland). Ohne `ANTHROPIC_API_KEY` sind alle KI-Funktionen aus.

## 1. Grundsätze

1. **Die KI entwirft, sie entscheidet nicht.** Kein KI-Endpunkt schreibt
   Geschäftsdaten: Offerten, E-Mails, Berichte, Routen und Zuteilungen sind
   Vorschläge, die eine Person übernimmt oder verwirft. (Geprüft: keine der
   sieben KI-Routen enthält einen Schreibzugriff.)
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

## 2. Inventar

| Funktion | Endpunkt | Was an den Anbieter geht | Sparsamkeit | Status |
|---|---|---|---|---|
| Offertentwurf | `/api/ai/quote-draft` | Leistungsart, Objektart, Masse, Turnus, Ort (Stadt), Kundentyp, Freitext der Anfrage | Ausgangsfilter | COMPLETE |
| E-Mail-Entwurf | `/api/ai/email` | Zweck, Kontext, Tonalität | Platzhalter für Namen + Filter | COMPLETE + VERIFIED (Regeln) |
| Zusammenfassung | `/api/ai/summarize` | der eingefügte Text | Ausgangsfilter; Namen im Freitext bleiben | PARTIAL (Freitext) |
| Übersetzung | `/api/ai/translate` | der eingefügte Text | Ausgangsfilter | PARTIAL (Freitext) |
| Routenplanung | `/api/ai/dispatch` | Adressen, Zeitfenster, Dauer | Kürzel statt Kennungen; Adressen sind nötig | COMPLETE |
| Blogentwurf | `/api/ai/blog-draft` | Thema, Stichworte | keine Personendaten | COMPLETE |
| Führungsassistent | `/api/bi/assistant` | Kennzahlen, Ziele (aggregiert) | keine Personendaten (bestehend) | COMPLETE |
| Personaldisposition | (Dienst) | Qualifikationen, Fenster, Auslastung | Kürzel (bestehend) | COMPLETE |
| Einsatzbericht | (Dienst) | Checkliste, Material, Notizen | Platzhalter für Kunde/Team + Filter | COMPLETE |
| Website-Chat | öffentlich | Besucherfragen | Ausgangsfilter; keine Protokollierung (anonym) | COMPLETE |

## 3. Was bewusst offen bleibt

- **Keine Anonymisierung.** Namen im Freitext, Adressen für die Route und
  fachliche Merkmale bleiben erkennbar. Die Übermittlung ist sparsam, nicht
  anonym.
- **Auftragsverarbeitungsvertrag, Datenstandort, Aufbewahrung beim
  Anbieter:** EXTERNAL VERIFICATION REQUIRED (rechtlich, nicht technisch).
- **Qualität der Antworten** wird nicht automatisiert geprüft; jede Antwort
  ist ein Entwurf.
