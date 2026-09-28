# Qualitätskontrolle

> Stand: 23. September 2026 (Wave 11).

---

## 1. Der Befund, der diese Wave ausgelöst hat

`ContractVersion` trägt seit Wave 10 drei Felder:

| Feld | Bedeutung |
|---|---|
| `targetQualityScore` | Zugesagter Zielwert der Qualitätsbewertung (0–100) |
| `inspectionIntervalDays` | Wie oft eine Kontrolle vereinbart ist |
| `responseHours` | Zugesagte Reaktionszeit auf eine Reklamation |

Sie wurden **gespeichert, angezeigt und gedruckt** — im Formular, in der
Vertragsakte, im Vertrags-PDF. Gemessen wurden sie von nichts. Eine
Volltextsuche über `src/` und `scripts/` fand vierundzwanzig Fundstellen, und
keine einzige las die Werte, um etwas mit ihnen zu vergleichen.

Das ist genau das Muster, das `scripts/feature-integrity.ts` seit Wave 10
sucht: Schema und Oberfläche vorhanden, aber kein Weg dorthin. Hier hat es die
eigene Wave gefunden — und zwar in Code, der einen Tag alt war.

**Wave 11 macht die Zusage messbar.** Sie erfindet dabei keinen Massstab: Wo
nichts vereinbart wurde, wird nichts behauptet.

---

## 2. Was gebaut wurde und was ausdrücklich nicht

**Gebaut:** Die **Begehung vor Ort** — eine Qualitätskontrolle an einem
Vertrag oder Objekt, mit Kriterien, Punkten und einem Urteil gegen die
Zusage, die am Begehungstag galt.

**Nicht gebaut:** ein neues Reklamationsobjekt. Das Schema hält seit je fest:

> Eine Reklamation ist in dieser Anwendung eine Bewertung — die Massnahme dazu
> hängt hier, nicht an einem neuen Reklamationsobjekt.
> — `Review.correctiveActions`

Diese Entscheidung bleibt. Was fehlt, ist die Messung der Reaktionszeit gegen
`responseHours`; der Rechenkern dafür steht (`reaktionsfrist`), die Anbindung
an `Review` ist in §8 als offener Punkt benannt.

**Nicht gebaut:** ein zweites Kontrollregister. `ControlEntry` in der
Unternehmensführung ist die Governance-Sicht — Kontrollen im Sinne von
Compliance. Diese hier ist die Begehung, die misst, ob die geleistete Arbeit
der Zusage entspricht. Zwei verschiedene Dinge mit demselben deutschen Wort.

---

## 3. Die vier Zusicherungen

### 3.1 Die Punktzahl rechnet der Server

`scoreAchieved`, `scorePercent` und `outcome` entstehen aus den Positionen
über `src/lib/quality/bewertung.ts` — nie aus einer Angabe des Clients. Das
Zod-Schema hat **kein Feld** dafür; ein mitgeschicktes Ergebnis prallt ab,
statt stillschweigend übernommen zu werden.

Dieselbe Regel wie beim Preis, und der Grund ist derselbe: Eine Note, die der
Beurteilte selbst mitschickt, ist keine.

> Die Maske zeigt trotzdem eine Zwischenzahl an — gerechnet vom **selben
> reinen Kern**, den der Server benutzt. Deshalb stimmen beide überein, ohne
> dass die Zahl je über die Leitung ginge. Für eine Begehung im Keller ohne
> Empfang ist das der Unterschied zwischen benutzbar und nicht.

### 3.2 Der Massstab ist ein Schnappschuss

Beim Anlegen wird festgehalten, **welche Vertragsfassung am Begehungstag
galt** (`contractVersionId`) und welchen Zielwert sie zusagte
(`targetScore`). Verschiebt jemand das Begehungsdatum, verschiebt sich der
Massstab mit — sonst trüge die Kontrolle die Zusage eines Tages, an dem sie
nicht stattfand.

Dieselbe Überlegung wie beim Einsatz (`Job.contractVersionId`) und bei der
Rechnung (`Invoice.contractVersionId`): Eine Messung, die nach einer
Vertragsänderung anders ausfiele, wäre kein Beleg.

Gesucht wird die Fassung, deren Geltungszeitraum den Stichtag enthält.
Findet sich keine — die Begehung liegt vor dem Vertragsbeginn, oder der
Vertrag ist noch Entwurf —, gilt **kein** Massstab. Auf die nächstbeste
Fassung auszuweichen wäre eine erfundene Zusage.

### 3.3 Abgeschlossen ist unveränderlich

| Zustand | Ändern | Verwerfen | Abschliessen |
|---|:--:|:--:|:--:|
| `DRAFT` | ✓ | ✓ | ✓ |
| `COMPLETED` | 422 | 422 | 422 |
| `CANCELLED` | 422 | 422 | 422 |

