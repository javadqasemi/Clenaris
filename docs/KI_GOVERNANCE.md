# KI-Governance und Datensparsamkeit

> Stand: 27. September 2026 (Korrektur des Inventars, siehe Abschnitt 2; Nutzlast der Freitext-Funktionen, F-15; zweiter F-15-Durchgang: E-Mail, Einsatzbericht, Bewertungsantwort, Führungsassistent, vermutete Namen). Anbieter: Anthropic (Auftragsverarbeiter
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
   E-Mail-Entwurf (`{{EMPFAENGER}}`, `{{ABSENDER}}`), Bewertungsantwort
   (dieselben) und Einsatzbericht (`{{KUNDE}}`, `{{TEAM_A}}`, `{{TEAM_B}}` …)
   setzen die Namen erst im eigenen Prozess ein. Seit F-15 auch dann, wenn
   im Text nur der Vor- oder Nachname steht („Frau Keller" → „Frau
   {{EMPFAENGER}}"); ein Namensteil, den zwei Personen tragen, wird zu
   `[NAME]`, und Firmennamen werden nicht zerlegt. Die Platzhalter tragen
   Buchstaben statt Ziffern, damit die Code-Regel sie nie als Wert liest.
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
   - **bekannte Namen**, wo die Funktion sie kennt → `[NAME]`;
   - **vermutete Namen** (`namenVermuten`, zweiter Durchgang) — Namen, die
     die Form verrät: nach „Frau"/„Herr"/„Hr."/„Fr." (samt „Dr."), in der
     Anrede am Zeilenanfang („Liebe Anna,", „Hallo Beat Keller!"), in der
     Zeile unter der Grussformel („Freundliche Grüsse\nAnna Keller") und
     nach „Mein Name ist". Was gefunden wird, wird im ganzen Text ersetzt.
     Zurückhaltend gebaut: „Sehr geehrte Damen und Herren", „Liebe Grüsse",
     „Ihr Clenaris-Team" und „Herrn Keller **Bescheid** geben" bleiben
     stehen — beides ist geprüft.

   Die Regeln erkennen Zusammenhang, nicht Bedeutung: Ein Code ohne
   Schlüsselwort („die Zahl an der Tür ist 4711") bleibt stehen. Geprüft wird
   die ausgehende Nutzlast je Funktion in `tests/api/ki-nutzlast.test.ts`.
7. **Führungsassistent nur aus Bausteinen** (F-15, zweiter Durchgang).
   `bi-assistant.service` baut keine Zeichenketten mehr, sondern übergibt
   typisierte Bausteine an `biDaten` (`nutzlast.ts`): Kennzahlen als Zahlen
   (formatiert erst dort), Status/Kategorien/Quellen nur als
   Aufzählungsschlüssel, Titel aus dem Katalog mit ersetzten Namen, Freitext
   geschwärzt, nur Überschriften aus einer festen Liste. Ein Wert, der nicht
   zu seinem Feld passt, wird „—". Regelbasierte Auffälligkeiten gehen mit
   Titel hinaus, die Detailzeile nur für geprüfte Regeln — die
   Klumpenrisiko-Regel nannte in ihrer Detailzeile die grösste Kundschaft
   beim Namen, und diese Zeile ging bis dahin mit jeder
   Zeitraum-Zusammenfassung hinaus.
   Der Ausgangsfilter des Clients filtert seit demselben Tag auch Textblöcke
   im Verlauf; Blöcke, die er nicht lesen kann (Bild, Dokument), gehen nicht
   hinaus.

## 2. Inventar

| Funktion | Endpunkt | Was an den Anbieter geht | Sparsamkeit | Status |
|---|---|---|---|---|
| Offertentwurf | `/api/ai/quote-draft` | Erlaubnisliste: Leistungs-/Objektart und Turnus nur als Katalogschlüssel, Fläche/Zimmer/Fenster als begrenzte Zahlen, Ort nur als Ortsname, Kundentyp, Stundenansatz aus dem Katalog; dazu der Anfragetext | `offertentwurfNutzlast`: Anfragetext nach Zusammenhang geschwärzt (Zugangswerte, Lohn, Gesundheit), Name und Firma der Anfrage → `[NAME]`, + Ausgangsfilter | COMPLETE + VERIFIED (Nutzlast) |
| E-Mail-Entwurf | `/api/ai/email` | Zweck, Kontext, Tonalität (nur Katalogwert) | `emailEntwurfNutzlast`: Empfänger/Absender als Platzhalter, auch als Namensteil; Zweck und Kontext mit Schutzplatzhaltern `{{ZWECK_x}}`/`{{KONTEXT_x}}` **mit Rückweg** (Zugangswerte, Lohn, Gesundheit, AHV, IBAN, E-Mail, Telefon, vermutete Namen) + Ausgangsfilter | COMPLETE + VERIFIED (Nutzlast) |
| Zusammenfassung | `/api/ai/summarize` | der eingefügte Text, der Fokus | `zusammenfassungNutzlast`: geschwärzt ohne Rückweg (Zugangswerte, Lohn, Gesundheit, vermutete Namen) + Ausgangsfilter | COMPLETE + VERIFIED (Nutzlast); Namen ohne Namensstelle bleiben |
| Übersetzung | `/api/ai/translate` | der eingefügte Text | `uebersetzungNutzlast`: Zugangswerte, Lohn, Gesundheitssätze, AHV, IBAN, E-Mail, Telefon und vermutete Namen als `{{GESCHUETZT_x}}` mit Rückweg — sie erscheinen im Ergebnis wieder, aber unübersetzt | COMPLETE + VERIFIED (Nutzlast); Namen ohne Namensstelle bleiben |
| Routenplanung | `/api/ai/dispatch` | Adressen, Zeitfenster, Dauer | Kürzel statt Kennungen; Adressen sind nötig | COMPLETE |
| Blogentwurf | `/api/ai/blog-draft` | Thema, Stichworte | keine Personendaten | COMPLETE |
| Führungsassistent | `/api/bi/assistant` | Kennzahlen, Gesundheitswert, Ziele, Risiken, Budget, Leads nach Quelle/Status (aggregiert, aus Bausteinen); je nach Auswertung Check-in-Kommentare, Marktnotizen, Bewertungstexte, Sitzungsnotizen, die Frage | `biDaten`: Erlaubnisliste typisierter Felder, Auffälligkeits-Details nur für geprüfte Regeln; Freitext über `biFreitext` geschwärzt (Zugangswerte, Lohn, Gesundheit, bekannte Namen inkl. Kontaktpersonen, vermutete Namen) + Ausgangsfilter | COMPLETE + VERIFIED (Nutzlast); Sitzungsprotokoll und Feedback-Auswertung bleiben Freitext |
| Anfrage-Einschätzung | automatisch bei jeder Anfrage (`crm.service` → `scoreLead`) | Anfragetext, Leistungsart, Fläche, Kundentyp, Quelle | Name und Firma der Anfrage → `[NAME]` + Filter; schreibt einen Punktwert mit Begründung an die Anfrage (Empfehlung) | COMPLETE |
| Antwortentwurf Bewertung | `/api/reviews/[id]/reply-draft` | Sterne (Zahl 1–5), Titel und Text der Bewertung; Zweck und Ton aus dem Code | `bewertungsantwortNutzlast` (eigene Funktion `writeReviewReply` statt `writeEmail`): Verfasser/Absender als Platzhalter; Titel und Text geschwärzt **ohne** Rückweg — die Antwort ist öffentlich; Konten, Kundschaft und Kontakte der Bewertung sowie vermutete Namen → `[NAME]` + Ausgangsfilter | COMPLETE + VERIFIED (Nutzlast) |
| Personaldisposition | (Dienst) | Qualifikationen, Fenster, Auslastung | Kürzel (bestehend) | COMPLETE |
| Einsatzbericht | `/api/jobs/[id]/report/draft` | Auftragsnummer, Leistung, Datum, Dauer (geprüfte Formen), Checkliste, Material, Notizen | `einsatzberichtNutzlast`: Kunde/Team als Platzhalter mit Rückweg, auch als Namensteil; Checkliste und Notizen geschwärzt **ohne** Rückweg — der Bericht geht an die Kundschaft; Kundenperson und Kontakte → `[NAME]` + Ausgangsfilter | COMPLETE + VERIFIED (Nutzlast) |
| Textassistent | `/api/ai/text-assist` | Der Text eines erlaubten Felds (bzw. der markierte Abschnitt), Aktion und Feldart als Schlüssel | Sperre vor dem Versand (AHV, IBAN, Zugangscode/Passwort, Lohnbetrag, Token → 422, nichts gesendet); übrige erkannte Angaben (Kontakt, Gesundheitssatz, vermutete Namen) als `{{GESCHUETZT_x}}` mit Rückweg + Ausgangsfilter; siehe Abschnitt 4 | COMPLETE + VERIFIED (Nutzlast, Sperre) |
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
  Sie greift seit dem zweiten F-15-Durchgang in allen Funktionen mit
  Freitext: Offertentwurf, Zusammenfassung, Übersetzung, E-Mail-Entwurf,
  Einsatzbericht, Antwortentwurf zu Bewertungen und Führungsassistent. Ein
  Wert ohne Schlüsselwort und ein Gesundheitsbegriff ausserhalb der Liste
  bleiben stehen.
- **Vermutete Namen sind eine Heuristik.** Ein Name ohne Namensstelle („Beat
  hat angerufen", „bei Brunners") bleibt stehen, wo ihn die Datenbank nicht
  kennt. Zusammenfassen und Übersetzen laden bewusst **keine** Namensliste
  aus der Datenbank — der eingefügte Text hat keinen Bezug zu einem
  Datensatz; die Builder nehmen `bekannteNamen` aber entgegen, falls ein
  Aufrufer welche hat. Umgekehrt wird ein Nachname, der zugleich ein Wort
  ist („Keller", „Koch"), im selben Text auch als Wort ersetzt.
- **Sitzungsprotokoll und Feedback-Auswertung** des Führungsassistenten sind
  ihrem Wesen nach Freitext; sie lassen sich nicht auf Kennzahlen
  reduzieren. Sie laufen durch dieselbe Schwärzung, bleiben aber sparsam,
  nicht anonym. Alle übrigen Fähigkeiten senden nur Bausteine aus der
  Erlaubnisliste.
- **Titel aus dem eigenen Katalog** (Zielname, Risikotitel, Kennzahl-,
  Budget- und Wettbewerberbezeichnung) gehen mit ersetzten bekannten Namen,
  aber **ohne** Schwärzung nach Zusammenhang hinaus: Die Lohnregel hätte
  „Löhne … Plan 120000" als Lohnbetrag geschwärzt — ein aggregierter
  Budgetwert, den die Abweichungserklärung braucht.
- **Der Systemtext wird nicht gefiltert — bewusst.** Er stammt aus dem Code
  und dem Katalog (Leistungen, Öffnungszeiten, die Telefonnummer der Firma im
  Website-Chat) — ein Filter darauf ersetzte die eigene Firmennummer. Keine
  Funktion setzt Eingaben der Person oder Datensätze in den Systemtext; was
  aus Datensätzen stammt, steht im Prompt und läuft durch Nutzlast und
  Ausgangsfilter. Geprüft 2026-09-27 für alle Funktionen in `features.ts`,
  `features-bi.ts` und `nutzlast.ts`; die Ausnahme ist der Website-Chat,
  dessen Systemtext Leistungskatalog, Öffnungszeiten, Einsatzgebiet und
  Firmennummer trägt — öffentliche Angaben der Firma.
- **Auftragsverarbeitungsvertrag, Datenstandort, Aufbewahrung beim
  Anbieter:** EXTERNAL VERIFICATION REQUIRED (rechtlich, nicht technisch).
- **Qualität der Antworten** wird nicht automatisiert geprüft; jede Antwort
  ist ein Entwurf.

## 4. KI-Textassistent (Textkorrektur und Textvorschläge, 2026-09-28)

Ein Knopf neben ausgewählten Textfeldern der Verwaltung: Rechtschreibung
und Grammatik korrigieren, professioneller oder freundlicher formulieren,
kürzen, ausführlicher, SEO verbessern, Titel und Meta-Description
vorschlagen. Endpunkt `POST /api/ai/text-assist`, Dienst
`src/server/services/text-assist.service.ts`, reine Regeln in
`src/lib/ai/text-assist.ts`, Oberfläche `src/components/app/text-assist.tsx`.

**Kein zweiter KI-Stapel.** Derselbe Client (`generateText`, schnelles
Modell, ohne Werkzeuge), derselbe Ausgangsfilter (`anfrageFiltern`),
dieselben Schwärzungsregeln (`freitextSchwaerzen`, `mitSchutzplatzhaltern`,
`namenVermuten`), dasselbe Recht (`ai:use`: Systemverantwortung,
Administration, Betriebsleitung — nicht Mitarbeitende, nicht Kundschaft),
dieselbe Rate-Limit-Klasse (`aiGenerate`) und dasselbe Nutzungsprotokoll
(`KiNutzung`). Neu am Client ist nur eine Zeitgrenze je Anfrage (45 s, ohne
stille Wiederholung).

**Nur an ausgewählten Feldern.** Die Feldart ist eine Erlaubnisliste
(`TEXT_ASSIST_KONTEXTE` in `src/lib/validation/ai.ts`): Website-Texte
(`/admin/inhalte`, nur Zeile/Absatz/Fliesstext), Blogbeitrag (Titel, Anriss,
Text, SEO-Felder), SEO-Titel und -Beschreibung (`/admin/seo`),
Leistungsbeschreibungen im Katalog (Kurzbeschreibung, Beschreibung,
SEO-Felder), Einleitung und Schlusstext der Offerte, und — noch ohne Feld —
E-Mail-Entwürfe. **Nicht** an Personal-, Lohn-, Bank-, AHV-, Gesundheits-,
Objekt- (Alarmcode) oder Notizfeldern: Der Assistent ist in `ResourceForm`
ein Opt-in je Feld (`textAssist`), nie eine Vorgabe. Welche Aktion zu welcher
Feldart passt, steht in `TEXT_ASSIST_AKTIONEN_JE_KONTEXT`; eine andere
Kombination weist der Server mit 422 ab.

**Sperren oder schützen.** Vor jedem Versand prüft `gesperrteInhalte` den
Text. AHV-Nummer, IBAN, Zugangs-/Alarmcode, Passwort, Lohnbetrag und
Zugangsschlüssel/Token (private Schlüssel, bekannte Tokenformen, JWT, Wert
nach „API-Key"/„Token"/„Secret") **sperren** die Anfrage: 422 mit einer
Meldung, die die Art nennt, nie den Wert — und nichts geht hinaus. Diese
Prüfung läuft vor der Frage nach dem Anbieter, damit sie mit und ohne
Schlüssel gleich antwortet. Was in Redaktionstexten legitim ist — Telefon
und E-Mail der Firma, ein Name in einer Referenz, ein Satz, den die grobe
Gesundheitsregel trifft („Für Allergiker geeignet") —, wird **geschützt**:
als `{{GESCHUETZT_x}}` hinaus, im eigenen Prozess zurück. Ein geschützter
Satz wird nicht umformuliert; die Oberfläche nennt die Anzahl.

**Eingabe ist Daten.** Der Text steht zwischen Markierungen mit einer
Kennung je Anfrage; eine Markierung im Text selbst wird entschärft; der
Systemtext erklärt den Inhalt ausdrücklich zu Material, nicht zu
Anweisungen, und verbietet Werkzeuge, erfundene Links und Kontaktdaten.
Das ist eine Abwehr, keine Garantie.

**Antwort prüfen.** `antwortAuswerten` nimmt nur Text innerhalb einer
Längengrenze (dreimal die Eingabe, 600–12 000 Zeichen) bzw. ein JSON-Array
aus ein bis drei Zeichenketten (Titel ≤ 90, Meta-Description ≤ 200
Zeichen); Codezäune, HTML-Tags, Steuerzeichen und „ß" werden entfernt bzw.
ersetzt. Alles andere wird verworfen (502, „Bitte erneut generieren") —
nicht gekürzt.

**Nichts wird gespeichert.** „Übernehmen" ersetzt nur den Text im Feld (bzw.
den markierten Abschnitt); gespeichert wird mit dem Formular, über dessen
Endpunkt, Recht und Protokoll. Ob der Knopf erscheint, entscheidet der
Server im Rahmen der Verwaltung (`TextAssistProvider`: Rolle mit `ai:use`;
ohne Anbieter gesperrt mit Begründung) — kein Probeaufruf je Feld.

**Protokoll nur mit Metadaten.** Der `KiNutzung`-Eintrag trägt Funktion,
Aktion, Feldart, Zeichenzahl von Eingabe und Ausgabe, Anzahl geschützter
Stellen, Modell und Dauer — nie Eingabe oder Ergebnis. Eine gesperrte
Anfrage ist keine Nutzung und erzeugt keinen Eintrag; das Log zählt nur die
gesperrte Kategorie.

**Ohne Anbieter** (kein `ANTHROPIC_API_KEY`): Der Knopf ist gesperrt und
sagt warum; der Endpunkt antwortet 503 (`NOT_CONFIGURED`) mit klarer
Meldung.

Geprüft: `tests/api/text-assist-nutzlast.test.ts` (direkt) und
`tests/api/text-assist.test.ts` (HTTP). **Offen:** Die Sperrregeln sind
dieselbe Heuristik wie in Abschnitt 1 — ein Code ohne Schlüsselwort bleibt
unerkannt, und ein Satz wie „Schlüsselübergabe ab 2026" kann fälschlich
sperren (die Meldung erklärt dann, was zu tun ist). Die Qualität der
Vorschläge prüft keine automatisierte Reihe.
