# Scanplattform (QR und Strichcode)

Stand 2026-09-26. Ein Scanner für die ganze Anwendung: Knopf in der Kopfzeile
von Administration und Portal, Kamera, Bild oder Eingabe (auch
Handscanner), aufgelöst auf dem Server im Leserecht der Rolle.

## Der Weg und wo jede Prüfung sitzt

```
SCAN → EINORDNEN → PRÜFEN → AUFLÖSEN → BERECHTIGEN → ZEIGEN → MENSCH WÄHLT → SERVER PRÜFT ERNEUT
```

| Schritt | Ort | Was geschieht |
|---|---|---|
| Scan | `src/components/app/scan-button.tsx` | `BarcodeDetector` im Browser, Bild aus der Galerie oder Eingabe. Kamerabilder verlassen das Gerät nie; gesendet wird nur der erkannte Text. |
| Einordnen, Prüfen | `src/lib/scan/kennung.ts` (rein) | Etikettcode, EAN/GTIN mit Prüfziffer, QR-Rechnung, QR-Referenz, Adresse, Text, ungültig. Steuer- und Richtungszeichen, über 1000 Zeichen, mehrzeilig ohne `SPC`: ungültig. |
| Auflösen, Berechtigen | `src/server/services/scan.service.ts` | Ein Schritt: jede Abfrage mit `organizationId` und der Sichtbarkeit der Rolle im `where`. Nicht geladen statt geladen und ausgeblendet. |
| Zeigen | `POST /api/scan/resolve` | Treffer, Merkmale, Link im Bereich der Rolle, *Schlüssel* der erlaubten Schnellaktionen. Nichts wird ausgeführt. |
| Wählen | Maske im Dialog | Ein Link wird erst mit einem Klick verfolgt, eine Aktion erst mit dem Knopf ihrer Maske gesendet. |
| Erneut prüfen | bestehende Endpunkte | `/api/materials/:id/movements`, `/api/equipment/:id/status`, `/maintenance` und `/assign`, `/api/time/clock-in` und `/clock-out`, `/api/invoices/:id/payments`, `/api/materials` — mit ihren eigenen Rechten, Schemas, Sperren und Protokolleinträgen. Verweise (PDF) gehen an `GET /api/invoices/:id/pdf` bzw. `/api/jobs/:id/report`, die das Leserecht selbst prüfen. Die Scanplattform hat keinen eigenen Schreibweg für Fachdaten. |

Unbekannt, fremde Organisation, gelöscht und ohne Leserecht ergeben dieselbe
leere Antwort — unterschiedliche Antworten verrieten, dass hinter einem Code
etwas steht. Einzige Ausnahme: ein gesperrtes eigenes Etikett meldet sich als
gesperrt, aber erst, wenn das Leserecht für den Datensatz feststeht.

## Kennungen

| Kennung | Wo | Eindeutig | Bemerkung |
|---|---|---|---|
| Etikettcode `CLX1:` + 20 Zeichen Crockford-Base32 (100 Bit Zufall) | `ScanCode` | global (`code`), ein aktiver je Datensatz (Teilindex `scan_codes_ein_aktiver_je_datensatz`) | Für Material, Gerät, Objekt, Einsatz. Sperrbar, Sperre endgültig, Eintrag bleibt. Enthält weder ID noch Nummer noch Namen. |
| Herstellerstrichcode | `Material.barcode` | je Organisation | Gespeichert als EAN-13/EAN-8/GTIN-14; UPC-A mit führender Null. Ohne gültige Prüfziffer abgewiesen (422), doppelt 409. |
| Artikelnummer | `Material.sku` | je Organisation | exakter Vergleich, keine Teilwörter |
| Inventar-/Seriennummer | `Equipment.inventoryNumber`, `.serialNumber` | Inventarnummer je Organisation | Seriennummer nicht eindeutig — mehrere Treffer werden gezeigt, keiner gewählt |
| Einsatz-, Rechnungs-, Kunden-, Vertragsnummer | `Job.number`, `Invoice.number`, `Customer.number`, `Contract.number` | je Organisation | exakter Vergleich; ein Vertragsentwurf hat noch keine Nummer |
| QR-Referenz | `Invoice.qrReference` | — | Index `(organizationId, qrReference)`; nur mit gültiger Prüfziffer. Zwei Formen im Umlauf: bis 2026-09-27 laufende Nummer mit führenden Nullen, seither Jahr + laufende Nummer (`buildQrReference`). Gesucht wird die gespeicherte Referenz, nicht ein Aufbau — beide lösen auf |

