# Gate 4A — Elektronische Unterzeichnung: Bestand, Sicherheitsmodell, Beweiskette, Schema

Stand 20.09.2026. Entwurf aus Gate 4A, ergänzt um § 0 aus Gate 4B: Dort steht,
was bei der Umsetzung anders entschieden wurde als hier vorgeschlagen. Wo
§ 0 und ein späterer Abschnitt sich widersprechen, gilt § 0 — die Abschnitte
1–22 bleiben als Herleitung stehen, nicht als Beschreibung des Codes. Die
Umsetzung selbst: `src/server/services/signature.service.ts`,
`src/lib/auth/signature-*.ts`, `src/lib/pdf/signature-artifacts.ts`,
`src/lib/http/client-ip.ts`, Migration `20260920100000_signatur_kern`.

## 0. Korrekturen und Entscheide aus Gate 4B

**Sieben Korrekturen am Entwurf** — jede war im Entwurf entweder falsch,
zu optimistisch oder unentschieden:

1. **`pdf-lib` ist kein Signaturvalidator** (§ 9, § 21.1). Es lädt, misst,
   zeichnet, hängt an und *findet* AcroForm-`/Sig`-Felder und `/Type /Sig`-
   bzw. `/ByteRange`-Wörterbücher. Es prüft keine PAdES, keine QES, keine
   Zertifikatskette. Der Befund im Protokoll heisst deshalb „Suche nach
   Signaturfeldern und -strukturen; keine kryptografische Prüfung" — und
   nirgends „keine Signatur vorhanden". Version fest `1.17.1`, nur
   serverseitig.
2. **`SignatureEvent` ist `Restrict`, nicht `Cascade`** (§ 18), und die
   Datenbank erzwingt die Unveränderlichkeit (§ 13 behauptete das
   Gegenteil): Funktion `signature_events_nur_anhaengen()` mit Triggern
   `BEFORE UPDATE`, `BEFORE DELETE` (je Zeile) und `BEFORE TRUNCATE`
   (Anweisung) — `RAISE EXCEPTION`, ERRCODE `P0001`. Ein Vorgang mit
   Ereignissen ist damit auch aus der Datenbank heraus nicht löschbar; das
   ist der Punkt, nicht ein Nebeneffekt. `tests/api/signatur.test.ts` prüft
   UPDATE, DELETE und TRUNCATE gegen die Testdatenbank.
3. **Abgeschlossene Beweise werden nicht automatisch anonymisiert oder
   bereinigt** (§ 14, § 21.4). `runPurge` weist die Bereiche `auftraege`
   und `fuehrung` ab, solange Vorgänge existieren (`assertKeineSignaturbeweise`,
   422). Keine Aufbewahrungsfrist wird erfunden; was eine Betreiberin mit
   Beweisen tun darf, entscheidet ein späterer Governance-Ablauf.
4. **Zugang nach Abschluss über einen eigenen Zweck** (§ 21.5):
   `PublicTokenPurpose.SIGNATURE_RESULT_VIEW`, 30 Tage (nicht 90), kein
   PDF-Anhang in der E-Mail. Ein Unterzeichnungslink öffnet kein Ergebnis,
   ein Ergebnislink keinen Unterzeichnungsablauf — der Tausch stellt die
   Sitzung mit `scope: 'sign' | 'result'` aus, und jede Route prüft den
   Zweck des zugrunde liegenden Tokens erneut in der Datenbank.
5. **Vertrauenswürdiger Proxy ausdrücklich** (§ 8, § 21.6):
   `TRUSTED_PROXY_MODE = NONE | SINGLE_REVERSE_PROXY | CLOUDFLARE`, Vorgabe
   `NONE` = Adresse **nicht verfügbar** (`ipSource = UNAVAILABLE`) statt
   erfunden. Zentral in `src/lib/http/client-ip.ts`; `getClientIp` des
   Rate-Limits und damit `AuditLog.ip` hängen daran. Nginx-Vorgabe in
   `docs/DEPLOYMENT.md` 13.5.1 (`X-Real-IP $remote_addr`, gesetzt, nicht
   angehängt).
6. **Der rohe Token steht nie im Pfad** (§ 4 schlug `GET /signieren/{raw}`
   vor). Er steht im URL-**Fragment** (`/signieren#t=<raw>`), das kein
   Browser mitschickt; die Seite liest ihn lokal, entfernt ihn per
   `history.replaceState`, tauscht ihn per `POST /api/public/signatures/exchange`
   **im Körper** und leitet mit `location.replace` auf die nicht geheime
   Adresse `/signieren/s/<publicId>`. Kein Referrer, kein Zugriffsprotokoll,
   kein Verlauf trägt ihn. Der Bereich `/signieren` liegt in einer eigenen
   Routengruppe ohne Website-Layout, Analytik oder Fremdskripte.
7. **Quote/Job werden in Gate 4B nicht migriert** (§ 2, § 15, § 21.2).
   Referenzfluss ist allein `ManagedDocument`/`DocumentVersion`. Die
   Altfelder bleiben, sind im Schema als `LEGACY_SIGNATURE` markiert und
   werden weder nachgefüllt noch umgedeutet; der Wortlaut „digital
   signiert"/„ZertES" ist entfernt. Gate 4C entscheidet, ob eine
   Offertannahme eine `SignatureRequest` wird.

**Weitere Entscheide aus 4B**, die den Entwurf ergänzen:

- **Zwei Artefaktmodi.** `EMBEDDED_VISUAL` (Original + sichtbare
  Unterschrift + Signaturseite = B) nur, wenn die Strukturprüfung nichts
  findet — gedacht für Clenaris-eigene PDFs. `DETACHED_EVIDENCE` (Vorgabe
  für hochgeladene Fassungen): das Original bleibt bytegenau, es entsteht
  nur das Protokoll (C). Kein `FileAsset.signatureRequestId`; die drei
  Artefakte hängen über benannte Relationen (`originalArtifact`,
  `signedArtifact`, `evidenceArtifact`), das Bild über
  `SignatureParticipant.signatureArtifact`. `originalArtifactId` ist nicht
  eindeutig — mehrere Vorgänge dürfen dieselbe Fassung binden.
- **Zustandsmaschine mit `FINALIZING`.** `PENDING → FINALIZING → COMPLETED`
  über bedingtes `updateMany`; deterministische Artefaktpfade
  (`<org>/signatures/<request>/{signed,evidence,signature-<participant>}`),
  Artefakte nur, wenn sie fehlen; `COMPLETED` nur mit Protokoll. Ein
  Fehlschlag lässt `FINALIZING` mit `finalizingSince` stehen; der Nachtlauf
  (`runSignatureNightly`, im täglichen Cron) übernimmt nach zehn Minuten,
  lässt Vorgänge ablaufen (`EXPIRED`, Tokens widerrufen) und löscht
  verbrauchte Codes nach 24 Stunden. Das ersetzt die Tabelle in § 12.
- **Sitzung.** Zustandsloses `jose`-HS256-Cookie `clenaris_sig`, eigener
  HKDF-Schlüssel (`clenaris-signature-session-v1`), HttpOnly, `Secure` in
  Produktion, `SameSite=Lax`, **Pfad `/api/public/signatures`**, 60 Minuten,
  zufälliges `jti`. Jede sensible Route lädt Vorgang, Teilnehmer und Token
  neu (`sitzungPruefen`): Abbrechen widerruft Tokens und damit jede Sitzung
  sofort, ohne Sitzungstabelle.
- **Code.** CSPRNG (`randomInt`) → HMAC-SHA256 mit HKDF-Schlüssel
  `clenaris-signature-otp-v1` → Argon2id (§ 5 sah Argon2id direkt über den
  Code vor; die HMAC-Schicht davor macht einen Datenbankabzug ohne
  Serverschlüssel wertlos). 10 Minuten, 5 Versuche — **vor** dem Vergleich
  gezählt —, 60 Sekunden Sperre, einmalig, neuer Code entwertet alte.
  Stufen `LINK_ONLY | LINK_PLUS_EMAIL_CODE | LINK_PLUS_SMS_CODE`; nie
  „2FA/MFA".
