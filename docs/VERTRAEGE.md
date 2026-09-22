# Verträge

> Stand: 22. September 2026 (Wave 10, Teil 1 — Domäne, Dienste, Endpunkte,
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
| `vertraege-rechenkern.test.ts` | **23** | Wochen- und Monatsrhythmus, Monatsletzter ohne Überlauf, Feiertagsbehandlung in allen vier Formen, Ausnahmen vor Feiertagen, Kündigungsfristen mit und ohne automatische Verlängerung |
| `vertraege.test.ts` | **30** | Zustandsautomat samt unzulässiger Übergänge, Versionsregel, Kopieren des Leistungsumfangs, **Idempotenz des Planers einschliesslich gleichzeitiger Läufe**, Probelauf, Ausnahmen, Vier-Augen-Prinzip, Abrechnungsgrundlage, Rechte, Sichtbarkeit für die Kundschaft |

Der Rechenkern hat beim ersten Lauf einen echten Fehler gefunden: Bei
zweiwöchentlichem Rhythmus wäre der **erste Termin eines Vertrags entfallen**,
wenn der Vertragsbeginn nicht auf einen Serientag fiel (§4.1).

---

## 10. Was noch fehlt — Wave 10, Teil 2

| Offen | Warum es nicht Teil 1 ist |
|---|---|
| **Oberfläche** (`/admin/vertraege` mit Übersicht, Leistungen, Einsatzplan, Preisen, Abrechnung, SLA, Dokumenten, Änderungen, Historie) | Der Schreibweg ist die Zusage, die fehlte; ohne ihn wäre eine Maske eine Oberfläche ohne Wirkung — genau das Muster, das die Waves 6, 8 und 9 aufgedeckt haben |
| **Signaturanbindung** (`contract:sign`) | Das Schema trägt `SignatureRequest.contractVersionId`, der Kern kennt die vierte Quelle noch nicht. Der Signaturkern serviert bisher drei Quellen, und eine vierte anzuschliessen heisst, `quote-acceptance` und `job-acceptance` eine dritte Geschäftsregel zur Seite zu stellen — mit derselben Transaktionskopplung |
| **Rechnungserzeugung aus dem Vertrag** | Die Grundlage rechnet (§7); der Schritt in den Rechnungsdienst hinein ist Wave 13 (Finanzen) |
| **E2E-Weg** Offerte → Vertrag → Aktivierung → Plan → Einsatz im Browser | Braucht die Oberfläche |
| **Demobestand** | Ein Seed mit einem laufenden Unterhaltsvertrag macht die Oberfläche erst prüfbar |

**Wave 10 ist damit ausdrücklich nicht abgeschlossen.** Was steht, ist die
Domäne mit ihren Zusicherungen, die Dienste, 28 Endpunkte und 53 Prüfungen.
Was fehlt, steht oben — und nicht als „Detail", sondern als benannter Rest.
