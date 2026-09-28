# Sicherung und Wiederherstellung — Prüfung (Wave 21)

Stand 2026-09-23. **Nur Prüfung.** In dieser Wave wurde kein
Produktionssystem berührt: kein Zugriff auf 2.29.18.45, keine Einstellung bei
Hetzner, keine Sicherung aus der Produktion. Alle Aussagen über die Produktion
stammen aus Repository und Dokumentation und sind als solche gekennzeichnet.

Status: **Mechanismus COMPLETE + VERIFIED (örtlich)** · **Betrieb EXTERNAL
VERIFICATION REQUIRED** · **Release-Blocker: ja** (B-DR-1 bis B-DR-3).

## 1. Was im Repository vorhanden ist

| Baustein | Was er tut | Stand |
|---|---|---|
| `scripts/db-backup.ts` | `pg_dump --format=custom`, Zugang nur über die Umgebung (nie in `argv`), Client ≥ Server geprüft, danach Datei vorhanden, Grösse > 0, `pg_restore --list` lesbar und nicht leer, SHA-256; Aufbewahrung `CLENARIS_BACKUP_KEEP` (7), aufgeräumt erst nach dem Beweis | vorhanden |
| `scripts/deploy.sh` | ruft die Sicherung **vor** `prisma migrate deploy` auf — nur wenn Migrationen anliegen; ohne geprüfte Sicherung keine Migration | vorhanden |
| `scripts/db-restore-verify.ts` | legt `clenaris_restore_verify_<Zeit>` an (Name im Skript erzeugt, Muster und Sperrliste), spielt ein Archiv ein, vergleicht Zeilenzahlen mit der Quelle, löscht die Wegwerfdatenbank | vorhanden, **in dieser Wave erweitert** |
| `.deploy/backups/<zeit>/` | Build und `.env` vor jeder Auslieferung (drei Stück) | vorhanden |

### Erweiterung in dieser Wave

`db-restore-verify.ts` verglich 14 Tabellen aus Gate 4 — ohne Finanzen, Lohn
oder Verträge. Neu:

- die aufbewahrungspflichtigen Belege und Anfüge-Tabellen: `invoices`,
  `invoice_items`, `payments`, `credit_notes`, `payslips`, `payslip_lines`,
  `salary_certificates`, `contracts`, `contract_versions`, `complaints`,
  `stock_movements`, `equipment_maintenances`, `site_visits`,
  `signature_events`, `audit_logs`;
- **Trigger und Teilindizes** als Anzahl und Namensprüfsumme. Die
  Sperrtrigger (Finanzbelege, Lohn, Signaturereignisse, Lagerbewegungen) und
  die Teilindizes stehen in handgeschriebenem SQL der Migrationen. Eine
  Wiederherstellung ohne sie liefe — und nähme dann still Änderungen an, die
  die Datenbank sonst verweigert. Gleiche Zeilen beweisen das nicht.

## 2. Örtliche Übung — tatsächlich durchgeführt

Gegen die Testdatenbank (`localhost:5433/clenaris_test`, PostgreSQL 18,
`pg_dump` 18), 2026-09-23:

| Schritt | Ergebnis |
|---|---|
| Sicherung | 27 360 984 Bytes, 1 189 Archiveinträge, SHA-256 geprüft |
| Zurückspielen in Wegwerfdatenbank | fehlerfrei, **14 s** einschliesslich Zählen |
| Vergleich | 29 Tabellen gleich (u. a. 14 436 Einsätze, 15 766 Signaturereignisse, 36 537 Protokolleinträge, 300 Rechnungen) |
| Trigger | 18 = 18, Namensprüfsumme gleich |
| Teilindizes | 11 = 11, Namensprüfsumme gleich |
| Aufräumen | Wegwerfdatenbank gelöscht, Archiv gelöscht |

Damit ist bewiesen: **Das Archivformat trägt Daten, Sperrtrigger und
Teilindizes vollständig, und `pg_restore` lädt die Daten, bevor es die Trigger
anlegt.** Nicht bewiesen ist, dass die Produktion so gesichert wird.

## 3. Befunde