- **Zustimmung** wie § 6, zusätzlich mit `consentLocale` (`de-CH`) am
  Vorgang und am Teilnehmer.
- **Rate-Limits:** `signatureExchange` 20/600 s (Adresse),
  `signatureFinalize` 10/600 s je Vorgang (Abschluss und Ablehnen),
  `otpRequest`/`otpVerify` je Vorgang, `publicTokenRead` 60/60 s. Im Modus
  `NONE` teilen sich alle Aufrufer eine Adresse — ein Grund mehr, den
  Modus in Produktion zu setzen.
- **Berechtigungen** wie § 16 (`signature:read|create|cancel`; MANAGER
  read+create). Das Recht am Vorgang ersetzt nicht das Recht am Ursprung:
  Ohne Sichtbarkeit des Dokuments antwortet das Anlegen 404.
- **`FileScope.SIGNATURE`**, `PURPOSE_RESOURCE.SIGNATURE_ACCESS |
  SIGNATURE_RESULT_VIEW | SIGNATURE_OTP = 'SignatureParticipant'`;
  `SIGNATURE_OTP` bleibt unbenutzt.

**Was 4B bewusst nicht tut:** kein Anbieter (`QUALIFIED_EXTERNAL` nur als
Enum-Wert), kein Nachfüllen alter Quote/Job-Signaturen, keine
Nummernkreise, kein Browser-Prüfstand (§ 22 bleibt offen), keine
Umrechnung gedrehter Seiten bei der Position.

Zwei Stufen, strikt getrennt:

- **INTERNAL_EVIDENCE** — Clenaris-eigener Prozess: sicherer Link, optionale
  Bestätigung per Code, ausdrückliche Zustimmung, Dokumentansicht, Name,
  gezeichnete oder getippte Unterschrift, unveränderlicher Snapshot, SHA-256,
  Ereignisprotokoll, signiertes PDF, Signaturprotokoll. **Keine** QES, keine
  ZertES-qualifizierte Signatur, kein qualifizierter Zeitstempel, keine
  Gleichstellung mit der Handunterschrift — und im Produkt wird nichts davon
  behauptet.
- **QUALIFIED_EXTERNAL** — nur die Schnittstelle. Kein Anbieter, kein
  Nachbau.

---

## 1. Bestand

Gesucht: `signature`, `signatureDataUrl`, `signatureName`, `signedAt`,
`signedBy`, `signatureIp`, `SignaturePad`, `accept`, `approval`, `consent`,
`otp`, `VerificationToken` — in Schema, Diensten, Routen, Masken, PDF.

| Bereich | Befund | Klasse |
|---|---|---|
| `Quote` | `signatureDataUrl` (PNG-Data-URL bis 500 kB als Text in der Zeile), `signatureName`, `signatureIp`, `signedAt`; gesetzt in `respondToQuoteCore` beim Annehmen | **CURRENT**, aber siehe Probleme |
| `Job` | `signatureDataUrl`, `signatureName`, `signedAt`; gesetzt in `completeJob` — Abnahme durch die Kundschaft **auf dem Gerät der Reinigungskraft** vor Ort | **CURRENT** — anderer Anwendungsfall (Präsenz), keine IP |
| `SignaturePad` (`features/portal/signature-pad.tsx`) | Canvas, Pointer-Events, `devicePixelRatio`, PNG-Data-URL; verwendet von Offertantwort und Rapport | **CURRENT** — keine getippte Alternative, keine Tastaturbedienung |
| PDF (`lib/pdf/documents.tsx`) | Offerte und Rapport betten das Bild ein, Beschriftung „digital signiert am" bzw. Datum | **CURRENT** — Wortlaut problematisch |
| PDF-Renderer (`lib/pdf/render.ts`) | Nach Annahme wird das Offert-PDF **neu gerendert** (`renderQuotePdf` in `respondToQuoteCore`); `persist()` überschreibt dieselbe Ablagezeile | **BROKEN** für Beweiszwecke — siehe Probleme |
| `Booking`, `Invoice`, `Contract` | keine Signaturfelder; `Contract` existiert nicht | **MISSING** |
| `ManagedDocument` / `DocumentVersion` | Fassungen mit `FileAsset` → `StoredFile` → `checksum` (Gate 2); Viewer mit Fassungsnummer (Gate 3) | **CURRENT** — die richtige Grundlage |
| `PublicAccessToken` | Zwecke `SIGNATURE_ACCESS`, `SIGNATURE_OTP` vorhanden, `maxUses`, Widerruf, Ablauf, nur Hash | **PARTIAL** — Zweckzuordnung zeigt auf `SignatureRequest`, muss auf den Teilnehmer |
| `SIGNATURE_OTP` als `PublicAccessToken` | SHA-256 über einen sechsstelligen Code wäre offline in Sekunden durchprobiert | **OBSOLETE** als Mechanismus — Enum-Wert bleibt, wird nicht verwendet |
| `VerificationToken` | E-Mail-Bestätigung, Passwortzurücksetzung, Einladung, `usedAt` | **CURRENT** für seinen Zweck; für Signaturen ungeeignet (Einmaligkeit im Token, keine Ressourcenbindung) |
| `Consent` | pro `User`, `type`, `version`, IP, User-Agent; `onDelete: Cascade` am Nutzer | **PARTIAL** — braucht ein Konto; externe Unterzeichnende haben keines, und der Text selbst wird nicht gespeichert |
| `AuditLog` | `action`, `entity`, `changes` (redigiert), IP, User-Agent | **CURRENT** — allgemeines Systemaudit, nicht fachliches Signaturprotokoll |
| TOTP (`lib/auth/totp.ts`) | HMAC-SHA1, Authenticator-Apps, 2FA | **CURRENT** — für Login; für E-Mail-/SMS-Codes ungeeignet (kein geteiltes Geheimnis beim Empfänger) |
| Argon2id (`lib/auth/password.ts`) | `@node-rs/argon2`, Passwörter | **CURRENT** — wiederverwendbar für Code-Hashes |
| Rate-Limits | `otpRequest` 5/900 s, `otpVerify` 8/900 s, `publicTokenRead`, `publicTokenAction` (pro Ressource) | **CURRENT** — vorbereitet in Gate 1, unbenutzt |
| CSRF (`lib/api/handler.ts`) | `SameSite=Lax` + `Origin`-Prüfung bei allen ändernden Methoden, auch `definePublicRoute` | **CURRENT** — gilt automatisch für neue Routen |
| IP (`lib/rate-limit.ts` `getClientIp`) | `cf-connecting-ip` → `x-real-ip` → `x-forwarded-for` → `127.0.0.1` | **BROKEN** als Beweismetadatum — siehe Probleme |
| Cookies (`lib/auth/jwt.ts` `cookieOptions`) | `httpOnly`, `secure` in Produktion, `SameSite=Lax`, `path=/` | **CURRENT** — wiederverwendbar |
| E-Mail/SMS | Resend, Twilio, `notify()` mit Kanälen, `EmailLog`/`SmsLog` ohne Inhalt | **CURRENT** — keine Signaturvorlagen |
| PDF-Bibliotheken | `@react-pdf/renderer` (erzeugt), `react-pdf`/`pdfjs-dist` (zeigt); **nichts, das ein PDF liest oder verändert** | **MISSING** für Overlay, Zusammenführen, Erkennen vorhandener Signaturfelder |
| Löschen | Papierkorb (`trash.service`, 7 Modelle inkl. `Quote`, `Job`, `Customer`), harte Bereinigung (`purge.service`) in fester Reihenfolge; `FileAsset` hängt per `Cascade` an Quote/Job/Customer/…; `Quote.customer` `SetNull`, `Booking.customer` `Cascade` | **CURRENT** — Konflikte in § 12 |
| Browser-/E2E-Prüfstand | keiner (kein Playwright/Puppeteer/Cypress, Chrome-Erweiterung nicht verbunden) | **MISSING** — Gate-3-Laufzeitprüfung bleibt offen |

