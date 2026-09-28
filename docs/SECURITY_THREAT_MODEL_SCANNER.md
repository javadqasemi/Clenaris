# Bedrohungsmodell der Scanplattform

Stand 2026-09-26, durchgesehen 2026-09-28 (neue Aktionen, Verweise, Art
Vertrag — Zeilen 23–25). Gilt für `src/lib/scan/kennung.ts`, `src/lib/scan/regeln.ts`,
`src/server/services/scan.service.ts`, `POST /api/scan/resolve`,
`POST /api/scan/codes`, `DELETE /api/scan/codes/:id`, die Etikettseite und
`src/components/app/scan-button.tsx`. Aufbau: `docs/SCANNER.md`.

**Annahme:** Jeder gescannte Inhalt ist fremd und möglicherweise feindlich —
auch ein Code auf einem eigenen Gerät, denn ein Aufkleber lässt sich
überkleben. Angreifer sind (a) jemand ohne Konto mit Zugang zu Etiketten oder
Dokumenten, (b) ein angemeldeter Mensch mit weniger Rechten, als er möchte,
(c) jemand, der präparierte Codes in Umlauf bringt (Paket, Aushang,
Bildschirm).

Die Spalte **Prüfung** nennt den Fall, der die Massnahme belegt. Ein
**Restrisiko** ist das, was nach der Massnahme bleibt — ehrlich, nicht null.