Korrigiert wird über eine **Nachkontrolle** (`followUpOfId`) — und die gibt es
genau einmal je Begehung. Der Teilindex erzwingt es; zwei Nachkontrollen wären
zwei Korrekturen desselben Belegs, und welche gilt, wäre eine Frage der
Reihenfolge.

Zwei Dinge stehen zusätzlich als CHECK-Bedingung in der Datenbank, weil eine
Prüfung im Dienst der nächste Codepfad umgeht, ohne es zu merken:

```sql
CHECK ("status" <> 'COMPLETED' OR ("number" IS NOT NULL AND "completedAt" IS NOT NULL))
CHECK ("scoreAchieved" >= 0 AND "scorePossible" >= 0 AND "scoreAchieved" <= "scorePossible")
```

Die Nummer (`QK-JJJJ-NNNNN`) entsteht **beim Abschluss**, in derselben
Transaktion wie der Zustand — dieselbe Regel wie bei Rechnung und Vertrag: Ein
verworfener Entwurf soll keine Lücke hinterlassen, und scheitert der
Abschluss, rollt die Nummer mit zurück.

### 3.4 Ohne Zusage kein Urteil

Ein Vertrag ohne `targetQualityScore`, eine Begehung ohne Vertrag, eine
Begehung vor dem Vertragsbeginn: Das Ergebnis ist `OHNE_ZIEL`. Die Begehung
**misst** — 80 % bleiben 80 % —, aber sie urteilt nicht.

Dieselbe Haltung wie bei der Indexierung (`indexReference` erhöht nichts von
selbst) und bei der Kündigung (das System beurteilt nicht, ob sie wirksam
ist).

---

## 4. Der Rechenkern

`src/lib/quality/bewertung.ts` — rein, ohne Prisma, ohne `server-only`, direkt
geprüft in `tests/api/qualitaet-rechenkern.test.ts` (19 Fälle).

### 4.1 Gewichtung statt Mittelwert

Ein Kriterium „Sanitärbereich" wiegt schwerer als „Papierkorb geleert". Ein
ungewichteter Mittelwert liesse sich durch viele Kleinigkeiten schönrechnen —
genau das, was eine Qualitätskontrolle nicht tun darf:

| | ungewichtet | mit Gewicht 4 auf dem Sanitärbereich |
|---|---|---|
| Sanitär 0/5, drei weitere 5/5 | **75 %** | **42,9 %** |

### 4.2 „Nicht beurteilbar" ist keine schlechte Note

`weight = 0` klammert die Position aus der Rechnung aus, statt sie als null
Punkte zu werten. Der Keller war verschlossen — das darf die Punktzahl weder
senken noch heben.

War **keine** Position beurteilbar, ist `scorePercent` **`null`**, nicht 0.
Eine solche Begehung lässt sich nicht abschliessen: Sie wäre ein Beleg über
nichts, und die Zahl darauf liesse sich von „null Punkte" nicht unterscheiden,
sobald jemand sie abschreibt.

### 4.3 Toleranz

| Ergebnis | Bedingung |
|---|---|
| `BESTANDEN` | Prozent ≥ Zielwert |
| `KNAPP` | Prozent ≥ Zielwert − 5 |
| `NICHT_BESTANDEN` | darunter |
| `OHNE_ZIEL` | kein Zielwert vereinbart, oder nichts beurteilbar |

`KNAPP` ist ein Hinweis, keine Massnahme — und sieht deshalb warnend aus, nicht
zerstörend. Die Unterscheidung wäre wertlos, wenn beides gleich aussähe.

### 4.4 Fälligkeit

Gerechnet ab der **letzten durchgeführten** Kontrolle, nicht ab dem
Vertragsbeginn: Wer früher kontrolliert als vereinbart, verschiebt die nächste
Frist nach hinten — sonst häuften sich Termine an, die niemand gewollt hat.
Gab es noch keine, zählt der Vertragsbeginn.

Ein **Entwurf zählt nicht**. Er sagt, dass jemand begonnen hat, nicht dass
kontrolliert wurde.

### 4.5 Reaktionszeit

`reaktionsfrist()` rechnet **Kalenderzeit, keine Arbeitszeit**. Eine Zusage
„Reaktion in 24 Stunden" ist gegenüber der Kundschaft eine Aussage über die
Uhr, nicht über Bürozeiten; eine Umrechnung auf Öffnungszeiten wäre eine
Auslegung des Vertrags, die dieses System nicht vornimmt. Wer Bürozeiten
meint, vereinbart eine entsprechend längere Frist.

Ohne Antwort gibt es kein Urteil, sondern eine offene Frist: `eingehalten`
bleibt `null`, und `fristBis` sagt, bis wann noch Zeit ist.

---

## 5. Rechte

| Recht | ADMIN | MANAGER | EMPLOYEE | CUSTOMER |
|---|:--:|:--:|:--:|:--:|
| `quality:read` | ✓ | ✓ | – | – |
| `quality:inspect` | ✓ | ✓ | – | – |
| `quality:complete` | ✓ | ✓ | – | – |
| `quality:read_own` | ✓ | ✓ | – | ✓ |

