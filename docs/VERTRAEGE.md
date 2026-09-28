# Verträge

> Stand: 22. September 2026 (Wave 10 — Domäne, Dienste, Endpunkte, Oberfläche,
> Prüfreihe). Was noch fehlt, steht in §10.

---

## 1. Was ein Vertrag in diesem Produkt ist

**Kein Dokument.** Der betriebliche Ursprung wiederkehrender Leistungen:

```
CRM-Anfrage → Offerte → angenommen → Vertrag → Vertragsversion
            → Leistung → Einsatzplan → Einsätze → Disposition
            → Zeit → Rapport → Abrechnung
```

Ein unterschriebenes PDF ist ein **Beleg** zu diesem Vertrag und liegt in der
bestehenden Dateikette (`FileAsset.contractId`, mit Byteprüfung,
Dateipolitik, Schadsoftwareprüfung und Auslieferungstor). Der Vertrag selbst
ist das, was Einsätze erzeugt und Rechnungen begründet.

---

## 2. Die zwei Entscheidungen, die alles tragen

### 2.1 Der Kopf trägt die Identität, die Version die Konditionen

Ein laufender Vertrag darf nicht rückwirkend umgeschrieben werden. Preis,
Leistungsumfang, Frequenz, Zahlungsbedingungen, Laufzeit, Indexierung und SLA
stehen deshalb **ausschliesslich** in `ContractVersion`.

| Am Vertragskopf | An der Version |
|---|---|
| Nummer, Kundschaft, Objekt, Offerte | Preis und Preismodell |
| Bezeichnung, Betreuung, Kostenstelle | Abrechnungszyklus, Zahlungsziel |
| Zustand und Lebenslauf (Pause, Kündigung, Ende) | Laufzeit, Verlängerung, Kündigungsfrist |
| Beginn und Ende der Laufzeit | Indexierung, SLA, Vertragstext |

Eine aktive Version ist **unveränderlich**. `PATCH` auf sie endet in 422 — und
zwar im Dienst, nicht in der Oberfläche: Der Preis eines laufenden Vertrags ist
die Grundlage ausgestellter Rechnungen.

Genau **eine** Version ist `ACTIVE`. Durchgesetzt über einen partiellen
eindeutigen Index in der Migration, nicht über die Oberfläche:

```sql
CREATE UNIQUE INDEX "contract_versions_eine_aktive"
  ON "contract_versions" ("contractId") WHERE "status" = 'ACTIVE';
```

Ein Vertrag mit zwei gültigen Preisen ist kein Anzeigefehler, sondern eine
falsche Rechnung.

### 2.2 Leistungen und Pläne hängen an der Version

Der bequemere Weg wäre, sie am Vertrag zu führen und mit `gültigAb`/`gültigBis`
zu versehen. Dann müsste aber **jede** Auswertung die Gültigkeit selbst
nachrechnen, und ein vergessener Zeitfilter erzeugt eine falsche Antwort, die
aussieht wie eine richtige.

Beim Anlegen einer Version werden Leistungen und Einsatzpläne **kopiert**. Das
kostet Zeilen und erspart eine Klasse stiller Fehler. `generatedUntil` wird
dabei übernommen, damit der neue Plan nicht erzeugt, was unter der alten
Fassung schon geplant ist.

---

## 3. Der Zustandsautomat

```
DRAFT ─┬─→ IN_REVIEW ─┬─→ OFFERED ─→ ACTIVE
       │              │              │
       └──────────────┴──────────────┤
                                     ├─→ PAUSED ──→ ACTIVE
       CANCELLED ←── (aus DRAFT,     ├─→ NOTICE_GIVEN ──→ ENDED
                      IN_REVIEW,     └─→ ENDED
                      OFFERED)
```

Die Tabelle steht an **einer** Stelle (`ERLAUBTE_UEBERGAENGE` in
`contract.service.ts`) und ist das, was die Prüfreihe abfragt. Verstreute
`if`-Prüfungen in den einzelnen Handlungen wären dasselbe in unübersichtlich:
Man sähe nie, welche Wege es gibt, und ein vergessener Fall wäre ein Weg, den
niemand beabsichtigt hat.

