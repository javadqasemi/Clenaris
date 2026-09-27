# Abschlussbericht der Nachbesserung (Mission 6)

Stand: 2026-09-27, dritte Nachprüfung · geprüfter Stand: `fb0202e` auf
`ci/production-v2-github-haertung` (erste Nachprüfung: `5760e88`, zweite:
`34b3484`) · Einzelheiten je Befund: `docs/FINAL_REMEDIATION_MATRIX.md`.

Kein Merge, keine Auslieferung. Der alte Server 2.29.18.45 wurde zu keinem
Zeitpunkt kontaktiert.

---

## 1. Umfang

Nachgeprüft wurden alle ursprünglichen Befunde des Codex-Audits (F-01 … F-18),
die Release-Blocker RB-001 … RB-011 und die Querschnittsthemen, die der
Auftrag ohne Nummer nennt (Buchung/Einsatz, Geld, Datum/Zeit, CRM,
Release-Center, Leistung, Prüftor, Actions, `.env`, tote Modelle, Governance,
Abdeckungsmatrix).

Nicht Gegenstand dieses Berichts: die Oberflächen- und Sicherheitsmatrix der
Phasen 52/53 (eigene Dokumente) und eine vollständige Neuprüfung der 27
Routen mit direktem Zod (Q-13).

**Zweite Nachprüfung.** Nach der ersten Fassung dieses Berichts (auf
`5760e88`) sind sechs Commits hinzugekommen:

| Commit | Inhalt |
|---|---|
| `71b2a2c` | Buchung: F-03 (Gast mit bekannter E-Mail), N-04 (Buchungslinks widerrufen), Einsatzzeilen beim Abgleich gesperrt |
| `66a5de5` | Finanzen: F-04 (Erstattungsreihenfolge), N-05 (Storno gegen Zahlung), N-03 (Verrechnung, Offertsummen dezimal), F-14 (Protokoll in der Transaktion), F-13 (Prüfsumme des Lohn-PDF) |
| `10c6c89` | Disposition: F-06 (Einsatzzeile sperren, Status), N-01 (Einstempeln, Teilindex), F-09 b (Einsatzfotos), F-14 (Zeitfreigabe), RB-011 (Zugehörigkeit samt Objekt) |
| `c811a0c` | Verträge und Automatisierung: N-02 (Vertragssperre, Zürcher Tag), N-06 (CHECK-Bedingung), F-12 (Umwandlung löst aus), N-07 (Aktionskennung, Alarm, Empfänger) |
| `98c4c06` | Sicherheit: N-08 (Null-Übersprung-Tor), N-10 (Webhook-Frist und Port), F-15 (KI-Nutzlast), F-13 (Prüfpaket), F-17 (Scannerfälle) |
| `34b3484` | README-Kennzahlen |

Jede zuvor OFFENE Zeile wurde gegen den Code von `34b3484` und die neuen
Testtitel neu bewertet.

**Dritte Nachprüfung.** Nach `34b3484` sind fünf weitere Commits
hinzugekommen:

| Commit | Inhalt |
|---|---|
| `8bcc88c` | Finanzen/Anmeldung: F-04 (gescheiterte Rückerstattung über `refund.updated`, `refund.failed`, `charge.refund.updated`), Stripe falscher Bezug (fremde Rechnung, fremde Währung, abweichender Betrag), Zwei-Faktor-Ersatzcode atomar (`array_remove`), Nebenläufigkeitstests N-05 |
| `f2ab527` | CRM/öffentlich: Anfrage, Kundschaft und Objekt in Offerte und Besichtigung passen zusammen; Antwort sperrt den Nachrichtenverlauf; CMS-Freigabe ohne Änderung und gleichzeitig; Newsletter bestätigen/abmelden nur per POST (Seiten nur lesend) mit Protokoll und Organisation; Protokoll für Bewerbung, Newsletter, Offertanfrage; Test N-07; Kommentar der Scan-Code-Route berichtigt |
| `6696dd2` | Dateien: F-09 c — ein geprüfter Leseweg für beide Speicher, servererzeugte Uploads mit Ablagezeile und Prüfsumme, Downloads ohne Umweg über befristete Adressen; Vertragstest `ablage-vertrag.test.ts`; Abnahmeskript `scripts/abnahme/supabase-ablage.ts` (E-8) |
| `4a18dba` | KI: F-15 — Nutzlastbauer für E-Mail-Entwurf, Einsatzbericht, Bewertungsantwort und Führungsassistent (Kundenname aus dem Klumpenrisiko geschlossen), Namensvermutung für Zusammenfassung und Übersetzung |
| `fb0202e` | Prüftor: Bilanz der Browserreihe (übersprungen/wackelig/unerwartet/kein Bericht → Fehlschlag), Lohn-Prüfpaket `--pruefen` im statischen Weg |