Öffentliche Abläufe (Offerte annehmen, Rechnung zahlen) verwenden weiterhin
`PublicAccessToken`; ein Etikettcode ist **kein** Zugang ohne Anmeldung.

## Unterstützte Formate — und was das heisst

„Unterstützt" heisst: `tests/api/scan-kennung.test.ts` beweist die Einordnung
mit festen Beispielen, `tests/api/scan.test.ts` die Auflösung über HTTP.

| Format | Einordnung | Auflösung |
|---|---|---|
| Eigener Etikettcode (QR) | ✓ | Material, Gerät, Objekt, Einsatz |
| EAN-13, EAN-8, UPC-A, GTIN-14 | ✓ mit Prüfziffer | Material über `barcode`; zusätzlich exakte Nummernsuche |
| Schweizer QR-Rechnung (SPC 0200) | ✓ QR-Referenz, Mitteilung „Rechnung …" | eigene Rechnung |
| Nackte QR-Referenz (27 Ziffern) | ✓ | eigene Rechnung |
| Freier Text | ✓ | exakte Nummern |
| Adressen (`https:`, `javascript:`, `data:`, `www.` …) | ✓ als Adresse | **nie** aufgelöst, **nie** als Link |

Nicht unterstützt: GS1-Elementstrings mit Anwendungskennzeichen (`(01)…(17)…`),
vCards, WLAN-Codes, Codes mit Steuerzeichen (GS1-Trenner `\x1d`).

Welche Formate die **Kamera** erkennt, entscheidet der Browser. Die Komponente
fragt `BarcodeDetector.getSupportedFormats()` und zeigt die Liste an; sie
verspricht keine. Verbreitet ist der Detektor in Chromium-Browsern auf
Android, macOS und ChromeOS; Chrome unter Windows und Firefox haben ihn nicht.
Dort bleiben Eingabe, Einfügen und Handscanner (ein Handscanner ist eine
Tastatur, die den Code tippt und Enter drückt).

Etiketten werden als QR-Code erzeugt (`qrcode`, bereits für die QR-Rechnung im
Einsatz). **Strichcode-Etiketten (Code 128) werden nicht erzeugt** — fehlende
Funktion, nicht zugesagt.

## Ersatzbibliothek für fehlende Kamera-Erkennung: bewusst keine

| Kandidat | Lizenz | Grösse (min.) | Pflege | Urteil |
|---|---|---|---|---|
| `@zxing/library` / `@zxing/browser` | Apache-2.0 | ≈ 400–500 kB | Wartungsmodus laut eigenem README | zu gross für einen Nebenweg |
| `jsQR` | Apache-2.0 | ≈ 130 kB | seit Jahren ohne Veröffentlichung | nur QR, ungepflegt |
| `html5-qrcode` | Apache-2.0 | ≈ 350 kB (bündelt ZXing) | als nicht mehr gepflegt markiert | ungepflegt |

Die Zahlen sind Grössenordnungen aus den Paketangaben, keine Messung in diesem
Bündel. Begründung: Der Weg ohne Detektor ist mit Eingabe und Handscanner
abgedeckt; eine halbe Megabyte grosse, kaum gepflegte Abhängigkeit, die
fremde Bilddaten im Browser dekodiert, wäre mehr Angriffsfläche als Nutzen.
Eine spätere Aufnahme verlangt den Eintrag in `docs/LIEFERKETTE.md` und einen
eigenen Chunk, der nur beim Öffnen der Kamera lädt.

## Schnellaktionen