**`status` ist kein Feld einer Anfrage.** Es gibt Handlungen — aktivieren,
pausieren, fortsetzen, kündigen, beenden, stornieren, verlängern —, und jede
prüft, ob sie aus dem aktuellen Zustand heraus zulässig ist.

`ENDED` und `CANCELLED` sind Endzustände. Ein beendeter Vertrag wird nicht
wiederbelebt; es entsteht ein neuer.

---

## 4. Die Serienplanung

### 4.1 Der Rechenkern ist rein

`src/lib/contracts/serie.ts` — ohne Prisma, ohne `server-only`, ohne
Pfad-Aliasse. Er beantwortet: *An welchen Kalendertagen ist zu leisten?* Und er
wird direkt geprüft (`tests/api/vertraege-rechenkern.test.ts`, 23 Fälle), weil
ein Fehler hier am teuersten ist: ein Termin zu viel heisst ein Team vor einer
verschlossenen Tür, ein Termin zu wenig eine Leistung, die niemand vermisst,
bis die Kundschaft anruft.

**Kalendertage, keine Zeitpunkte.** Ein Vertrag sagt „jeden Montag und
Donnerstag von 06:00 bis 10:00" — ein Tag plus ein Zeitfenster in *Ortszeit*.
In Zeitpunkten gerechnet verschöbe sich jede Serie beim Wechsel auf die
Sommerzeit um eine Stunde, und zwar still.

**Der Wochenrhythmus zählt ab der Woche des ersten Serientermins.** Zwei
falsche Bezugspunkte liegen nahe, und einer davon hat in der Prüfreihe
tatsächlich zugeschlagen:

- *Die Woche des Fensterbeginns* — dann verschöbe sich „alle zwei Wochen" bei
  jedem Nachplanen, und der Plan hinge davon ab, wann man ihn abfragt.
- *Die Woche von `effectiveFrom`* — beginnt der Vertrag an einem Donnerstag und
  wird montags gereinigt, läge der erste Montag in der **Folgewoche**, und bei
  zweiwöchentlichem Rhythmus fiele er aus. **Der erste Termin eines Vertrags
  entfällt** — der Fehler, den niemand beim Testen sieht und jeder beim ersten
  Kunden.

### 4.2 Feiertage sind Konfiguration, keine Regel

Welche Tage Feiertage sind, steht je Organisation und Kanton in `Holiday`. Wie
damit umzugehen ist, entscheidet der Vertrag: `IGNORE`, `SKIP`, `MOVE_BEFORE`,
`MOVE_AFTER`. Ein eingebauter Feiertagskalender wäre für genau einen Kanton
richtig und überall sonst still falsch.

Verschiebt ein Feiertag einen Termin, bleibt der **Serientag** derselbe — siehe
Idempotenz.

### 4.3 Idempotenz — die teuerste Zusage des Moduls

**Derselbe Serientermin erzeugt nie zwei Einsätze.** Nicht „sollte nicht",
sondern kann nicht:

```prisma
@@unique([serviceScheduleId, scheduleDate])
```

Eine Prüfung im Code allein reichte nicht: Zwischen „gibt es schon?" und
`INSERT` liegt ein Moment, und zwei gleichzeitige Läufe passen genau hinein.
Der Planer *versucht* deshalb anzulegen und wertet einen Verstoss gegen den
Index als „war schon da".

Dass ein gewöhnlicher eindeutiger Index genügt und kein partieller nötig ist,
liegt an Postgres: In einem eindeutigen Index gelten zwei `NULL` als
verschieden. Alle Einsätze ohne Serie tragen `NULL` in beiden Spalten und
kollidieren deshalb nie.

**Die Kennung ist der Serientag, nicht der tatsächliche Termin.** Wird ein
Einsatz wegen eines Feiertags verschoben, bleibt der Serientag stehen; sonst
entstünde beim Nachtragen eines Feiertags ein zweiter Einsatz für denselben
Termin.

Geprüft in `tests/api/vertraege.test.ts`: zweiter Lauf, **gleichzeitiger** Lauf,
Probelauf, Lauf gegen einen pausierten Vertrag, Lauf nach einer Ausnahme.

### 4.4 Wo der Planer aufhört