**Anders als bei Verträgen liegt die Linie hier nicht zwischen Entwurf und
Zusage nach aussen.** Eine Begehung ist eine Feststellung über die eigene
Arbeit, und wer sie macht, schliesst sie auch ab. Die Betriebsleitung davon
auszuschliessen hiesse, die Person mit der Zange in der Hand auf eine Freigabe
warten zu lassen — und in der Zwischenzeit steht ein halber Beleg im System.

**Mitarbeitende haben keinen Zugang.** Wer geprüft wird, prüft nicht.

**Die Kundschaft sieht das Ergebnis der eigenen Objekte** — abgeschlossene
Begehungen, nicht Entwürfe, und nie `internalNote`. Beide Einschränkungen
stehen in der `where`-Klausel und in der Feldauswahl, nicht in der Anzeige:
Ein Feld, das nur die Anzeige ausblendet, stünde trotzdem auf der Leitung.

Eine zugesagte Qualität, deren Messung die Kundschaft nicht sehen darf, wäre
eine Zusage an niemanden.

---

## 6. Endpunkte

| Methode | Pfad | Recht |
|---|---|---|
| `GET` | `/api/quality-inspections` | `quality:read` **oder** `quality:read_own` |
| `POST` | `/api/quality-inspections` | `quality:inspect` |
| `PATCH` | `/api/quality-inspections/{id}` | `quality:inspect` |
| `DELETE` | `/api/quality-inspections/{id}` | `quality:inspect` |
| `POST` | `/api/quality-inspections/{id}/complete` | `quality:complete` |
| `GET` | `/api/contracts/{id}/quality` | `quality:read` |

Der letzte ist der eigentliche Ertrag dieser Wave: Er beantwortet, was die drei
SLA-Felder zusagen, wann zuletzt gemessen wurde und wann die nächste Messung
ansteht.

---

## 7. Die Oberfläche

`/admin/qualitaet` — zwei Listen auf einer Seite, weil sie zwei Hälften
derselben Frage beantworten: **Was wurde gemessen, und wo steht die Messung
aus.** Getrennt müsste man zwischen ihnen hin- und herklicken, um zu wissen,
ob man etwas vergessen hat.

`/admin/qualitaet/{id}` — die Begehungsakte: Bewertung, Befund, interne Notiz,
Ergebnis gegen die Zusage, Bezug, Nachkontrolle.

In der **Vertragsakte** steht der Stand direkt unter der Zusage — die Zeile,
die den Unterschied zwischen einer Zusage und einer gemessenen Zusage
ausmacht.

Die Maske ist eine eigene Komponente und kein `FieldSpec[]`: Eine Begehung ist
eine **Liste von Bewertungen**, keine Reihe von Feldern. Wer vor Ort steht,
trägt Zeile für Zeile ein und will dabei sehen, wo er steht — nicht erst nach
dem Absenden.

---

## 8. Prüfung

| Reihe | Fälle | Was sie belegt |
|---|---|---|
| `qualitaet-rechenkern.test.ts` | **19** | Gewichtung (und dass sie sich nicht schönrechnen lässt), ausgeklammerte Kriterien, `null` statt 0 bei nichts Beurteilbarem, gekappte Fehleingaben, die Toleranzgrenze in beide Richtungen, kein Urteil ohne Zusage, Fälligkeit ab der letzten Kontrolle, Reaktionsfrist über das Wochenende |
| `qualitaet.test.ts` | **15** | Der Server rechnet (mitgeschicktes Ergebnis prallt ab), Schnappschuss des Massstabs über eine Fassungsänderung hinweg, Unveränderlichkeit nach dem Abschluss, genau eine Nachkontrolle, kein Abschluss ohne beurteilbare Position, Fälligkeit mit und ohne Intervall, Rechte, und **die Sichtbarkeit an der Antwort statt am Statuscode** |

---

## 9. Was noch fehlt

| Offen | Warum |
|---|---|
| **Reaktionszeit an der Reklamation** | Der Rechenkern steht (`reaktionsfrist`), die Anbindung an `Review.repliedAt` und `responseHours` nicht. Das ist der zweite Teil derselben Zusage und gehört in dieselbe Akte |
| **Fotos zur Position** | Eine Begehung ohne Bild ist eine Behauptung. `FileAsset` und die Upload-Kette stehen; die Verknüpfung fehlt |
| **Bericht als PDF** | Die Zahlen sind über die Schnittstelle vollständig; ein Begehungsbericht zum Versenden fehlt |
| **Erinnerung im Nachtlauf** | Die Fälligkeit wird gerechnet und angezeigt, aber niemand wird erinnert. `runFuehrungNightly` ist der Ort dafür |
| **Nachkontrolle im Portal** | Mitarbeitende haben bewusst keinen Zugang — ob die begehende Person immer aus der Verwaltung kommt, ist eine fachliche Frage, keine technische |
