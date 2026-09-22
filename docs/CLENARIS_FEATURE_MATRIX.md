# Clenaris — Feature Matrix

**Stand:** 2026-09-21 · **Grundlage:** Arbeitsbaum, Basis `main` = `7ec5d74`
**Ausführlicher Bericht:** [`CLENARIS_ENTERPRISE_SYSTEM_REPORT.md`](CLENARIS_ENTERPRISE_SYSTEM_REPORT.md)

Die IDs sind stabil und für spätere Entwicklungswellen gedacht.

## Legende

| Kürzel | Bedeutung |
|---|---|
| **C+V** | COMPLETE + VERIFIED — implementiert **und** durch benannte Tests belegt |
| **C** | COMPLETE — implementiert und technisch nutzbar, ohne gezielten Testbeleg |
| **C/EVR** | COMPLETE / EXTERNAL VERIFICATION REQUIRED — Code vollständig, Wirksamkeit aber nur ausserhalb dieses Repositorys nachweisbar (reale Pipeline, echter Anbieter, echte Infrastruktur). **Zählt nicht als erledigt.** |
| **P** | PARTIAL — wesentliche Teile da, Prozess nicht vollständig |
| **BO** | BACKEND ONLY — Logik da, keine Bedienoberfläche |
| **FO** | FRONTEND ONLY — Oberfläche da, Fachlogik fehlt |
| **SO** | SCHEMA ONLY — nur Datenmodell |
| **NI** | NOT IMPLEMENTED |

Spalten `FE` (Frontend), `BE` (Backend), `DB`, `RBAC`, `SEC` (eigener Sicherheitsmechanismus), `T` (HTTP-Prüfung), `E2E` (Browser): `✓` vorhanden · `○` teilweise · `–` nicht vorhanden/nicht anwendbar.

---

## Gesamtverteilung

*Stand nach Wave 9.1 (2026-09-22). Änderungen gegenüber der Erstfassung sind unten begründet; die Anteile sind gerundet.*

| Status | Anzahl | Anteil |
|---|---|---|
| COMPLETE + VERIFIED | **95** | 51 % |
| COMPLETE | **56** | 30 % |
| COMPLETE / EXTERNAL VERIFICATION REQUIRED | **6** | 3 % |
| PARTIAL | **21** | 11 % |
| BACKEND ONLY | **0** | 0 % |
| FRONTEND ONLY | **0** | 0 % |
| SCHEMA ONLY | **3** | 2 % |
| NOT IMPLEMENTED | **4** | 2 % |
| **Summe** | **185** | |

**Technisch nutzbar (C+V oder C): 151 von 185 = 82 %.**
**Durch Tests belegt: 95 von 185 = 51 %.**

> **Diese Zahlen sind ausgezählt, nicht fortgeschrieben.** Sie stammen aus den
> Zeilen dieser Datei selbst:
>
> ```powershell
> Get-Content docs\CLENARIS_FEATURE_MATRIX.md |
>   Where-Object { $_ -match '^\|\s*[A-Z]{1,6}-\d{3}\s*\|' } |
>   ForEach-Object { [regex]::Match($_, '\|\s*\*\*(C\+V|C/EVR|C|P|NI|SO|BO|FO)\*\*\s*\|').Groups[1].Value } |
>   Group-Object | Sort-Object Count -Descending
> ```
>
> Der Anlass ist ein Fehler, den erst dieses Auszählen sichtbar gemacht hat:
> Die Verteilung stand bis Wave 9 auf **59 × C**, gezählt waren es **57**. Eine
> von Hand fortgeschriebene Zusammenfassung läuft still auseinander — und
> gerade eine Statustabelle wird gelesen, als wäre sie gemessen.

> **BACKEND ONLY und FRONTEND ONLY sind beide leer.** Das waren die zwei
> kleinsten Kategorien und die zwei ärgerlichsten: Logik, die niemand bedienen
> kann (Wave 7: Fähigkeiten, Arbeitszeiten), und eine Oberfläche, deren Inhalt
> nicht entstehen konnte (Wave 9: `/portal/lohn`).

### Änderungen in Wave 0

| Änderung | Begründung |
|---|---|
| **INF-001 … INF-004: C → C/EVR** | Die reale Pipeline war noch nie grün (0 von 6 Läufen, 0 Deployments). Code allein ist kein Nachweis, dass eine Auslieferung funktioniert. Auf ausdrücklichen Hinweis hin zurückgestuft. |
| **SEC-021 neu: NOT IMPLEMENTED** | Lohn- und Bankdaten werden **nicht** verschlüsselt — nur AHV-Nummer, Alarmcode und TOTP-Geheimnis. Der Erstbericht hatte das falsch dargestellt. |

### Änderungen in Wave 1

| Änderung | Begründung |
|---|---|
| **SEC-017: P → C+V** | Von den drei gemeldeten Auditlücken waren zwei echt (Tokenausstellung, `employeeIds` der Zuteilung) und sind geschlossen. Die dritte — Objektänderungen — gab es nicht; ich hatte nach Dateilage statt nach Aufrufpfad gemessen. Eine Gegenprüfung in `protokoll-und-schranken.test.ts` hält das fest, statt den Befund stillschweigend zu streichen. |
| **SEC-014, SEC-015: offene Punkte geschlossen** | Alle vier Benachrichtigungsrouten tragen eine Limitklasse; die Tokenausstellung steht im Prüfprotokoll, ohne rohen Token und ohne Hash. Beides wird geprüft, nicht behauptet. |

### Änderungen in Wave 2

| Änderung | Begründung |
|---|---|
| **SEC-020: NI → C/EVR** | Die Kette ist vollständig: Dateipolitik, Prüferabstraktion, ClamAV-Anbindung über `zINSTREAM`, Zustandsautomat mit Quarantäne, Auslieferungstor bei jedem Abruf, Nachlaufskript. Nicht **C+V**, weil in der vertrauenswürdigen Entwicklungsumgebung kein `clamd` läuft — der Adapter ist gegen das Protokoll gebaut, aber nicht gegen einen echten Dienst gelaufen. |
| **SEC-022, SEC-023 neu: C+V** | Dateipolitik und Auslieferungstor sind eigene Eigenschaften mit eigenem Nachweis und hängen nicht am Vorhandensein eines Prüfers. Sie wirken auch dann, wenn gar kein Prüfer eingerichtet ist — dann bleibt jede Datei gesperrt. |

### Änderungen in Wave 3

| Änderung | Begründung |
|---|---|
| **SEC-024 neu: C+V** | „Security Center" stand als MISSING #8 in der Baseline und hatte bis dahin keine Zeile in dieser Matrix — ein Merkmal, das nirgends geführt wird, wird auch nicht vermisst. Es gibt es jetzt: Modell, Katalog, Dienst, Seite, vier Endpunkte, 26 Prüfungen. |
| **SEC-025 neu: C+V** | Der Katalog ist getrennt vom **Anschluss** geführt, und das ist keine Erbsenzählerei: Ein Ereignisstrom, den niemand füllt, ist eine leere Tabelle mit einer schönen Oberfläche davor. Dass sechs Dienste tatsächlich schreiben, ist eine eigene Eigenschaft mit eigenem Nachweis. |

### Änderungen in Wave 4