Pause, Kündigungsdatum und Vertragsende sind keine Warnungen — der Planer
plant dort nicht weiter. Mit dem Beenden eines Vertrags werden alle
Einsatzpläne stillgelegt; sonst erzeugte der nächtliche Lauf weiter Einsätze
für einen beendeten Vertrag, und niemand sähe es.

Der Planer **disponiert nicht**: Ein erzeugter Einsatz ist `UNASSIGNED`. Wer
ihn übernimmt, entscheidet die Disposition mit ihrer Eignungsprüfung. Ein
Planer, der nebenbei zuteilt, wäre eine zweite Zuteilungsstelle neben der
einen, die es gibt.

---

## 5. Änderungen, Freigaben, Preise

**Der Antrag ist nicht die Änderung.** Ein `ContractAmendment` durchläuft
Entwurf → Prüfung → Freigabe und wird erst dann wirksam, indem er eine neue
Vertragsversion erzeugt. Drei Gründe, und der dritte wiegt am schwersten:

1. Eine Änderung braucht eine Zustimmung — ein eigener Vorgang mit eigenem
   Zeitpunkt und eigener Person.
2. Zwischen Antrag und Wirksamkeit liegt fast immer ein Stichtag.
3. **Die Version allein sagt nur, *dass* sich etwas geändert hat.** Warum, auf
   wessen Wunsch und mit wessen Zustimmung steht im Antrag — und genau danach
   wird gefragt, wenn ein halbes Jahr später jemand über den Preis stolpert.

**Vier-Augen-Prinzip, zweimal abgesichert.** Im Rechteschnitt
(`contract:version` hat die Betriebsleitung, `contract:approve` nicht) und im
Dienst: Wer beantragt hat, kann nicht selbst freigeben (422). Der
Rechteschnitt allein reichte nicht — die Administration hat beide Rechte, und
genau dort ist die Versuchung am grössten.

**Preisanpassungen behaupten keine Indexierungsregel.** Ob und wie indexiert
wird, steht im Vertrag; `indexReference` hält fest, worauf sich die Parteien
geeinigt haben, und die Indexwerte werden erfasst, nicht abgerufen. Eine
automatische Erhöhung findet nicht statt.

`oldAmount` ist kein Feld der Anfrage: Der bisherige Betrag steht in der
geltenden Version. Ihn mitschicken zu lassen hiesse, dem Client zu erlauben,
die Vergangenheit zu behaupten.

---

## 6. Kündigung und Verlängerung

**Das System beurteilt keine Kündigung.** Festgehalten wird, wer wann gekündigt
hat. Das Wirkungsdatum ist eine **Rechnung** aus Kündigungsfrist, Laufzeit und
Verlängerungsart — nachvollziehbar und überschreibbar. Ob die Kündigung
formgerecht, rechtzeitig und wirksam ist, ist eine Rechtsfrage.

**Auch die „automatische" Verlängerung läuft über eine Handlung.** Der
nächtliche Lauf erinnert; verlängern tut ein Mensch, und wer es tut, gehört ins
Protokoll. `renewalType: AUTOMATIC` sagt etwas über den *Vertrag* aus, nicht
über den Server.

---

## 7. Abrechnung

`GET /api/contracts/{id}/billing-basis` **rechnet, schreibt aber nichts**. Die
Rechnung entsteht über den Rechnungsdienst, damit Nummernkreis, Belegregeln und
Append-only an genau einer Stelle bleiben.

### 7.1 Eine Periode, eine Rechnung

`POST /api/contracts/{id}/invoices` erzeugt die Rechnung einer
Abrechnungsperiode. Die Zusicherung dahinter ist die zweitteuerste des Moduls,
und sie steht — wie die Idempotenz des Planers — **in der Datenbank**, nicht im
Ablauf:

```sql
CREATE UNIQUE INDEX "invoices_vertragsperiode_einmal"
  ON "invoices" ("contractId", "contractPeriodStart")
  WHERE "contractId" IS NOT NULL
    AND "contractPeriodStart" IS NOT NULL
    AND "status" <> 'CANCELLED'
    AND "deletedAt" IS NULL;
```

Drei Entscheidungen stecken darin:

