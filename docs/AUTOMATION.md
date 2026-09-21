# Automatisierungen und Hintergrundläufe

> Stand: 21. September 2026 (Wave 6).

---

## 1. Der Befund

`Automation`, `AutomationAction` und `AutomationRun` standen seit der ersten
Migration im Schema. Es gab eine Oberfläche, mit der sich Regeln anlegen,
aktivieren und löschen liessen, und einen Dienst, der sie verwaltete.

**`automation_runs` wurde von keinem Codepfad je beschrieben.**

Das ist die schlechteste Form einer Lücke: keine fehlende Funktion, sondern
eine Zusage, die das System nicht einlöst. Wer eine Regel anlegt, sieht sie in
der Liste — aktiv, mit Auslöser und Aktionen — und verlässt sich darauf, dass
die Erinnerung hinausgeht.

Nicht zu verwechseln mit `automation.service.ts`: Der enthält **fest
verdrahtete** Tagesaufgaben (Terminerinnerungen, Bewertungsanfragen,
Geburtstage, Nachfassaufgaben) und läuft seit jeher. Was fehlte, war die
Maschine für die Regeln, die Benutzer selbst anlegen.

---

## 2. Der Ablauf

```
Auslöser  →  Bedingungen  →  Lauf anlegen  →  (Verzögerung)  →
Bedingungen erneut  →  Aktionen der Reihe nach  →  Ergebnis
```

**Zwei Hälften, getrennt durch die Zeit.** `emitAutomationTrigger` läuft im
Geschäftsvorgang mit und legt nur den Lauf an; ausgeführt wird er später durch
`runDueAutomations` aus dem Scheduler.

Das ist die einzige Bauart, die mit `delayMinutes` verträglich ist — und sie
hat einen zweiten Nutzen: **Eine Automatisierung kann keinen
Geschäftsvorgang scheitern lassen.** Wer eine Regel mit einer unerreichbaren
Gegenstelle anlegt, bringt damit nicht das Buchungsformular zum Stehen.
`emitAutomationTrigger` wirft zusätzlich nie.

### Warum der Zustand beim Ausführen neu geladen wird

Zwischen Auslöser und Ausführung können Tage liegen. In dieser Zeit ändert sich
die Welt: Die Buchung wird abgesagt, die Offerte abgelehnt, die Rechnung
bezahlt. Der Lauf speichert deshalb **keine Momentaufnahme**, sondern lädt den
Vorgang neu und prüft die Bedingungen ein zweites Mal.

Ohne diesen zweiten Durchgang ginge die Erinnerung an einen Termin hinaus, den
es nicht mehr gibt — der Fehler, den die Kundschaft bemerkt und der Betrieb
nicht. Nebenbei bleibt so auch keine Sammlung von Personendaten in einer
Json-Spalte liegen, die niemand aufräumt.

### Genau ein Lauf je Regel und Vorgang

`@@unique([automationId, entity, entityId])`. Ein doppelter Auslöser — zwei
Klicks, ein wiederholter Aufruf, ein Nachtlauf, der einen Vorgang erneut findet
— erzeugt keine zweite E-Mail. Die Entscheidung liegt in der Datenbank und
nicht in einer Prüfung davor, die zwei gleichzeitige Aufrufe beide bestünden.

---

## 3. Die Auslöser

Angeschlossen sind die Zustandsübergänge, die es tatsächlich gibt:

| Auslöser | Wo gemeldet |
|---|---|
| `BOOKING_CREATED` | `createBooking` — Website und Büro |
| `BOOKING_CONFIRMED` | `confirmBooking` |
| `BOOKING_CANCELLED` | `cancelBooking` |
| `BOOKING_COMPLETED` | `completeJob`, wenn der letzte Einsatz der Buchung fertig ist |
| `QUOTE_SENT` | `sendQuote` |
| `INVOICE_ISSUED` | `issueInvoice` |
| `JOB_ASSIGNED` | `assignJob` |
| `JOB_COMPLETED` | `completeJob` |
| `LEAD_CREATED` | `createLead` und `createLeadFromContactForm` |