## 2. Probleme

1. **Die Signatur hängt an veränderlichen Daten.** `Quote.signatureDataUrl` beweist, dass *irgendein* Stand der Offerte unterschrieben wurde. Das PDF wird nach der Annahme neu gerendert — aus den *aktuellen* Feldern — und überschreibt die Ablage (`persist()` → `putLocalBuffer` upsert). Ändert jemand danach eine Position, zeigt das „unterschriebene" PDF den neuen Betrag. Es gibt keinen Hash, keinen Snapshot, keine Bindung an Bytes.
2. **Kein Ereignisprotokoll.** Vorhanden ist ein `AuditLog`-Eintrag „angenommen"; nicht vorhanden: wann angesehen, welcher Link, welche Zustimmung, welcher Name eingegeben.
3. **Keine Zustimmung mit Wortlaut.** Die Antwortmaske zeigt einen Hinweistext; gespeichert wird er nicht.
4. **IP-Adresse ist spoofbar.** `getClientIp` glaubt `cf-connecting-ip` zuerst. Steht die Anwendung nicht hinter Cloudflare, setzt jeder Client diesen Kopf selbst. `Quote.signatureIp` ist damit heute eine Behauptung des Absenders.
5. **Wortlaut.** `signature-pad.tsx` nennt das Ergebnis „einfache elektronische Signatur im Sinne des ZertES"; das PDF schreibt „digital signiert am". Ersteres ist eine rechtliche Einordnung, die Clenaris nicht treffen sollte; Letzteres suggeriert eine kryptografische Signatur, die es nicht gibt.
6. **Bild als Beweis.** Die Data-URL ist das einzige Artefakt. Ein PNG ist kopierbar; ohne Prozesskette beweist es nichts.
7. **Barrierefreiheit.** Nur Zeichnen. Keine getippte Unterschrift, keine Tastatur.
8. **`SIGNATURE_OTP` als `PublicAccessToken`** wäre ein Entwurfsfehler gewesen (SHA-256 über sechs Ziffern). Noch nicht verwendet — bleibt so.
9. **`PURPOSE_RESOURCE.SIGNATURE_ACCESS = 'SignatureRequest'`** ist zu grob: Jeder Unterzeichnende braucht einen eigenen Link; Ressource ist der Teilnehmer.

Nichts davon wird in 4A entfernt. Klassifikation der Altfelder in § 15.

## 3. Beweiskette (Artifact Chain)

```
Geschäftsobjekt (Quote | Job | ManagedDocument)
  │
  ├─ Quote/Job: unveränderlicher PDF-Snapshot beim Anlegen der Anfrage
  │             (react-pdf, ohne Unterschriftsblock) → uploadBuffer → StoredFile + FileAsset
  └─ ManagedDocument: die gewählte DocumentVersion → FileAsset → StoredFile (Gate 2)
  │
  ▼
originalArtifact  = FileAsset (scope SIGNATURE, kein Cascade an Quote/Job)
Hash A            = StoredFile.checksum des Originals (SHA-256 der gespeicherten Bytes, Gate 2)
  │
  │  Signaturprozess: Link → Sitzung → Ansicht (Gate-3-Viewer, Quelle = Original) → Code → Zustimmung → Name → Unterschrift → Abschluss
  │  Beim Abschluss: SHA-256 der Originalbytes erneut berechnen; ≠ A → ABBRUCH, Ereignis INTEGRITY_MISMATCH
  ▼
signedArtifact    = neues PDF: Original + sichtbare Unterschrift/Signaturblatt (pdf-lib, § 9)
Hash B            = StoredFile.checksum des signierten Artefakts; B ≠ A, sonst ABBRUCH
  │
  ▼
Beweisdaten final (Anfrage, Teilnehmer, Ereignisse, Zustimmungs-Snapshot, A, B, Methode, Zeiten, technische Metadaten)
  │
  ▼
evidenceArtifact  = Signaturprotokoll-PDF (react-pdf) — enthält A und B, **nicht** C
Hash C            = StoredFile.checksum des Protokolls → SignatureRequest.evidenceArtifactHash
```

Reihenfolge ist zwingend: 1 Original finalisieren → 2 A → 3 signiertes PDF → 4 B → 5 Beweisdaten einfrieren → 6 Protokoll-PDF → 7 C → 8 C speichern. Kein Dokument enthält seinen eigenen Hash.

Alle drei Artefakte sind `FileAsset` (scope `SIGNATURE`, `isPublic: false`, `signatureRequestId` gesetzt) über die Gate-2-Ablage. **Keine vierte Dateiarchitektur.**

## 4. Zugang: `SIGNATURE_ACCESS` → Tausch → Sitzung → Teilnehmer

**Link.** `issuePublicToken({ purpose: 'SIGNATURE_ACCESS', resourceId: participant.id })` — 32 Zufallsbytes, nur Hash in der Datenbank, Ablauf = `request.expiresAt`, Widerruf beim Abbrechen. `PURPOSE_RESOURCE.SIGNATURE_ACCESS` wird zu `'SignatureParticipant'` (Code, kein Schema).

**Tausch (`GET /signieren/{rawToken}`) — *so nicht umgesetzt, siehe § 0.6: Fragment + `POST …/exchange`.*** Server löst den Token auf (`resolvePublicToken`, **kein** Legacy-Rückfall — es gibt keinen Altbestand), prüft Anfrage `PENDING`, Teilnehmer nicht terminal, nicht abgelaufen; schreibt Ereignis `LINK_EXCHANGED`; setzt die Signatur-Sitzung; antwortet mit `303 See Other` auf `/signieren/s/{request.publicId}`. Der rohe Token steht danach nirgends mehr: nicht in der Adresszeile, nicht im Referrer der PDF-Abrufe, nicht in Fehlerberichten. `publicId` ist eine **nicht geheime** Adresse (16 Zufallsbytes hex): Ohne Sitzung zeigt sie nur „Link nicht mehr gültig".

**Sitzung.** Kleinste sichere Lösung: ein signiertes, zustandsloses Cookie (`jose`, wie die Anmeldung), Name `clenaris_sig`, Nutzlast `{ typ: 'sig', req, part, tok, jti, iat, exp }`, Laufzeit 60 Minuten fest (kein Gleiten — ein Signaturvorgang ist kurz), `cookieOptions()` aus `jwt.ts` (`httpOnly`, `secure` in Produktion, `SameSite=Lax`). **Kein neues Modell.** Die Sitzung ersetzt keine Prüfung: Jede Route lädt Anfrage und Teilnehmer und prüft Status, Ablauf, Widerruf, `tok` = Token-Kennung noch gültig (widerrufen ⇒ Sitzung wertlos, ohne Sitzungstabelle). Abbrechen der Anfrage widerruft den Token; damit sind alle Sitzungen dazu tot.

**CSRF.** Alle ändernden Routen laufen über `definePublicRoute` → `assertTrustedOrigin` + `SameSite=Lax`. Zusätzlich trägt jede ändernde Signaturroute die Sitzung; ein fremdes Formular hätte sie nicht.

**Ratenbegrenzung** (bestehende Infrastruktur, Schlüssel nie der rohe Token):

| Route | Klasse | Schlüssel |
|---|---|---|
| Tausch | `signatureExchange` 20/600 s (neu) | IP |
| Code anfordern | `otpRequest` 5/900 s | Teilnehmer-ID (Hash) **und** IP |
| Code prüfen | `otpVerify` 8/900 s | Teilnehmer-ID (Hash) |
| Abschluss / Ablehnen | `publicTokenAction` 10/600 s | Teilnehmer-ID (Hash) |
| Dokument (PDF) | `publicTokenRead` 60/60 s | IP |