**Die Periode ist kanonisch, nicht frei wählbar.** Sie entsteht aus dem
Abrechnungszyklus der geltenden Fassung und einem *Stichtag*; zwei Stichtage im
selben Monat ergeben dieselbe Periode. Nähme der Endpunkt einen Zeitraum
entgegen, liessen sich beliebig viele sich überlappende „Perioden" bilden und
jede einzeln fakturieren — der Schutz hätte keinen Schlüssel mehr, an dem er
greifen könnte.

**Der Index entscheidet, nicht die Prüfung.** Der Dienst sieht zwar zuerst
nach — das erspart im Normalfall eine vergebliche Transaktion —, verlässt sich
aber auf den Verstoss gegen den Index und liefert dann die Rechnung des
Gewinners zurück. Zwischen „gibt es schon eine?" und dem `INSERT` liegt ein
Moment, und ein zweiter Klick, ein Wiederholungsversuch nach einem Netzabbruch
und zwei gleichzeitige Monatsabschlüsse passen genau hinein. Der zweite Aufruf
antwortet deshalb **200 statt 201** und meldet `neu: false`.

**Storniert zählt nicht mit.** Eine zurückgenommene Rechnung darf die Periode
nicht für immer blockieren — sonst wäre ein Fehler in der ersten Rechnung nicht
mehr korrigierbar: stornieren ginge, neu ausstellen nicht.

Die Rechnung trägt `contractId`, `contractVersionId` und
`contractPeriodStart`. Der mittlere Wert ist der wichtige: Er hält fest, unter
welchen Konditionen fakturiert wurde. Ohne ihn liesse sich eine Rechnung nach
der ersten Preisanpassung nicht mehr nachrechnen — und eine spätere
Vertragsänderung darf einen ausgestellten Beleg nicht berühren.

Der Beleg selbst entsteht über `createInvoice` aus dem Rechnungsdienst, nicht
in diesem Modul. Die Vertragsfelder sind dort bewusst **kein** Teil der
Zod-Eingabe: Über `POST /api/invoices` sind sie nicht erreichbar, sonst könnte
eine von Hand erfasste Rechnung eine Periode für sich beanspruchen, die der
Serienlauf später braucht — und der Index wiese dann den regulären Lauf ab
statt der Falscheingabe.

`GET /api/contracts/{id}/invoices` beantwortet die Frage des Monatsabschlusses:
welche Perioden gedeckt sind und welche offen — ab der zuletzt abgeschlossenen
rückwärts; die laufende ist noch nicht fällig (§10a). Die Perioden entstehen aus dem
Zyklus, nicht aus den vorhandenen Rechnungen — eine vergessene Periode wäre
sonst unsichtbar, weil zu ihr eben kein Beleg existiert.

---

## 7a. Elektronische Annahme einer Fassung

`POST /api/contracts/{id}/versions/{versionId}/acceptance` schickt eine
Vertragsfassung zur Unterzeichnung. **Kein zweiter Signaturweg**: Es entsteht
ein gewöhnlicher `SignatureRequest` des bestehenden Kerns — unveränderlicher
Snapshot, Hash A, versionierter Zustimmungstext, Protokoll, Ablauf. Neu ist
allein die vierte Quelle (`contractVersionId`) neben `Quote`, `Job` und
`DocumentVersion`.

**Unterzeichnet wird eine Fassung, nie „der Vertrag".** Was die Kundschaft
annimmt, sind konkrete Konditionen, und die stehen in der Version. Eine
Unterschrift am Vertragskopf wäre eine Zusage auf etwas, das sich danach ändern
kann — genau das, was die Versionierung verhindern soll. Das Dokument nennt die
Versionsnummer im Titel, das Protokollereignis führt sie als eigene Angabe, und
`ContractVersion.acceptedRequestId` ist eindeutig: Der Beweis lässt sich in
beide Richtungen führen.

**Die Kopplung ist dieselbe wie bei der Offerte.** Der Finalisierer ruft
`acceptContractVersionInTx` in *derselben* Transaktion, in der er den Vorgang
auf `COMPLETED` setzt:

> Fassung angenommen ⇔ Annahmevorgang COMPLETED

