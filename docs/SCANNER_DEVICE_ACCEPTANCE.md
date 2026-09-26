# Scanner — Abnahme auf echten Geräten

Stand 2026-09-26. **Status: EXTERNAL VERIFICATION REQUIRED.** Nichts in
diesem Dokument ist bisher ausgeführt. Die Browserreihe (`tests/e2e/scan.spec.ts`)
bildet Kamera und `BarcodeDetector` nach; sie beweist den Weg ab dem erkannten
Text, nicht die Erkennung selbst. Erst wenn die Tabellen unten mit echten
Geräten ausgefüllt sind, darf „REAL DEVICE VERIFIED" gesagt werden — und nur
für die Geräte und Formate, die dann tatsächlich bestanden haben.

## Was erwartet wird — vorab festgehalten

Der Scanner fragt den Browser, ob es `BarcodeDetector` gibt und welche
Formate er erkennt. Er verlangt davon nur
`qr_code, ean_13, ean_8, upc_a, code_128, code_39, data_matrix`
(`GEWUENSCHTE_FORMATE` in `src/components/app/scan-button.tsx`).

| Plattform | Erwartung vor dem Test | Begründung |
|---|---|---|
| Android, Chrome (aktuell) | Kamera erkennt die abgefragten Formate | Chromium stellt `BarcodeDetector` auf Android bereit |
| iPhone, Safari (aktuell) | **Keine Kameraerkennung**: Meldung „Dieser Browser erkennt keine Codes über die Kamera …"; Eingabe, Einfügen und Handscanner funktionieren | Safari bietet `BarcodeDetector` nach bisherigem Stand nicht an. Wird er doch angeboten, ist das zu notieren, nicht vorauszusetzen |
| iPhone, Chrome | wie Safari | Alle iOS-Browser nutzen WebKit |
| macOS, Chrome | Kamera erkennt, sofern `getSupportedFormats` Formate liefert | Chromium auf macOS |
| Windows, Chrome/Edge | Keine Kameraerkennung, Meldung wie oben | kein `BarcodeDetector` unter Windows |
| Desktop mit USB-Handscanner | Eingabe über das Feld, Enter löst aus | Handscanner ist eine Tastatur |

Ein Gerät, das von der Erwartung abweicht, ist ein **Befund**, kein Erfolg
und kein Fehlschlag — er wird notiert und `docs/SCANNER.md` angepasst.

## Vorbereitung

1. Testumgebung: Vorschau (`npm run preview:server`) oder eine
   Staging-Kopie mit **HTTPS** — Kamerazugriff verlangt einen sicheren
   Kontext. Nie gegen Produktion mit echten Daten.
2. Konten: Systemverantwortung, Betriebsleitung (Lager/Geräte), Mitarbeitende
   (Portal), Kundschaft; dazu die fremde Prüforganisation in der Datenbank.