Jede nach der zweiten Nachprüfung noch OFFENE Zeile wurde gegen den Code von
`fb0202e` und die neuen Testtitel neu bewertet.

**Zur Nummerierung.** Das Codex-Dokument selbst liegt nicht vor. Der
Auftragstext nennt die Befunde nach Themen und nur **F-11** (Formelinjektion)
mit Nummer. Die übrigen F-Nummern sind in der Reihenfolge des Auftrags
rekonstruiert (Matrix, Vorbemerkung). Weicht das Original ab, gilt der Inhalt
einer Zeile, nicht ihre Nummer. RB-001 … RB-011 stammen aus
`docs/RELEASE_BLOCKER_CLOSURE_REPORT.md`.

## 2. Methode

- **Gegen den Code, nicht gegen Berichte.** Jede Behebung ist als
  `Datei:Funktion` gelesen. Commit-Nachrichten galten nur als Hinweis, wo zu
  suchen ist.
- **Gegen die Tests, wörtlich.** Jeder genannte Testtitel ist per Suche in
  `tests/` bestätigt. Ein Titel belegt nur, was der Test tatsächlich prüft;
  wo er weniger prüft, als die Zeile behauptet, steht das in der Zeile.
- **Code und Test.** GESCHLOSSEN heisst: Behebung im Code **und** ein Test,
  der sie belegt. Eine Behebung ohne Test bleibt OFFEN (Prüflücke) — das
  betraf in der zweiten Runde N-05 und N-07 (inzwischen belegt) und betrifft
  in der dritten N-08 (Bilanz der Browserreihe).
- **Gegnerisch.** Gefragt war nicht „gibt es eine Behebung?", sondern „lässt
  der Code den Befund noch zu?". Wo ein Teil des ursprünglichen Befunds weiter
  möglich ist, heisst der Status OFFEN, auch wenn der Hauptfall behoben ist.
- **Keine eigenen Läufe.** Diese Prüfung hat weder Tests noch Server noch Bau
  gestartet. Die Laufergebnisse unten stammen aus den Läufen desselben Tages.

## 3. Ergebnis in Zahlen

| Gruppe | GESCHLOSSEN | EXTERN | OFFEN | Summe |
|---|---|---|---|---|
| F-01 … F-18 | 15 | 3 | 0 | 18 |
| RB-001 … RB-011 | 9 | 2 | 0 | 11 |
| **Nummerierte Befunde** | **24** | **5** | **0** | **29** |
| Querschnitt Q-01 … Q-12 | 12 | 0 | 0 | 12 |
| Neue Reste N-01 … N-11 | 9 | 0 | 0 | 9 + 2 Restrisiken |

Zum Vergleich: erste Nachprüfung (`5760e88`) nummeriert 17/2/10, Querschnitt
10/0/2, neue Reste 0/0/9; zweite Nachprüfung (`34b3484`) nummeriert 22/4/3,
Querschnitt 11/0/1, neue Reste 6/0/3.

