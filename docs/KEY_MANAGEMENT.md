# Schlüsselverwaltung und Feldverschlüsselung

> Stand: 21. September 2026 (Wave 4). Betrifft `src/lib/crypto.ts`,
> `scripts/rotate-encryption-key.ts` und die vier verschlüsselten Felder.

---

## 1. Das Schutzversprechen — und seine Grenze

Die Feldverschlüsselung schützt gegen **einen** Angriff: dass ein
Datenbankabzug abhandenkommt. Eine Sicherungskopie auf einem falschen
Laufwerk, ein Dump für die Fehlersuche, ein versehentlich offener Pooler.

Gegen jemanden, der die **laufende Anwendung samt Umgebung** kontrolliert,
hilft sie nicht: Der Schlüssel liegt im selben Prozess. Das ist kein Mangel
dieser Umsetzung, sondern die Grenze jeder Anwendung ohne
Hardware-Schlüsselspeicher — und sie gehört benannt, damit niemand die
Verschlüsselung für mehr hält, als sie ist.

Passwörter gehören **nicht** hierher: Die werden gehasht
(`auth/password.ts`), nicht verschlüsselt. Verschlüsselt wird nur, was die
Anwendung im Klartext zurückbraucht.

---

## 2. Was verschlüsselt ist — und was nicht

| Feld | Verschlüsselt | Warum |
|---|---|---|
| `User.twoFactorSecret` | **ja** | Wer es hat, erzeugt für jedes Konto gültige zweite Faktoren |
| `Employee.ahvNumber` | **ja** | Eindeutige Personenkennung, nach DSG besonders schützenswert |
| `Property.alarmCode` | **ja** | Physischer Zugang zu fremden Wohnungen und Büros |
| `Employee.iban` | **ja** (seit Wave 4) | Personenbezogene Kennung; wird nirgends gerechnet |
| `Employee.hourlyRate` | **nein** | Wird in der Datenbank verrechnet — Begründung unten |
| `Employee.monthlySalary` | **nein** | dito |
| `TimeEntry.hourlyRate` | **nein** | Wird in SQL summiert |
| `Organization.iban` / `qrIban` | **nein** | Steht auf jeder Rechnung |
| `Supplier.iban` | **nein** | Geschäftsdaten, keine Personendaten |

---

## 3. SEC-021 — die Analyse vor der Entscheidung

Der Erstbericht hatte behauptet, Lohn- und Bankdaten seien verschlüsselt. Sie
waren es nicht. Die naheliegende Reaktion — „dann jetzt eben alles
verschlüsseln" — ist geprüft und **verworfen** worden. Hier steht, woran.

### 3.1 Was die Felder tatsächlich tun

Untersucht wurde jede Verwendung von `hourlyRate`, `monthlySalary` und `iban`
im Quelltext.