Ist die Fassung inzwischen abgelöst oder der Vertrag annulliert, trifft der
Übergang keine Zeile, alles rollt zurück, und der Vorgang endet `CANCELLED` mit
Grund. Es gibt keinen stillen Endzustand „unterschrieben, aber nichts
geschehen".

**Die Annahme setzt den Vertrag nicht in Kraft.** Sie ist die Zusage der
Kundschaft; in Kraft setzt ihn der Betrieb mit `contract:activate`. Beides in
einem Schritt zu erledigen hiesse, eine Zusage nach aussen von einem Klick der
Gegenseite abhängig zu machen — und die Nummer aus dem Nummernkreis entstünde
in einer Transaktion, die ein Aussenstehender auslöst. Stattdessen wandert der
Vertrag nach `OFFERED`, und die Aktivierung findet die angenommene Fassung vor.

**Ab dem Versand ist die Fassung eingefroren.** `updateContractVersion` und
`replaceContractServices` weisen ab, solange ein Vorgang läuft oder die Fassung
angenommen ist. Der Fall, den das verhindert: Die Kundschaft hat den Snapshot
offen, jemand korrigiert „schnell noch" den Preis — und danach zeigt das
unterschriebene Dokument den alten Betrag, die Datenbank den neuen. Wer doch
ändern will, zieht den Vorgang zurück (`DELETE` auf denselben Pfad); das ist
sichtbar und protokolliert. Eine **angenommene** Fassung lässt sich nicht
zurückziehen — dafür gibt es die neue Version.

**Keine Rechtsbehauptung.** `assuranceLevel` bleibt `LINK_ONLY`,
`ceremonyMode` ist `REMOTE_LINK`. Wer den Link öffnet, hat einen Link; mehr
behauptet das Produkt nicht, hier so wenig wie anderswo. QES oder ZertES kommen
in keinem Text vor.

Geliefert wird die Herleitung mit jeder Zwischengrösse — Preismodell, Zahl der
Einsätze, freigegebene Minuten, Menge, Satz. Eine Summe, die sich nicht
nachrechnen lässt, erzeugt eine Rückfrage je Monat und je Kundschaft.

Jede Position trägt ihre **Vertragsversion**. Bei einem Vertrag, der sich
geändert hat, ist eine Rechnungssumme ohne diese Zuordnung nicht mehr prüfbar.

Gezählt werden nur **abgeschlossene** und **geprüfte** Einsätze; bei
Stundenabrechnung nur **freigegebene** Zeiten — der Ertrag aus Wave 8.

---

## 8. Rechte

| Recht | ADMIN | MANAGER | CUSTOMER |
|---|:--:|:--:|:--:|
| `contract:read` | ✓ | ✓ | – |
| `contract:read_own` | ✓ | ✓ | ✓ |
| `contract:create` | ✓ | ✓ | – |
| `contract:update` | ✓ | ✓ | – |
| `contract:delete_draft` | ✓ | ✓ | – |
| `contract:version` | ✓ | ✓ | – |
| `contract:billing` | ✓ | ✓ | – |
| `contract:approve` | ✓ | – | – |
| `contract:activate` | ✓ | – | – |
| `contract:terminate` | ✓ | – | – |
| `contract:sign` | ✓ | – | – |

Die Linie ist dieselbe wie bei Preisen und Website, nur schärfer: Ein Vertrag
bindet den Betrieb über Monate. Entwerfen, ändern, eine Version vorschlagen und
daraus abrechnen ist Tagesgeschäft. **Aktivieren, freigeben, zur Unterschrift
geben und kündigen** sind Zusagen nach aussen.

Mitarbeitende haben keinen Zugang: Was sie brauchen — Sonderanweisungen,
Qualitätsanforderungen — steht am Einsatz, den sie zugeteilt bekommen.

---

## 9. Prüfung

