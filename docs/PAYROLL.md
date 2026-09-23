# Lohnabrechnung

> Stand: 21. September 2026 (Wave 9).

---

## 1. Was das ist — und was es nicht ist

Die **monatliche Beitragsrechnung**: Bruttolohn aus freigegebenen Zeiten oder
Monatslohn, davon AHV/IV/EO, ALV, BVG, UVG und wahlweise Krankentaggeld, daraus
der Nettolohn. Genug für eine nachvollziehbare Lohnabrechnung im
Reinigungsgewerbe und als Grundlage für die Abrechnung mit der
Ausgleichskasse.

**Keine Lohnbuchhaltung.** Bewusst nicht enthalten:

| Fehlt | Warum |
|---|---|
| Quellensteuer | Tarife je Kanton, Zivilstand, Konfession und Kinderzahl, monatlich oder jährlich abgerechnet — ein eigenes System |
| Kinder- und Ausbildungszulagen | Kantonal geregelt, an Bewilligungen gebunden |
| 13. Monatslohn, Ferien- und Feiertagsentschädigung | Ergeben sich aus Vertrag und GAV, nicht aus einem Satz |
| Naturalleistungen, Spesen | Bewertungsfragen mit eigenen Regeln |
| Lohnausweis, Jahresabschluss | Formularpflichten mit eigenen Fristen |

**Eine halbe Umsetzung wäre gefährlicher als keine**: Sie sieht aus wie eine
vollständige Abrechnung. Was hier fehlt, gehört zur Treuhand — und dieser
Abschnitt steht da, damit niemand das Gegenteil annimmt.

---

## 2. Der Befund, der die Wave ausgelöst hat

`Payslip` stand seit der ersten Migration im Schema — samt Spalten für AHV,
ALV, BVG und UVG. Zwei Seiten lesen daraus (`/portal/lohn` und die
Personalakte), `payslip:create` war an Rollen vergeben.

**Es gab keinen Codepfad, der je eine Abrechnung erzeugt hätte.**

Dasselbe Muster wie bei den Automatisierungen (Wave 6) und der Zeiterfassung
(Wave 8): Felder und Berechtigungen, die eine Zusage machen, die das System
nicht einlöst.

---

## 3. Die Sätze

**Sie stehen nicht im Code.** Die Versuchung ist, `AHV = 5.3` als Konstante zu
schreiben. Das wäre für genau ein Jahr richtig und danach falsch — und zwar
still: Eine Lohnabrechnung mit dem Satz des Vorjahres sieht aus wie eine
Lohnabrechnung.

Drei Dinge ändern sich unabhängig voneinander:

- **jährlich** — AHV/IV/EO und die ALV-Grenze, vom Bund festgelegt,
- **je Betrieb** — der UVG-Satz, nach Branche und Schadenerfahrung, im Vertrag
  mit der Versicherung,
- **je Vorsorgeeinrichtung** — der BVG-Plan, oft über dem Gesetzesminimum.

`PayrollSetting` hält sie je Organisation **und Jahr**. Alte Zeilen bleiben
stehen: Eine nachträgliche Korrektur einer Abrechnung von 2025 muss mit den
Sätzen von 2025 rechnen. Sie zu überschreiben hiesse, die Vergangenheit
umzuschreiben.

### Die Vorbelegung für 2026

| Satz | Wert | Herkunft |
|---|---|---|
| AHV/IV/EO (Arbeitnehmeranteil) | 5,3 % | gesetzlich |
| ALV bis 148 200 CHF/Jahr | 1,1 % | gesetzlich |
| ALV darüber | 0 % | Solidaritätsbeitrag seit 2023 aufgehoben |
| UVG Nichtberufsunfall | 1,6 % | **Annahme** — steht im Versicherungsvertrag |
| Krankentaggeld | 0 % | **Annahme** — je nach GAV vorgeschrieben |
| BVG Eintrittsschwelle | 22 680 CHF | gesetzlich |
| BVG Koordinationsabzug | 26 460 CHF | gesetzlich |
| BVG Mindestkoordiniert | 3 780 CHF | gesetzlich |
| BVG Obergrenze | 90 720 CHF | gesetzlich |
| Altersgutschriften | 7 / 10 / 15 / 18 % ab 25 / 35 / 45 / 55 | gesetzliches Minimum |
| Arbeitnehmeranteil BVG | 50 % | gesetzliches Maximum (Art. 66 BVG) |