**Fehlerantworten** sind enumerationssicher: unbekannt, abgelaufen, widerrufen, abgeschlossen, falscher Teilnehmer → dieselbe Seite „Dieser Link ist nicht mehr gültig" (404). Nur ein *gültiger* Link darf „abgelaufen am …" erfahren (wie `tokenRejectionError`). Technische Fehler (500) bleiben unterscheidbar.

## 5. Bestätigungscode (OTP)

**Nicht** `PublicAccessToken` mit SHA-256: sechs Ziffern sind 10^6 Möglichkeiten; ein Datenbankabzug wäre offline in Sekunden durch. Eigenes Modell `SignatureOtpChallenge`.

- **Hash:** Argon2id (vorhandenes `hashPassword`) über `${code}:${challenge.id}`. Ein Abzug erfordert ~10^6 Argon2-Läufe *je Code* — bei zehn Minuten Gültigkeit praktisch wertlos. Alternative HMAC-SHA256 mit HKDF-Pepper aus `JWT_SECRET` (Muster aus `crypto.ts`) wäre schneller, hängt aber am Serversecret; Argon2id braucht kein weiteres Geheimnis. **Empfehlung: Argon2id.**
- **Gültigkeit** 10 Minuten. **Versuche** `attempts`/`maxAttempts = 5`; danach Challenge ungültig, neuer Code nötig. **`usedAt`** einmalig. **Neuer Code invalidiert** alle offenen (`invalidatedAt`). **Erneut senden** frühestens nach 60 s (`resendAfter`). Bindung: `participantId`; Prüfung nur aus einer gültigen Sitzung desselben Teilnehmers.
- **Kanal:** `EMAIL` (Resend) oder `SMS` (Twilio) an den beim Anlegen eingefrorenen `emailSnapshot`/`phoneSnapshot`. Kein Wechsel des Ziels aus dem öffentlichen Ablauf heraus.
- **Keine MFA-Bezeichnung.** Link per E-Mail + Code per E-Mail ist eine zweite Bestätigung über denselben Kanal. Erst Link per E-Mail + Code per SMS an eine *separat hinterlegte* Nummer ist ein zweiter Kanal — und auch das ist keine QES.

**Assurance-Stufen** (technisch definiert, keine rechtliche Wertung):

| Stufe | Was geprüft wurde |
|---|---|
| `LINK_ONLY` | Besitz des per E-Mail zugestellten Links |
| `LINK_PLUS_EMAIL_CODE` | Besitz des Links **und** Zugriff auf dasselbe Postfach zum Zeitpunkt der Unterzeichnung |
| `LINK_PLUS_SMS_CODE` | Besitz des Links **und** Zugriff auf die hinterlegte Mobilnummer |

Die Stufe wird beim Anlegen festgelegt (`SignatureRequest.assuranceLevel`); erreicht wird sie beim Abschluss auf dem Teilnehmer festgehalten (`authenticationMethod`).

## 6. Zustimmung (Consent)

Der Text ist Produkttext, versioniert im Code (`SIGNATURE_CONSENT[version]`), Beispiel v1: *„Ich bestätige, dass ich das angezeigte Dokument gelesen habe und es elektronisch unterzeichnen möchte."* Beim Abschluss auf dem Teilnehmer eingefroren: `consentTextSnapshot` (der exakte Wortlaut), `consentTextHash` (SHA-256 des Wortlauts), `consentVersion`, `consentAcceptedAt`. Der Client sendet nur `consentAccepted: true`; den Text nimmt der Server aus der Version, die die Anfrage trägt — nie aus dem Request. Das bestehende `Consent`-Modell bleibt für Kontoeinwilligungen; Unterzeichnende haben kein Konto.

## 7. Beweisdaten — was gespeichert wird und warum

| Datum | Ort | Warum |
|---|---|---|
| Hash A, B, C | Request | Bindung an Bytes; Nachprüfbarkeit |
| Ereignisse mit Zeit (UTC) | `SignatureEvent` | Ablauf nachvollziehbar |
| Zustellziel (E-Mail/Telefon-Snapshot) | Participant | „Link/Code an X gesendet" — Tatsache, nicht Identität |
| eingegebener Name, Methode, Bild-Hash | Participant | Was die Person angegeben hat |
| Zustimmungstext + Hash + Version + Zeit | Participant | Wozu zugestimmt wurde |
| IP-Adresse **und Quelle** (`ipSource`) | Event/Participant | technisches Metadatum; Quelle nennt, welchem Kopf geglaubt wurde |
| User-Agent | Event/Participant | „Browser-/Client-Angabe" — spoofbar, so beschriftet |
| Sitzungskennung (`jti`, Hash) | Event | Zuordnung mehrerer Aktionen zu einer Sitzung |

**Nicht** gespeichert: Fingerprints (Browser, Canvas), Geolokation, Gerätekennungen, Tracking. Kein rohes Token, kein Code, keine Sitzung im Klartext — nirgends, auch nicht im Protokoll.

Das Protokoll sagt „Link an … gesendet", „Code bestätigt", „Name eingegeben: …", „Sitzung …", „um … UTC (… Zürich)". Es sagt nicht „Identität verifiziert" und nicht „qualifizierter Zeitstempel" — Serverzeit ist Systemzeit.

## 8. IP und Proxy

`getClientIp` muss eine **vertrauenswürdige Proxy-Richtlinie** bekommen, bevor eine Adresse als Beweismetadatum taugt: Umgebungsvariable `TRUSTED_PROXY = cloudflare | nginx | none`. `cloudflare` → nur `cf-connecting-ip`; `nginx` → nur `x-real-ip` (Nginx setzt ihn aus der Socket-Adresse); `none` → Socket-Adresse. `x-forwarded-for` nie ungeprüft, weil anhängbar. Gespeichert wird `ipAddress` + `ipSource`. Das betrifft auch das heutige `Quote.signatureIp` und `AuditLog.ip` — Änderung in 4B, hier nur Befund.

## 9. PDF

**Sichtbare Unterschrift ≠ kryptografische Signatur.** INTERNAL_EVIDENCE erzeugt **keine** PAdES-/ZertES-Signatur. Das signierte Artefakt ist ein PDF mit sichtbarem Unterschriftsbild und Signaturblatt; die Beweiskraft liegt in Hashes und Protokoll, nicht in einer Zertifikatskette.

**Erzeugung.** `@react-pdf/renderer` kann PDFs nur erzeugen, nicht lesen. Für „Original + Unterschrift" braucht es eine Bibliothek, die ein vorhandenes PDF öffnet: **`pdf-lib`** (MIT, reines JavaScript, keine nativen Abhängigkeiten). Damit: Originalseiten übernehmen, Unterschriftsbild an validierter Position stempeln, ein mit react-pdf erzeugtes Signaturblatt anhängen, Seitenzahl und Seitenmasse lesen. Für Quote/Job-Snapshots ginge auch ein Neurendern *aus den Snapshot-Daten* — aber das bindet an Daten statt an Bytes und wäre genau der Fehler aus § 2.1. Deshalb einheitlich: **signiert = Originalbytes + Overlay/Anhang**.

**Position.** `placementPage`, `placementX`, `placementY`, `placementWidth`, `placementHeight` in PDF-Punkten. Validierung beim Anlegen *und* beim Abschluss gegen die tatsächliche Seite: `1 ≤ page ≤ numPages`, `x, y ≥ 0`, `x + width ≤ pageWidth`, `y + height ≤ pageHeight`, `width ≥ 60`, `height ≥ 24`, `width ≤ pageWidth/2`, `height ≤ pageHeight/4`. Ohne Angabe: kein Stempel, nur Signaturblatt.