| Reihe | Fälle | Was sie belegt |
|---|---|---|
| `vertraege-rechenkern.test.ts` | **35** | Wochen- und Monatsrhythmus, „alle n Wochen", Vertragsbeginn zwischen zwei Serientagen, Monatsletzter ohne Überlauf, Februar und Schaltjahr, Feiertagsbehandlung in allen vier Formen, Ausnahmen vor Feiertagen, Kündigungsfristen — und die **Ortszeit**: 06:00 bleibt 06:00 über beide Zeitumstellungen, die UTC-Stunde unterscheidet sich dabei um eine |
| `vertraege.test.ts` | **44** | Zustandsautomat samt unzulässiger Übergänge, **Unveränderlichkeit einer geltenden Fassung** (Konditionen, Leistungsumfang, Einsatzplan — je 422), **Versions-Schnappschuss am Einsatz**, Idempotenz des Planers einschliesslich gleichzeitiger Läufe, Probelauf, Ausnahmen, Vier-Augen-Prinzip, Abrechnungsgrundlage, **Vertragsrechnung** (Idempotenz, gleichzeitige Läufe, Perioden, Schnappschuss nach Preisanpassung), Rechte, Sichtbarkeit für die Kundschaft |
| `wave10-vertraege.spec.ts` (Browser) | **5** | Die Frage, die keine HTTP-Reihe beantwortet: ob es die Maske gibt, ob sie in dieselbe Datenbank schreibt und ob das Ergebnis auf der Seite erscheint. Einsatzplan im Dialog → Inkraftsetzung → Einsätze mit ihrer Fassung; Unterzeichnung im Browser samt Einfrierung danach; zweimal abrechnen ergibt eine Rechnung; Antrag, Freigabe, neue Fassung — bestehender Einsatz bleibt bei Fassung 1; Pause hält den Planer an |

Der Rechenkern hat beim ersten Lauf einen echten Fehler gefunden: Bei
zweiwöchentlichem Rhythmus wäre der **erste Termin eines Vertrags entfallen**,
wenn der Vertragsbeginn nicht auf einen Serientag fiel (§4.1).

---

## 10. Die Oberfläche

`/admin/vertraege` — Liste mit Kennzahlen und sechs Sichten (Alle, Aktiv,
Entwürfe, Kündigungsfristen, Laufen aus, Änderungen). Die Sichten sind Filter
über denselben Pfad, keine eigenen Seiten: Es ist dieselbe Liste mit derselben
Sortierung, und eine Auswahl, die in der Adresse steht, lässt sich weitergeben
und als Lesezeichen ablegen — genau das tut man mit „welche Verträge laufen
aus".

`/admin/vertraege/neu` — eine Maske für Kopf, erste Fassung und erste Leistung.
Fachlich sind es drei Dinge, und der Endpunkt nimmt sie auch getrennt
entgegen; für die Eingabe wäre die Trennung trotzdem falsch, weil ein Vertrag
ohne Konditionen nicht in Kraft treten kann und einer ohne Leistung erst recht
nicht. Drei Masken hintereinander hiessen drei Gelegenheiten, nach der ersten
aufzuhören — und zurück bliebe ein Entwurf, der nie etwas erzeugt.

`/admin/vertraege/{id}` — die Vertragsakte: Übersicht, Leistungen mit
Einsatzplan, nächste Einsätze **mit ihrer Fassung**, Änderungen und
Preisanpassungen, Konditionen, Fassungsgeschichte, Dokumente.

**Die Handlungsknöpfe zeigen nur, was aus dem aktuellen Zustand heraus möglich
ist.** Eine ausgegraute Schaltfläche wäre ehrlicher als eine, die 422
antwortet — aber eine, die gar nicht da ist, ist die ehrlichste: Sie behauptet
nichts.

### 10.1 Die Masken

Alle schreiben über die **bestehenden Endpunkte** — dieselbe Validierung,
dieselbe Rechteprüfung, dasselbe Protokoll wie jeder andere Zugriff. Keine
zweite Schreibstrecke, keine Beispielwerte. Sie liegen in
`src/features/admin/contract-panels.tsx`; die Seite bindet Komponenten ein, nie
Konstanten (ein Import aus einer `'use client'`-Datei in eine Seite bricht den
Bau).