Die übrigen Werte des Aufzählungstyps (`BOOKING_REMINDER_24H`,
`QUOTE_EXPIRING`, `CUSTOMER_BIRTHDAY`, …) sind **noch nicht angeschlossen**.
Sie bezeichnen keinen Zustandsübergang, sondern einen Zeitpunkt, und gehören
damit in den Nachtlauf, der die fälligen Vorgänge sucht. Für die häufigsten
davon gibt es bereits die fest verdrahteten Läufe in `automation.service.ts`;
sie durch Regeln zu ersetzen wäre eine eigene Änderung mit eigenem Nachweis.

**Der Auslöser steht immer ausserhalb der Transaktion** und nach allem, was
fachlich dazugehört. Innerhalb sähe die Maschine den Datensatz nicht, denn sie
lädt ihn beim Ausführen neu.

---

## 4. Bedingungen

Eine Tabelle aus Feldnamen und Vergleichen. Alle sind mit **und** verknüpft.

```json
{
  "kunde.typ": "BUSINESS",
  "betrag": { "gte": 500 },
  "status": { "in": ["PENDING", "CONFIRMED"] }
}
```

| Vergleich | Bedeutung |
|---|---|
| (blosser Wert) | Gleichheit |
| `eq`, `ne` | gleich, ungleich |
| `in`, `notIn` | in einer Liste |
| `gt`, `gte`, `lt`, `lte` | Zahlenvergleich |
| `contains` | Teilzeichenkette, Gross-/Kleinschreibung egal |
| `exists` | Wert vorhanden / nicht vorhanden |

**Warum keine Ausdruckssprache.** `kunde.typ == "BUSINESS" && betrag > 500`
wären ein Parser, ein Auswerter und eine Absicherung gegen alles, was ein
Ausdruck sonst anrichten kann — drei Dinge, die falsch sein können, für ein
Merkmal, dessen Benutzer in einem Formular aus Feldern auswählen.

**Kein `regex`.** Ein vom Benutzer gestellter regulärer Ausdruck ist eine
Rechenzeitbombe (katastrophales Backtracking), und der Gewinn wäre gering.

**Kein „oder".** Es lässt sich durch zwei Regeln ausdrücken, und die Auswertung
bräuchte sonst eine Baumstruktur.

Zahl und Zeichenkette werden **gutmütig** verglichen (`"5"` trifft `5`). Die
Bedingungen kommen aus einem Json-Feld, in dem beides vorkommt; ein strenger
Vergleich liesse eine Regel stillschweigend nie greifen — sie stünde in der
Liste, wäre aktiv und täte nichts.

Leere Bedingungen heissen **ja**.

---

## 5. Die Nutzlast

Was eine Regel über den Vorgang weiss. **Bewusst schmal.**

Die Versuchung ist, den ganzen Datensatz hineinzugeben — dann kann jede
Bedingung auf jedes Feld schauen. Der Preis wäre, dass Personendaten in
Vorlagen und Webhook-Rümpfen landen, an die beim Entwurf niemand gedacht hat.
**Was hier nicht steht, kann eine Regel nicht verschicken.**

Insbesondere fehlen: AHV-Nummer, IBAN, Alarmcode, Zugangsdaten am Objekt,
interne Notizen.

| Ressource | Felder |
|---|---|
| `Booking` | `nummer`, `status`, `termin`, `terminEnde`, `betrag`, `netto`, `kunde` |
| `Quote` | `nummer`, `status`, `gueltigBis`, `betrag`, `kunde` |
| `Invoice` | `nummer`, `status`, `faelligAm`, `betrag`, `kunde` |
| `Job` | `nummer`, `status`, `beginn`, `kunde`, `zugeteilt` |
| `Lead` | `nummer`, `status`, `quelle`, `vorname`, `nachname`, `firma`, `name`, `email` |
| `Customer` | `kunde` |
| `Task` | `titel`, `status`, `faelligAm`, `prioritaet` |

`kunde` ist überall gleich aufgebaut: `id`, `typ`, `firma`, `vorname`,
`nachname`, `name`, `email`, `userId`.

---

## 6. Die Aktionen

Jede Art hat ein eigenes Konfigurationsschema
(`src/lib/validation/automation-config.ts`), geprüft **beim Anlegen** und noch
einmal **beim Ausführen** — Letzteres, weil eine Regel im Bestand aus der Zeit
vor dieser Prüfung stammen kann. Sie endet dann als `SKIPPED` mit Begründung,
statt mit geratenen Werten ausgeführt zu werden.