**Vorhandene PDF-Signaturen.** Jede Veränderung eines PDF mit kryptografischer Signatur (PAdES, QES eines Dritten) macht diese ungültig — und zwar still. `pdf-lib` kann AcroForm-Felder lesen (`getForm().getFields()`, Feldtyp `/Sig`) und `/ByteRange`-Einträge erkennen. Gate 4B: Beim Anlegen einer Anfrage auf eine hochgeladene Fassung das Original prüfen; bei erkanntem Signaturfeld die Anfrage für INTERNAL_EVIDENCE **ablehnen** (nicht warnen — ein Overlay zerstörte den fremden Beweis). Was `pdf-lib` nicht erkennt (nicht-AcroForm-Signaturen, beschädigte Strukturen), wird **nicht** als „keine Signatur" behauptet; das Protokoll hält fest: „Prüfung auf vorhandene Signaturfelder: keine gefunden (AcroForm)". Keine Zusicherung, eine vorhandene PAdES/QES bleibe gültig.

**Signaturbild.** `SignaturePad` liefert PNG-Data-URL; zusätzlich getippte Variante (Name in einer festen Schrift, serverseitig gerendert — kein Client-Bild). Speicherung: Data-URL serverseitig dekodieren, gegen `verifyBytes('signatureImage', 'image/png', bytes)` prüfen (neues Profil, nur PNG, ≤ 512 kB), als privates `FileAsset` (scope `SIGNATURE`) ablegen, Hash am Teilnehmer. **Keine** Data-URL in Geschäftsmodellen mehr. Kein öffentliches Asset, keine Ablageadresse als Berechtigung — Abruf nur über die Anfrage-Berechtigung.

## 10. Anbietergrenze

```ts
interface SignatureProvider {
  readonly type: 'INTERNAL_EVIDENCE' | 'QUALIFIED_EXTERNAL';
  prepare(request): Promise<void>;        // Snapshot, Positionen, Vorprüfung
  invite(participant): Promise<void>;     // Link/Code-Zustellung (INTERNAL) bzw. Redirect-URL (EXTERNAL)
  finalize(participant, payload): Promise<SignedArtifact>;  // erzeugt B
  cancel(request): Promise<void>;
}
```

`SignatureRequest.providerType` wählt die Umsetzung; `providerReference` (nullable) nimmt später die Vorgangskennung des externen Dienstes auf. Kein Anbieter wird integriert; die Grenze verhindert nur, dass ein späterer QES-Anbieter das Modell ersetzt.

## 11. Abschluss — die Transaktion

```
1.  Sitzung prüfen → participant, request laden (SELECT … FOR UPDATE auf beiden)
2.  request.status = PENDING, participant.status ∉ {SIGNED, DECLINED}
3.  now < request.expiresAt
4.  Token-Kennung aus der Sitzung noch gültig (nicht widerrufen)
5.  assuranceLevel ≠ LINK_ONLY ⇒ participant.verifiedAt gesetzt, Challenge usedAt gesetzt
6.  consentAccepted = true ⇒ Snapshot/Hash/Version festhalten
7.  Original laden (readStoredBytes), SHA-256 berechnen
8.  ≠ originalDocumentHash ⇒ Ereignis INTEGRITY_MISMATCH, Abbruch (422)
9.  Nutzlast prüfen: Methode, Name (2–120 Zeichen), Bild (PNG ≤ 512 kB) bzw. getippter Text
10. Signiertes PDF erzeugen (pdf-lib) — im Speicher
11. Signiertes PDF ablegen (uploadBuffer → StoredFile + FileAsset scope SIGNATURE)
12. B = checksum; B ≠ A, sonst Abbruch
13. participant: status SIGNED, signedAt, Methode, Name, Bild-Asset, Consent-Felder, authenticationMethod, ip/ipSource/userAgent
14. request: signedArtifactId/Hash; wenn alle SIGNER SIGNED ⇒ COMPLETED, completedAt
15. Ereignisse SIGNATURE_SUBMITTED, ARTIFACT_CREATED, SIGNED, ggf. REQUEST COMPLETED
16. Danach (ausserhalb, idempotent): Protokoll-PDF → C → evidenceArtifactId/Hash; Ereignis ARTIFACT_CREATED
```

**Rennen.** Der Übergang steht in der `where`-Klausel: `updateMany({ where: { id, status: PENDING, signedAt: null }, data: … })` — trifft eine Zeile oder keine (Muster aus Gate 1). Zusätzlich `@@unique([requestId, order])` und `signedArtifactId @unique`. Zwei parallele Abschlüsse ergeben genau einen; der Verlierer bekommt „bereits abgeschlossen".

**Idempotenz.** Wiederholung mit derselben Nutzlast nach erfolgreichem Abschluss: Antwort ist der bestehende Abschluss (Zustand, nicht Fehler). Ein Wiederholungsschlüssel ist nicht nötig, weil der Zustandsübergang die Idempotenz trägt.

## 12. Speicher und Datenbank sind nicht atomar

Es gibt keine gemeinsame Transaktion über PostgreSQL und Objektspeicher. Der Entwurf lügt nicht darüber:

| Fall | Verhalten |
|---|---|
| PDF erzeugt, Ablage scheitert (Schritt 11) | Transaktion nicht begonnen; Abschluss scheitert mit 502 „Speicher"; Zustand unverändert; Wiederholung erlaubt |
| Ablage gelungen, DB-Commit scheitert (Schritte 13–15) | Artefakt liegt verwaist im Speicher, `FileAsset` nicht angelegt (steht in der Transaktion); Wiederholung erzeugt ein *neues* Artefakt; Aufräumen: nächtlicher Lauf löscht `StoredFile` mit `checksum` gesetzt, `profile = null`, ohne `FileAsset`, älter als 24 h und Pfad unter `signatures/` |
| DB reserviert (Sitzung, Status), Speicher scheitert | Kein Statusübergang vor Schritt 11; nichts zu reservieren |
| Protokoll-PDF scheitert (Schritt 16) | Anfrage bleibt COMPLETED mit `evidenceArtifactId = null`; Nachtlauf holt es nach (idempotent — gleiche Eingaben, gleiches Protokoll); UI zeigt „Protokoll wird erstellt" |

Der Zustand in der Datenbank ist immer eindeutig; Artefakte sind aus den gespeicherten Daten deterministisch nachvollziehbar (Protokoll) oder unveränderlich (signiert). Ein Abschluss ist erst dann einer, wenn der Commit durch ist.

## 13. Unveränderlichkeit

Nach `SIGNED` (Teilnehmer) bzw. `COMPLETED` (Anfrage) werden folgende Felder von keinem Dienst mehr geschrieben: Original-Asset/Hash, Bild-Asset/Hash, Zustimmungsfelder, signiertes Asset/Hash, Protokoll-Asset/Hash, `signedAt`, Methode, Name, alle `SignatureEvent`-Zeilen. Durchgesetzt in `signature.service.ts` (kein `update` auf diese Felder nach Abschluss; Prisma-Erweiterung, die schreibende Aufrufe auf abgeschlossene Zeilen ablehnt) und im Test. Korrektur = neuer Vorgang. *Gate 4B hat sich anders entschieden als hier vorgeschlagen (§ 0.2): Für `signature_events` erzwingt die Datenbank das Anhängen per Trigger; für die übrigen Felder gilt weiterhin die Regel im Dienst.*

## 14. Löschen, Aufbewahrung, Datensparsamkeit

Befund, keine Fristfestlegung:

- `FileAsset` hängt heute per **`Cascade`** an Quote, Job, Customer, Booking, Invoice. Signaturartefakte dürfen deshalb **keine** dieser Fremdschlüssel tragen — nur `signatureRequestId`.
- `SignatureRequest → Quote/Job/DocumentVersion` sollte **`Restrict`** sein: Ein Vorgang mit Beweis hält sein Geschäftsobjekt fest. Folge: `purge.service` (harte Bereinigung) muss Signaturen als eigenen Bereich *vor* Aufträgen und Führung bereinigen, sonst scheitert die Bereinigung an der Einschränkung — **Entscheidung nötig** (§ 19).
- Papierkorb (weiches Löschen) berührt Signaturen nicht; die Anfrage bleibt lesbar, das Geschäftsobjekt gilt als gelöscht — Anzeige „Grundlage im Papierkorb".
- `Customer` löschen: `Quote.customer` ist `SetNull` (Anfrage überlebt), `Booking.customer` `Cascade` (Job → ? kaskadiert nicht direkt). Teilnehmer tragen Snapshots (`nameSnapshot`, `emailSnapshot`), keinen Zwang zu einem Kundendatensatz; optionaler `customerId` mit `SetNull`.
- Anonymisierung: Ein Anonymisierungslauf müsste `nameSnapshot`/`emailSnapshot`/`phoneSnapshot` schwärzen — das *verändert Beweisdaten*. Konflikt: Beweiskraft gegen Löschanspruch. **Keine** Aufbewahrungsfrist wird hier erfunden; der Konflikt wird gemeldet (§ 19).
- Datensparsamkeit: siehe § 7 — gespeichert wird nur, was Prozessnachweis, Sicherheit, Fehleranalyse und Audit brauchen.

## 15. Altfelder

| Feld | Klassifikation | Begründung |
|---|---|---|
| `Quote.signatureDataUrl`, `signatureName`, `signatureIp`, `signedAt` | **legacy-read-only** | Bestehende Annahmen bleiben lesbar und im PDF sichtbar; neue Annahmen laufen nach Entscheidung § 19 entweder weiter über den bestehenden Weg (mit neuem Wortlaut) oder über eine Signaturanfrage. Löschen später. |
| `Job.signatureDataUrl`, `signatureName`, `signedAt` | **weiterverwenden**, umbenennen im Wortlaut | Präsenz-Abnahme auf dem Gerät der Reinigungskraft ist ein anderer Fall (kein Link, kein Code); im Produkt „Abnahmebestätigung", nicht „Signatur". Später optional auf Bild-Asset statt Data-URL migrieren. |
| `PublicTokenPurpose.SIGNATURE_OTP` | **legacy-unbenutzt** | Enum-Wert bleibt, kein Code verwendet ihn. |
| `signature-pad.tsx` Wortlaut „ZertES" | **ändern (4B)** | Rechtliche Einordnung gehört nicht in einen Komponentenkommentar. |
| `documents.tsx` „digital signiert am" | **ändern (4B)** | → „elektronisch unterzeichnet am". |

Keine Migration löscht oder ändert diese Spalten.

## 16. Berechtigungen

Neu im Katalog (Code): `signature:create` (Anfrage anlegen/senden), `signature:read` (Anfragen und Protokolle sehen), `signature:cancel`. Zuordnung: `SUPER_ADMIN`, `ADMIN` alle drei; `MANAGER` `signature:create`/`read` — Anlegen setzt zusätzlich das Leserecht am Ursprung voraus (`quote:read`, `job:read`, `document:read` mit `documentVisibilityWhere`). `document:read` allein berechtigt **nicht** zum Versenden. `EMPLOYEE`/`CUSTOMER` nichts; Kundschaft sieht abgeschlossene Vorgänge zu eigenen Offerten über die Eigentümerprüfung (`signature:read_own`, später).

## 17. Masken (Plan, nicht gebaut)

**Verwaltung:** Dokument/Offerte → „Zur Unterschrift senden" → Teilnehmer (Name, E-Mail, optional Mobil) → Stufe → Ablauf (Vorgabe 14 Tage) → Position (Klick in Gate-3-Viewer, in Punkte umgerechnet, serverseitig validiert) → Vorschau → senden. Status: ausstehend, angesehen, bestätigt, unterschrieben, abgelehnt, abgelaufen, abgebrochen. Abbrechen nur bei offenen; abgeschlossene nie.

**Unterzeichnende:** `/signieren/{raw}` → Tausch → `/signieren/s/{publicId}` → Gate-3-Viewer mit Quelle `GET /api/public/signatures/{publicId}/document` (Sitzung, liefert das **Original**) → Code (falls Stufe) → Zustimmung (Text aus Version) → Name → zeichnen **oder tippen** (Tastatur, Touch, Pointer, Löschen) → Zusammenfassung → „Verbindlich elektronisch unterzeichnen" → `POST …/finalize` → Bestätigung → signiertes PDF/Protokoll je Berechtigung. Nichts wird beim Zeichnen gespeichert; der Abschluss ist die einzige schreibende Handlung. Ablehnen mit optionalem Grund, terminal, kein Bild.

**Nachrichten (Vorlagen, nicht gesendet):** Einladung, Erinnerung (vor Ablauf), Code, Abschluss (mit Zugang zum signierten PDF über einen neuen `SIGNATURE_ACCESS`-Link mit Leserecht — *oder* nur Anhang, § 19), Ablehnung intern. Kein Geheimnis in `EmailLog`/`SmsLog`.

## 18. Schema-Vorschlag

Nur additiv. Vier Modelle, drei Enums, eine Spalte und ein Enum-Wert an bestehenden Modellen. Keine Sitzungstabelle (zustandslos, § 4).