> **Eine Vorbelegung, keine Wahrheit.** Sie steht da, damit ein Betrieb nicht
> bei null anfängt — nicht, damit sie ungeprüft übernommen wird. Solange
> niemand die Sätze bestätigt hat, meldet jeder Lohnlauf
> `saetzeGeprueft: false`.

`bvgAnteilArbeitnehmer` ist auf 50 % gedeckelt: Gesetzlich trägt der Betrieb
mindestens die Hälfte der Altersgutschrift. Ein höherer Wert wäre kein
Tippfehler, den man durchlassen sollte — er stünde auf jeder Abrechnung des
Jahres.

---

## 4. Die Rechnung

`src/lib/payroll/beitraege.ts` — rein, ohne Datenbank, mit festen Zahlen
prüfbar (wie `lib/bi/math.ts`).

### Der koordinierte Lohn

Die Reihenfolge ist gesetzlich und nicht beliebig:

1. Unter der **Eintrittsschwelle** besteht keine Versicherungspflicht.
2. Der Lohn wird bei der **Obergrenze** gekappt.
3. Davon wird der **Koordinationsabzug** abgezogen (der Teil, den bereits die
   AHV deckt).
4. Was übrig bleibt, wird auf den **Mindestbetrag** angehoben.

**Schritt 4 wird beim Nachbauen am häufigsten vergessen**, und der Fehler
trifft genau die Teilzeitstellen, die in diesem Gewerbe die Mehrheit sind: Ohne
ihn fiele jemand knapp über der Schwelle auf fast null.

### Das Alter

Am **31. Dezember des Abrechnungsjahres**, nicht am Stichtag. Die
BVG-Altersbänder wechseln auf den 1. Januar nach dem Geburtstag; am Stichtag zu
rechnen liesse den Satz mitten im Jahr springen.

**Ohne Geburtsdatum wird nichts abgezogen.** Ein geratener Satz wäre ein
falscher Lohn; die fehlende Angabe ist eine Lücke in der Personalakte und
gehört dort behoben. Die Herleitung sagt das auch so.

### Rundung

**Je Beitragsart, nicht erst am Ende.** Der einzelne Abzug erscheint auf der
Abrechnung, und eine Summe, die sich aus den angezeigten Zeilen nicht
nachrechnen lässt, erzeugt eine Rückfrage je Monat und je Person.

### Zwei bewusste Vereinfachungen

**Die ALV-Grenze wird durch zwölf geteilt.** Die genaue Handhabung wäre eine
laufende Jahressumme mit rückwirkender Korrektur. Der Unterschied zeigt sich
nur bei sehr hohen, stark schwankenden Löhnen; im Reinigungsgewerbe tritt der
Fall nicht auf. Dass er bestünde, steht im Code.

**Die Jahreshochrechnung bei Stundenlohn kommt aus dem Pensum**, nicht aus
`Monatslohn × 12`. Bei schwankenden Stunden wäre Letzteres im Spitzenmonat zu
hoch und im schwachen zu tief, und der koordinierte Lohn spränge von Monat zu
Monat — mit ihm der BVG-Abzug. Gerechnet wird mit dem vereinbarten Pensum auf
eine 42-Stunden-Woche. Der Wert ist eine Annahme und steht als solche in
`breakdown`.

---

## 5. Der Bruttolohn

| Anstellung | Grundlage |
|---|---|
| **Monatslohn** | `monthlySalary × workloadPct / 100`. Auch in einem Monat mit wenigen Einsätzen — die Zeiterfassung dient dort der Planung und der Nachkalkulation, nicht der Lohnberechnung. Die Stunden werden trotzdem ausgewiesen |
| **Stundenlohn** | Summe der **freigegebenen** Erfassungen × Stundenansatz |

> **Nur freigegebene Zeiten zählen.** Das ist der Ertrag aus Wave 8 und die
> wichtigste Regel: Eine Abrechnung, die offene Zeiten mitnimmt, zahlt Stunden
> aus, die niemand geprüft hat. Offene werden gezählt und in der Antwort
> gemeldet — nicht bezahlt.