> Bis Wave 6 war `config` ein `z.record(z.unknown())` — also alles. Solange die
> Regeln nie liefen, war das folgenlos: ein Feld, das niemand liest, kann
> nichts anrichten. Mit der Maschine bestimmt `config`, an wen eine E-Mail
> geht, welcher Datensatz seinen Status ändert und welche Adresse der Server
> aufruft. Unvalidiert wäre das eine Eingabemaske für alles, was der Server
> kann — für jede Person mit `automation:update`.

### `SEND_EMAIL`, `SEND_SMS`

```json
{ "templateKey": "booking_reminder", "empfaenger": "CUSTOMER" }
```

**Keine freie Adresse und kein freier Text.** Der Empfänger ergibt sich aus der
**Rolle im Vorgang** (`CUSTOMER`, `ASSIGNED_EMPLOYEE`, `MANAGEMENT`), der Text
aus einer gepflegten Vorlage. Beides ist dieselbe Überlegung: Ein Feld, in das
jemand eine Adresse schreibt, wäre ein Versandkanal für Beliebiges — mit den
Daten des Vorgangs darin, an die echte Kundschaft, mit dem echten Absender.

Fehlt die Vorlage, endet die Aktion `SKIPPED` und wird **nicht** wiederholt:
Sie kommt nicht von selbst zurück, und drei Versuche im Abstand von einer
Stunde verdeckten nur die eigentliche Auskunft.

### `CREATE_TASK`, `CREATE_NOTIFICATION`

```json
{ "titel": "Buchung {{nummer}} prüfen", "faelligInTagen": 1, "prioritaet": "HIGH" }
```

Die Aufgabe wird an den auslösenden Vorgang gehängt — über die Spalte, die zu
seiner Art gehört (`Task` hat keine allgemeine `relatedType`-Spalte, sondern je
eine Verknüpfung; das ist die bessere Bauart, weil der Fremdschlüssel hält).

### `UPDATE_STATUS`

```json
{ "ziel": "lead", "status": "CONTACTED" }
```

Eine **Erlaubnisliste**, und sie ist die ganze Sicherheitsmassnahme:

| Ziel | Erlaubte Werte |
|---|---|
| `lead` | `CONTACTED`, `QUALIFIED`, `LOST` |
| `booking` | `CONFIRMED`, `CANCELLED` |
| `job` | `UNASSIGNED`, `CANCELLED` |

Ohne sie hiesse die Aktion: „schreibe in ein beliebiges Feld eines beliebigen
Datensatzes einen beliebigen Wert". Das ist keine Automatisierung mehr, das ist
ein Datenbankzugang über ein Formular.

**Nichts Finanzielles, und das bleibt so.** Eine Rechnung wird nicht
automatisch ausgestellt, storniert oder bezahlt gesetzt — Belegnummern sind
lückenlos zu vergeben (Art. 957a OR), und eine ausgestellte Rechnung ist
unveränderlich. Dasselbe gilt für den Abschluss einer Unterschrift.

Zusätzlich darf eine Regel **nur den Datensatz ändern, der sie ausgelöst hat**.
Ohne diese Prüfung wäre `UPDATE_STATUS` ein Weg, aus einem Auslöser heraus
einen anderen Datensatz zu ändern — und über eine Kette von Regeln beliebig
viele.

### `WEBHOOK`

```json
{ "url": "https://gegenstelle.ch/hook", "secret": "…" }
```

Siehe Abschnitt 7 — die gefährlichste Aktion, und deshalb die engste.

### `AI_GENERATE`