```prisma
enum SignatureProviderType {
  INTERNAL_EVIDENCE
  QUALIFIED_EXTERNAL
}

enum SignatureAssuranceLevel {
  LINK_ONLY
  LINK_PLUS_EMAIL_CODE
  LINK_PLUS_SMS_CODE
}

enum SignatureRequestStatus {
  DRAFT
  PENDING
  COMPLETED
  DECLINED
  EXPIRED
  CANCELLED
}

enum SignatureParticipantRole {
  SIGNER
  CC
}

enum SignatureParticipantStatus {
  PENDING
  VIEWED
  VERIFIED
  SIGNED
  DECLINED
}

enum SignatureMethod {
  DRAWN
  TYPED
}

enum SignatureEventType {
  REQUEST_CREATED
  LINK_ISSUED
  LINK_EXCHANGED
  DOCUMENT_VIEWED
  OTP_REQUESTED
  OTP_VERIFIED
  OTP_FAILED
  CONSENT_ACCEPTED
  SIGNATURE_SUBMITTED
  INTEGRITY_MISMATCH
  SIGNED
  DECLINED
  EXPIRED
  CANCELLED
  ARTIFACT_CREATED
  REQUEST_COMPLETED
}

enum SignatureOtpChannel {
  EMAIL
  SMS
}

/// Ein Unterzeichnungsvorgang — gebunden an exakte Bytes, nie an ein
/// veränderliches Geschäftsobjekt.
model SignatureRequest {
  id             String @id @default(cuid())
  organizationId String
  /// Nicht geheime Adresse für den Ablauf ohne rohen Token (16 Zufallsbytes hex).
  publicId       String @unique

  status         SignatureRequestStatus  @default(DRAFT)
  providerType   SignatureProviderType   @default(INTERNAL_EVIDENCE)
  assuranceLevel SignatureAssuranceLevel
  title          String
  /// Vorgangskennung eines späteren externen Anbieters. Bei INTERNAL null.
  providerReference String?

  /// Ursprung — genau einer gesetzt. Restrict: Ein Vorgang mit Beweis hält
  /// sein Geschäftsobjekt fest (Bereinigung: eigener Bereich, § 14).
  quoteId           String?
  jobId             String?
  documentVersionId String?

  /// Immutable ab PENDING.
  originalArtifactId   String @unique
  originalDocumentHash String // Hash A
  signedArtifactId     String? @unique
  signedArtifactHash   String? // Hash B
  evidenceArtifactId   String? @unique
  evidenceArtifactHash String? // Hash C

  consentVersion String

  /// Sichtbare Unterschrift, PDF-Punkte; null = nur Signaturblatt.
  placementPage   Int?
  placementX      Decimal? @db.Decimal(8, 2)
  placementY      Decimal? @db.Decimal(8, 2)
  placementWidth  Decimal? @db.Decimal(8, 2)
  placementHeight Decimal? @db.Decimal(8, 2)

  createdById   String
  createdAt     DateTime  @default(now()) @db.Timestamptz(6)
  sentAt        DateTime? @db.Timestamptz(6)
  expiresAt     DateTime  @db.Timestamptz(6)
  completedAt   DateTime? @db.Timestamptz(6)
  declinedAt    DateTime? @db.Timestamptz(6)
  expiredAt     DateTime? @db.Timestamptz(6)
  cancelledAt   DateTime? @db.Timestamptz(6)
  cancelledById String?
  /// Fachliche Entwertung nach Abschluss — Beweis bleibt, Bedeutung nicht.
  supersededById String?

  organization     Organization     @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  quote            Quote?           @relation(fields: [quoteId], references: [id], onDelete: Restrict)
  job              Job?             @relation(fields: [jobId], references: [id], onDelete: Restrict)
  documentVersion  DocumentVersion? @relation(fields: [documentVersionId], references: [id], onDelete: Restrict)
  originalArtifact FileAsset        @relation("SignatureOriginal", fields: [originalArtifactId], references: [id], onDelete: Restrict)
  signedArtifact   FileAsset?       @relation("SignatureSigned", fields: [signedArtifactId], references: [id], onDelete: Restrict)
  evidenceArtifact FileAsset?       @relation("SignatureEvidence", fields: [evidenceArtifactId], references: [id], onDelete: Restrict)
  createdBy        User             @relation("SignatureRequestsCreated", fields: [createdById], references: [id], onDelete: Restrict)
  participants     SignatureParticipant[]
  events           SignatureEvent[]
  artifacts        FileAsset[]      @relation("SignatureArtifacts")

  @@index([organizationId, status])
  @@index([organizationId, createdAt])
  @@index([expiresAt])
  @@index([quoteId])
  @@index([jobId])
  @@index([documentVersionId])
  @@map("signature_requests")
}

/// Wer unterzeichnet — mit eingefrorenen Kontaktdaten, damit ein späterer
/// Kundenwechsel den Beweis nicht verändert.
model SignatureParticipant {
  id        String @id @default(cuid())
  requestId String
  order     Int    @default(1)
  role      SignatureParticipantRole   @default(SIGNER)
  status    SignatureParticipantStatus @default(PENDING)

  nameSnapshot  String
  emailSnapshot String
  phoneSnapshot String?
  /// Optionaler Bezug; SetNull — der Snapshot bleibt.
  customerId String?

  viewedAt   DateTime? @db.Timestamptz(6)
  verifiedAt DateTime? @db.Timestamptz(6)
  signedAt   DateTime? @db.Timestamptz(6)
  declinedAt DateTime? @db.Timestamptz(6)
  declineReason String?

  /// Immutable ab SIGNED.
  authenticationMethod  SignatureAssuranceLevel?
  signatureMethod       SignatureMethod?
  signedName            String?
  signatureImageAssetId String? @unique
  signatureImageHash    String?
  consentTextSnapshot   String?
  consentTextHash       String?
  consentVersion        String?
  consentAcceptedAt     DateTime? @db.Timestamptz(6)
  ipAddress             String?
  ipSource              String?
  userAgent             String?

  request        SignatureRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  customer       Customer?        @relation(fields: [customerId], references: [id], onDelete: SetNull)
  signatureImage FileAsset?       @relation("SignatureImage", fields: [signatureImageAssetId], references: [id], onDelete: Restrict)
  events         SignatureEvent[]
  otpChallenges  SignatureOtpChallenge[]

  @@unique([requestId, order])
  @@index([requestId, status])
  @@map("signature_participants")
}

/// Fachliches Signaturprotokoll — nur anhängen. Kein Dienst ändert oder
/// löscht Zeilen; AuditLog bleibt das allgemeine Systemaudit.
model SignatureEvent {
  id            String @id @default(cuid())
  requestId     String
  participantId String?
  type          SignatureEventType
  at            DateTime @default(now()) @db.Timestamptz(6)
  ipAddress     String?
  ipSource      String?
  userAgent     String?
  /// SHA-256 der Sitzungskennung (jti) — Zuordnung ohne Geheimnis.
  sessionRef    String?
  /// Sachliche Details ohne Geheimnisse (z. B. Hash A, Kanal, Fehlgrund).
  details       Json?

  request     SignatureRequest      @relation(fields: [requestId], references: [id], onDelete: Cascade)
  participant SignatureParticipant? @relation(fields: [participantId], references: [id], onDelete: Cascade)

  @@index([requestId, at])
  @@map("signature_events")
}

/// Ein zugestellter Bestätigungscode. Argon2id-Hash, nicht SHA-256: sechs
/// Ziffern sind eine Million Möglichkeiten.
model SignatureOtpChallenge {
  id            String @id @default(cuid())
  participantId String
  channel       SignatureOtpChannel
  sentTo        String
  codeHash      String
  attempts      Int      @default(0)
  maxAttempts   Int      @default(5)
  expiresAt     DateTime @db.Timestamptz(6)
  usedAt        DateTime? @db.Timestamptz(6)
  invalidatedAt DateTime? @db.Timestamptz(6)
  resendAfter   DateTime @db.Timestamptz(6)
  createdAt     DateTime @default(now()) @db.Timestamptz(6)

  participant SignatureParticipant @relation(fields: [participantId], references: [id], onDelete: Cascade)

  @@index([participantId, createdAt])
  @@index([expiresAt])
  @@map("signature_otp_challenges")
}
```

An bestehenden Modellen:

```prisma
enum FileScope { … SIGNATURE }           // neuer Wert

model FileAsset {
  …
  /// Signaturartefakte hängen nur hier — nie per Cascade an Quote/Job/Customer.
  signatureRequestId String?
  signatureRequest   SignatureRequest? @relation("SignatureArtifacts", fields: [signatureRequestId], references: [id], onDelete: Restrict)
  originalOf         SignatureRequest? @relation("SignatureOriginal")
  signedOf           SignatureRequest? @relation("SignatureSigned")
  evidenceOf         SignatureRequest? @relation("SignatureEvidence")
  signatureImageOf   SignatureParticipant? @relation("SignatureImage")
  @@index([signatureRequestId])
}

model Quote          { … signatureRequests SignatureRequest[] }
model Job            { … signatureRequests SignatureRequest[] }
model DocumentVersion{ … signatureRequests SignatureRequest[] }
model Customer       { … signatureParticipations SignatureParticipant[] }
model User           { … signatureRequestsCreated SignatureRequest[] @relation("SignatureRequestsCreated") }
```