**Der Satz des Tages, nicht der von heute** (RB-009, 2026-09-23). Der
Stundenansatz einer Erfassung kommt aus der **Lohnhistorie** am Tag der
Arbeit, danach aus dem Schnappschuss der Zeiterfassung, erst zuletzt aus dem
aktuellen Satz. Beim Monatslohn gilt der Stand am Monatsende. Vorher rechnete
ein Lauf für den August nach einer Lohnerhöhung im September rückwirkend mit
dem neuen Satz.

**Der Monat endet um Mitternacht in Zürich**, nicht in UTC. Stunden vom 1.
zwischen 00:00 und 02:00 (Sommerzeit) landeten im Vormonat.

**Ein veröffentlichter Monat ist zu.** Der Lauf schreibt nur noch
unveröffentlichte Abrechnungen (`updateMany … published: false`, sonst
`create` mit Behandlung des Wettlaufs), und in einem veröffentlichten Monat
lassen sich Zeiten weder erfassen noch freigeben noch wieder öffnen. Vorher
überschrieb ein zweiter Lauf eine bereits sichtbare Abrechnung.

**Das Lohnportal** zeigt KTG bei den Abzügen, wo er abgezogen wird (vorher
fehlte er in der Aufstellung, und die Summe der Zeilen ergab nicht den
Nettolohn). Das Versprechen eines PDFs und eine Aussage zum Lohnausweis sind
entfernt — es gibt beides nicht. **Clenaris ist damit nicht „Swiss Payroll
compliant"** und behauptet es nicht; §9a gilt unverändert.

---

## 6. Der Ablauf

```
1. Zeiten freigeben            POST /api/time/approve
2. Sätze prüfen                GET/PATCH /api/payroll/settings?year=…
3. Lohnlauf                    POST /api/payroll/run
4. Ergebnis prüfen             GET /api/payroll/payslips?year=…&month=…
5. Veröffentlichen             POST /api/payroll/publish
```

**Schritt 1 vor Schritt 3** ist die Kontrolle, nicht die Reihenfolge einer
Bequemlichkeit.

**Ein laufender Monat wird abgewiesen** (422). Der Fall dahinter: Am 12. einen
Lauf starten, weil man „schon mal schauen" will — das Ergebnis sähe aus wie
eine Abrechnung und wäre um zwei Drittel zu tief, und ein späterer Lauf
überschriebe es stillschweigend. Wer die Zwischenzahl braucht, nimmt die
Zeiterfassung.

**Der Lauf ist idempotent** je Person und Monat. Ein zweiter Lauf überschreibt
die noch nicht veröffentlichten Abrechnungen und lässt die veröffentlichten
unberührt — genau das ist der Nachlauf, wenn eine vergessene Zeit nachträglich
freigegeben wurde.

**Veröffentlichen ist endgültig.** Ab da ist die Abrechnung sichtbar und
unveränderlich — dieselbe Schwelle wie beim Ausstellen einer Rechnung. **Es
gibt kein Zurücknehmen:** Eine Abrechnung, die wieder verschwindet, ist
schlimmer als eine falsche, die korrigiert wird. Korrekturen laufen über die
Abrechnung des Folgemonats.

---

## 7. Die Herleitung

`Payslip.breakdown` hält als **Momentaufnahme** fest:

- die angewandten Sätze (vollständig),
- das Alter, mit dem gerechnet wurde,
- den koordinierten Jahreslohn und den BVG-Altersband-Satz,
- die Zahl der berücksichtigten und der offenen Erfassungen,
- die Jahreshochrechnung.

Dieselbe Überlegung wie bei der Empfängeradresse einer Rechnung: Ändert sich
ein Satz im nächsten Jahr, bleibt die alte Abrechnung nachvollziehbar.

Und der eigentliche Zweck: **Eine Lohnabrechnung, bei der sich der BVG-Abzug
nicht nachrechnen lässt, erzeugt genau eine Rückfrage je Monat und je Person.**

---

## 8. Wer was darf

| Berechtigung | Erlaubt | Rollen |
|---|---|---|
| `payslip:read_own` | Die eigene Abrechnung — **nur veröffentlichte** | alle Angestellten |
| `payslip:create` | Lohnlauf; Lohn, AHV-Nummer und IBAN in der Personalakte | ADMIN, SUPER_ADMIN |
| `payslip:read_all` | Alle Abrechnungen ansehen | ADMIN, SUPER_ADMIN |
| `payslip:publish` | Veröffentlichen, Sätze pflegen | ADMIN, SUPER_ADMIN |

