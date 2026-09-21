# Sicherheitszentrum

> Stand: 21. September 2026 (Wave 3). `/admin/sicherheit`, nur für die
> Systemverantwortung.

---

## 1. Was es ist

Eine **Zusammenführung**, keine Erkennung.

Jeder Wert, den diese Seite zeigt, stand vorher schon in der Datenbank:
gesperrte Konten an `User.lockedUntil`, Fehlversuche an
`User.failedLoginCount`, offene Sitzungen an `RefreshToken`, laufende
Geräteübergaben an `DeviceHandoffSession`, Dateien in Quarantäne an
`FileAsset.scanStatus`. Was fehlte, war ein Ort, an dem man sie nebeneinander
sieht — und an dem man etwas tun kann.

Was hier **nicht** entsteht: eine eigene Erkennungslogik. Keine
Wahrscheinlichkeiten, keine ungewöhnlichen Anmeldezeiten, keine Länderkennung,
keine Bewertung „verdächtig". Solche Anzeigen werden nach drei Fehlalarmen
weggeklickt — und danach auch dann, wenn sie recht haben. Angezeigt wird
ausschliesslich, was tatsächlich geschehen ist.

---

## 2. Warum `SecurityEvent` neben `AuditLog` steht und nicht darin

Technisch hätte alles in `AuditLog` gepasst: `action`, `entity`, `summary`,
`ip`, `userAgent` sind da. Drei Gründe dagegen, und der dritte wiegt am
schwersten.

**Mengenverhältnis.** Das Prüfprotokoll nimmt jeden ändernden
Geschäftsvorgang auf — im Bestand 223 Aufrufstellen in 60 Dateien. Eine
Sicherheitsübersicht, die darin nach fehlgeschlagenen Anmeldungen filtert,
findet sie; im Alltag übersieht sie sie trotzdem, weil sie zwischen
Rechnungsänderungen steht.

**Andere Frage.** Das Prüfprotokoll beantwortet: *wer hat welchen Datensatz
geändert.* Ein fehlgeschlagener Anmeldeversuch ändert keinen Datensatz, ein
abgelehnter Zugriff erst recht nicht. Beides als „Änderung an `User`" zu
führen, wäre eine Notlüge — und eine, die man später glaubt.

**Bearbeitungszustand.** Ein Protokolleintrag ist fertig, sobald er
geschrieben ist; er wird gelesen, nicht bearbeitet. Ein gesperrtes Konto
dagegen ist *offen*, bis jemand hingesehen hat. `acknowledgedAt` in `AuditLog`
wäre eine Spalte, die für 99 % der Zeilen bedeutungslos ist.

Umgekehrt **ersetzt** der Ereignisstrom das Prüfprotokoll nicht. Eine
Rollenvergabe steht in beiden, und das ist richtig: im Prüfprotokoll als
Änderung an einem Datensatz, hier als Ereignis, das jemand sehen soll. Zwei
Fragen, von verschiedenen Personen zu verschiedenen Zeiten gestellt; ein
Eintrag, der beide beantworten soll, beantwortet keine gut.

---

## 3. Der Katalog

Die Arten stehen in `src/lib/security/events.ts`. Die Art selbst ist in der
Datenbank eine **Zeichenkette**, kein Aufzählungstyp — bewusst:

> Ein `enum` wäre sauberer und hätte einen Preis, den man erst später bezahlt:
> Jede neue Ereignisart bräuchte eine Migration. Wer im laufenden Betrieb eine
> Stelle absichert und dabei ein Ereignis mitschreiben will, schreibt dann
> keines — nicht aus Nachlässigkeit, sondern weil der Aufwand grösser ist als
> der Nutzen im Moment. Genau so entstehen Sicherheitsprotokolle mit Lücken.

Die Typsicherheit geht nicht verloren, sie wandert in den Katalog:
`SecurityEventKind` ist die Vereinigung seiner Schlüssel, und
`recordSecurityEvent` nimmt nichts anderes an.

### Die Schwere

`CRITICAL` heisst **nicht „schlimm"**, sondern *braucht eine Entscheidung eines
Menschen*. Eine zugeschlagene Kontosperre ist nicht schlimm — sie hat ja
funktioniert — aber jemand sollte wissen, dass es sie gab.