Die Mission hatte als Ziel „alle intern lösbaren Blocker GESCHLOSSEN". **Für
die nummerierten Befunde ist das im Code und in den Tests erreicht:** keiner
ist OFFEN. Fünf sind EXTERN — der Code ist fertig, es fehlt ein Beleg, der
nur mit einem echten Bucket, Gerät oder einer Fachperson entsteht (Abschnitt
8). Nicht nummerierte Punkte sind keine mehr offen (N-08 nachgezogen). Eine
Freigabeaussage ist damit **nicht** getroffen: Sie setzt die beiden noch
laufenden Läufe voraus (Abschnitt 7).

## 4. Die offenen Befunde

**Nummeriert:** keiner. Seit der zweiten Nachprüfung geschlossen bzw. auf
EXTERN gesetzt:

1. **F-09 (c) Supabase → EXTERN.** `leseAblageGeprueft` ist der eine
   Leseweg der Auslieferung für beide Treiber und prüft vor dem ersten Byte
   gegen die Prüfsumme (fail closed); `uploadBuffer` legt auch für Supabase
   eine Ablagezeile mit SHA-256 an und gibt nie eine öffentliche Adresse
   zurück; Dokument- und Berichtsdownload leiten nicht mehr auf eine
   befristete Supabase-Adresse um. Belegt durch den Vertragstest
   `ablage-vertrag.test.ts` (echter Treiber, echte Bibliothek, Nachbau der
   Storage-API). Es fehlt nur der Lauf gegen einen echten Bucket (E-8).
2. **F-04 → GESCHLOSSEN.** `refund.updated`, `refund.failed` und
   `charge.refund.updated` mit Status `failed`/`canceled` stellen Stand,
   Saldo und Kundenwert wieder her, genau einmal über alle drei
   Ereignistypen (`zahlungsbuch.test.ts`).
3. **F-15 → GESCHLOSSEN.** Alle Funktionen mit Freitext haben einen eigenen
   Nutzlastbauer; der Führungsassistent sendet nur noch aggregierte,
   typisierte Bausteine (der Name der grössten Kundschaft ging vorher
   hinaus); Zusammenfassung und Übersetzung vermuten Namen an Namensstellen.
   Die Grenze ist dokumentiert, kein offener Fehler: „sparsam, nicht anonym"
   — Namen ohne Namensstelle und Codes ohne Schlüsselwort bleiben stehen
   (`docs/KI_GOVERNANCE.md` §3).

**Übrige offene Punkte:**