| Maske | Endpunkt | Sichtbar für |
|---|---|---|
| **Einsatzplan anlegen / ändern** | `POST /api/contract-services/{id}/schedules`, `PATCH /api/contract-schedules/{id}` | `contract:update`, nur am Entwurf |
| **Ausnahme** (aussetzen, verschieben, ansetzen) | `POST /api/contract-schedules/{id}/exceptions` | `contract:update` |
| **Leistung hinzufügen / entfernen** | `PUT /api/contracts/{id}/versions/{versionId}/services` | `contract:version`, nur am Entwurf |
| **Neue Version** | `POST /api/contracts/{id}/versions` | `contract:version` |
| **Versionsentwurf ändern** | `PATCH /api/contracts/{id}/versions/{versionId}` | `contract:version`, nicht wenn eingefroren |
| **Änderung beantragen** | `POST /api/contracts/{id}/amendments` | `contract:version` |
| **Freigeben / ablehnen / wirksam machen** | `.../decision`, `.../apply` | `contract:approve` |
| **Zur Unterschrift senden / zurückziehen** | `POST` bzw. `DELETE .../acceptance` | `contract:sign` |
| **Periode abrechnen** | `POST /api/contracts/{id}/invoices` | `contract:billing` **und** `invoice:create` |

Zwei Entscheidungen, die sich beim Bauen ergaben und erklärungsbedürftig sind:

**Der Einsatzplan hat eine eigene Komponente statt einer Feldliste.** Wochentage
sind eine Menge — als Textfeld „1,3,5" eine Einladung zum Vertippen —, und die
Uhrzeiten stehen in der Datenbank als Minuten seit Mitternacht, weil ein
Zeitfenster keine Zeitpunktangabe ist und „ab 06:00" über die Sommerzeit hinweg
richtig bleiben muss. Die Umrechnung gehört an eine Stelle, nicht in den Kopf
der Nutzenden. `ResourceForm` erlaubt so etwas über `transform` — eine Funktion,
und Funktionen lassen sich nicht von einer Server- an eine Client-Komponente
reichen.

**Der Leistungsumfang wird als Ganzes ersetzt.** Die Maske schickt die
bestehenden Zeilen mit. Das ist kein Umweg, sondern die Regel des Dienstes: An
den Zeilen eines Entwurfs hängt nichts, was ihre Kennung bräuchte, und ein
zeilenweiser Abgleich brächte eine zweite Wahrheit über „welche Zeile ist
welche".

Eine Fassung, die zur Unterzeichnung vorliegt oder angenommen wurde, zeigt
statt der Masken einen Satz, der sagt warum. Ohne ihn sähe die greifende Sperre
aus wie ein Fehler der Anwendung.

---

## 10a. Integrität nach der Stabilisierung vom 2026-09-23

Die Freigabeprüfung vom 2026-09-23 fand in diesem Modul sieben Blocker
(RB-002 bis RB-008). Was seither gilt — und wo die Grenze liegt:

**Fassungswechsel V1 → V2 → V3.** `POST /api/contracts/{id}/versions/{versionId}/activate`
setzt einen Versionsentwurf zu seinem Stichtag in Kraft: alte Fassung
`SUPERSEDED` mit `effectiveUntil` = Stichtag, neue `ACTIVE`, in einer
Transaktion hinter `SELECT … FOR UPDATE` auf dem Vertragskopf. Der Stichtag
liegt nicht vor heute (Zürich) und nach dem Beginn der geltenden Fassung. Ein
Entwurf, den niemand mehr will, wird **verworfen** (`DISCARDED`), nicht
gelöscht — ein zurückgezogener Signaturvorgang zeigt auf ihn und ist Beleg.

**Die Datenbank verweigert Änderungen an gebundenen Fassungen.** Trigger aus
`20260923100000_vertragsintegritaet`:

| Trigger | Was er verweigert |
|---|---|
| `contract_versions_unveraenderlich` | jede Änderung an einer Fassung, die nicht mehr frei ist (galt, angenommen, in Unterzeichnung) — ausser Zustand und `effectiveUntil` beim Ablösen |
| `contract_services_unveraenderlich` | Einfügen, Ändern, Löschen von Leistungen einer gebundenen Fassung; Kaskaden aus dem Löschen eines Entwurfs sind erlaubt |
| `service_schedules_unveraenderlich` | Änderungen an Einsatzplänen einer gebundenen Fassung — nur die Fortschrittsmarke `generatedUntil` darf wandern |