Tenant-Grenze: `organizationId` an `SignatureRequest`; Teilnehmer, Ereignisse und Codes erreichen die Organisation über die Anfrage — jede Abfrage geht über `request: { organizationId }`. Neue Modelle in `DOMAINS` von `scripts/generate-erd.ts` (Bereich „Signaturen").

Warum vier Modelle und nicht weniger: Anfrage und Teilnehmer trennen, sonst erzwingt der zweite Unterzeichner eine Migration; Ereignisse trennen, weil `AuditLog` redigiert und nach Nutzer indexiert ist — das fachliche Protokoll braucht Reihenfolge je Anfrage und darf keine Geschäftsobjektänderungen enthalten; Codes trennen, weil `PublicAccessToken`-Semantik (SHA-256, `maxUses`) für Codes falsch ist. Keine Sitzungstabelle.

## 19. Migration (Empfehlung für 4B — **nicht anwenden**)

`prisma migrate diff` würde erzeugen, in dieser Reihenfolge; alles additiv:

```sql
-- CreateEnum ×8: SignatureProviderType, SignatureAssuranceLevel, SignatureRequestStatus,
--                SignatureParticipantRole, SignatureParticipantStatus, SignatureMethod,
--                SignatureEventType, SignatureOtpChannel
-- AlterEnum:     ALTER TYPE "FileScope" ADD VALUE 'SIGNATURE';
-- AlterTable:    ALTER TABLE "file_assets" ADD COLUMN "signatureRequestId" TEXT;
-- CreateTable ×4: signature_requests, signature_participants, signature_events, signature_otp_challenges
-- CreateIndex:   wie im Schema; UNIQUE auf publicId, originalArtifactId, signedArtifactId,
--                evidenceArtifactId, (requestId, order), signatureImageAssetId
-- AddForeignKey: Restrict für quote/job/documentVersion/Artefakte/createdBy,
--                Cascade für request→participant/event, participant→otp,
--                SetNull für participant.customer
```

Keine bestehende Spalte geändert oder gelöscht, keine Zeile umgeschrieben, kein Backfill. `ADD VALUE` auf `FileScope` ist in PostgreSQL 16 innerhalb der Migrationstransaktion zulässig, solange der Wert nicht in derselben Transaktion verwendet wird — wird er nicht. Vor Anwendung: SQL prüfen, Entwicklungs- und Testdatenbank, keine Produktion.

Nicht im Schema, aber Teil von 4B: `PURPOSE_RESOURCE.SIGNATURE_ACCESS = 'SignatureParticipant'`; Upload-Profil `signatureImage`; Rate-Limit `signatureExchange`; Berechtigungen `signature:*`; Bereinigungsbereich „Signaturen"; Nachtlauf (Ablauf → `EXPIRED`, Protokoll nachholen, verwaiste Artefakte); `TRUSTED_PROXY`; Abhängigkeit `pdf-lib`.

## 20. Testplan Gate 4B

Alle über HTTP gegen `clenaris_test`, Reine-Rechnung-Teile direkt importiert (Hashkette, Positionsvalidierung, Code-Hashing).

**Token & Zugang:** 32 Bytes CSPRNG, kein gemeinsamer Präfix (bestehend); nur Hash in `public_access_tokens` (DB-Lesehelfer); Ablauf → 404; Widerruf beim Abbrechen → 404; Tausch setzt Cookie und antwortet 303 auf Adresse ohne Token; die Zieladresse enthält keine 64-Hex-Folge; zweiter Tausch desselben Tokens vor Abschluss erlaubt (Wiederaufruf), nach Abschluss → Anzeige „abgeschlossen"; Adresse ohne Sitzung → 404; Sitzung nach 60 min → 401 mit Hinweis „Link erneut öffnen"; Sitzung eines anderen Teilnehmers → 404; falsche Organisation → 404.

**CSRF:** `POST …/finalize` mit fremdem `Origin` → 403; ohne Sitzungscookie → 401.

**Code:** Anfordern setzt Challenge mit Argon2-Hash (kein Klartext, kein SHA-256-Muster); Ablauf nach 10 min → 422; sechster Versuch → 422 und Challenge ungültig; erneut senden vor 60 s → 429; neuer Code invalidiert alten (alter → 422); Wiederverwendung eines benutzten Codes → 422; `otpRequest`/`otpVerify` greifen je Teilnehmer; Kanal SMS nur bei `phoneSnapshot`.

**Zustimmung:** Abschluss ohne `consentAccepted` → 422; Snapshot = Wortlaut der Version, Hash = SHA-256 davon; Version stimmt mit Anfrage überein.

**Fassung:** Anfrage auf `DocumentVersion` N; neue Fassung N+1 anlegen; Viewer-Quelle liefert weiter N (Hash A); Abschluss bindet N.

**Integrität:** Originalbytes im Speicher verändern (DB-Helfer, nur Testdatenbank) → Abschluss 422, Ereignis `INTEGRITY_MISMATCH`, kein Artefakt; B ≠ A; C ≠ B; Protokoll-PDF enthält A und B als Text, nicht C; `verifyFileIntegrity` auf allen drei Artefakten `ok`.

**Rennen:** vier gleichzeitige `finalize` → genau ein `SIGNED`, drei „bereits abgeschlossen"; genau ein signiertes Artefakt; Wiederholung mit gleicher Nutzlast → 200 mit bestehendem Zustand.

**Ablehnen/Abbrechen/Ablauf:** Ablehnen terminal, kein Bild, Ereignis; Abbrechen widerruft Token (Tausch → 404), invalidiert Sitzung (nächste Aktion → 404), Codes ungültig, Status `CANCELLED`; Abbrechen einer abgeschlossenen → 422; Nachtlauf setzt `EXPIRED` und schreibt Ereignis.

**Unveränderlichkeit:** `PATCH` auf abgeschlossene Anfrage → 422; Ereignisse lassen sich nicht ändern/löschen (kein Endpunkt; Dienstfunktion wirft).

**Speicherfehler:** Ablage-Doppelgänger schlägt fehl → 502, Zustand unverändert, Wiederholung gelingt; Protokoll-Erzeugung schlägt fehl → `COMPLETED` ohne Protokoll, Nachtlauf holt nach, Ergebnis idempotent (gleicher Hash C bei gleichen Eingaben).

**Vorhandene Signatur:** hochgeladenes PDF mit AcroForm-`/Sig`-Feld (Fixture programmatisch mit pdf-lib erzeugt) → Anfrage anlegen 422 „enthält bereits eine Signatur"; Protokoll nennt die Prüfung.

**Position:** ausserhalb der Seite, negativ, übergross → 422; gültig → Stempel auf richtiger Seite (Seitenzahl aus pdf-lib).

**Berechtigungen:** `document:read` ohne `signature:create` → 403; Kundschaft/Personal → 403; fremde Organisation → 404.

**Wortlaut:** öffentliche Seiten und PDFs enthalten weder „QES", „qualifiziert", „ZertES" noch „amtlich".

## 21. Offene Entscheidungen

Nur, wo eine Produkt- oder Architekturentscheidung nötig ist:

1. **`pdf-lib` als Abhängigkeit** für Overlay, Zusammenführen und Erkennen vorhandener Signaturfelder. Ohne sie: signiertes Artefakt = Original **plus getrenntes Signaturblatt-PDF** (kein Overlay, keine Erkennung) — schwächer, aber ohne neue Abhängigkeit.
2. **Offertannahme:** weiter über die bestehende Antwortmaske (Altweg, mit korrigiertem Wortlaut und neuem Snapshot-Mechanismus) — oder jede Annahme wird eine `SignatureRequest` (`LINK_PLUS_EMAIL_CODE` Vorgabe)? Zweiteres ist sauberer, ändert aber den Kundenfluss (zusätzlicher Code-Schritt).
3. **Bereinigung:** `Restrict` von Anfragen zu Quote/Job/Fassung — mit eigenem Bereich „Signaturen" in `purge.service`, der Vorgänge samt Artefakten hart löscht? Oder `SetNull` (Beweis überlebt Bereinigung, verliert den Bezug)?
4. **Anonymisierung vs. Beweis:** Sollen Teilnehmer-Snapshots bei einem Löschbegehren geschwärzt werden dürfen (Beweis wird unvollständig) — oder bleibt der Vorgang bis zu einer noch festzulegenden Frist unangetastet? Keine Frist wird hier vorgeschlagen.
5. **Zugang zum signierten Dokument nach Abschluss** für die unterzeichnende Person: neuer `SIGNATURE_ACCESS`-Leselink in der Abschluss-E-Mail (90 Tage) — oder nur PDF-Anhang?
6. **`TRUSTED_PROXY`:** Welche Kette gilt in Produktion (Cloudflare → Nginx → Node)? Davon hängt ab, welchem Kopf die IP-Ermittlung glauben darf — auch für das bestehende `AuditLog`.

## 22. Offener Verifikationspunkt aus Gate 3

Kein Browser-/E2E-Prüfstand im Repository. Nicht im echten Browser beobachtet: Worker-Laden unter der CSP, Rendern, Text-Layer, Skripte in PDFs. Bleibt `PRE-PRODUCTION VERIFICATION REQUIRED`; Gate 4A wurde dafür nicht erweitert.