| Stufe | Bedeutung | Bestätigung |
|---|---|---|
| `INFO` | Normalbetrieb, nachvollziehbar | nein |
| `WARNING` | Auffällig, aber erklärbar; die Aussage steckt in der Häufung | nein |
| `CRITICAL` | Braucht eine Entscheidung | **ja** |

Die Regel „welche Stufe verlangt eine Bestätigung" steht **einmal**
(`verlangtBestaetigung` in `events.ts`) und wird von Dienst, Endpunkt und Seite
nur angewandt. Stünde sie in der Oberfläche, entschiede diese, was als erledigt
gilt — und eine zweite Oberfläche entschiede es anders.

### Die tragenden Einstufungen

| Art | Stufe | Warum |
|---|---|---|
| `TWO_FACTOR_DISABLED` | `CRITICAL` | Der erste Schritt, den jemand geht, der ein Konto übernommen hat — und der letzte, den die rechtmässige Person bemerkt. Auch wenn er regulär ist und Passwort *und* Code verlangt |
| `REFRESH_REUSE_DETECTED` | `CRITICAL` | Ein verbrauchter Erneuerungstoken kommt ein zweites Mal. Zwei Erklärungen: ein Wettlauf zweier Tabs — oder jemand hat eine Kopie. Von hier aus nicht unterscheidbar |
| `ACCOUNT_LOCKED` | `CRITICAL` | Die Sperre hat funktioniert; dass sie zuschlug, gehört gesehen |
| `ROLE_ASSIGNED` | `CRITICAL` | **Auch bei Herabstufung.** „Nur Höherstufungen sind interessant" ist naheliegend und falsch — wer die Rechteverwaltung übernommen hat, probiert beide Richtungen |
| `FILE_SCAN_INFECTED`, `FILE_QUARANTINED` | `CRITICAL` | Beim Fund hat der Prüfer gearbeitet; bei veränderten Bytes hatte jemand Zugriff auf die Ablage, und dann ist die Datei die kleinere Frage |
| `SCANNER_MISSING` | `CRITICAL` | Die Anwendung nimmt Dateien an und kann keine prüfen |
| `LOGIN_FAILED`, `ACCESS_DENIED` | `WARNING` | Der Einzelfall ist der Normalfall einer funktionierenden Prüfung. Erst die Häufung ist eine Aussage — und die trifft die Übersicht, nicht die Zeile |
| `LOGIN_SUCCEEDED` | `INFO` | Alltäglich, aber unverzichtbar: Ohne sie beantwortet das Zentrum die wichtigste Frage nicht — *was ist nach der Reihe von Fehlversuchen passiert?* Ein Protokoll, das nur das Auffällige sammelt, zeigt den Einbruch, nicht ob er gelang |

---

## 4. Wo die Ereignisse entstehen

Ausschliesslich dort, wo der Zustand ohnehin wechselt. Kein zusätzlicher
Wächter, kein Abfragedienst.

| Ort | Ereignisse |
|---|---|
| `auth.service.ts` | `LOGIN_SUCCEEDED`, `LOGIN_FAILED`, `LOGIN_BLOCKED`, `ACCOUNT_LOCKED`, `PASSWORD_CHANGED` |
| `two-factor.service.ts` | `TWO_FACTOR_ENABLED/DISABLED/FAILED`, `LOGIN_SUCCEEDED` (mit Code), `SESSIONS_REVOKED` |
| `session-refresh.service.ts` | `REFRESH_REUSE_DETECTED` |
| `user.service.ts` | `ROLE_ASSIGNED`, `USER_SUSPENDED`, `USER_REACTIVATED`, `SESSIONS_REVOKED` |
| `access-token.service.ts` | `PUBLIC_LINK_ISSUED`, `PUBLIC_LINK_REJECTED` |
| `file.service.ts` | `FILE_SCAN_INFECTED`, `FILE_QUARANTINED`, `FILE_SCAN_UNAVAILABLE`, `FILE_POLICY_REJECTED`, `SCANNER_MISSING` |
| `security.service.ts` | `USER_REACTIVATED`, `SESSIONS_REVOKED` (die Handlungen der Seite selbst) |

### Zwei Entscheidungen, die man leicht andersherum trifft

**Der Fehlversuch und die Sperre sind zwei Ereignisse, nicht eines.** Der
Fehlversuch ist der achte einer Reihe, die Sperre ist die Folge daraus. Wer
später nachvollzieht, was geschah, will die Reihe sehen *und* den Moment, in
dem sie abriss.