| # | Bedrohung | Massnahme | Prüfung | Restrisiko |
|---|---|---|---|---|
| 1 | QR-Code mit Phishing- oder Schadadresse (`https://…`, `javascript:`, `data:`) | Jede `schema:`- und `www.`-Form wird als ADRESSE eingeordnet, nie aufgelöst, nie als Link, `src` oder Weiterleitung zurückgegeben; Hinweis an die Person | `scan-kennung.test.ts` „jede Adresse ist eine Adresse"; `scan.test.ts` „Adressen … nie als Link"; `scan.spec.ts` feindliche Inhalte | Die Person kann die angezeigte (gekürzte) Adresse selbst abtippen. Das ist ihre Entscheidung ausserhalb der Anwendung |
| 2 | XSS über den gescannten Text | Anzeige nur als React-Text (maskiert), einzeilig, gekürzt; kein `dangerouslySetInnerHTML` im Scanner | `scan.spec.ts`: `<img onerror>` erscheint als Text, kein `img`-Element, kein Browserdialog | Eine künftige Änderung mit rohem HTML — die Musterprüfung (`html-roh`) meldet sie |
| 3 | Injection über den Text (SQL, Prisma-Operatoren) | Prisma mit Parametern, exakter Vergleich (`equals`), der Text ist nie ein Objekt (Zod: `z.string()`) | `scan.test.ts`: `' OR 1=1 --`, `{{7*7}}`, `../../etc/passwd` → 200 ohne Treffer; `{ text: 42 }` → 422 | — |
| 4 | Durchzählen fortlaufender Nummern (Rechnungen, Kundschaft, Einsätze) | Nur im Leserecht der Rolle; Kontingent `scanResolve` 60/min **je Person** | `scan.test.ts` Kontingent (61. Anfrage 429, andere Person unberührt) | Wer lesen darf, kann in seinem Leserecht zählen — das kann er auch in der Liste |
| 5 | Erraten eines Etikettcodes | 20 Zeichen Crockford-Base32 aus `crypto.randomInt` = 100 Bit; Kontingent | Format in `scan.test.ts` | vernachlässigbar |
| 6 | Auflösen über Mandantengrenzen | `organizationId` in jeder Abfrage; Code global eindeutig, gesucht mit Organisation | `scan.test.ts` „Code einer fremden Organisation", „fremder Strichcode" | — |
| 7 | Mehr sehen als erlaubt (Rolle, Eigentum) | Leserecht und Sichtbarkeit **in der Abfrage** (`job:read_assigned` über Zuteilung, `propertyVisibilityWhere`); Kundschaft hat keinen Scanner (403); ohne Recht dieselbe Antwort wie unbekannt | `scan.test.ts` Mitarbeitende/Material, Rechnung, fremder Einsatz, Kundschaft 403, 401 ohne Anmeldung | Zeitunterschied: Bei einem existierenden Code ohne Leserecht entfällt die zweite Abfrage. Messbar allenfalls im Millisekundenbereich und nur mit gültigem, zu erratendem Code (siehe 5) |
| 8 | Verlorenes oder fotografiertes Etikett | Sperren (endgültig, Nachweis bleibt), neuer Code beim Neudruck; gesperrter Code ohne Schnellaktionen, Hinweis nur mit Leserecht | `scan.test.ts` „gesperrt" | Bis zum Sperren löst das Etikett auf — für jemanden mit Anmeldung und Leserecht |
| 9 | Vertauschtes oder überklebtes Etikett (Aktion am falschen Gerät) | Keine Aktion ohne Klick; der Treffer zeigt Bezeichnung, Inventarnummer, Status zur Kontrolle; jede Buchung protokolliert und per Gegenbuchung berichtigbar | `scan.spec.ts`: nach dem Scan nichts gebucht, Seite unverändert | Ein Mensch, der nicht hinsieht. Das Protokoll macht es nachvollziehbar, verhindert es nicht |
| 10 | Automatische Ausführung nach dem Scan | Der Scanner öffnet, navigiert und ändert nichts von sich aus; Schnellaktionen sind Masken für bestehende Endpunkte, die Recht, Schema, Zustand und Sperren **erneut** prüfen | `scan.test.ts` „der Endpunkt prüft erneut" (Mitarbeitende 403 trotz bekannter ID); `scan.spec.ts` | — |
| 11 | CSRF auf Auflösen, Erzeugen, Sperren | Routenfactory mit `assertTrustedOrigin`; POST/DELETE; kein schreibender GET (die Etikettseite erzeugt nichts beim Aufrufen) | `scan.test.ts` „fremde Herkunft" (403 für Erzeugen, Sperren, Auflösen); Rauchtest der Etikettseite | — |
| 12 | Kamera: Bilder verlassen das Gerät, Kamera läuft weiter | Erkennung im Browser, gesendet wird nur der Text; Strom endet beim Treffer und beim Schliessen; keine Kamera beim Rendern des Rahmens | `scan.spec.ts`: `srcObject` nach dem Treffer `null` | Die Kameraerlaubnis bleibt im Browser für die Herkunft gespeichert (Browsersache) |
| 13 | Präpariertes Bild für den Decoder | Dekodiert der Browser (`BarcodeDetector`); keine eigene Decoderbibliothek, kein Upload | — (keine eigene Angriffsfläche) | Lücken im Decoder des Browsers — extern, Browserupdates |
| 14 | Überlast durch riesige oder viele Eingaben | Zod-Grenze 1000 Zeichen (422 vor jedem Dienst), Kontingent, höchstens 5 Treffer je Art | `scan.test.ts` Überlänge 422, Kontingent | — |
| 15 | Täuschung mit Unicode (Rechts-nach-links, unsichtbare Zeichen, Steuerzeichen) | Steuer-, Bidi- und Null-Breite-Zeichen → UNGUELTIG | `scan-kennung.test.ts` Steuer- und Richtungszeichen | Verwechselbare Buchstaben anderer Schriften (Homoglyphen) in freiem Text — führen höchstens zu „nichts gefunden" |
| 16 | Zwei Artikel mit demselben Strichcode | eindeutiger Index `(organizationId, barcode)`; 409 mit Hinweis; Prüfziffer Pflicht | `scan.test.ts` doppelt 409, falsche Prüfziffer 422 | — |
| 17 | Zwei gültige Codes für denselben Datensatz (Rennen) | Teilindex `scan_codes_ein_aktiver_je_datensatz`; der Verlierer liest den Gewinner | `scan.test.ts` gleichzeitig → genau ein aktiver Code; `security:check` prüft den Index | — |
| 18 | Code im Prüfprotokoll (Nachdruck aus dem Protokoll) | Zusammenfassung ohne Code | `scan.test.ts` „ohne den Code selbst" | — |
| 19 | Etikettcode als Zugang ohne Anmeldung missverstanden | Kein öffentlicher Weg; Auflösen verlangt Sitzung und `dashboard:view`; öffentliche Abläufe bleiben bei `PublicAccessToken` | `scan.test.ts` 401; `security/oeffentliche-endpunkte.json` enthält keinen Scanweg | — |
| 20 | QR-Rechnung mit fremder IBAN oder manipuliertem Betrag | Nur zum Finden der **eigenen** Rechnung über QR-Referenz (mit Prüfziffer) oder Nummer; es wird nie eine Zahlung ausgelöst oder ein Betrag übernommen — „Zahlung erfassen" verlangt die Eingabe des Betrags | `scan-kennung.test.ts`, `scan.test.ts` QR-Rechnung | Eine Person erfasst einen falschen Betrag — wie bei jeder manuellen Zahlung; korrigierbar per Storno |
| 21 | Suche als zweiter Weg zu Daten | Etikettcodes in der Suche gehen durch denselben Auflöser mit denselben Prüfungen | `scan.test.ts` „Suche findet den Artikel über den Etikettcode" | — |
| 22 | Lieferkette einer Scanbibliothek | Keine neue Abhängigkeit; `qrcode` war bereits vorhanden (QR-Rechnung) | `security:check` (npm audit, Lockfile) | Browser-API-Verfügbarkeit ändert sich — die Komponente fragt sie zur Laufzeit ab |
| 23 | Verweis (PDF, Rapport) als zweiter Zugang oder als Sprung auf eine fremde Seite (seit 2026-09-28) | Verweise bildet nur `src/lib/scan/regeln.ts` aus der geladenen Datensatz-ID (kodiert), nie aus dem gescannten Text; nur für Rollen mit Leserecht; die Ziele sind bestehende GET-Endpunkte, die das Recht beim Abruf selbst prüfen; der Browser rendert nur eigene Pfade (`verweisSicher`) | `scan-regeln.test.ts` (Pfade, Rollen), `scan.test.ts` (PDF und Bericht für Mitarbeitende 403) | — |
| 24 | Personenliste über „Zuteilen" an Rollen, die sie nicht sehen sollen (seit 2026-09-28) | Die Liste (Name, Personalnummer — nichts Sensibles) wird nur geladen und mitgeschickt, wenn ein Treffer „Zuteilen" anbietet, also nur mit `equipment:manage`; dieselbe Liste zeigt die Geräteliste dieser Rolle | `scan-regeln.test.ts` (kein Zuteilen ohne Recht), `scan.test.ts` (Mitarbeitende: leer) | — |
| 25 | Vertrags- oder Rechnungsnummer als Existenzorakel (seit 2026-09-28: Vertrag, beide QR-Referenzformen) | Sicht in der Abfrage (`contract:read`/`invoice:read`, nur Büro, Organisation); ohne Recht dieselbe Antwort wie eine unbekannte Nummer | `scan.test.ts` „Vertrag über die Nummer", „alte und neue QR-Referenz" | wie 4 |
## Nicht abgedeckt

* **Physische Sicherheit der Etiketten** (Aufkleber entfernen, austauschen)
  ist kein Softwareproblem; Nummer 9 beschreibt, was die Software dazu tut.
* **Strichcode-Etiketten (Code 128)** werden nicht erzeugt; wer fremde
  Code-128-Etiketten scannt, bekommt nur exakte Nummerntreffer.
* **GS1-Elementstrings** werden nicht zerlegt (siehe `docs/SCANNER.md`).

## Wann dieses Modell neu durchgesehen wird

Bei jeder neuen Schnellaktion, jeder neuen Art (`ScanEntity`), jedem
öffentlichen Scanweg, einer eigenen Decoderbibliothek oder einem Weg, auf dem
ein Scan etwas ohne Klick auslöst — Letzteres widerspricht dem Modell
grundsätzlich und braucht eine eigene Begründung.