**Die Betriebsleitung hat keines davon.** Sie gibt Zeiten frei
(`timetracking:approve`) und sieht keine Löhne — das ist der bestehende
Entscheid aus der Personalakte und bleibt so.

**Eine unveröffentlichte Abrechnung existiert für die eigene Person nicht**
(404, nicht 403). Sie ist ein Entwurf und kann sich noch ändern; eine Zahl,
die sich ändert, nachdem jemand sie gesehen hat, ist schlimmer als keine Zahl.
Die Einschränkung steht in der Prisma-`where`-Klausel, nicht in einer Prüfung
danach.

---

## 9. Offen

| Punkt | Warum noch nicht |
|---|---|
| **PDF der Abrechnung** | `Payslip.pdfUrl` steht im Schema und bleibt leer. Ein Lohnausweis hat formale Anforderungen, die über ein Rendering hinausgehen; die Zahlen sind über die Schnittstelle vollständig verfügbar |
| **Maske in der Verwaltung** | Der Lauf ist heute nur über die Schnittstelle zu starten |
| **Arbeitgeberbeiträge** | Für die Abrechnung mit der Ausgleichskasse nötig, für den Nettolohn nicht. Eigene Rechnung mit eigenen Sätzen |
| **Quellensteuer und Zulagen** | Siehe Abschnitt 1 — Treuhand |
| **13. Monatslohn, Ferien- und Feiertagsentschädigung** | Ergeben sich aus Vertrag und GAV, nicht aus einem Satz — siehe Abschnitt 1 |
| **Lohnausweis und Jahresabschluss** | Formularpflichten mit eigenen Fristen — siehe Abschnitt 1 |

---

## 9a. Fachliche Prüfung — ausdrücklich ausstehend

> **Diese Wave ist und bleibt bis auf Weiteres als PARTIAL eingestuft.**

Was hier steht, ist eine **technisch geprüfte Rechnung mit fachlich
ungeprüften Sätzen.** Der Unterschied ist wichtig genug, um ihn auszuschreiben:

- Die Rechnung selbst ist gegen feste Zahlen geprüft
  (`tests/api/lohnabrechnung.test.ts`): koordinierter Lohn in allen vier
  Fällen, Altersbänder ab ihrem Anfang, ALV-Grenze auf den Monat,
  Art. 66 BVG (über 50 % Arbeitnehmeranteil wird abgewiesen). Diese Prüfungen
  belegen, dass die Formeln das tun, was in diesem Dokument steht.
- Sie belegen **nicht**, dass die hinterlegten Prozentsätze, Eintrittsschwellen
  und Grenzbeträge den geltenden Werten entsprechen. Beitragssätze ändern sich
  von Jahr zu Jahr; der Wert im Seed ist ein Startwert, kein Nachweis.
- Kein Treuhandbüro und keine Ausgleichskasse hat diese Umsetzung bisher
  angesehen.

**Vor dem produktiven Einsatz sind daher extern zu bestätigen:** AHV/IV/EO-,
ALV- und UVG-Sätze, die BVG-Eintrittsschwelle, der Koordinationsabzug, die
Ober- und Untergrenze des koordinierten Lohns, die Altersgutschriftsbänder und
die ALV-Höchstgrenze — jeweils für das Abrechnungsjahr und für den Kanton
Bern.

Bis dahin gilt für jede Aussage über dieses Modul: **keine vollständige
Schweizer Lohnbuchhaltung**, sondern eine nachvollziehbare Beitragsrechnung,
deren Sätze konfiguriert und deren Richtigkeit von aussen zu bestätigen ist.

---

## 10. Wo was steht

| Datei | Inhalt |
|---|---|
| `src/lib/payroll/beitraege.ts` | Die Rechnung — rein, direkt prüfbar |
| `src/server/services/payroll.service.ts` | Bruttolohn, Lauf, Veröffentlichen, Lesen |
| `src/lib/validation/payroll.ts` | Schemata — **kein Feld für einen Betrag** |
| `src/app/api/payroll/**` | Sechs Endpunkte |
| `prisma/schema.prisma` | `PayrollSetting`, erweiterter `Payslip` |
| `tests/api/lohnabrechnung.test.ts` | 26 Prüfungen — Rechnung mit festen Zahlen, Ablauf über HTTP |