*Grenze:* Wer als Superuser Trigger abschaltet (`ALTER TABLE … DISABLE
TRIGGER`, `session_replication_role = replica`), umgeht sie. Das ist eine
Betriebsfrage (Rollen, Zugriff auf die Datenbank), keine des Schemas.

**Stabile Serienidentität.** Jeder Einsatzplan trägt `seriesKey`; eine neue
Fassung kopiert ihn. Ein geplanter Termin ist eindeutig über
`(contractId, seriesKey, scheduleDate)` — Teilindex `jobs_serientermin_einmal`,
ohne abgesagte und gelöschte Einsätze. Vorher hing die Eindeutigkeit an der
Kennung des Plans, und die wechselte mit jeder Fassung: doppelte Einsätze nach
jedem Fassungswechsel; und ein abgesagter Termin blockierte seinen Schlüssel
für immer.

**Der Abgleich (`einsaetzeAbgleichen`).** Fassungswechsel, Pause,
Wiederaufnahme, Kündigung und Ende gleichen die **offenen** Einsätze ab einem
Tag mit dem Sollplan ab: umstellen, absagen (mit Entzug der Zuteilung),
fehlende anlegen. Begonnene und erledigte Einsätze rührt er nie an. Die
Untergrenze ist immer heute in Zürich — die Wiederaufnahme plant nichts in die
Vergangenheit, auch nicht über eine Zeitumstellung hinweg.

**Annahme fail-closed.** Eine Annahme wird im Finalizer nur übernommen, wenn der
Vertrag noch annehmbar ist (`ANNAHME_ZULAESSIGE_VERTRAGSZUSTAENDE`), gelesen
unter derselben Zeilensperre wie Stornieren und Löschen. Stornieren und Löschen
brechen laufende Annahmen in derselben Transaktion ab. Ein Vertrag mit
**angenommener** Fassung lässt sich nicht mehr stornieren oder löschen (422) —
die Kundschaft hat zugestimmt, der Weg führt über Beenden oder Kündigen.

**Abrechnung je Fassung.** Jede Periode rechnet mit der Fassung, die an ihrem
Stichtag galt; ein Fassungswechsel mitten in der Periode schneidet sie.
`invoices.contractPeriodEnd` und die Ausschlussbedingung
`invoices_vertragsperiode_ueberlappungsfrei` (btree_gist) verhindern, dass
sich Perioden nach einem Zykluswechsel überlappen. **Ohne Stichtag** gilt die
zuletzt **abgeschlossene** Periode — bis 2026-09-23 war es die laufende (der
Vorgabetag war „gestern"), gefunden von der Browserreihe.

**Nachweis:** `tests/api/vertraege-integritaet.test.ts` (Regeln und Trigger
über HTTP und SQL), `tests/e2e/wave10-vertraege.spec.ts` (Wege A–F im Browser,
gegen die Datenbank geprüft).

---

## 11. Was noch fehlt

| Offen | Warum |
|---|---|
| **Feiertagskalender** | `Holiday` ist je Organisation und Kanton befüllbar und wird vom Planer ausgewertet — befüllt ist er nicht. Das ist Konfiguration, keine Entwicklung |
| **Indexierung wirkt nicht von selbst** | `indexReference` und `indexBaseValue` halten fest, worauf sich die Parteien geeinigt haben. Eine automatische Erhöhung findet nur statt, wenn jemand sie über eine Preisanpassung freigibt — mit Absicht |
| **Kein Mahnwesen je Vertrag** | Mahnungen hängen an der Rechnung, nicht am Vertrag. Eine zweite Mahnstrecke wäre eine zweite Wahrheit über den Zahlungsstand |
| **Sammelrechnung über mehrere Verträge** | Heute eine Rechnung je Vertrag und Periode. Eine Kundschaft mit fünf Verträgen bekommt fünf Belege; ob das gewünscht ist, ist eine fachliche Frage, keine technische |

**Was Wave 10 jetzt trägt.** Domäne mit ihren Zusicherungen, die Dienste, 30
Endpunkte, drei Seiten mit neun Masken, die vierte Quelle des Signaturkerns,
die idempotente Vertragsrechnung — und die Prüfungen aus §9 samt der
Browserreihe `tests/e2e/wave10-vertraege.spec.ts`.