| Eigenschaft | `hourlyRate` / `monthlySalary` | `Employee.iban` |
|---|---|---|
| **Aggregation in der Datenbank** | **ja** — `prisma.employee.aggregate({ _avg: { hourlyRate } })` in `scenario.service.ts`; `SUM(te.minutes / 60.0 * te."hourlyRate")` als rohes SQL in `analytics.service.ts` (zweimal) | nein |
| **Sortierung / Bereichsabfrage** | möglich und naheliegend (Lohnbänder, Ausreisser) | nein |
| **Suche** | nein | nein |
| **Rechnen in der Anwendung** | **ja** — `effectiveHourlyRate` in `lib/costing/job.ts`, Lohnkostenschnappschuss in `job.service.ts`, Hochrechnung in `employee.service.ts` | nein |
| **Datentyp** | `Decimal(12,2)` | `String?` |
| **Berichte** | Nachkalkulation, Szenarien, Kennzahlen | nein |
| **Verlässt das System** | nein | nein (heute) |
| **Rechteprüfung** | vorhanden (`payslip:create` / „Lohneinblick") | dieselbe |

### 3.2 Was eine Verschlüsselung der Lohnfelder kosten würde

**Die Aggregation bricht — nicht „wird langsamer", sondern bricht.** Ein
Chiffrat ist eine Zeichenkette. `AVG` darüber ergibt einen Fehler, keine Zahl.
`prisma.employee.aggregate({ _avg: { hourlyRate } })` liesse sich nur
ersetzen, indem alle aktiven Mitarbeitenden geladen, einzeln entschlüsselt und
in JavaScript gemittelt werden. Dasselbe für die beiden SQL-Summen über
`TimeEntry.hourlyRate` — die laufen heute über alle Zeiterfassungen eines
Zeitraums.

**Der Datentyp geht verloren.** `Decimal(12,2)` ist nicht Dekoration: Die
Datenbank stellt sicher, dass ein Lohn zwei Nachkommastellen hat und nicht als
Gleitkommazahl driftet. Ein verschlüsselter Lohn wäre `String`, und die
Rundungsregeln lägen ab da in der Anwendung — genau die Verschiebung, die
`CLAUDE.md` mit „`Decimal(12,2)` für Beträge, `toNumber()` erst am
Anzeigerand" verhindert.

**Die Migration ist nicht rückwärtskompatibel.** `decrypt()` gibt Klartext
unverändert zurück; bei einer Zeichenkette geht das auf. Bei einer
Decimal-Spalte müsste der Spaltentyp geändert werden — eine
`ALTER COLUMN … TYPE text`-Migration über Produktionsdaten, die sich nicht
schrittweise fahren lässt.

**Der Gewinn ist klein.** Der geschützte Angriff ist der gestohlene Abzug. In
demselben Abzug stehen bereits: alle Rechnungsbeträge, alle Zeiterfassungen
mit Minuten und Schnappschuss-Ansätzen, die vollständige Lohnhistorie als
`SalaryRecord`. Wer den Lohn wissen will, rechnet ihn aus dem Rest aus. Eine
Verschlüsselung von zwei Spalten, während die Herleitung daneben im Klartext
steht, ist eine Behauptung und keine Massnahme.

### 3.3 Die geprüften Alternativen

**Tokenisierung** — verworfen. Sie ersetzt den Wert durch einen Platzhalter und
hält das Original in einem eigenen Tresor. Das lohnt sich, wenn der Wert eine
Systemgrenze überschreitet (Kartendaten zu einem Zahlungsdienst). Ein Lohn tut
das nie. Der Tresor wäre eine zweite Datenbank mit demselben Problem — und der
Abzug enthielte dann beide.

**Verschlüsselung auf Datenbank- oder Speicherebene** — **das ist die
Antwort.** Sie schützt genau denselben Angriff (gestohlener Abzug, gestohlene
Sicherungskopie, gestohlener Datenträger), ohne dass ein einziger
`AVG`-Aufruf, ein Spaltentyp oder eine Rundungsregel angefasst wird. Sie ist
eine Betriebsmassnahme, keine Codeänderung:

- verschlüsselter Datenträger für das Datenverzeichnis von PostgreSQL,
- **verschlüsselte Sicherungskopien** — das ist der Weg, auf dem Abzüge
  tatsächlich abhandenkommen,
- TLS auf der Verbindung (steht bereits).

Die Betriebsanweisung dazu gehört nach `docs/DEPLOYMENT.md`; der Zustand ist
dort als **PRE-PRODUCTION VERIFICATION REQUIRED** geführt.

**Feldverschlüsselung** — nur dort, wo sie nichts kostet. Das trifft auf
`Employee.iban` zu: eine Kennung, die gespeichert, angezeigt und weitergegeben
wird, aber in dieser Anwendung nirgends gerechnet, sortiert, gefiltert oder
aggregiert wird. Sie ist seit Wave 4 verschlüsselt.

### 3.4 Das Ergebnis in einem Satz

> Verschlüsselt wird, was eine **Kennung** ist; was eine **Zahl** ist, schützt
> die Ebene darunter. Pauschale Feldverschlüsselung wurde geprüft und
> verworfen — sie hätte die Berichte gebrochen und den Schutz nicht erhöht.

`tests/api/schluesselrotation.test.ts` hält beide Hälften fest: dass die IBAN
verschlüsselt in der Spalte liegt, und dass die Aggregation über `hourlyRate`
weiterhin in der Datenbank läuft. Wer die Entscheidung umdreht, bricht diese
Prüfungen und muss sich erklären.

---

## 4. Das Format

```
enc:v1:<base64(iv ‖ authTag ‖ ciphertext)>          Altbestand, wird gelesen
enc:v2:<kid>:<base64(iv ‖ authTag ‖ ciphertext)>    wird geschrieben
```

AES-256-GCM, 96-Bit-IV, 128-Bit-Prüfwert. Der **Kontext** (`user.twoFactorSecret`,
`employee.iban`, …) wandert als zusätzliche authentifizierte Daten (AAD) in die
Berechnung: Ein Chiffrat lässt sich damit nicht von einer Spalte in eine andere
verschieben. Ohne AAD wäre genau das ein lautloser Angriff mit reinem
Datenbankzugriff.

**Warum v2 eine Schlüsselkennung trägt.** v1 sagt nicht, mit welchem Schlüssel
es verschlüsselt wurde. Solange es einen gibt, fällt das nicht auf; sobald
rotiert wird, fehlt genau die Auskunft, auf die es ankommt:

- *Ist die Rotation fertig?* Ohne Kennung nicht zu beantworten — man kann nur
  alles blind neu verschlüsseln und hoffen.
- *Warum geht dieser eine Wert nicht auf?* Mit Kennung: „Für diesen Wert fehlt
  der Schlüssel a1b2c3d4." Ohne: „Entschlüsselung fehlgeschlagen."

Die Kennung sind die ersten acht Hexzeichen des SHA-256 über die
Schlüsselbytes. Sie verrät nichts — aus einem Hash über 256 Zufallsbits lässt
sich der Schlüssel nicht zurückrechnen — und darf deshalb in eine
Fehlermeldung. Die Prüfreihe hält fest, dass sie weder Präfix noch Teil des
Schlüssels ist.

Ein Wert **ohne** Präfix gilt als Klartext-Altbestand und wird unverändert
zurückgegeben.

---

## 5. Der Schlüsselbund

| Variable | Rolle |
|---|---|
| `ENCRYPTION_KEY` | Der **aktive** Schlüssel. Hiermit wird geschrieben, und nur hiermit |
| `ENCRYPTION_KEY_PREVIOUS` | Ein oder mehrere **ausgemusterte** Schlüssel, durch Komma getrennt. Nur lesen |

Beide sind 64 Hexzeichen (32 Byte), erzeugt mit `openssl rand -hex 32`.

Fehlt `ENCRYPTION_KEY` ganz, wird der Schlüssel über HKDF-SHA256 aus
`JWT_SECRET` abgeleitet. Nicht, weil das gleichwertig wäre, sondern weil ein
harter Abbruch beim ersten Start nach der Auslieferung hiesse, dass eine
Sicherheitsverbesserung die Anwendung umwirft.

> **Betrieblich wichtig:** Ohne gesetzten `ENCRYPTION_KEY` hängen die
> verschlüsselten Felder an `JWT_SECRET`. Wer den wechselt, macht sie unlesbar.
> Mit gesetztem `ENCRYPTION_KEY` ist die Frage entkoppelt — und erst dann ist
> eine Rotation überhaupt durchführbar, weil sich der abgeleitete Schlüssel
> nicht als Hexwert in `ENCRYPTION_KEY_PREVIOUS` eintragen lässt.
>
> **Für eine Produktion ist `ENCRYPTION_KEY` deshalb Pflicht, nicht Kür.**

---

## 6. Die Rotation, Schritt für Schritt

```
1. Neuen Schlüssel erzeugen              openssl rand -hex 32
2. Alten nach ENCRYPTION_KEY_PREVIOUS, neuen nach ENCRYPTION_KEY
3. Anwendung neu starten                 liest beide, schreibt nur den neuen
4. npx tsx scripts/rotate-encryption-key.ts --status
5. npx tsx scripts/rotate-encryption-key.ts
6. …--status, bis alles auf dem aktiven Schlüssel steht
7. ENCRYPTION_KEY_PREVIOUS entfernen, Anwendung neu starten
```

**Schritt 3 vor Schritt 5 ist nicht vertauschbar.** Umschlüsseln, bevor die
Anwendung den neuen Schlüssel kennt, hiesse: Der Bestand ist schon neu, die
laufende Anwendung noch alt — und keine Anmeldung mit zweitem Faktor
funktioniert mehr. Es gibt keine Reihenfolge, die ohne den doppelten Lesepfad
auskommt; genau deshalb gibt es `ENCRYPTION_KEY_PREVIOUS`.

### Eigenschaften des Laufs

- **Wiederholbar.** Jeder Wert wird einzeln gelesen, entschlüsselt und neu
  geschrieben. Ein abgebrochener Lauf lässt sich neu starten; was schon auf dem
  aktiven Schlüssel steht, wird übersprungen.
- **Ein Wert je Schreibvorgang.** Ein unlesbarer Wert bringt den Lauf nicht zum
  Stehen und reisst die anderen nicht mit; er wird gemeldet, die Zeile bleibt
  unverändert, der Exitcode ist 1.
- **Kein Klartext auf der Konsole.** Ausgegeben werden Kennungen und Zahlen.
  Wer ein Rotationsprotokoll aufhebt, hätte sonst eine Liste aller
  AHV-Nummern.
- **Klartext-Altbestand wandert mit.** Werte ohne Präfix werden verschlüsselt —
  das ist die Umstellung, die `crypto.ts` bis Wave 4 dem Zufall überliess
  („beim nächsten Schreiben").

### Die abgeleiteten Geheimnisse

`deriveSecret` leitet aus dem Wurzelschlüssel zweckgebundene Geheimnisse ab.
Zwei davon können zum Zeitpunkt einer Rotation **unterwegs** sein:

- der HMAC über einen Bestätigungscode (`signature-otp.ts`) — steht als
  Argon2-Hash in der Datenbank,
- der Signaturschlüssel der Unterzeichnungssitzung (`signature-session.ts`) —
  ein bereits ausgestelltes Cookie.

Beide werden deshalb unter **allen** Schlüsseln des Bundes geprüft
(`deriveSecretAll`), geschrieben aber nur mit dem aktiven. Ohne das bräche eine
Rotation genau das: Wer gerade unterzeichnet und den Code schon per SMS
bekommen hat, sähe „Der Code stimmt nicht" — ohne jeden Hinweis auf den Grund.

Nach Schritt 7 laufen die letzten offenen Bestätigungscodes ins Leere. Bei zehn
Minuten Gültigkeit ist das der richtige Preis; **Schritt 7 gehört trotzdem
nicht mitten in den Arbeitstag.**

---

## 7. Wann rotiert wird

| Anlass | Dringlichkeit |
|---|---|
| Der Schlüssel stand in einem Protokoll, einer Fehlermeldung, einem Ticket | **sofort** |
| Ein Datenbankabzug ist abhandengekommen | **sofort** (der Abzug enthält Chiffrate — der Schlüssel entwertet sie) |
| Eine Person mit Zugang zur Produktionsumgebung geht | zeitnah |
| Vorsorglich | jährlich genügt |

Eine Rotation ist **keine** Antwort auf einen Angriff auf die laufende
Anwendung: Wer den Prozess kontrolliert, bekommt den neuen Schlüssel genauso.
Dort hilft nur, den Zugang zu schliessen.

---

## 8. Betriebs-Checkliste

Vor dem Produktivgang:

- [ ] `ENCRYPTION_KEY` gesetzt (**nicht** aus `JWT_SECRET` abgeleitet)
- [ ] Der Schlüssel liegt ausserhalb des Repositorys und ausserhalb des
      Anwendungsverzeichnisses, und es gibt eine zweite Kopie an einem Ort,
      der einen Serverausfall überlebt — **ein verlorener Schlüssel ist
      unwiederbringlich**
- [ ] `ENCRYPTION_KEY_PREVIOUS` **nicht** gesetzt (nur während einer Rotation)
- [ ] `npx tsx scripts/rotate-encryption-key.ts --status` zeigt alle Werte auf
      dem aktiven Schlüssel und **keinen** Klartext-Altbestand
- [ ] Datenverzeichnis und Sicherungskopien verschlüsselt (Abschnitt 3.3) —
      **PRE-PRODUCTION VERIFICATION REQUIRED**

---

## 9. Wo was steht

| Datei | Inhalt |
|---|---|
| `src/lib/crypto.ts` | Schlüsselbund, Format, `encrypt`/`decrypt`, `deriveSecret`/`deriveSecretAll`, `CRYPTO_CONTEXT` |
| `scripts/rotate-encryption-key.ts` | `--status` und der Umschlüsselungslauf |
| `src/lib/auth/signature-otp.ts` | Bestätigungscodes — prüft unter allen Schlüsseln |
| `src/lib/auth/signature-session.ts` | Unterzeichnungssitzung — dito |
| `src/server/services/employee.service.ts` | AHV-Nummer und IBAN: verschlüsseln beim Schreiben, entschlüsseln nur für Rollen mit Lohneinblick |
| `tests/api/verschluesselung.test.ts` | Der Rechenkern der Verschlüsselung |
| `tests/api/schluesselrotation.test.ts` | Rotation, Schlüsselkennung, abgeleitete Geheimnisse, IBAN im Ruhezustand |