| Änderung | Begründung |
|---|---|
| **SEC-019: NI → C+V** | Schlüsselbund mit zweitem Lesepfad, Format mit Schlüsselkennung, Rotationsskript mit Statusanzeige. Gegen die Testdatenbank an echten Zeilen gefahren — einschliesslich des Fehlerwegs mit fehlendem Schlüssel. |
| **SEC-021: NI → C/EVR, und umbenannt** | Nicht mehr „Verschlüsselung von Lohn- und Bankdaten", sondern „**Schutz** von Lohn- und Bankdaten". Die Umbenennung ist das Ergebnis: Pauschale Feldverschlüsselung wurde geprüft und verworfen, weil sie die Aggregation in der Datenbank bricht und den Schutz nicht erhöht — die Herleitung des Lohns steht im selben Abzug. Die IBAN ist verschlüsselt, die Zahlenfelder schützt die Ebene darunter. Das ist Betrieb, nicht Code, deshalb **EVR**. |

### Änderungen in Wave 5

| Änderung | Begründung |
|---|---|
| **INF-008: NI → PARTIAL** | Anfragekennung, Kennzahlen je Endpunkt, `/api/metrics`. **Nicht C**, weil Alarmierung und eine Zeitreihe über Neustarts hinweg einen Sammler brauchen — und der ist eine Betriebsentscheidung, keine Codelücke. Die Abgrenzung steht in `docs/OBSERVABILITY.md` §1, damit sie nicht später als Versäumnis gelesen wird. |
| **SEC-026, SEC-027 neu: C+V** | Kennung und Kennzahlen sind getrennt geführt, weil sie Verschiedenes leisten: Die eine verbindet Protokollzeilen einer Anfrage, die andere beantwortet „wie oft und wie lange". Beide sitzen in der Handlerfabrik — der einen Stelle, durch die jeder Endpunkt läuft. |

### Änderungen in Wave 6

| Änderung | Begründung |
|---|---|
| **OPS-010 war zu gut bewertet** | Die Zeile stand auf **C** mit `automation.service.ts` als Beleg — aber der enthält die **fest verdrahteten** Tagesaufgaben, nicht die Regeln, die Benutzer anlegen. Die beiden sind jetzt getrennt (OPS-010 Regeln, OPS-012 feste Läufe), und die Bewertung stimmt wieder. Dass die Baseline dasselbe Merkmal als **FRONTEND ONLY** führte, war der Widerspruch, der die Wave ausgelöst hat. |
| **OPS-011: SO → C+V** | `automation_runs` wurde von keinem Codepfad je beschrieben. Jetzt: Schreibpfad, Beanspruchung in der `where`-Klausel, drei Versuche mit wachsendem Abstand, Ergebnis je Aktion. |
| **INF-009: NI → PARTIAL** | `AutomationRun` **ist** die Warteschlange — mit Beanspruchung, Wiederholung, Obergrenze und Entkopplung. Was fehlt, ist Minutengenauigkeit, und die verlangt einen eigenen Arbeitsprozess. Das ist eine Betriebsentscheidung und kein Codemangel. |

### Änderungen in Wave 7