| Treffer | Aktion | Recht | Endpunkt |
|---|---|---|---|
| Material | Wareneingang, Entnahme, Inventurkorrektur | `inventory:manage`, aktiver Artikel | `POST /api/materials/:id/movements` |
| Material (unbekannte EAN) | Neuen Artikel erfassen — vorbelegt **nur** Strichcode und Standardwerte | `inventory:manage` | `POST /api/materials` |
| Gerät | Wartung erfassen; Defekt melden bzw. wieder verfügbar | `equipment:manage`, nicht ausgemustert | `/api/equipment/:id/maintenance`, `/status` |
| Gerät | Zuteilen (Person aus der Antwort) bzw. Zurücknehmen — seit 2026-09-28 | `equipment:manage`; Zuteilen nur frei und verfügbar | `POST /api/equipment/:id/assign` |
| Einsatz | Einstempeln (= Start: setzt „in Arbeit"); Ausstempeln, wenn die eigene Zeit hier läuft — seit 2026-09-28 | `timetracking:own` und zugeteilt, Status geplant bis pausiert | `POST /api/time/clock-in`, `/clock-out` |
| Einsatz | Verweis Rapport: Büro PDF, Portal Einsatzseite `#rapport` | `job:read` bzw. zugeteilt | `GET /api/jobs/:id/report` |
| Rechnung | Zahlung erfassen; Verweis PDF | `payment:create` und offen; PDF mit `invoice:read` | `POST /api/invoices/:id/payments`, `GET /api/invoices/:id/pdf` |
| Kundschaft, Objekt, Vertrag | nur Öffnen | Leserecht (Vertrag: `contract:read`, nur Büro) | — |

Die Regeln stehen seit 2026-09-28 als reine Funktionen in
`src/lib/scan/regeln.ts` (geprüft in `tests/api/scan-regeln.test.ts` mit der
echten Rollenzuordnung); der Dienst liefert nur Status, Zuteilung und Recht.

Nachbestellen gibt es nicht (kein Bestellmodell) — der Treffer zeigt
„am oder unter dem Meldebestand". Fehlende Funktion.

Mitarbeitende (Portal) sehen nur eigene Einsätze und Objekte mit eigenem
Einsatz; Links führen ins Portal. Kundschaft: 403.

## Protokoll

Erzeugen und Sperren eines Etiketts stehen im Prüfprotokoll (`ScanCode`),
ohne den Code selbst. Aufgelöste Scans werden nicht protokolliert — sie lesen
nur. Was nach einem Scan geändert wird, protokolliert der Endpunkt, der es
ändert.

## Kontingent

`scanResolve`: 60 pro Minute **je Person** (nicht je IP — im Büro teilen sich
alle eine Adresse). Der Grund ist nicht der Etikettcode (100 Bit), sondern die
fortlaufenden Nummern: 300 Versuche pro Minute wären ein bequemes Werkzeug, sie
durchzuzählen.

## Bedrohungen

Siehe `docs/SECURITY_THREAT_MODEL_SCANNER.md`.

## Stand 2026-09-28 — Bestandsaufnahme und Ausbau

Ein Scanner für die ganze Anwendung — geprüft, wo er erreichbar ist, was er
auflöst und was danach möglich ist. Kein zweiter Scanner: Ausgebaut wurden
`scan.service.ts`, die reinen Regeln (`src/lib/scan/regeln.ts`, neu), die
Masken (`src/features/shared/scan-aktionen.ts`) und der Dialog
(`scan-button.tsx`).

### Erreichbarkeit je Bereich

| Bereich / Rolle | Vorher | Nachher | Begründung |
|---|---|---|---|
| Administration (SUPER_ADMIN, ADMIN) | Kopfzeile, Symbolknopf | unverändert | `scan={can(role, 'dashboard:view')}` im Layout |
| Betriebsleitung (MANAGER) | Kopfzeile (Administrationsrahmen) | unverändert | dasselbe Layout |
| Mitarbeitendenportal (EMPLOYEE) | Kopfzeile | unverändert | `portal/layout.tsx` setzt `scan` |
| Telefon | Symbolknopf in der Kopfzeile, **ohne** Schubfach erreichbar | unverändert | Die Kopfzeile ist klebend; der Knopf steht vor Farbschema und Glocke. `scan.spec.ts` prüft Pixel 7 |
| Kundschaft (`/konto`) | kein Scanner, Endpunkt 403 | **bewusst unverändert** | Keine Tätigkeit, bei der die Kundschaft einen Clenaris-Code scannt: keine Etiketten an ihren Gegenständen, keine Lagerbuchung, die eigene QR-Rechnung zahlt sie in der Bank-App. Ein Scanner wäre dort nur ein weiterer Weg, fortlaufende Nummern zu probieren (Bedrohung 4) |

### Auflösbare Arten

| Art | Kennung | Vorher | Nachher | Sicht in der Abfrage |
|---|---|---|---|---|
| Material | Etikett, EAN/GTIN, Artikelnummer | ✓ | ✓ | `inventory:read`, Organisation |
| Gerät | Etikett, Inventar-/Seriennummer | ✓ | ✓ | `equipment:read`, Organisation |
| Einsatz | Etikett, Nummer | ✓ | ✓ | Büro `job:read`; Portal nur zugeteilt (`assignments.some`) |
| Objekt | Etikett | ✓ | ✓ | `propertyVisibilityWhere` |
| Rechnung | Nummer, QR-Referenz, QR-Zahlteil | ✓ (nur eine Referenzform geprüft) | ✓ alte **und** neue Referenzform, belegt | Büro, `invoice:read`, Organisation |
| Kundschaft | Nummer | ✓ | ✓ | Büro, `customer:read` |
| Vertrag | Nummer | — | **neu** | Büro, `contract:read`, Organisation, nur mit Nummer |
| Lagerort | — | — | **nicht umgesetzt** | Es gibt kein Lagerortmodell. Ein Etikett für etwas, das nicht existiert, wäre eine Scheinfunktion |
| Dokument (Ablage) | — | — | **nicht umgesetzt** | Ablagedokumente sind Dateien, keine Gegenstände mit Aufkleber, und sie tragen keine Nummer. Die Sichtbarkeit (`EMPLOYEE_PRIVATE`) wäre ein zusätzlicher Auflösungsweg ohne Nutzen |
| Offerte | — | — | nicht umgesetzt | Annahme läuft elektronisch über den Signaturkern; ein Scan der Nummer brächte nur einen Link, den die globale Suche schon liefert |

Unbekannt, fremde Organisation, gelöscht und ohne Leserecht: dieselbe Antwort
(kein Existenzorakel) — für jede neue Art mit je einem Fall in `scan.test.ts`
belegt (Mitarbeitende gegen Vertrag, Rechnung beider Referenzformen, fremden
Einsatz, Geräteetikett).

### Etikettarten (J5)

| Art | Etikettseite | Verlinkt von | Vorher | Nachher |
|---|---|---|---|---|
| Material | `/admin/etikett/MATERIAL/:id` | Materialliste | ✓ | ✓ |
| Gerät | `/admin/etikett/EQUIPMENT/:id` | Geräteliste | ✓ | ✓ |
| Einsatz | `/admin/etikett/JOB/:id` | nur aus einem Scan (also nie) | ✗ unerreichbar | **Einsatzseite, Kopf** (`job:update`) |
| Objekt | `/admin/etikett/PROPERTY/:id` | nur aus einem Scan (also nie) | ✗ unerreichbar | **Kundenakte, Objektkarte** (`property:update`) |

Inhalt jedes Etiketts: `CLX1:` + 20 Zufallszeichen, darunter dieselbe
Zeichenfolge und die Bezeichnung. Keine ID, keine Nummer, keine Adresse, kein
Kundenname. Keine Schemaänderung nötig.

### Kontextaktionen

| Treffer | Vorher | Nachher |
|---|---|---|
| Material | Eingang, Entnahme, Korrektur | unverändert; „Nachbestellen" bleibt bewusst weg (kein Bestellmodell), Hinweis „unter dem Meldebestand" |
| Gerät | Wartung, Defekt / Wieder verfügbar | + **Zuteilen** (Personenauswahl aus der Antwort), **Zurücknehmen** |
| Einsatz | Einstempeln | + **Ausstempeln** bei laufender eigener Zeit; Verweis **Rapport** (Büro PDF, Portal `#rapport`) |
| Rechnung | Zahlung erfassen | + Verweis **PDF** |
| Vertrag | — | Öffnen (Vertragsseite); keine Maske — jeder Vertragsschritt braucht Begründung und Konditionen |
| Unbekannte EAN | „Artikel nicht gefunden." + Anlegen (vorbelegt nur Strichcode) | unverändert — die Maske im Dialog *ist* das Anlegeformular (`materialFields`, `POST /api/materials`); ein zweiter Einstieg über einen Adressparameter wäre ein zweiter Weg zum selben Formular. Keine externe EAN-Abfrage, keine erfundenen Produktdaten |

### Wo jede Stufe durchgesetzt wird

| Stufe | Ort | Beleg |
|---|---|---|
| Auflösen | `scanEinordnen` (rein), dann je Art eine Abfrage | `scan-kennung.test.ts` |
| Berechtigen | im `where` jeder Abfrage (Organisation + Sichtbarkeit), vor dem Laden | `scan.test.ts` „dieselbe Antwort wie unbekannt" |
| Zeigen | Antwort mit Treffern, Aktions*schlüsseln*, Verweisen; Aktionen nur, wenn `can()` und Zustand passen (`regeln.ts`) | `scan-regeln.test.ts` |
| Bestätigen | Maske im Dialog, gesendet erst mit ihrem Knopf; Verweise sind Links, nie automatisch geöffnet | `scan.spec.ts` („vorher nichts") |
| Erneut berechtigen | der bestehende Endpunkt (`defineRoute` mit eigenem Recht, Schema, Zustand, Sperre) | `scan.test.ts` 403 für Mitarbeitende an `/assign`, `/movements`, `/report`, `/pdf` |
| Ändern | nur der Endpunkt, mit Protokolleintrag | `scan.test.ts`, `scan.spec.ts` (Prüfprotokoll) |