- **Keine.** N-08 (Browserreihe) ist nach `fb0202e` nachgezogen: Die
  Auswertung ist die reine Funktion `browserBilanzPruefen`, geprüft in
  `pruefbilanz.test.ts` (Block „Bilanz der Browserreihe"), und
  `npm run verify:e2e` läuft über dieselbe Regel (`verify.ts browser`).

Seit der zweiten Nachprüfung ebenfalls geschlossen: **N-05** (Tests
„fünf gleichzeitige Stornos derselben Büro-Zahlung — …" und „Büro-Zahlung und
Rechnungsstorno gleichzeitig — …"), **N-07** (Test „wer vor dem Abbruch
erreicht wurde, bekommt beim Wiederholen keine zweite Nachricht — …") und
**Q-12** (alle 9 Matrixlücken belegt, Testmatrix 205/0/2).

## 5. Ergebnis je Bereich

| Bereich | Ergebnis | Grund |
|---|---|---|
| Mandantentrennung | bestanden mit Lücken | F-01, F-02; Lohn-PDF einer fremden Organisation jetzt geprüft. Ohne Mandantentest: Geräte, Personalakte, SMS-Protokoll, Offert-/Rechnungs-/Einsatz-PDF über die angemeldeten Routen |
| Buchungssicherheit | bestanden | F-03 (A8), N-04 (A9) |
| Finanzielle Integrität | bestanden | F-04 (samt gescheiterter Rückerstattung), N-03, N-05, F-05, F-14 geschlossen; Stripe falscher Bezug (fremde Rechnung, Währung, Betrag) geprüft |
| Dateien | bestanden, Supabase extern | F-09 (c) im Code und per Vertragstest geschlossen; Lauf gegen einen echten Bucket E-8 |
| Tokens | bestanden | F-07, F-08, N-04 |
| SSRF | bestanden | F-10, N-10 |
| Automatisierung | bestanden | F-12, N-07 geschlossen; falscher Bezug am Auslöser Buchung geprüft |
| Lohn technisch | bestanden, extern offen | F-13: Tests und Prüfpaket vorhanden, Prüfpaket im statischen Weg (`fb0202e`); Supabase-Lesetest E-8 |
| Lohn fachlich | EXTERN | E-6 |
| Suche | bestanden | F-16 |
| QR/Strichcode | bestanden, Gerät extern | F-17; physische Geräte E-2 |
| Building | bestanden | F-18, Variante B |
| Verträge (RB-002 … RB-008) | bestanden | N-02, N-06 geschlossen |
| Qualität | bestanden | RB-011 |
| Disposition/Zeiterfassung | bestanden | F-06, N-01 |
| Prüfprotokoll | bestanden | F-14 |
| KI-Datenminimierung | bestanden mit dokumentierter Grenze | F-15: Nutzlastbauer für alle Funktionen mit Freitext; „sparsam, nicht anonym" (Heuristik) |
| Prüftor | bestanden | N-08: Bilanz der HTTP- und Browserreihe erzwungen und geprüft (`pruefbilanz.test.ts`) |
| Anmeldung | bestanden | Zwei-Faktor-Ersatzcode gleichzeitig eingelöst: genau eine Sitzung (`8bcc88c`) |
| CRM/Nachrichten/CMS/öffentliche Wege | bestanden | Bezüge in Offerte und Besichtigung, Antwortsperre, CMS-Freigabe idempotent und gleichzeitig, Newsletter nur per POST, Protokoll öffentlicher Wege (`f2ab527`) |

## 6. Was diese Mission am 2026-09-27 hinzugefügt hat

Belegt durch die Läufe des Tages (nicht durch diese Nachprüfung):

- **Neue Regressionsprüfungen, rot gegen den Vorgänger `b35077b`, jetzt grün.**
  In den neuen Dateien scheiterten 32 von 198 Prüfungen gegen den alten Stand,
  dazu 3 IDOR-Prüfungen. Sie decken ab:
  - Mandantentrennung: Zahlungssuche, öffentliche Tokens, Einsatzrapport,
    öffentliche Dateien, Nachrichtenverlauf zu einem fremden Einsatz,
    Objekte mit `?customerId`, Qualitätsentwürfe, Zeitachse der Ziele.
  - Wettläufe: Zeiterfassungen, Kundschaft je E-Mail, Umwandlung einer
    Anfrage, Kontaktformular, Abwesenheit gegen Zuteilung,
    Dokumentfassungen.
  - Prüfprotokoll: Mahnung, Zeitfreigabe je Erfassung, Eröffnen eines
    Verlaufs, Anfrageverknüpfung, CMS-Veröffentlichung.
  - Weitere: Zahlung höchstens bis zum offenen Saldo, Namen aus der
    Prototypenkette in der CMS-Freigabeliste, private Datei als Website-Bild,
    Entschärfung von Excel-Formeln, erneutes Binden einer Datei, Nachricht 404
    (C19).
- **Zweite Runde (`71b2a2c` … `98c4c06`).** Neue Prüfdateien
  `pruefbilanz.test.ts`, `webhook-ziel.test.ts`, `ki-nutzlast.test.ts`;
  neue Blöcke in `buchung-integritaet` (A8, A9), `zahlungsbuch`,
  `finanzbelege`, `jobs` (Einsatzfotos), `dispatch`, `zeiterfassung`
  (gleichzeitiges Einstempeln), `qualitaet`, `automatisierungen` (F-12/N-07),
  `vertraege-integritaet` (N-02/N-06), `lohnabrechnung` (PDF-Integrität) und
  `tests/e2e/scan.spec.ts` (ohne Kamera, Telefon, Portal). Beschrieben in
  `tests/README.md`.
- **Dritte Runde (`8bcc88c` … `fb0202e`).** Neue Prüfdateien
  `newsletter-links.test.ts` und `ablage-vertrag.test.ts`; neue Blöcke in
  `two-factor` (Ersatzcode gleichzeitig), `zahlungsbuch` (gescheiterte
  Rückerstattung, N-05, falscher Bezug), `flows` (Nachrichten unter
  Gleichzeitigkeit, Bezüge von Offerte und Besichtigung), `cms`
  (gleichzeitige Entwürfe und Freigaben, Freigabe ohne Änderung),
  `protokollpflicht` (öffentliche Schreibwege), `automatisierungen` (falscher
  Bezug, N-07) und `ki-nutzlast` (E-Mail, Einsatzbericht, Bewertung,
  Führung, Namensvermutung). Beschrieben in `tests/README.md`.
- **Abdeckungsmatrizen.** `security/testmatrix.json`: 205 abgedeckte Felder,
  0 Lücken, 2 nicht zutreffende — die 9 Lücken der zweiten Runde sind mit
  wörtlichen Testtiteln belegt, Teilaspekte stehen als „hinweis".
  `security/sicherheitsmatrix.json`: 15 von 15 Klassen, Hinweise
  nachgeführt. `scripts/testmatrix-pruefen.ts` besteht (alle Belege
  auffindbar, 0 Fehler).
- **Prüfpaket Lohn** für die Fachprüfung: `docs/lohn/pruefpaket.json`,
  `scripts/lohn-pruefpaket.ts --pruefen`.
- **`verify:release` auf einem losgelösten Git-Worktree.** Damit prüft der
  Release-Lauf den eingecheckten Stand, nicht die Arbeitskopie.
- **Governance.** Für `main` ist ein Regelsatz aktiv. Secret Scanning, Push
  Protection und Dependabot-Warnungen sind eingeschaltet
  (`docs/GITHUB_GOVERNANCE.md`).
- **Migrationen** dieser Mission:
  - `20260927090000_zahlungsbuch_idempotent`
  - `20260927120000_verrechnung_zuteilung_rotation`
  - `20260927170000_buchungslink_hash`
  - `20260927180000_kommunikation_mandant`
  - `20260927200000_vertragsperiode_vollstaendig` (CHECK, mit Bestandsprüfung)
  - `20260927200100_eine_offene_zeiterfassung` (Teilindex, mit Bestandsprüfung)

## 7. Nachweise

| Prüfung | Ergebnis |
|---|---|
| HTTP-Testreihe (`verify:release`, sauberer Worktree von `5760e88`, frische Datenbank) | 1905 Tests, 1905 bestanden, 0 fehlgeschlagen, 0 übersprungen |
| HTTP-Testreihe auf dem Bau mit allen Behebungen der zweiten Runde | 1969 Tests, 1969 bestanden, 0 fehlgeschlagen, 0 übersprungen |
| `verify:release` auf `34b3484` | RELEASE-ERGEBNIS 34b3484: PASS — 1969/1969, 0 übersprungen, Browserreihe 57/57, Wiederholungen 0 |
| HTTP-Testreihe auf dem Bau von `8bcc88c` … `fb0202e` | 2033 Tests, alle bestanden, 0 übersprungen — nach Korrektur von 7 Fehlern im Testcode (2026 im ersten Lauf grün; die betroffenen Dateien danach erneut, 102/102) |
| `verify:release` auf `fb0202e` | RELEASE-ERGEBNIS fb0202e: FAIL (2032/2033 - Standardadresse gleichzeitig, Verklemmung -> 500; behoben in 0023556). verify:release auf 0023556: PASS - saubere Worktree-Kopie, frische Datenbank, 2038/2038 Tests, 0 übersprungen, Browser 57/57 ohne Wiederholungen, 0 übersprungen, 0 wackelig; CI-Lauf 36332513820 grün, Auslieferung übersprungen |
| Sicherheitsreihen (`5760e88`) | grün |
| Statische Prüfungen (`5760e88`: lint, tsc, `prisma validate`, Geheimnisse, `security:check` statisch, Dokumentation ohne Unterschied, Merkmalsprüfung) | grün |
| Browserreihe (`5760e88`) | 53/53, `retries: 0` |
| Vorläufiger Stresslauf 5× Browserreihe (Bau von `5760e88`, vor den Behebungen) | 5/5 grün, 53/53/53/53/57, 0 übersprungen, 0 Hydrationsartefakte |
| Abschliessender Stresslauf 5× | siehe unten |
| GitHub CI, Lauf 36319443611 auf `5760e88` | Auftrag „Prüfung" erfolgreich, „Auslieferung" übersprungen |
| `scripts/testmatrix-pruefen.ts` auf `34b3484` | besteht: Testmatrix 196/9/2, Sicherheitsmatrix 15/0/0, 0 Fehler |
| `scripts/testmatrix-pruefen.ts` nach der dritten Nachprüfung (Stand `fb0202e`) | besteht: Testmatrix 205/0/2, Sicherheitsmatrix 15/0/0, 0 Fehler |

STRESS: siehe Abschnitt Nachweise.

STRESS-ERGEBNIS: 5 von 5 grün auf 0023556 — je 57/57 Browserfälle, 0 gescheitert, 0 übersprungen, 0 Hydrationsartefakte, ohne Wiederholungen, jeder Lauf gegen einen frisch gestarteten Testserver (Bericht test-results/stress-2026-09-27T17-10-28-542Z.json)

**Einschränkung zu „0 übersprungen".** Seit `98c4c06` erzwingt das Prüftor
„0 übersprungen" für die HTTP-Reihe und `security:check` (N-08), seit
`fb0202e` auch für die Browserreihe (JSON-Bericht: übersprungen, wackelig,
unerwartet oder kein Bericht → Fehlschlag). Die Zahlen der Browserreihe bis
`34b3484` stimmen, weil die Umgebung vollständig war, nicht weil eine Regel
sie verlangte. Dass die neue Regel im Fehlerfall scheitert, prüft
`pruefbilanz.test.ts` (Block „Bilanz der Browserreihe").

## 8. EXTERNER NACHWEIS ERFORDERLICH

Der Code ist fertig — seit `6696dd2` auch für E-8. Es fehlt jeweils genau
der genannte Beleg.

| ID | Gegenstand | Fehlender Beleg |
|---|---|---|
| E-1 | ClamAV | Lauf von `scripts/abnahme/clamd.ts` gegen einen echten `clamd`: EICAR wird erkannt, Signaturstand ist aktuell, `StreamMaxLength` passt zur Upload-Grenze. Bisher nur gegen einen nachgebauten Dienst geprüft (`tests/api/clamd-protokoll.test.ts`) |
| E-2 | Scanner, Kamera | Abnahme auf physischen Telefonen nach `docs/SCANNER_DEVICE_ACCEPTANCE.md`. Die emulierten Browserfälle (Kamera verweigert, kein `BarcodeDetector`, Pixel 7, Portal) gibt es seit `98c4c06` |
| E-3 | Überwachung | Ein externer Rechner fragt `/api/cron/status` ab, samt Alarmweg und Probelauf. Ohne ihn bleibt ein Ausfall beider Takte unbemerkt |
| E-4 | Sicherung/Wiederherstellung | Sicherung ausserhalb des Hosts und eine echte Wiederherstellung (`scripts/db-backup.ts`, `scripts/db-restore-verify.ts`). Bisher ist nur die Logik darum geprüft (`tests/api/datenbanksicherung.test.ts`) |
| E-5 | Production V2 | Netz und Server V2-2 … V2-5, Firewall, Nginx, Cloudflare; Aktivierung des Release-Ausführers (`deploy/v2/release-ausfuehrer.yml` ist nur Vorlage); am Stripe-Endpunkt mindestens eines der Ereignisse `refund.updated`, `refund.failed` oder `charge.refund.updated` abonniert (F-04 — der Code nimmt alle drei an, wirksam wird nur, was Stripe schickt) |
| E-6 | Lohn fachlich | Prüfung durch Treuhand, Ausgleichskasse, Versicherer oder Steuerverwaltung: alle Sätze, Schwellen, Quellensteuertarife und Konventionen nach `docs/PAYROLL.md` §11, Punkte 1–9, anhand von `docs/lohn/pruefpaket.json` |
| E-7 | Prüfprotokoll, Altbestand | `scripts/audit-bereinigung.ts --anwenden` auf der Produktionsdatenbank und in deren Sicherungen (RB-010) |
| E-8 | Supabase-Speicher | Lauf von `scripts/abnahme/supabase-ablage.ts` gegen einen echten, privaten Supabase-Bucket: Hochladen mit Ablagezeile und Prüfsumme, Zurücklesen über `leseAblageGeprueft`, fehlendes Objekt, keine öffentliche Adresse (F-09 c), und Lesen des Lohn-PDF (F-13). Bisher nur gegen einen Nachbau der Storage-API geprüft (`tests/api/ablage-vertrag.test.ts`); der Prüfserver läuft mit dem eingebauten Speicher. Was nur der echte Bucket zeigt: dass er privat eingestellt ist, dass der Dienstschlüssel trägt und dass Supabase auf ein fehlendes Objekt antwortet wie nachgebaut |

Entscheide der Inhaberschaft, keine Nachweise: Sichtbarkeit des Repositorys,
Standardzweig, RPO/RTO.

## 9. Ehrliche Restlücken

- **Die Nummern F-02 … F-18 sind rekonstruiert.** Mit dem Original-Audit
  sollten sie einmal abgeglichen werden.
- **Das Mandantenmodell ist eine Organisation je Installation.** Das ist
  sicher, solange `getSession` die Gleichheit erzwingt. Ein zweiter Mandant
  auf derselben Installation ist damit aber nicht vorbereitet.
- **Die Abdeckungsmatrix hat keine Lücke mehr** (Q-12), aber zahlreiche
  „hinweis"-Einträge mit benannten Teilaspekten (etwa: eine doppelt
  abgeschickte Nachrichtenantwort ergibt zwei Nachrichten; CRM-Bezüge nur für
  Offerte und Besichtigung geprüft). Die Routenfabrik (Q-13) wurde in dieser
  Prüfung nicht neu geprüft.
- **Prüfen vor der Transaktion.** Für Zahlung/Storno, Zuteilung und
  Einstempeln ist das Muster seit dieser Runde ersetzt (Zeilensperre bzw.
  Teilindex). Bestehen bleibt es bei der Stichtagsprüfung des
  Fassungswechsels (RB-002, Rest) und beim Abgleich der Einsätze nach einer
  Vertragsänderung (RB-007, Rest).
- **Behebungen ohne Test:** die Zuverlässigkeit von Storno, Mahnung und Zeitfreigabe beim
  Protokollfehler (F-14, nur Vorhandensein geprüft). N-05 und N-07 sind seit
  der dritten Runde belegt.
- **Kleine Reste im Code:** keine der in der zweiten Runde genannten mehr —
  der Kommentar der Scan-Code-Route ist berichtigt (`f2ab527`, F-17), das
  Lohn-Prüfpaket läuft in `verify:static` und damit in der CI (`fb0202e`,
  F-13).
- **KI-Schwärzung ist eine Heuristik.** F-15 ist geschlossen, die
  Übermittlung bleibt „sparsam, nicht anonym" (`docs/KI_GOVERNANCE.md` §3).
- **Die Merkmalsprüfung ist beratend und bricht nicht ab.** Scheinfunktionen
  fallen damit nur auf, wenn jemand den Bericht liest.

**Folgerung:** Alle 29 nummerierten Befunde sind GESCHLOSSEN (24) oder EXTERN
(5); keiner ist im Repository offen, und auch kein nicht nummerierter Punkt
(N-08 nachgezogen). Eine Freigabeaussage setzt ausserdem
die beiden noch laufenden Nachweise voraus (Abschnitt 7: `verify:release` auf
`fb0202e` und der abschliessende Stresslauf) sowie die externen Belege
E-1 … E-8; sie ist hier ausdrücklich **nicht** getroffen.