| Änderung | Begründung |
|---|---|
| **EMP-008, EMP-009: BO → C+V** | Beide Listen wurden gelesen und liessen sich nicht ändern. Die Arbeitszeit entstand beim Anlegen als Mo–Fr 07:00–17:00 und blieb das für immer — für einen Betrieb mit Teilzeit und Schichten keine Vorgabe, sondern eine Behauptung, auf der die Eignungswarnung beruhte. **BACKEND ONLY ist damit leer.** |
| **JOB-010: P → C** | Die Eignungsprüfung wertete die Arbeitszeit aus; was fehlte, war die Pflegemaske. Sie gibt es. |
| **JOB-011 bleibt PARTIAL** | Die Qualifikationen sind jetzt pflegbar, fliessen aber weiterhin **nur in den Personalvorschlag** ein und nicht in die Eignungsprüfung. Eine echte Prüfregel wäre eine fachliche Entscheidung („darf jemand ohne Staplerschein diesen Einsatz übernehmen — Warnung oder Sperre?") und gehört nicht als Nebenwirkung einer Pflegemaske hinein. |

### Änderungen in Wave 8

| Änderung | Begründung |
|---|---|
| **EMP-010 geteilt und geprüft** | Die Zeile stand auf **C** mit dem Vermerk „**Prüfungen**" — und in der Risikoliste auf Platz 9 mit „Grundlage der Lohnabrechnung". Beides zusammen war der Anlass. Das Stempeln (EMP-010) ist jetzt belegt; was darüber hinausging, war gar nicht vorhanden und steht als eigene Zeile. |
| **EMP-015 neu: C** | Ansehen, korrigieren, freigeben. `TimeEntry.approved`, `approvedById` und `manual` standen im Schema und wurden von keinem Codepfad je geschrieben; `timetracking:approve` war an Rollen vergeben und wurde von **nichts** geprüft. Nicht **C+V**, obwohl 22 Prüfungen dahinterstehen: Es fehlt die Ansicht in der Verwaltung, und ohne sie ist der Vorgang für den Betrieb nicht abgeschlossen — die Schnittstelle allein bedient niemand. |

### Änderungen in Wave 9

| Änderung | Begründung |
|---|---|
| **EMP-013: NI → C** | `Payslip` stand seit der ersten Migration im Schema, samt AHV-, ALV-, BVG- und UVG-Spalten — und kein Codepfad hat je eine Abrechnung erzeugt. Jetzt: Beitragsrechnung, Satztabelle je Jahr, Lohnlauf, Veröffentlichung. Nicht **C+V**, weil das PDF fehlt und der Lauf nur über die Schnittstelle zu starten ist. |
| **EMP-014: FO → C+V** | Die Seite `/portal/lohn` war vorhanden und konnte keinen Inhalt bekommen. Jetzt gibt es welchen — und ein Entwurf bleibt für die eigene Person unsichtbar. **FRONTEND ONLY ist damit leer.** |
| **Was ausdrücklich nicht dazukam** | Quellensteuer, Kinderzulagen, 13. Monatslohn, Ferienentschädigung, Naturalleistungen und Lohnausweis. Jedes ist eine eigene Regel mit eigenen Ausnahmen; eine halbe Umsetzung sähe aus wie eine vollständige Abrechnung. Die Abgrenzung steht in `docs/PAYROLL.md` §1 — nicht als Versäumnis, sondern als Entscheidung. |

### Änderungen in Wave 9.1

| Änderung | Begründung |
|---|---|
| **EMP-013: C → P** | Die Einstufung **C** las sich als „Lohnabrechnung fertig", und das ist sie nicht. Was vorhanden ist, ist der **Kern**: Beitragsrechnung (AHV/IV/EO, ALV, BVG, UVG, KTG), Sätze je Organisation und Jahr, Lohnlauf aus freigegebenen Zeiten, Veröffentlichung. Was fehlt, ist weder Randfall noch Kosmetik: PDF, Maske in der Verwaltung, Arbeitgeberbeiträge — und fachlich Quellensteuer, Zulagen, 13. Monatslohn, Ferienentschädigung und Lohnausweis. Nach der Legende dieser Datei ist das **PARTIAL**: wesentliche Teile da, Prozess nicht vollständig. Zusätzlich gilt für jeden gesetzlichen Wert **E-10** — die Sätze sind eine datierte Vorbelegung und keine Wahrheit; solange sie niemand bestätigt hat, meldet jeder Lauf `saetzeGeprueft: false`. |
| **Keine Aussage über Konformität** | Weder „vollständige Schweizer Lohnbuchhaltung" noch „gesetzeskonform" noch „Swiss compliant". Diese Sätze darf nur eine Treuhandstelle sagen, und sie steht als **E-10** in der Baseline. Was hier steht, ist eine Umsetzung des definierten Kernumfangs, überprüfbar, datiert konfigurierbar — mehr nicht. |
| **PDF-Zeile bereinigt** | FILE-006 trug „Lohnabrechnung fehlt" als offenen Punkt und behält ihn; er ist jetzt in EMP-013 sichtbar, statt nur dort zu stehen, wo ihn niemand sucht. |
| **Neu: INF-011 (Hydration/E2E-Zuverlässigkeit) = PARTIAL** | Die Hauptursache des zeitweisen Hydrationsfehlers ist bestimmt und beseitigt — Reacts gedrosselte Suspense-Einblendung, gemessen von 1–7 % auf 0,3–0,5 %. Ein Restfehler bleibt: 16 Browserläufe, 13 grün, 3 rot. Er wird als **offen** geführt und nicht als behoben; neun Ausschlussmessungen, zwei dokumentierte Sackgassen und der nächste Schritt stehen in `docs/HYDRATION.md`. |

---

## SEC — Plattform und Sicherheit (25)

| ID | Feature | FE | BE | DB | RBAC | SEC | T | E2E | Status | Evidence | Missing Work |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SEC-001 | Anmeldung / Abmeldung | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `src/app/api/auth/*`, `auth.service.ts`, `two-factor.test.ts` | – |
| SEC-002 | Passwort-Hashing Argon2id | – | ✓ | ✓ | – | ✓ | ✓ | – | **C+V** | `src/lib/auth/password.ts`, `@node-rs/argon2` | – |
| SEC-003 | Zugangstoken 15 min | – | ✓ | – | – | ✓ | ✓ | – | **C+V** | `src/lib/auth/jwt.ts`, `session-refresh.test.ts` | – |
| SEC-004 | Refresh-Rotation + Leerlauffenster | ✓ | ✓ | ✓ | – | ✓ | ✓ | – | **C+V** | `session-refresh.service.ts`, `session-refresh.test.ts` (5) | – |
| SEC-005 | Sofortiger Sitzungswiderruf | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `User.sessionsRevokedAt`, `two-factor.test.ts` | – |
| SEC-006 | Zwei-Faktor-Anmeldung (TOTP) | ✓ | ✓ | ✓ | – | ✓ | ✓ | – | **C+V** | `totp.ts`, `two-factor.service.ts`, `two-factor.test.ts` (28) | – |
| SEC-007 | Passwort zurücksetzen | ✓ | ✓ | ✓ | – | ✓ | ○ | – | **C** | `/auth/passwort-vergessen`, `/auth/passwort-neu` | eigene Prüfungen |
| SEC-008 | Kontoaktivierung / Einladung | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | `/auth/einladung`, `/auth/verifizieren` | eigene Prüfungen |
| SEC-009 | RBAC — 215 Rechte, 6 Rollen | ✓ | ✓ | – | ✓ | ✓ | ✓ | – | **C+V** | `permissions.ts` (215), `rbac.ts`, `rbac.test.ts` (25) | – |
| SEC-010 | Routen-Wächter (Middleware) | – | ✓ | – | ✓ | ✓ | ✓ | – | **C+V** | `src/middleware.ts`, `ROUTE_GUARDS`, `PERMISSION_ROUTES` | – |
| SEC-011 | Eigentümerfilter in der Abfrage | – | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `ownership.test.ts` (9) | – |
| SEC-012 | Mandantentrennung (`organizationId`) | – | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | 65/117 Modelle, `dispatch.test.ts` | systematische Vollprüfung |
| SEC-013 | CSRF / Herkunftsprüfung | – | ✓ | – | – | ✓ | ○ | – | **C** | `assertTrustedOrigin` in `handler.ts` | eigene Prüfung |
| SEC-014 | Rate-Limiting — 24 Klassen | – | ✓ | – | – | ✓ | ✓ | – | **C+V** | `rate-limit.ts`, `rate-limit.test.ts` (4); Benachrichtigungsrouten seit Wave 1 gedeckt, `protokoll-und-schranken.test.ts` prüft jede | – |
| SEC-015 | Öffentliche Zugriffstokens | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **C+V** | `access-token.service.ts`, 40 Prüfungen; Ausstellung seit Wave 1 protokolliert — ohne rohen Token und ohne Hash | – |
| SEC-016 | Feldverschlüsselung AES-256-GCM | – | ✓ | ✓ | – | ✓ | ✓ | – | **C+V** | `crypto.ts`, `verschluesselung.test.ts` (9) | – |
| SEC-017 | Prüfprotokoll (`AuditLog`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `audit.ts`, 223 Aufrufe / 60 Dateien, `protokoll-und-schranken.test.ts` (24); Wave 1: Tokenausstellung und `employeeIds` der Zuteilung ergänzt — die gemeldete Objektlücke gab es nicht, eine Gegenprüfung hält das fest | – |
| SEC-018 | Sicherheitskopfzeilen / CSP | – | ✓ | – | – | ✓ | ○ | – | **C** | `next.config.ts` | – |
| SEC-019 | Schlüsselrotation | – | ✓ | – | – | ✓ | ✓ | – | **C+V** | Schlüsselbund in `crypto.ts` (`ENCRYPTION_KEY_PREVIOUS`), Format `enc:v2:<kid>`, `scripts/rotate-encryption-key.ts`, `schluesselrotation.test.ts` | `ENCRYPTION_KEY` in der Produktion setzen — ohne ihn ist keine Rotation möglich |
| SEC-020 | Schadsoftwareprüfung bei Uploads | – | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C/EVR** | `src/lib/security/malware/*`, `dateipolitik.ts`, `scanFileAsset`/`authorizeStoredFile` in `file.service.ts`, `scan-backfill.ts`, `dateisicherheit.test.ts` (41) | **PRE-PRODUCTION VERIFICATION REQUIRED** — kein `clamd` in der Entwicklungsumgebung, der ClamAV-Adapter ist gegen das Protokoll gebaut, aber nicht gegen einen echten Dienst gelaufen; Bucket-Sichtbarkeit prüfen |
| SEC-022 | Dateipolitik (Name, Endung, Typ) | – | ✓ | – | – | ✓ | ✓ | – | **C+V** | `src/lib/storage/dateipolitik.ts`, `dateisicherheit.test.ts` | – |
| SEC-023 | Auslieferungstor Zustand × Herkunft | – | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `malware/auslieferung.ts`, `authorizeStoredFile`, 30 Tabellenfälle | Altbestand nachprüfen (`scan-backfill.ts`) |
| SEC-024 | Security Center | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `SecurityEvent`, `lib/security/events.ts`, `security.service.ts`, `/admin/sicherheit`, 4 Endpunkte, `sicherheitszentrum.test.ts` (26) | Aufbewahrungsfrist (Wave 24) |
| SEC-025 | Sicherheitsereignisse an den Zustandsübergängen | – | ✓ | ✓ | – | ✓ | ✓ | – | **C+V** | 6 Dienste angeschlossen: Anmeldung, Zweitfaktor, Sitzungserneuerung, Rollen/Status, Zugangslinks, Dateiprüfung | – |
| SEC-026 | Anfragekennung und Protokollzusammenhang | – | ✓ | – | – | ✓ | ✓ | – | **C+V** | `observability/context.ts`, `X-Request-Id` an jeder Antwort, Kennung im Rumpf einer 500er, `beobachtbarkeit.test.ts` | – |
| SEC-027 | Kennzahlen je Endpunkt | – | ✓ | – | ✓ | ✓ | ✓ | – | **C+V** | `observability/metrics.ts`, `mitBeobachtung` um alle drei Fabriken, `GET /api/metrics` (`security:read`) | Ausleitung an einen Sammler — Betriebsentscheidung, bewusst offen |
| SEC-021 | Schutz von Lohn- und Bankdaten | – | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C/EVR** | Analyse und Entscheid in `docs/KEY_MANAGEMENT.md` §3: **`Employee.iban` verschlüsselt** (Kennung, wird nirgends gerechnet), **Lohnbeträge bewusst nicht** — sie werden in der Datenbank aggregiert (`_avg` in `scenario.service.ts`, SQL-Summe in `analytics.service.ts`); `schluesselrotation.test.ts` prüft beide Hälften | **PRE-PRODUCTION VERIFICATION REQUIRED** — verschlüsselter Datenträger und verschlüsselte Sicherungskopien sind die Massnahme für die Zahlenfelder; das ist Betrieb, nicht Code |

---

## SIG — Elektronische Unterzeichnung (9)

| ID | Feature | FE | BE | DB | RBAC | SEC | T | E2E | Status | Evidence | Missing Work |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SIG-001 | Signaturkern — Bindung an Bytes | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **C+V** | `signature.service.ts`, `signatur.test.ts` (25) | – |
| SIG-002 | Artefakte A / B / C | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **C+V** | `signature-artifacts.ts`, geprüft B≠A, C≠A/B | – |
| SIG-003 | Tokentausch genau einmal sichtbar | ✓ | ✓ | ✓ | – | ✓ | ✓ | ✓ | **C+V** | `signatur.test.ts` | – |
| SIG-004 | Einmalcode — Argon2, Sperre, Einmaligkeit | ✓ | ✓ | ✓ | – | ✓ | ✓ | – | **C+V** | `signature-otp.ts`, `SignatureOtpChallenge` | – |
| SIG-005 | Zustimmung — versioniert, gehasht | ✓ | ✓ | ✓ | – | ✓ | ✓ | ✓ | **C+V** | `src/lib/signature/`, `signatur.test.ts` | – |
| SIG-006 | Append-only Ereignisse (4 Trigger) | – | ✓ | ✓ | – | ✓ | ✓ | – | **C+V** | Migration `…_signatur_kern` | – |
| SIG-007 | Offertannahme mit Unterschrift | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **C+V** | `quote-acceptance.service.ts`, `offertannahme.test.ts` (16), `gate4c` (3) | – |
| SIG-008 | Vor-Ort-Abnahme | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **C+V** | `job-acceptance.service.ts`, `vor-ort-abnahme.test.ts` (19), `gate4d-abnahme` (3) | – |
| SIG-009 | Gerätesperre — 423, Rotationsfamilie | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **C+V** | `device-handoff.service.ts`, `gate4d-sperre` (8) | – |

---

## WEB — Website und CMS (14)

| ID | Feature | FE | BE | DB | RBAC | SEC | T | E2E | Status | Evidence | Missing Work |
|---|---|---|---|---|---|---|---|---|---|---|---|
| WEB-001 | Öffentliche Website — 29 Seiten | ✓ | ✓ | ✓ | – | ✓ | ✓ | – | **C+V** | `src/app/(public)`, `public-site.test.ts` (4) | – |
| WEB-002 | CMS — Bearbeitung in der echten Seite | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `editable.tsx`, `preview-bridge.tsx`, `cms.test.ts` (16) | – |
| WEB-003 | Entwurf → Veröffentlichung → Revisionen | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | Migration `…_content_draft_publish_revisions` | – |
| WEB-004 | SEO-Angaben | ✓ | ✓ | ✓ | ✓ | – | ✓ | – | **C+V** | `/admin/seo`, `cms.test.ts` | – |
| WEB-005 | Handlungsaufrufe (CTA) mit Terminierung | ✓ | ✓ | ✓ | ✓ | – | ○ | – | **C** | `/admin/cta`, 5 Dateien / 8 Ops | Prüfungen |
| WEB-006 | Navigation pflegen | ✓ | ✓ | ✓ | ✓ | – | ✓ | – | **C** | `website-ops.test.ts` | – |
| WEB-007 | Rechtstexte | ✓ | ✓ | ✓ | ✓ | – | ✓ | – | **C** | `website-ops.test.ts` | – |
| WEB-008 | Galerie | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C** | `GalleryItem`, Asset-Allowlist | – |
| WEB-009 | FAQ | ✓ | ✓ | ✓ | ✓ | – | ✓ | – | **C** | `website-ops.test.ts` | – |
| WEB-010 | Blog | ✓ | ✓ | ✓ | ✓ | – | ○ | – | **C** | `/admin/blog`, `BlogPost` | Prüfungen |
| WEB-011 | Bewertungen / Moderation | ✓ | ✓ | ✓ | ✓ | – | ✓ | – | **C** | `review:moderate` | – |
| WEB-012 | Mediathek | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | `/admin/medien`, `media:*` | Prüfungen |
| WEB-013 | Strukturierte Daten | ○ | ○ | – | – | – | – | – | **P** | Metadaten je Seite | Nachweis, Schema.org-Abdeckung |
| WEB-014 | Cookie-/Consent-Steuerung | ○ | – | – | – | – | – | – | **P** | `/legal/cookies` vorhanden | Banner mit Wirkung auf Zähler |

---

## CRM — Kundenbeziehung (10)

| ID | Feature | FE | BE | DB | RBAC | SEC | T | E2E | Status | Evidence | Missing Work |
|---|---|---|---|---|---|---|---|---|---|---|---|
| CRM-001 | Leads / Pipeline | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | `/admin/leads` (+3), 4 Dateien / 6 Ops | Prüfungen |
| CRM-002 | Kundenakte | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `crm.service.ts`, `flows.test.ts` (34) | – |
| CRM-003 | Kundenadressen | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `address.service.ts`, `addresses.test.ts` (28) | – |
| CRM-004 | Kontakte | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | `Contact`, Kundendetail | Prüfungen |
| CRM-005 | Aktivitäten / Zeitachse | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | `/api/activities` | Ändern/Löschen fehlt |
| CRM-006 | Aufgaben | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | `/admin/aufgaben`, `Task` | Prüfungen |
| CRM-007 | Nachrichtenverläufe | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `flows.test.ts`, `ownership.test.ts` | – |
| CRM-008 | Schlagworte (Tags) | ✓ | ✓ | ✓ | ✓ | – | ○ | – | **C** | `Tag`, `LeadTag`, verschachtelt | Prüfungen |
| CRM-009 | Kundenportal — 11 Seiten | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C** | `src/app/(app)/konto`, `smoke.test.ts` | – |
| CRM-010 | Globale Suche | – | – | – | – | – | – | – | **NI** | keine Codestelle | modulübergreifende Suche |

---

## PROP — Objekte (4)

| ID | Feature | FE | BE | DB | RBAC | SEC | T | E2E | Status | Evidence | Missing Work |
|---|---|---|---|---|---|---|---|---|---|---|---|
| PROP-001 | Objekte CRUD | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `property.service.ts`, `ownership.test.ts` | Protokollierung |
| PROP-002 | Alarmcode verschlüsselt | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `CRYPTO_CONTEXT.alarmCode`, `verschluesselung.test.ts` | – |
| PROP-003 | Zugangsdaten nur für die zugeteilte Person | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `job.service.ts:1863`, `dispatch.test.ts` | – |
| PROP-004 | Liegenschaften (`Building`) | – | – | ✓ | – | – | – | – | **SO** | Modell ohne jede Codeberührung | Dienst, Route, Maske |

---

## BOOK — Buchungen (7)

| ID | Feature | FE | BE | DB | RBAC | SEC | T | E2E | Status | Evidence | Missing Work |
|---|---|---|---|---|---|---|---|---|---|---|---|
| BOOK-001 | Online-Buchungsstrecke | ✓ | ✓ | ✓ | – | ✓ | ✓ | – | **C+V** | `features/booking/steps.tsx`, `flows.test.ts` | – |
| BOOK-002 | Preisvorschau serverseitig | ✓ | ✓ | – | – | ✓ | ✓ | – | **C+V** | `/api/public/pricing/estimate`, `catalog.test.ts` | – |
| BOOK-003 | Verfügbarkeit / freie Termine | ✓ | ✓ | ✓ | – | ✓ | ○ | – | **C** | `availability.service.ts` | Prüfungen |
| BOOK-004 | Büroerfassung | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `dispatch.test.ts` (22) | – |
| BOOK-005 | Kundenabgleich / -anlage | – | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `booking.service.ts`, `flows.test.ts` | – |
| BOOK-006 | Stornierung (auch durch Kundschaft) | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | `booking:write_own` | Prüfungen |
| BOOK-007 | Serienbuchungen | ○ | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | `generateRecurringBookings`, Cron | Prüfungen |

---

## QUOTE — Offerten (8)

| ID | Feature | FE | BE | DB | RBAC | SEC | T | E2E | Status | Evidence | Missing Work |
|---|---|---|---|---|---|---|---|---|---|---|---|
| QUOTE-001 | Offerte anlegen, Positionen | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | `quote.service.ts`, `QuoteItem` verschachtelt | Prüfungen der Maske |
| QUOTE-002 | Serverseitige Totale, Rabatt, MwSt. | – | ✓ | ✓ | – | ✓ | ✓ | – | **C+V** | `quote.service.ts:77–125` | – |
| QUOTE-003 | Offert-PDF | – | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **C+V** | `documents.tsx`, `pdf-auslieferung.test.ts` | – |
| QUOTE-004 | Versand mit Zugriffstoken | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **C+V** | `oeffentlicher-zugang.test.ts` (18) | – |
| QUOTE-005 | Annahme mit Unterschrift | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **C+V** | `offertannahme.test.ts` (16), `gate4c` (3) | – |
| QUOTE-006 | Ablehnung (terminal) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **C+V** | `offertannahme.test.ts` | – |
| QUOTE-007 | Ablauf (`validUntil`) | – | ✓ | ✓ | – | ✓ | ✓ | – | **C** | `processExpiringQuotes`, Cron | – |
| QUOTE-008 | Umwandlung in Einsatz / Rechnung | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **P** | `quote:convert` | Prüfungen, Vollständigkeit |

---

## CTR — Verträge und wiederkehrende Leistungen (2)

| ID | Feature | FE | BE | DB | RBAC | SEC | T | E2E | Status | Evidence | Missing Work |
|---|---|---|---|---|---|---|---|---|---|---|---|
| CTR-001 | Vertragsmodell (Laufzeit, Verlängerung, Kündigung) | – | – | – | – | – | – | – | **NI** | kein `Contract` im Schema | vollständig zu bauen |
| CTR-002 | Wiederkehrende Leistungen über Serienbuchung | ○ | ✓ | ✓ | ✓ | ✓ | ○ | – | **P** | `generateRecurringBookings` | Laufzeit, Kündigung, Indexierung |

---

## JOB — Einsätze und Disposition (13)

| ID | Feature | FE | BE | DB | RBAC | SEC | T | E2E | Status | Evidence | Missing Work |
|---|---|---|---|---|---|---|---|---|---|---|---|
| JOB-001 | Einsatz anlegen (aus Buchung/Offerte/manuell) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `job.service.ts`, `dispatch.test.ts` | – |
| JOB-002 | Zustandsmaschine | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | `JobStatus` | Übergangsprüfungen |
| JOB-003 | Team mit mehreren Personen und Rollen | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `jobs.test.ts` (6) | – |
| JOB-004 | Materialverbrauch als Aufwand | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `jobs.test.ts` | – |
| JOB-005 | Lohnkosten aus Team und Plan | – | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `jobs.test.ts` | – |
| JOB-006 | Rapport | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **C+V** | `vor-ort-abnahme.test.ts` | – |
| JOB-007 | Einsatzkalender | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | FullCalendar, `/admin/kalender` | Darstellungsprüfungen |
| JOB-008 | Zuteilung mit Eignungsprüfung | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `assignment.service.ts`, `dispatch.test.ts` | **Protokollierung** |
| JOB-009 | Abwesenheit blockiert / warnt | – | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `dispatch.test.ts` | – |
| JOB-010 | Arbeitszeiten in der Eignungsprüfung | – | ✓ | ✓ | – | – | ✓ | – | **C** | `assignment.service.ts:162`; die Angabe dahinter ist seit Wave 7 pflegbar | – |
| JOB-011 | Fähigkeiten in der Eignungsprüfung | – | ○ | ✓ | – | – | ○ | – | **P** | nur `suggestStaffing`; die Angabe ist seit Wave 7 pflegbar | Eine **echte** Prüfregel in `assignment.service.ts` — heute fliessen Qualifikationen nur in den Vorschlag ein, nicht in die Eignung |
| JOB-012 | Verschieben / Umteilen | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `moveJob`, `dispatch.test.ts` | – |
| JOB-013 | Keine doppelten Einsätze aus einer Buchung | – | ✓ | ✓ | – | ✓ | ✓ | – | **C+V** | `dispatch.test.ts` | – |

---

## EMP — Personal (14)

| ID | Feature | FE | BE | DB | RBAC | SEC | T | E2E | Status | Evidence | Missing Work |
|---|---|---|---|---|---|---|---|---|---|---|---|
| EMP-001 | Personalakte anlegen | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `employee.service.ts`, `employees.test.ts` (10) | – |
| EMP-002 | Profil bearbeiten (inkl. `null`-Leerung) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `employees.test.ts` | – |
| EMP-003 | Lohn-, AHV- und Bankfelder für MANAGER gesperrt | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `employees.test.ts` | – |
| EMP-004 | Lohnhistorie (`SalaryRecord`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `employee.service.ts:132–278` | – |
| EMP-005 | Konto, Zugangslink, Passwortzwang, Sperre | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `employees.test.ts` | – |
| EMP-006 | Rolle über die Personalakte | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C** | `ownership.test.ts` | – |
| EMP-007 | Stilllegen / Personalnummer eindeutig | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C** | `employees.test.ts` | – |
| EMP-008 | Fähigkeiten (`EmployeeSkill`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `PUT /api/employees/{id}/skills`, `EmployeeSkillsDialog`, `personalstammdaten.test.ts` | – |
| EMP-009 | Arbeitszeiten (`Availability`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `PUT /api/employees/{id}/availability`, freie Fensterliste (geteilter Dienst), Überschneidungsprüfung | – |
| EMP-010 | Zeiterfassung — stempeln | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `/api/time/clock-in`, `clock-out`, `/portal/zeiterfassung`, `zeiterfassung.test.ts` | – |
| EMP-015 | Zeiterfassung — ansehen, korrigieren, freigeben | – | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C** | `timetracking.service.ts`, fünf Endpunkte, 22 Prüfungen | Eine Ansicht in der Verwaltung — heute nur über die Schnittstelle |
| EMP-011 | Abwesenheiten (Antrag, Bewilligung, Rückzug) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `crud-audit.test.ts`, `dispatch.test.ts` | – |
| EMP-012 | Stellen und Bewerbungen | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **P** | `/karriere`, `/admin/personal/bewerbungen` | Prüfungen, Bewerberweg |
| EMP-013 | **Lohnabrechnung — definierter Kernumfang** | – | ✓ | ✓ | ✓ | ✓ | ✓ | – | **P** | `lib/payroll/beitraege.ts`, `payroll.service.ts`, `PayrollSetting`, sechs Endpunkte, `lohnabrechnung.test.ts` (26) | **Technisch:** PDF (`pdfUrl` bleibt leer), Maske in der Verwaltung, Arbeitgeberbeiträge. **Fachlich:** Quellensteuer, Kinder- und Ausbildungszulagen, 13. Monatslohn, Ferien- und Feiertagsentschädigung, Naturalleistungen, Lohnausweis — ausdrücklich **nicht** enthalten (`docs/PAYROLL.md` §1). **Keine Aussage über Konformität**: die Sätze sind eine datierte Vorbelegung, jeder Lauf meldet `saetzeGeprueft: false`, bis eine Treuhandstelle sie bestätigt (**E-10**) |
| EMP-014 | Seite `/portal/lohn` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | Die Seite hat seit Wave 9 einen Inhalt: veröffentlichte Abrechnungen. Ein Entwurf existiert für die eigene Person nicht (404) | – |

---

## INV — Finanzen (13)

| ID | Feature | FE | BE | DB | RBAC | SEC | T | E2E | Status | Evidence | Missing Work |
|---|---|---|---|---|---|---|---|---|---|---|---|
| INV-001 | Rechnung anlegen und ausstellen | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `invoice.service.ts`, `flows.test.ts` | – |
| INV-002 | Nummernkreis in der Transaktion | – | ✓ | ✓ | – | ✓ | ○ | – | **C** | `numbering.service.ts` | Nebenläufigkeitsprüfung |
| INV-003 | Swiss QR-Rechnung (SIX v2.3) | – | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **C+V** | `swiss-qr.ts`, `pdf-auslieferung.test.ts` | – |
| INV-004 | Versand mit Zahllink | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `oeffentlicher-zugang.test.ts` | – |
| INV-005 | Mahnlauf | – | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | `processOverdueInvoices`, Cron | Prüfungen |
| INV-006 | Unveränderlichkeit ausgestellter Rechnungen | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C** | `invoice:update` nur Entwurf | – |
| INV-007 | Gutschriften | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | `CreditNote` | Prüfungen |
| INV-008 | Zahlungen manuell verbuchen | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | `payment:create` | Prüfungen |
| INV-009 | Stripe / TWINT | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **P** | `stripe.ts`, Webhook, `stripe-rueckkehr.test.ts` (4) | Durchlauf gegen echtes Stripe, Rückerstattung |
| INV-010 | Datatrans | – | – | – | – | – | – | – | **NI** | nur `.env.example` | vollständig |
| INV-011 | Ausgaben | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | **C** | `/admin/ausgaben`, `Expense` | Prüfungen |
| INV-012 | Lieferanten | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | **C** | `Supplier` | Prüfungen |
| INV-013 | Buchhaltungsexport | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **P** | `accounting:export`, `/api/exports` | Lohn fehlt, Treuhandformat unbelegt |

---

## BI — Unternehmensführung (17)

| ID | Feature | FE | BE | DB | RBAC | SEC | T | E2E | Status | Evidence | Missing Work |
|---|---|---|---|---|---|---|---|---|---|---|---|
| BI-001 | Führungscockpit | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `cockpit.service.ts`, `bi-fuehrung.test.ts` (26) | – |
| BI-002 | Gesundheitswert | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `src/lib/bi/math.ts`, `bi-rechenkerne.test.ts` | – |
| BI-003 | Kennzahlen mit gespeicherter Historie | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `KpiSnapshot`, `kpi.service.ts` | – |
| BI-004 | Rechenkerne (Abschreibung, Varianz, Szenario, Perioden) | – | ✓ | – | – | – | ✓ | – | **C+V** | `bi-rechenkerne.test.ts` (22) | – |
| BI-005 | Ziele / OKR / Strategie / Roadmap | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `objective.service.ts`, `bi-fuehrung.test.ts` | – |
| BI-006 | Budget mit Plan/Ist/Abweichung | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C** | `budget.service.ts` | – |
| BI-007 | Investitionen / Anlagenverzeichnis | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | `investment.service.ts` | Prüfungen |
| BI-008 | Szenarien | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C** | `scenario.service.ts` | – |
| BI-009 | Risikoregister und -matrix | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C** | `governance.service.ts` | – |
| BI-010 | Qualität und Compliance (Kontrollen) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C** | `ControlEntry` | – |
| BI-011 | Massnahmen mit Wirksamkeit | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C** | `Action` | – |
| BI-012 | Dokumentenablage mit Sichtbarkeit | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C** | `documentVisibilityWhere`, Downloads auditiert | – |
| BI-013 | Wissensdatenbank | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | `knowledge.service.ts`, `/portal/wissen` | Prüfungen |
| BI-014 | Markt / Wettbewerb (SWOT, PESTEL) | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **P** | `insight.service.ts` | Prüfungen, Vollständigkeit |
| BI-015 | Sitzungen und Protokolle | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C** | `meeting.service.ts` | Beschlussregister |
| BI-016 | Berichte in drei Formaten + Zeitpläne | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `bi-report.service.ts`, `bi-fuehrung.test.ts` | – |
| BI-017 | KI-Assistent mit Begründung und Quellen | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | **P** | `/api/bi/assistant`, `bi-assistant.service.ts` | Prüfungen |

---

## COM — Kommunikation (7)

| ID | Feature | FE | BE | DB | RBAC | SEC | T | E2E | Status | Evidence | Missing Work |
|---|---|---|---|---|---|---|---|---|---|---|---|
| COM-001 | E-Mail (Resend) | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **P** | `email/client.ts`, Postausgang für Prüfungen | DKIM/SPF/DMARC, Zustellprüfung |
| COM-002 | SMS (Twilio) | ○ | ✓ | ✓ | ✓ | ✓ | – | – | **P** | `sms/client.ts`, `SmsLog` | Prüfungen, Ansicht |
| COM-003 | Nachrichtenvorlagen | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | **C** | `/api/templates` | Prüfungen, Anlegen/Löschen |
| COM-004 | Benachrichtigungszentrum | ✓ | ✓ | ✓ | ✓ | ○ | – | – | **P** | 4 Dateien / 4 Ops | **Rate-Limit**, Prüfungen |
| COM-005 | Newsletter mit Double-Opt-in | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | `/api/newsletter` | Prüfungen |
| COM-006 | Erinnerungen (Termin, Crew, Aufgaben) | – | ✓ | ✓ | – | ✓ | ○ | – | **C** | Cron stündlich/täglich | Prüfungen |
| COM-007 | Interne Nachrichtenverläufe | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `flows.test.ts`, `ownership.test.ts` | – |

---

## OPS — Stammdaten und Plattformbetrieb (11)

| ID | Feature | FE | BE | DB | RBAC | SEC | T | E2E | Status | Evidence | Missing Work |
|---|---|---|---|---|---|---|---|---|---|---|---|
| OPS-001 | Einstellungen (alle Gruppen) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `settings.test.ts` (17) | – |
| OPS-002 | Leistungskatalog / Kategorien / Zusätze | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `catalog.test.ts` (8) | – |
| OPS-003 | Preisregeln und Preis-Engine | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `pricing/engine.ts`, `catalog.test.ts` | – |
| OPS-004 | Steuersätze | ✓ | ✓ | ✓ | ✓ | ✓ | ○ | – | **C** | `TaxRate`, Vorgabe 8,1 % | Prüfungen |
| OPS-005 | Gutscheine | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | **C** | `Coupon`, `coupon:*` | Prüfungen |
| OPS-006 | Einsatzgebiet und Anfahrtspauschalen | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `website-ops.test.ts` | – |
| OPS-007 | Öffnungszeiten und Feiertage | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `crud-audit.test.ts` | – |
| OPS-008 | Papierkorb (7 Datensatzarten) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `trash.service.ts`, `crud-audit.test.ts` | – |
| OPS-009 | Datenbereinigung (`data:purge`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `purge.service.ts`, `purge.test.ts` (7) | – |
| OPS-010 | Automatisierungsregeln (Auslöser → Bedingungen → Aktionen) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `automation-engine.service.ts`, 9 angeschlossene Zustandsübergänge, `automatisierungen.test.ts` (36) | Zeitbezogene Auslöser (`*_REMINDER_*`, `QUOTE_EXPIRING`, `CUSTOMER_BIRTHDAY`) — heute als feste Läufe in `automation.service.ts` |
| OPS-011 | Automatisierungsprotokoll (`AutomationRun`) | – | ✓ | ✓ | – | ✓ | ✓ | – | **C+V** | Schreibpfad, Beanspruchung über die `where`-Klausel, drei Versuche mit wachsendem Abstand, Ergebnis je Aktion | Ansicht in der Oberfläche |
| OPS-012 | Feste Tagesabläufe (Erinnerungen, Bewertungen, Geburtstage) | – | ✓ | ✓ | – | – | ○ | – | **C** | `automation.service.ts`, `/api/cron/*` | eigene Prüfungen |

---

## FILE — Dateien und PDF (7)

| ID | Feature | FE | BE | DB | RBAC | SEC | T | E2E | Status | Evidence | Missing Work |
|---|---|---|---|---|---|---|---|---|---|---|---|
| FILE-001 | Upload mit Ticket und Profilgrenzen | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `file.service.ts`, `datei-integritaet.test.ts` (13) | – |
| FILE-002 | Byteprüfung (echter Typ) | – | ✓ | ✓ | – | ✓ | ✓ | – | **C+V** | `datei-integritaet.test.ts` | – |
| FILE-003 | Abschlussgrenze, Prüfsumme, Nebenläufigkeit | – | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `datei-integritaet.test.ts` | – |
| FILE-004 | Zugriffsbindung (Ablagekennung öffnet nichts) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | **C+V** | `datei-zugriff.test.ts` (11) | – |
| FILE-005 | Objektspeicher Supabase | – | ✓ | ✓ | ✓ | ✓ | – | – | **P** | `storage/supabase.ts`, Rückfall auf Postgres-Blob | Lauf gegen echten Speicher |
| FILE-006 | PDF-Erzeugung (Offerte, Rechnung, Rapport, Bericht) | – | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **C+V** | `src/lib/pdf/` (2 453 Zeilen) | Lohnabrechnung fehlt |
| FILE-007 | Sicherer PDF-Betrachter | ✓ | ✓ | – | ✓ | ✓ | ✓ | ✓ | **C+V** | `gate3-pdf-viewer.spec.ts` (6), `pdf-viewer-mathematik.test.ts` (15) | – |

---

## INF — Infrastruktur, CI/CD, Betrieb (10)

| ID | Feature | FE | BE | DB | RBAC | SEC | T | E2E | Status | Evidence | Missing Work |
|---|---|---|---|---|---|---|---|---|---|---|---|
| INF-001 | CI-Qualitätstor (Lint, Typen, Doku, DB, Build, Tests, Browser) | – | – | – | – | ✓ | ✓ | – | **C/EVR** | `.github/workflows/deploy.yml` | **nie erfolgreich gelaufen** |
| INF-002 | PR-Prüfung ohne Auslieferung | – | – | – | – | ✓ | ✓ | – | **C/EVR** | `auslieferung-absicherung.test.ts` (24) | erster grüner PR-Lauf |
| INF-003 | Deployment-Gating (`DEPLOY_ENABLED`, fail-closed) | – | – | – | – | ✓ | ✓ | – | **C/EVR** | Workflow `if:`, statisch ausgewertet | Variable setzen, wenn V2 steht |
| INF-004 | Auslieferungsskript mit Rücksprung | – | – | – | – | ✓ | ✓ | – | **C/EVR** | `scripts/deploy.sh` (502 Zeilen) | nie gelaufen |
| INF-005 | Datenbanksicherung fail-closed | – | ✓ | ✓ | – | ✓ | ✓ | – | **C+V** | `db-backup.ts`, `datenbanksicherung.test.ts` (19) | – |
| INF-006 | Wiederherstellungsprobe mit Namensschutz | – | ✓ | ✓ | – | ✓ | ✓ | – | **C+V** | `db-restore-verify.ts` | echter Produktionslauf |
| INF-007 | Health-Endpunkt mit Commit-Abgleich | – | ✓ | ✓ | – | ✓ | ✓ | – | **C** | `/api/health`, `APP_VERSION` | – |
| INF-008 | Beobachtbarkeit (Fehlerverfolgung, Alarm) | – | ✓ | – | ✓ | ✓ | ✓ | – | **P** | Seit Wave 5: Anfragekennung, Kennzahlen je Endpunkt, `/api/metrics`, `/api/health`. **Kein Anbieter** — das ist die Abgrenzung, nicht die Lücke (`docs/OBSERVABILITY.md` §1) | Alarmierung und Zeitreihe über Neustarts hinweg brauchen einen Sammler — Betriebsentscheidung |
| INF-009 | Warteschlange für Hintergrundarbeit | – | ✓ | ✓ | – | ✓ | ✓ | – | **P** | `AutomationRun` **ist** die Warteschlange: Beanspruchung in der `where`-Klausel, Wiederholung mit wachsendem Abstand, Obergrenze je Lauf, Entkopplung vom Geschäftsvorgang. Angetrieben vom Scheduler | Ein eigener Arbeitsprozess brächte Minutengenauigkeit — Betriebsentscheidung, kein Codemangel (`docs/AUTOMATION.md` §10) |
| INF-010 | Cloudflare- und Firewall-Topologie | – | – | – | – | ○ | – | – | **NI** | `TRUSTED_PROXY_MODE` vorbereitet | V2-Server |
| INF-011 | **Hydrations- und Browserlauf-Zuverlässigkeit** | ✓ | – | – | – | – | – | ✓ | **P** | Wave 9.1: Hydrationswache an **jedem** Browserfall (`tests/e2e/helpers/diagnose.ts`), verschiebbares Bauverzeichnis, Diagnoseserver, Stressreihe. Hauptursache (Reacts gedrosselte Suspense-Einblendung) bestimmt und beseitigt: Rate von 1–7 % auf 0,3–0,5 % | **Restfehler offen.** 16 Browserläufe, 13 grün, 3 rot — das Tor „fünf aufeinanderfolgende 20/20" ist einmal erreicht und zweimal verfehlt. Ort eingegrenzt (Anwendungsrahmen, Elementebene, unverändertes DOM), Ursache nicht bestimmt. Neun Ausschlussmessungen und der Weg weiter in `docs/HYDRATION.md` §9 |

---

## X — Querschnitt (9)

| ID | Feature | FE | BE | DB | RBAC | SEC | T | E2E | Status | Evidence | Missing Work |
|---|---|---|---|---|---|---|---|---|---|---|---|
| X-001 | Validierung (Zod, 28 Module, eine Quelle) | ✓ | ✓ | – | – | ✓ | ✓ | – | **C+V** | `src/lib/validation/`, OpenAPI abgeleitet | Antwortvalidierung |
| X-002 | Typisierte Fehlerklassen (12) | ✓ | ✓ | – | – | ✓ | ○ | – | **C** | `src/lib/errors.ts` | `VALIDATION_ERROR` doppelt belegt |
| X-003 | Caching (Redis mit Prozessrückfall) | – | ✓ | – | – | – | ○ | – | **C** | `src/lib/redis.ts` | – |
| X-004 | Strukturiertes Logging | – | ✓ | – | – | ✓ | – | – | **C** | `src/lib/logger.ts` | Rotation erzwingen |
| X-005 | Mehrsprachigkeit | – | – | ✓ | – | – | – | – | **SO** | `Locale` DE/EN/FR/IT, keine i18n-Bibliothek | Bibliothek, Routen, Übersetzungen |
| X-006 | Barrierefreiheit | ○ | – | – | – | – | ○ | ○ | **P** | Signatur/PDF geprüft, kein axe | axe in die Browserreihe |
| X-007 | Responsive / Mobil | ✓ | – | – | – | – | ✓ | ✓ | **P** | `tables.test.ts`, `gate4d` Telefonfall | breitere Abdeckung |
| X-008 | Performance | ○ | ○ | ✓ | – | – | – | – | **P** | 150 Indizes, Caching, Bündel 103 kB | Budgets, Lasttest, N+1-Messung |
| X-009 | Landingpages (`LandingPage`) | – | – | ✓ | – | – | – | – | **SO** | nirgends erreichbar | Dienst, Route, Maske |

---

## Statuszählung je Domäne

| Domäne | Merkmale | C+V | C | C/EVR | P | BO | FO | SO | NI |
|---|---|---|---|---|---|---|---|---|---|
| SEC — Plattform und Sicherheit | 21 | 12 | 5 | – | 1 | – | – | – | 3 |
| SIG — Unterzeichnung | 9 | 9 | – | – | – | – | – | – | – |
| WEB — Website und CMS | 14 | 4 | 8 | – | 2 | – | – | – | – |
| CRM — Kundenbeziehung | 10 | 3 | 6 | – | – | – | – | – | 1 |
| PROP — Objekte | 4 | 3 | – | – | – | – | – | 1 | – |
| BOOK — Buchungen | 7 | 4 | 3 | – | – | – | – | – | – |
| QUOTE — Offerten | 8 | 5 | 2 | – | 1 | – | – | – | – |
| CTR — Verträge | 2 | – | – | – | 1 | – | – | – | 1 |
| JOB — Einsätze und Disposition | 13 | 9 | 2 | – | 2 | – | – | – | – |
| EMP — Personal | 14 | 5 | 4 | – | 1 | 2 | 1 | – | 1 |
| INV — Finanzen | 13 | 3 | 7 | – | 2 | – | – | – | 1 |
| BI — Unternehmensführung | 17 | 6 | 9 | – | 2 | – | – | – | – |
| COM — Kommunikation | 7 | 1 | 3 | – | 3 | – | – | – | – |
| OPS — Stammdaten und Betrieb | 11 | 7 | 3 | – | – | – | – | 1 | – |
| FILE — Dateien und PDF | 7 | 6 | – | – | 1 | – | – | – | – |
| INF — Infrastruktur und CI/CD | 10 | 2 | 1 | 4 | – | – | – | – | 3 |
| X — Querschnitt | 9 | 1 | 3 | – | 3 | – | – | 2 | – |
| **Summe** | **176** | **80** | **56** | **4** | **19** | **2** | **1** | **4** | **10** |

---

## Die 12 Merkmale, die einer Inbetriebnahme im Weg stehen

Nach Priorität, mit ID:

| Rang | ID | Merkmal | Status | Warum jetzt |
|---|---|---|---|---|
| 1 | INF-001/002 | Pipeline zum ersten Mal grün | C, nie gelaufen | Ohne Nachweis ist jede Auslieferung ein Erstversuch |
| 2 | SEC-019 | `ENCRYPTION_KEY` vor dem ersten Wert | NI | Danach unwiderruflich |
| 3 | EMP-013 | Lohnabrechnung | NI | Kernprozess endet im Nichts |
| 4 | INF-008 | Beobachtbarkeit | NI | Fehler fallen durch Anrufe auf |
| 5 | INF-010 | Firewall- und Cloudflare-Topologie | NI | `TRUSTED_PROXY_MODE` hängt daran |
| 6 | INV-009 | Stripe produktiv erproben | P | Geldfluss unbelegt |
| 7 | COM-001 | DKIM/SPF/DMARC | P | Ohne DKIM landet die Rechnung im Spam |
| 8 | SEC-017 | Drei Auditlücken | P | Zugangsrelevante Handlungen |
| 9 | EMP-010 | Zeiterfassung prüfen | C, ungeprüft | Grundlage der Lohnabrechnung |
| 10 | EMP-008/009 | Fähigkeiten und Arbeitszeiten pflegbar | BO | Disposition rechnet mit unveränderlichen Daten |
| 11 | CTR-001 | Vertragsmodell | NI | Unterhaltsreinigung ist das Kerngeschäft |
| 12 | COM-004 | Benachrichtigungen mit Rate-Limit | P | Vier offene Endpunkte |

---

*Erhoben am 2026-09-21 gegen den Arbeitsbaum. Statusvergabe nach den Regeln in `CLENARIS_ENTERPRISE_SYSTEM_REPORT.md`; `C+V` nur, wo eine benannte Testdatei das Merkmal abdeckt.*
