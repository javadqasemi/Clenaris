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
| Erneut prüfen | bestehende Endpunkte | `/api/materials/:id/movements`, `/api/equipment/:id/status` und `/maintenance`, `/api/time/clock-in`, `/api/invoices/:id/payments`, `/api/materials` — mit ihren eigenen Rechten, Schemas, Sperren und Protokolleinträgen. Die Scanplattform hat keinen eigenen Schreibweg für Fachdaten. |

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
| Einsatz-, Rechnungs-, Kundennummer | `Job.number`, `Invoice.number`, `Customer.number` | je Organisation | exakter Vergleich |
| QR-Referenz | `Invoice.qrReference` | — | Index `(organizationId, qrReference)`; nur mit gültiger Prüfziffer |

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
| Einsatz | Einstempeln | `timetracking:own` und zugeteilt, Status geplant bis pausiert | `POST /api/time/clock-in` |
| Rechnung | Zahlung erfassen | `payment:create`, Status offen | `POST /api/invoices/:id/payments` |
| Kundschaft, Objekt | nur Öffnen | Leserecht | — |

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