| Nr. | Befund | Schwere | Status |
|---|---|---|---|
| **B-DR-1** | **Keine regelmässige Datenbanksicherung.** Die Produktion wird nur vor einer Migration gesichert. Zwischen zwei Migrationen — Wochen — gibt es keinen Stand. RPO ist damit unbestimmt | Release-Blocker | offen, extern |
| **B-DR-2** | **Sicherung auf demselben Server.** Vorgabe ist `<über der Anwendung>/backups/clenaris-db`. Geht der Server verloren, gehen Datenbank und Sicherung zusammen. Kein zweiter Ort | Release-Blocker | offen, extern |
| **B-DR-3** | **Infrastruktursicherung aus.** `DEPLOYMENT.md` (B5) vermerkt Hetzner-Backup/Snapshot als nicht aktiviert (`backup_window: null`); die Projekt-Erinnerung sagt dasselbe für den neu aufgebauten Server. Nicht nachgeprüft (kein Zugriff) | Release-Blocker | offen, extern |
| B-DR-4 | **Schlüssel getrennt sichern.** Die Auszahlungs-IBAN ist verschlüsselt gespeichert (`KEY_MANAGEMENT.md`). Ein Archiv ohne die Schlüssel aus der `.env` stellt sie nicht lesbar wieder her — und die `.env`-Kopie liegt ebenfalls auf demselben Server | hoch | offen, extern |
| B-DR-5 | **Archive unverschlüsselt.** Das Archiv enthält Lohn, Kundschaft, Prüfprotokoll. Auf dem Server mit 600/700 geschützt; für einen zweiten Ort braucht es Verschlüsselung (etwa `age` oder `gpg`) mit einem Schlüssel, der **nicht** neben dem Archiv liegt | hoch | offen — Auflage für B-DR-2 |
| B-DR-6 | **Dateien.** Mit dem eingebauten Speicher (`LOCAL`) liegen Dateien als Bytes in `stored_files` und sind im Archiv enthalten (örtlich: 6 220 Zeilen gleich). Ist in der Produktion Supabase eingerichtet, liegen sie **ausserhalb** — dann braucht der Speicher eine eigene Sicherung. Welcher Treiber in der Produktion läuft, ist hier nicht feststellbar | mittel | EXTERNAL VERIFICATION REQUIRED |
| B-DR-7 | **Widersprüchliche Doku.** `DEPLOYMENT.md` §9 beschreibt Supabase mit täglicher Sicherung und einen monatlichen `pg_dump` mit der Zugangs-URL in der Befehlszeile; §1 („Zwei Sicherungsebenen") beschreibt den Hetzner-Weg mit `db-backup.ts`. Für den heutigen Betrieb gilt §1; §9 ist Altbestand | niedrig | dokumentiert hier, §9 bei Production V2 bereinigen |
| B-DR-8 | **RPO/RTO nicht festgelegt.** Messbar ist bisher nur die Rückspielzeit örtlich (14 s bei 27 MB). Die Produktion ist kleiner oder grösser — unbekannt | mittel | Entscheid der Geschäftsleitung |
| B-DR-9 | **Aufbewahrung.** Art. 958f OR verlangt zehn Jahre für Geschäftsbücher und Belege. Die Datenbank hält sie (Belege sind unlöschbar); eine Sicherungsreihe mit sieben Ständen deckt keinen Zeitraum ab, sondern nur sieben Migrationen | mittel | offen |

## 4. Empfehlung (nicht umgesetzt — Produktionseingriff)

1. **Täglich** `db-backup.ts --grund taeglich` per systemd-Timer oder Cron auf
   dem Server, danach Kopie an einen zweiten Ort (Hetzner Storage Box oder
   Objektspeicher in der Schweiz), **verschlüsselt** mit einem öffentlichen
   Schlüssel; der private Schlüssel liegt offline. Aufbewahrung gestaffelt
   (z. B. 14 täglich, 12 monatlich, 10 jährlich — Letzteres für Art. 958f OR).
2. Hetzner-Backup für den Server einschalten (ergänzt, ersetzt nicht 1).
3. Die Schlüssel aus der `.env` (`ENCRYPTION_KEY*`, `JWT_SECRET`,
   `CRON_SECRET`) in einem Passwortmanager ausserhalb des Servers führen.
4. **Monatlich** `db-restore-verify.ts` gegen die jüngste Kopie vom
   zweiten Ort — nicht gegen die Datei auf dem Server —, Ergebnis
   protokollieren. (Bis 2026-09-26 stand hier „vierteljährlich"; die
   Überwachung erwartet seither eine bestandene Probe spätestens alle
   35 Tage, `WIEDERHERSTELLUNG_TAGE` in `security-report.service.ts`.)
5. RPO/RTO festlegen; Vorschlag: RPO 24 h, RTO 4 h.
6. Einen Überwacher für das Ausbleiben der Sicherung (dasselbe Werkzeug wie
   für den Cron-Monitor, siehe offene externe Punkte).

## 5. Ablauf bei Totalverlust (Soll, noch nicht geübt)

1. Neuer Server nach `DEPLOYMENT.md` §13.
2. Jüngstes Archiv vom zweiten Ort holen, entschlüsseln, SHA-256 prüfen.
3. `.env` aus dem Passwortmanager, insbesondere **alle** Schlüssel
   einschliesslich ausgemusterter (`KEY_MANAGEMENT.md`).
4. `pg_restore --no-owner --exit-on-error --dbname clenaris <archiv>`, dann
   `npx prisma migrate status` — muss „up to date" melden.
5. `db-restore-verify.ts` ist hier nicht anwendbar (keine Quelle mehr);
   stattdessen Stichproben: letzte Rechnungsnummer, letzte Lohnabrechnung,
   letzter Protokolleintrag gegen das, was ausserhalb dokumentiert ist.
6. Workflow von Hand auslösen; `/api/health` meldet den Commit.

Keiner dieser Schritte ist gegen die Produktion geübt —
**EXTERNAL VERIFICATION REQUIRED**.

## 6. Abnahme vor Production V2 (Stand 2026-09-26)

Eine Hetzner-Server-Sicherung allein **genügt nicht**: Sie liegt beim selben
Anbieter, im selben Konto, ist nicht verschlüsselt unter eigener Kontrolle
und beweist nicht, dass die Datenbank daraus konsistent zurückkommt. Sie
ergänzt die Datenbanksicherung, sie ersetzt sie nicht.

Was **im Code vorhanden** ist (Repository, örtlich geprüft): `db-backup.ts`
(Archiv, Lesbarkeit, SHA-256, Aufbewahrung am Ort), `db-restore-verify.ts`
(Wegwerfdatenbank, Zeilen, Trigger, Teilindizes), beide **melden** an die
Sicherheitszentrale; `/api/cron/status` liefert das Alter der letzten
Sicherung und der letzten bestandenen Probe; `security_check.sh` alarmiert je
Punkt. Was **nicht im Code** ist und zum Betrieb gehört: Zeitplan, Kopie an
einen zweiten Ort, Verschlüsselung, gestaffelte Aufbewahrung.

| Nr. | Punkt | Abnahme (Nachweis) | Stand |
|---|---|---|---|
| BK-1 | Tägliche Sicherung | systemd-Timer/Cron ruft `db-backup.ts --grund taeglich`; zwei aufeinanderfolgende Tage mit `BACKUP_DATEI=` im Journal | offen, extern |
| BK-2 | Prüfsumme | `BACKUP_SHA256` im Journal; nach der Übertragung an den zweiten Ort denselben SHA-256 **dort** berechnen und vergleichen | offen, extern |
| BK-3 | Aufbewahrung am Ort | `CLENARIS_BACKUP_KEEP` gesetzt (z. B. 7); nach acht Läufen sieben Archive | offen, extern |
| BK-4 | Zweiter Ort, ausserhalb des Servers | Storage Box oder Objektspeicher in der Schweiz, **anderes Konto/anderer Zugang** als der Server; Server darf dort nur schreiben, nicht löschen (Append-only/Unveränderlichkeit, falls verfügbar) | offen, extern |
| BK-5 | Verschlüsselung | Archiv vor dem Kopieren mit `age`/`gpg` auf einen öffentlichen Schlüssel verschlüsselt; privater Schlüssel offline, nicht auf dem Server | offen, extern |
| BK-6 | Gestaffelte Aufbewahrung am zweiten Ort | z. B. 14 täglich, 12 monatlich, 10 jährlich (Art. 958f OR); Löschregel dort, nicht auf dem Server | offen, extern |
| BK-7 | Schlüssel und `.env` getrennt | `ENCRYPTION_KEY*` (auch ausgemusterte), `JWT_SECRET`, `CRON_SECRET`, `SECURITY_REPORT_TOKEN` im Passwortmanager ausserhalb des Servers | offen, extern |
| RS-1 | Wiederherstellungsprobe vom zweiten Ort | monatlich: Archiv holen, entschlüsseln, SHA-256 prüfen, `db-restore-verify.ts` → „alle Zeilenzahlen stimmen überein", Trigger und Teilindizes gleich | offen, extern |
| RS-2 | Vollständige Übung | einmal vor Inbetriebnahme Abschnitt 5 auf einem Wegwerfserver durchspielen, Zeit messen (RTO) | offen, extern |
| RS-3 | RPO/RTO beschlossen | Geschäftsleitung; Vorschlag RPO 24 h, RTO 4 h | offen, Entscheid |
| MO-1 | Meldung an die Zentrale | `SECURITY_REPORT_URL`/`SECURITY_REPORT_TOKEN` auf dem Server gesetzt; `/admin/sicherheit` zeigt „Sicherung und Wiederherstellung" mit frischem Bericht | offen, extern |
| MO-2 | Alarm bei Ausbleiben | `/api/cron/status` → `betrieb.sicherung.frisch` / `betrieb.wiederherstellung.frisch`; `security_check.sh` alarmiert `sicherung`/`wiederherstellung` (Probe: Timer einen Tag aussetzen) | Code vorhanden; Einrichtung extern |
| MO-3 | Alarm bei Fehlschlag | `db-backup.ts` meldet bei Fehler `KRITISCH` → Sicherheitsereignis und Alarm; Probe mit falscher `BACKUP_DATABASE_URL` | Code vorhanden; Abnahme extern |
| DT-1 | Dateien | Ist in V2 der eingebaute Speicher (`LOCAL`) aktiv, sind Dateien im Archiv; sonst eigener Sicherungsweg für den Objektspeicher (B-DR-6) | Entscheid bei V2 |

**BACKUP PLAN READY** heisst hier: Die Punkte sind vollständig beschrieben und
der Code trägt sie. **Abgenommen** ist davon nichts — jede Zeile verlangt
einen Nachweis auf der echten Infrastruktur.