**Ein unbekannter Zugangslink erzeugt ausdrücklich kein Ereignis.** Abgewiesen
werden gemeldet: abgelaufen, widerrufen, verbraucht — alle drei existieren, sie
gehören einer bekannten Organisation, und ihre Zahl ist durch die Zahl
ausgestellter Links begrenzt. Ein *geratener* Wert nicht:

> Ein Ereignis je unbekanntem Wert hiesse: Wer vierstellig oft rät, schreibt
> vierstellig viele Zeilen in die Sicherheitstabelle. Ein Protokoll, das sich
> von aussen füllen lässt, ist ein Verstärker — es verdrängt die echten
> Einträge, wächst unbegrenzt und kostet je Versuch eine Schreiboperation mehr
> als das Raten selbst. Gegen das Raten steht das Rate-Limit der Route, und das
> ist der richtige Ort dafür.

Dieselbe Überlegung gilt für `FILE_SCAN_UNAVAILABLE`: gemeldet wird erst nach
dem **letzten** Versuch. Ein kurzer Netzaussetzer meldete sonst für jede gerade
hochgeladene Datei eine Zeile, und ein Protokoll, das bei einer Störung
überläuft, wird beim nächsten Mal nicht mehr gelesen.

---

## 5. Was niemals hineingeht

Ein Sicherheitsprotokoll ist genau die Datei, die jemand mitnimmt, der schon
drin ist. Sie darf ihm nichts geben, was er noch nicht hat.

* Kein Passwort, kein Passworthash.
* **Kein roher Zugangstoken — und kein Hash davon.** Der Hash im Protokoll
  erlaubte den Abgleich gegen einen abgefangenen Wert.
* Kein TOTP-Geheimnis, keine AHV-Nummer, kein Alarmcode, keine IBAN.
* Keine E-Mail-Adresse aus einem fehlgeschlagenen Anmeldeversuch mit
  **unbekanntem** Konto. Ein Protokoll, das jede getippte Adresse sammelt, ist
  eine Adressliste.

`context` läuft durch `redact` aus `lib/audit.ts` — **dieselbe** Liste, nicht
eine zweite. Eine zweite wäre eine, die beim nächsten neuen Geheimnis nur an
einer Stelle ergänzt wird.

Was `redact` nicht kann, muss die aufrufende Stelle lassen: Ein Tokenwert unter
dem Schlüssel `wert` heisst `wert` und käme durch. Deshalb steht die Regel
zusätzlich an den auslösenden Stellen — und
`tests/api/sicherheitszentrum.test.ts` prüft die **ganze** Antwort als Text,
nicht Feld für Feld: Ein Geheimnis, das über ein neues Feld hereinkäme, entginge
einer Prüfung, die nur die bekannten Felder ansieht.

---

## 6. Wer hineinkommt

`security:read` und `security:manage` liegen bei `SUPER_ADMIN_ONLY`, neben
`audit:read`, `role:assign`, `user:impersonate` und `data:purge`.

Die Begründung ist die des Prüfprotokolls, eine Stufe schärfer: Diese Seite
zeigt, wessen Anmeldungen scheitern, wessen Konto gesperrt wurde und wer seinen
zweiten Faktor abgeschaltet hat. Das ist eine **Aufsicht über Personen**. Wer
beaufsichtigt wird, darf sie nicht öffnen — sonst sieht die Administration, die
sich zu weit vorgewagt hat, als Erste, dass es aufgefallen ist.

`security:manage` ist getrennt, weil die Handlungen dieselbe Tragweite haben
wie das Lesen: Ein Konto entsperren heisst, eine Sperre aufzuheben, die aus
einem Grund zugeschlagen hat.

Alle vier Schichten stimmen überein, wie es `CLAUDE.md` verlangt:

| Schicht | Wo |
|---|---|
| Middleware | `PERMISSION_ROUTES`: `/admin/sicherheit` → `security:read` |
| Navigation | `filterNavigation` über `permission: 'security:read'` |
| Seite | `requirePagePermission('security:read')` — **404**, nicht 403: Für andere Rollen existiert die Seite nicht |
| Endpunkte | `defineRoute({ permissions: [...] })` je Route |

---

## 7. Die Handlungen

### Kontosperre aufheben

`POST /api/security/users/:id/unlock`