3. Testcodes drucken (Laserdrucker, Normalpapier, 100 %):
   - **Q1** Clenaris-Etikett eines Materials (Etikettseite, „Etikett erzeugen")
   - **Q2** Clenaris-Etikett eines Geräts, danach **gesperrt**
   - **Q3** QR mit `https://example.com/login`
   - **Q4** QR mit `javascript:alert(1)`
   - **Q5** QR mit beliebigem Text („Hallo")
   - **Q6** QR mit beschädigtem Clenaris-Code (`CLX1:` + 10 Zeichen)
   - **Q7** Schweizer QR-Rechnung einer eigenen Rechnung (aus dem PDF)
   - **E1** EAN-13 eines erfassten Artikels (Strichcode am Material hinterlegt)
   - **E2** EAN-13 eines **nicht** erfassten Artikels
   - **E3** EAN-8
   - **U1** UPC-A
   - **C1** Code 128 mit einer Inventarnummer (z. B. `GR-0003`)
   - **C2** Code 128 mit einer unbekannten Zeichenfolge
   - **M1** ein Blatt mit Q1 und E1 nebeneinander (mehrere Codes im Bild)
   - **D1** E1 mit einem Filzstiftstrich quer über 10 % der Striche

## Matrix A — Erkennung

Für jedes Gerät eine Spalte. Eintrag: ✓ erkannt / ✗ nicht erkannt / — nicht
anwendbar, dazu Zeit bis zur Erkennung in Sekunden.

| Fall | Bedingung | Android Chrome | iPhone Safari | macOS Chrome | Handscanner |
|---|---|---|---|---|---|
| Q1 | gutes Licht, 15–25 cm | | | | |
| Q1 | schwaches Licht (Raumlicht aus, nur Bildschirm) | | | | |
| Q1 | nah (5 cm) / fern (60 cm) | | | | |
| E1 | gutes Licht | | | | |
| E3 (EAN-8) | gutes Licht | | | | |
| U1 (UPC-A) | gutes Licht — findet denselben Artikel wie seine EAN-13-Form | | | | |
| C1 (Code 128) | gutes Licht | | | | |
| D1 | beschädigt | | | | |
| M1 | zwei Codes im Bild — **welcher** wurde genommen? (erwartet: der erste, den der Detektor liefert; notieren) | | | | |
| Bild | Foto von Q1 über „Bild" | | | | |

## Matrix B — Verhalten und Sicherheit

Jede Zeile auf **mindestens** Android Chrome und einem Handscanner/Eingabe;
Q3/Q4 zusätzlich auf dem iPhone per Eingabe/Einfügen.

| Fall | Erwartet | Ergebnis |
|---|---|---|
| Kamera verweigert (Browserdialog „Nicht zulassen") | Meldung „Der Zugriff auf die Kamera wurde nicht erlaubt."; Eingabe funktioniert | |
| Keine Kamera / kein Detektor | Meldung „… erkennt keine Codes über die Kamera …" | |
| Dialog schliessen während die Kamera läuft | Kameraanzeige des Geräts erlischt | |
| Nach Erkennung | Kamera endet; **Seite unverändert**; nichts gebucht (Bestand vorher = nachher, Prüfprotokoll ohne neuen Eintrag) | |
| Q1 als Betriebsleitung | Material mit Bestand, Knöpfe Wareneingang/Entnahme/Korrektur | |
| Q1 als Mitarbeitende | „Kein Datensatz zu diesem Etikett." — dieselbe Meldung wie Q6-unbekannt | |
| Q1 als Kundschaft | kein Scan-Knopf in `/konto` | |
| Q1 in der fremden Organisation eingetragen (Datenbank) | nichts gefunden | |
| Q2 (gesperrt) als Betriebsleitung | Hinweis „Etikett ist gesperrt", keine Knöpfe | |
| Q3 externe Adresse | Hinweis „öffnet gescannte Adressen nicht", **kein Link**, Seite bleibt | |
| Q4 `javascript:` | wie Q3, kein Browserdialog | |
| Q5 Text | „Nichts gefunden." | |
| Q6 beschädigt | „Nicht lesbar: Beschädigter oder unbekannter Clenaris-Code." | |
| Q7 QR-Rechnung als Administration | die eigene Rechnung, Knopf „Zahlung erfassen" | |
| E2 unbekannte EAN als Betriebsleitung | „Artikel nicht gefunden." + „Neuen Artikel erfassen", nur Strichcode vorbelegt | |
| E2 als Mitarbeitende | „Artikel nicht gefunden.", **kein** Anlegen | |
| C2 unbekannt | „Nichts gefunden.", keine Knöpfe | |
| Schnellaktion Wareneingang auf Q1 | erst nach Klick auf „Eingang buchen" gebucht; Protokolleintrag `StockMovement` | |
| Handscanner: 61 Scans in unter einer Minute | ab dem 61. „Zu viele Anfragen" | |

## Abnahme

„REAL DEVICE VERIFIED" gilt je Gerät und Format, wenn in Matrix A „gutes
Licht" für das Format ✓ ist **und** Matrix B vollständig den Erwartungen
entspricht. Abweichungen der Erkennungsrate bei schwachem Licht, Beschädigung
oder Entfernung sind Eigenschaften des Geräts; sie werden notiert, blockieren
aber nicht, solange Eingabe und Handscanner funktionieren.

Nicht Gegenstand: GS1-Elementstrings, Code-128-**Etiketten aus Clenaris**
(werden nicht erzeugt), Data Matrix (vom Detektor verlangt, aber ohne
Prüfcode im Bestand — erkannter Text wird wie freier Text behandelt).

| Gerät | Betriebssystem / Browser | Datum | Person | Ergebnis |
|---|---|---|---|---|
| | | | | |