**Ausdrücklich nicht umgesetzt**, und das ist eine Aussage und keine Lücke: Ein
Text, den eine Maschine erzeugt und der ohne Ansehen an die Kundschaft geht,
ist genau das, was `docs/bi/` für den Assistenten ausschliesst („der Assistent
entwirft nur"). Der Weg dahin führt über eine Aufgabe, die jemand liest — und
den gibt es bereits als `CREATE_TASK`. Die Aktion endet `SKIPPED` mit dieser
Begründung.

---

## 7. Ausgehende Aufrufe

Ein Webhook ist ein Aufruf, den **der Server** ausführt. Er läuft aus dem Netz
des Servers heraus — und in dieses Netz hinein. Wer die Adresse bestimmen darf,
erreicht alles, was der Server erreicht:

- `http://127.0.0.1:5432` — die Datenbank,
- `http://169.254.169.254/latest/meta-data/` — der Metadatendienst der Cloud,
  der Zugangsdaten herausgibt,
- `http://10.0.0.5/admin` — der Verwaltungszugang des Nachbardienstes.

Das ist serverseitige Anfragefälschung (SSRF), und sie stünde jeder Person mit
`automation:update` offen.

### Die Prüfung

**Eine Prüfung der Zeichenkette genügt nicht.** Ein Name im *öffentlichen* DNS
darf auf `127.0.0.1` zeigen, und es gibt Dienste, die genau das anbieten. Die
Zeichenkette sagt nichts darüber, wo der Aufruf landet.

Geprüft wird deshalb die **aufgelöste Adresse**, und zwar **alle**, die die
Auflösung liefert — ein Name mit zwei Einträgen (einer öffentlich, einer auf
der Rückschleife) käme sonst durch, und welcher beim Aufruf gewählt wird,
entscheidet nicht diese Anwendung.

| Massnahme | Grund |
|---|---|
| Nur `https` | Über `http` ginge der Inhalt des Vorgangs im Klartext durch fremde Netze |
| Alle aufgelösten Adressen öffentlich | Die eigentliche SSRF-Prüfung |
| `AUTOMATION_WEBHOOK_HOSTS` | Optionale Erlaubnisliste — die engere Einstellung für Betriebe mit festen Gegenstellen |
| Keine Weiterleitungen | Eine Weiterleitung führte an der Zielprüfung vorbei |
| 10 s Zeitlimit | Sonst bindet eine langsame Gegenstelle den Lauf |
| Antwort gedeckelt gelesen und verworfen | Der Rumpf der Gegenstelle interessiert nicht und gehört nirgends hin |
| HMAC statt Geheimnis in der Kopfzeile | Ein Geheimnis im Klartext stünde in jedem Protokoll dazwischen |

### Was bleibt

Zwischen der Prüfung hier und der Auflösung, die `fetch` selbst vornimmt, liegt
ein Moment. Wer den DNS-Eintrag in diesem Moment ändert (**DNS Rebinding**),
umgeht die Prüfung. Vollständig schliessen liesse sich das nur, indem die
geprüfte Adresse direkt angewählt wird — und dann passt der Name im
TLS-Handschlag nicht mehr, der Aufruf scheitert an jedem sauber eingerichteten
Ziel.

**Diese Lücke wird benannt und nicht verschwiegen.** Sie verlangt einen
Angreifer mit Kontrolle über einen DNS-Eintrag und ein genaues Zeitfenster;
davor liegen `automation:update`, nur `https`, keine Weiterleitungen, ein
Zeitlimit und eine Grössengrenze. Wer es enger will, setzt
`AUTOMATION_WEBHOOK_HOSTS`.

---

## 8. Vorlagen

`{{kunde.vorname}}` — Ersetzung, keine Auswertung.

Das Schema nennt die Syntax „handlebars-artig", und die Versuchung ist, einfach
Handlebars zu nehmen. Das brächte Schleifen, Bedingungen, Teilvorlagen und
Helfer — eine kleine Programmiersprache, die jemand mit `template:update` in
eine E-Mail schreiben kann, die an echte Kundschaft geht. Gebraucht wird davon
nichts.

**Unbekannte Platzhalter werden leer.** Bliebe der Platzhalter stehen, ginge
`Guten Tag {{kunde.vorname}}` hinaus und sähe nach einem defekten System aus.
Leer ist still falsch, aber nicht peinlich — und `fehlendePlatzhalter` landet im
Ergebnis des Laufs, damit die Vorlagenpflege es sieht, bevor jemand anders es
tut.

**HTML wird maskiert, auch bei Werten aus der eigenen Datenbank.** Ein
Kundenname kommt aus einem öffentlichen Buchungsformular.

---

## 9. Wiederholung

Drei Versuche mit wachsendem Abstand (5 min, 60 min), danach bleibt `FAILED`
stehen und ist sichtbar.

Ohne Zähler gäbe es nur zwei Möglichkeiten, und beide sind falsch: Ein
Fehlschlag wäre entweder endgültig — dann fällt jede Erinnerung aus, während
der Mailversand eine Minute lang klemmt — oder er würde ewig wiederholt, und
eine dauerhaft unerreichbare Gegenstelle erzeugte eine Schleife, die mit jedem
Vorgang länger wird.

**Was nicht wiederholt wird**, weil ein zweiter Versuch dasselbe Ergebnis
brächte:

- eine unverstandene Aktionskonfiguration,
- eine fehlende Vorlage,
- eine abgewiesene Webhook-Adresse (privat, falsches Schema, nicht erlaubt),
- ein Vorgang, den es nicht mehr gibt,
- Bedingungen, die nicht mehr zutreffen.

Netzwerkfehler und Zeitlimits dagegen sind vorübergehend und werden wiederholt.

Die Aktionsreihe **bricht beim ersten Fehler ab** und der Lauf wird als Ganzes
wiederholt. Das ist richtig, solange die Aktionen aufeinander aufbauen —
„Aufgabe anlegen, dann benachrichtigen" ohne Aufgabe ergibt keine sinnvolle
Benachrichtigung. Der Preis: Eine bereits ausgeführte Aktion läuft beim
Wiederholungsversuch erneut. Deshalb sind die Aktionen so gewählt, dass das
verträglich ist — die Statusänderung setzt einen Zielzustand und keinen
Übergang, und ein zweiter Versand derselben Erinnerung ist ärgerlich, aber
nicht falsch.

---

## 10. Wann gelaufen wird

| Takt | Was |
|---|---|
| **stündlich** (`/api/cron/hourly`) | Terminerinnerungen, fällige Automatisierungen (bis 200) |
| **täglich** (`/api/cron/daily`) | Die festen Tagesaufgaben, der Nachlauf der Dateiprüfung, fällige Automatisierungen (bis 500) |

**Stündlich und nicht minütlich.** `delayMinutes` rechnet in Minuten, eine
Regel mit „nach 5 Minuten" wartet damit bis zu einer Stunde. Das ist die
bewusste Grenze dieser Bauart: Sie kommt ohne eigenen Arbeitsprozess und ohne
Warteschlangendienst aus, und der Preis ist die Genauigkeit. Für „Erinnerung 24
Stunden vorher" und „Nachfassen in drei Tagen" — also für das, wofür Regeln in
einem Reinigungsbetrieb da sind — ist eine Stunde ohne Bedeutung.

Wer Minutengenauigkeit braucht, braucht einen Arbeitsprozess, und das ist eine
Betriebsentscheidung.

Die Automatisierungen laufen in **beiden** Takten. Fällt der stündliche aus,
holt der nächtliche auf, statt dass ein Rückstau bis zum nächsten Eingriff
liegen bleibt. `limit` begrenzt, was ein Lauf anfasst — ein Rückstau soll den
Scheduler nicht über sein Zeitlimit tragen, sondern über mehrere Takte abgebaut
werden.

---

## 11. Der Nachlauf der Dateiprüfung

Aus Wave 2 blieb offen: Dateien ohne Befund kommen nicht von selbst frei.

- **Altbestand** (`LEGACY_UNSCANNED`) — die Migration hat ihn ehrlich als
  ungeprüft markiert, mit der Folge, dass er gesperrt ist.
- **Fälle, bei denen der Prüfer beim Abschluss nicht erreichbar war**
  (`ERROR`) — der Upload ist durch, die Datei liegt fest, niemand hat je wieder
  hingesehen.

`scripts/scan-backfill.ts` ist richtig für eine einmalige Umstellung und falsch
für einen Zustand, der jeden Tag neu entsteht. Seit Wave 6 läuft
`runScanNachlauf` im Nachtlauf, begrenzt auf 200 Dateien — ein Lauf über
zehntausend wäre selbst eine Störung.

---

## 12. Wo was steht

| Datei | Inhalt |
|---|---|
| `src/lib/automation/conditions.ts` | Bedingungssprache — rein, direkt prüfbar |
| `src/lib/automation/template.ts` | Platzhalter — Ersetzung, keine Auswertung |
| `src/lib/automation/webhook.ts` | Adressprüfung und Aufruf |
| `src/lib/validation/automation-config.ts` | Konfigurationsschema je Aktionsart, Erlaubnisliste der Statuswerte |
| `src/server/services/automation-engine.service.ts` | Auslöser, Lader, Lauf, Aktionen |
| `src/server/services/automation.service.ts` | Die **festen** Tagesaufgaben (nicht die Regeln) |
| `src/app/api/cron/*` | Die beiden Takte |
| `tests/api/automatisierungen.test.ts` | 36 Prüfungen — Kern direkt, Maschine über HTTP samt Blick in `automation_runs` |