Setzt `failedLoginCount` und `lockedUntil` zurück — **mehr nicht**. Kein neues
Passwort, keine Sitzung. Wer entsperrt wird, meldet sich selbst an; alles andere
hiesse, dass die Systemverantwortung einen Zugang *herstellt*, statt eine Sperre
aufzuheben.

Die Sperre läuft ohnehin nach 15 Minuten ab. Der Endpunkt ist für den Fall, für
den er gebaut ist: Jemand steht vor einer Schicht und kommt nicht herein, weil
die Zwischenablage ein altes Passwort hielt.

### Alle Sitzungen beenden

`POST /api/security/users/:id/revoke-sessions`

Zwei Dinge zusammen, und beide sind nötig:

1. Alle `RefreshToken` widerrufen — damit sich keine neue Sitzung daraus ziehen
   lässt.
2. `User.sessionsRevokedAt` setzen.

Nur das Erste liesse die bereits ausgestellten Zugangstokens für ihre restlichen
fünfzehn Minuten weiterlaufen — und genau in diesen fünfzehn Minuten würde
jemand tun, wovor der Widerruf schützen soll.

**Keine Ausnahme für die eigene Sitzung.** Wer sich selbst aussperrt, meldet
sich neu an. Eine Ausnahme wäre die Lücke, durch die ein übernommenes Konto
seine eigene Sitzung behält, während es alle anderen hinauswirft.

### Ereignis bestätigen

`POST /api/security/events/:id/acknowledge`

**Bestätigen ist keine Bewertung und kein Löschen.** Die Zeile bleibt
unverändert stehen; Zeitpunkt, Person und Notiz kommen hinzu. Wer später
nachvollzieht, was geschah, sieht beides: das Ereignis *und* dass jemand
hingesehen hat. Ein „erledigt"-Häkchen, das die Zeile verschwinden lässt, wäre
die bequemere Oberfläche und die schlechtere Auskunft.

Die Notiz ist freiwillig. Ein Zwang zur Begründung führt zu „ok" in jedem Feld,
und das ist schlechter als nichts, weil es aussieht wie eine Einordnung.

Ein bereits bestätigtes Ereignis antwortet **200** mit `bestaetigt: false` —
kein Fehler: Die Absicht der aufrufenden Person ist erfüllt, und zwei Personen,
die gleichzeitig klicken, sollen keinen Fehlschlag sehen. Die bedingte
Aktualisierung (`acknowledgedAt: null` in der `where`-Klausel) entscheidet den
Wettlauf in der Datenbank; ohne sie überschriebe der zweite Aufruf Zeitpunkt und
Notiz des ersten.

---

## 8. Aufbewahrung — offen, und das steht hier

`security_events` trägt **keinen** Anfüge-nur-Trigger, anders als
`signature_events`. Zwei Gründe:

* Zeilen werden absichtlich geändert (`acknowledgedAt`, `acknowledgedNote`).
  Ein Trigger, der `UPDATE` verbietet, müsste genau diese Spalten ausnehmen und
  wäre damit kein Schutz mehr, sondern eine Einladung.
* Gelöscht werden *muss*: Ein Ereignisstrom ohne Grenze wächst unbegrenzt, und
  gerade die Alltagsereignisse (`INFO`) sind nach Monaten wertlos.

**Heute löscht nichts diese Tabelle.** Die Aufbewahrung gehört nach Wave 24
(Löschfristen) und wird dort einheitlich geregelt — zusammen mit `AuditLog`,
`Notification` und den übrigen Strömen, damit nicht jeder seine eigene Frist
bekommt.

---

## 9. Wo was steht

| Datei | Inhalt |
|---|---|
| `src/lib/security/events.ts` | Der Katalog — rein, ohne Server-Abhängigkeit, direkt prüfbar |
| `src/lib/security/record.ts` | `recordSecurityEvent`, mit derselben Redigierung wie das Prüfprotokoll |
| `src/server/services/security.service.ts` | Überblick, Liste, Entsperren, Sitzungswiderruf, Bestätigen |
| `src/lib/validation/security.ts` | Zod-Schemata (speisen auch die OpenAPI-Beschreibung) |
| `src/app/api/security/**` | Vier Endpunkte |
| `src/app/(app)/admin/sicherheit/page.tsx` | Die Seite |
| `tests/api/sicherheitszentrum.test.ts` | 26 Prüfungen — Katalog als Tabelle, alles andere über HTTP |
