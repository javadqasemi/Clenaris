# Pendenzen — Register der Mission vom 2026-09-28

> Zweig `feature/produkt-ux-sicherheit-2026-09-28`, Ausgang `241d8d5`.
> Jeder Punkt, der in dieser Mission auftaucht, steht hier — auch der, der
> nicht behoben wurde. **Kein Punkt verschwindet still**: Ein erledigter Punkt
> wechselt den Status und bekommt Beleg und Commit, er wird nicht gelöscht.

Status: `OPEN` · `IN PROGRESS` · `CODE COMPLETE` (Code und Prüfung da, Vollauf
steht aus) · `VERIFIED` (in der Vollprüfung grün) · `EXTERNAL EVIDENCE
REQUIRED` · `CLOSED` (ohne Änderung erledigt, z. B. bereits behoben).

Priorität: **P0** Datenverlust/Sicherheitsbruch jetzt · **P1** falsche Beträge,
Zugriff über Kunden- oder Mandantengrenze, Kernablauf unbenutzbar · **P2**
Robustheit, Randfall, Verteidigung in der Tiefe · **P3** Pflege.

## B — Nachprüfung früherer Befunde (gegen `241d8d5`)

Nicht aus den Berichten übernommen, sondern am Code nachgelesen (drei
Durchgänge: Finanzen, Zugriff, Infrastruktur).

| ID | Bereich | Befund | Prio | Status | Beleg / Prüfung | Commit | Extern |
|---|---|---|---|---|---|---|---|
| B-01 | Finanzen | Rechnung: `bookingId`/`quoteId` beim Anlegen ungeprüft (fremde Kundschaft; Kundenkonto sieht fremde Rechnung an eigener Buchung) | P1 | CODE COMPLETE | `invoice.service.ts` createInvoice; keine Prüfung; `sicherheitsluecken.test.ts` „Rechnung nimmt keine Buchung … anderen Kundschaft" | | |
| B-02 | Finanzen | Erstattungen monoton und idempotent | — | CLOSED (bereits behoben) | `erstattungsstandUebernehmen` FOR UPDATE, `zahlungsbuch.test.ts`, `nebenlaeufigkeit.test.ts` | | |
| B-03 | Finanzen | Ausstellen gegen Löschen eines Entwurfs: nummerierte Rechnung kann weich gelöscht werden (Lücke nach Art. 957a OR) | P1 | CODE COMPLETE | `trash.service.ts` prüft DRAFT ohne Sperre; `issueInvoice` prüft `deletedAt` nicht unter Sperre; `nebenlaeufigkeit.test.ts` „Ausstellen und Löschen … gleichzeitig" | | |
| B-04 | Finanzen | QR-Referenz wiederholt sich jedes Jahr (Zähler ohne Jahr) | P1 | CODE COMPLETE | `swiss-qr.ts` buildQrReference; `nebenlaeufigkeit.test.ts` „QR-Referenz … Jahr und Laufnummer" | | |
| B-05 | Finanzen | Entwurfsplatzhalter `ENTWURF-<ms>` kollidiert bei zwei Entwürfen in derselben Millisekunde → 500 | P2 | CODE COMPLETE | `invoice.service.ts`; `nebenlaeufigkeit.test.ts` „fünf Entwürfe gleichzeitig angelegt" | | |
| B-06 | Geld | Vertragsabrechnung rechnet mit Gleitkomma (`Math.round(x*100)/100`), 90 min × 12.35 → 18.52 statt 18.53 | P1 | CODE COMPLETE | `contract.service.ts` Abrechnungsgrundlage; `vertraege-rechenkern.test.ts` „Vertragsabrechnung — Betrag dezimal" (5 Fälle, alle vorher ein Rappen zu wenig) | | |
| B-07 | Geld | Excel-Summen und MWST-Bericht als Gleitkommasummen | P2 | OPEN | `export.service.ts`, `analytics.service.ts` | | |
| B-08 | Geld | `BEZAHLT_TOLERANZ` 0.05 markiert bezahlt, gespeicherter Saldo bleibt 0.05 | P2 | OPEN | `invoice.service.ts` | | |
| B-09 | Lohn | Lohn-PDF nur eigene, nur veröffentlicht; Veröffentlichen idempotent | — | CLOSED (bereits behoben) | `lohnabrechnung.test.ts` | | |
| B-10 | Mandant | Lesen mandantengetrennt; `where`-Spread-Falle nicht mehr vorhanden | — | CLOSED (bereits behoben) | `mandanten.test.ts` | | |
| B-11 | IDOR | Vertrag: `propertyId` ungeprüft, `quoteId` nicht gegen Kundschaft, verantwortliche Personen nicht gegen Organisation | P1 | CODE COMPLETE | `contract.service.ts` create/update; `vertraege.test.ts` „Bezüge des Vertrags"; Prüfbestand in 4 Dateien korrigiert (setzte fremde Objekte voraus) | | |
| B-12 | IDOR | Kundschaft hängt Nachrichtenverlauf an fremden Einsatz (nur Organisation geprüft) | P1 | CODE COMPLETE | `message.service.ts`; `sicherheitsluecken.test.ts` „Nachrichtenverlauf zu einem fremden Einsatz" | | |
| B-13 | Mandant | Schreibseitige Fremdschlüssel ohne Organisationsprüfung (Lieferant, Verantwortliche, Eltern-Ziel, Sitzung, Kennzahl am Schlüsselergebnis) | P2 | VERIFIED | `bezug.service.ts`; `mandanten.test.ts` „Verweise der Führung und der Finanzen" — Produktionsbau 64/0 | 4b56a4b | |
| B-14 | Dateien | Dateizugriff: Bindung, Scan-Tor, Prüfsumme | — | CLOSED (bereits behoben) | `datei-zugriff.test.ts`, `dateisicherheit.test.ts` | | |
| B-15 | Sitzung | Refresh-Token einmalig, Familie bei Wiederverwendung gesperrt | — | CLOSED (bereits behoben) | `session-refresh.test.ts` | | |
| B-16 | Dateien | Upload-Bytes einmalig; Signaturartefakte B/C bei Übernahme eines hängenden Abschlusses überschreibbar | P2 | OPEN | `signature.service.ts` Pfad ohne Versuchskennung | | |
| B-17 | Automation | Hängende Läufe ohne Lease wieder freigegeben; Aktion kann bei gestopptem Worker doppelt laufen | P2 | OPEN | `automation-engine.service.ts` | | |
| B-18 | SSRF | Webhook-Ziel inkl. DNS-Rebinding geprüft; `64:ff9b:1::/48`, `192.88.99.0/24` fehlen | P3 | OPEN | `lib/automation/webhook.ts` | | |
| B-19 | Zuteilung | Nebenläufige Zuteilung gesperrt; Automation `UPDATE_STATUS` reaktiviert abgesagten Einsatz ohne Überschneidungsprüfung | P2 | OPEN | `automation-engine.service.ts` | | |
| B-20 | Ablage | `scopeId` frei (max. 60 Zeichen) im Speicherschlüssel, auch anonym (`../`) | P1 | CODE COMPLETE | `lib/validation/files.ts`, `tickets.ts`; `dateisicherheit.test.ts` „Zuordnung mit Pfadzeichen" | | |
| B-21 | Protokoll | Prüfprotokoll durchweg geschwärzt | — | CLOSED (bereits behoben) | `protokoll-schwaerzung.test.ts` | | |
| B-22 | Buchung | Gutscheinlimit wird vor der Transaktion geprüft, Zählung ohne Bedingung → Überbuchung des Gutscheins | P1 | CODE COMPLETE | `pricing/engine.ts`, `booking.service.ts`; `buchung-integritaet.test.ts` „Limit 2, fünf gleichzeitig" und „Kleinbuchstaben" | | |
| B-23 | Buchung | Doppelte Übermittlung erzeugt zwei Buchungen (kein Idempotenzschlüssel) | P2 | OPEN | `booking.service.ts` | | |
| B-24 | Konvention | Inline-`z.object` in `api/contracts/route.ts` | P3 | CODE COMPLETE | CLAUDE.md: Schemas nur in `lib/validation`; 12 Routen, OpenAPI bytegleich | | |

## C — Offerte: Rabattart und Navigation

| ID | Bereich | Befund | Prio | Status | Beleg / Prüfung | Commit | Extern |
|---|---|---|---|---|---|---|---|
| C-01 | UI | Seitenleiste/Kopfzeile verschwinden bei geöffneter Auswahl (html `overflow-x: clip` blockiert die Weitergabe der Scrollsperre) | P1 | CODE COMPLETE | `tests/e2e/offerte-rabatt.spec.ts` (vorher rot) | c28328e | |
| C-02 | Offerte | „Kein Rabatt" wird nicht gespeichert | P1 | CODE COMPLETE | `flows.test.ts` „Offerte speichern wie die Maske" | c28328e | |
| C-03 | Formulare | Jedes Datumsfeld (`dateOnlySchema`) über `zodResolver` → 422; Offerte weder anlegen noch bearbeiten | P1 | CODE COMPLETE | `flows.test.ts`, Browserfall | c28328e | |
| C-04 | Formulare | Englische Zod-Meldungen in der Oberfläche | P2 | CODE COMPLETE | `flows.test.ts` | c28328e | |
| C-05 | Offerte | PATCH nur mit Rabatt rechnet die Summen nicht neu | P2 | CODE COMPLETE | `flows.test.ts` | c28328e | |

## D — Bilder, Firefox und die anderen Engines

| ID | Bereich | Befund | Prio | Status | Beleg / Prüfung | Commit | Extern |
|---|---|---|---|---|---|---|---|
| D-01 | Website | Gemeldet: Bilder (Vorher/Nachher) in Firefox erst nach mehrmaligem Neuladen. Lokal in Firefox **nicht** nachstellbar: hochgeladene Bilder in allen sechs Lagen (kalt, warm, Neuladen, Linkwechsel, langsam, mobil) dekodiert | P1 | EXTERNAL EVIDENCE REQUIRED | `tests/e2e/bilder.browser.spec.ts` Chromium/Firefox/WebKit 15/15 gegen den Produktionsbau | 4e81670 | Firefox gegen die Produktionsadresse (Cloudflare, https, echte Galerie) — Abnahme: Galerie und Startseite in Firefox mit leerem Cache öffnen, Netzwerkpanel: Status und Typ jeder `/api/files/blob/*`-Antwort; dazu `scripts/abnahme/bilder-browser.ts` |
| D-02 | Website | WebKit: `upgrade-insecure-requests` stuft auf http-Auslieferung jede Unteranfrage auf https hoch (auch Loopback) — Seite ungestylt, Bilder leer | P1 | VERIFIED | Probe „SSL connect error" vor, 15/15 nach der Korrektur | 4e81670 | |
| D-03 | Demodaten | Demogalerie veröffentlicht Adressen `/gallery/*.jpg`, die es nie gab — kaputte Bilder in jedem Browser | P2 | VERIFIED | Seed zieht solche Einträge zurück; Bildprüfung ohne kaputte Bilder | 4e81670 | Produktion: prüfen, ob dort Demo-Galerieeinträge veröffentlicht sind (Notfallauftrag 2026-09-27: Demodaten in Prod) |

## K — Sitzung

| ID | Bereich | Befund | Prio | Status | Beleg / Prüfung | Commit | Extern |
|---|---|---|---|---|---|---|---|
| K-01 | Anmeldung | „Angemeldet bleiben" war eine Scheinfunktion: geprüft, verworfen, jede Sitzung 30 Tage persistent; Kästchen vorausgewählt | P1 | CODE COMPLETE | `session-refresh.test.ts` „Sitzungscookies" | | |
| K-02 | Sitzung | Ein Tab im Hintergrund meldete die ganze Sitzung ab, während im anderen gearbeitet wurde | P1 | CODE COMPLETE | `tests/e2e/sitzung-tabs.spec.ts` | | |
| K-03 | Sitzung | Abmeldung erreichte die anderen Tabs nicht | P2 | CODE COMPLETE | `tests/e2e/sitzung-tabs.spec.ts` | | |
| K-04 | Sitzung | Warnung vor Ablauf mit Weiterarbeiten/Abmelden | P2 | CODE COMPLETE | `tests/e2e/sitzung-tabs.spec.ts` | | |
| K-05 | Doku | Grenzen (Schliessen nicht erkennbar, Sitzungswiederherstellung) | — | CODE COMPLETE | `docs/SITZUNG.md` | | |

## N, O, P, Q — Arbeitsweise

| ID | Bereich | Aufgabe | Prio | Status | Beleg | Commit | Extern |
|---|---|---|---|---|---|---|---|
| N-01 | Skill | `.claude/skills/security/SKILL.md` | P1 | CODE COMPLETE | Prüftabelle mit Clenaris-Wegen | | |
| O-01 | Skill | `.claude/skills/ui-ux/SKILL.md` | P1 | CODE COMPLETE | Bausteine, Ebenen, Engines, Zustände | | |
| P-01 | Skill | `.claude/skills/pendenzen/SKILL.md` | P1 | CODE COMPLETE | Vorher suchen, nichts still löschen, Löschdetektor, Register | | |
| Q-01 | DoD | Pflichtablauf (15 Schritte), browserübergreifende Zeile, Verweis in `.claude/rules/engineering.md` | P1 | CODE COMPLETE | `docs/ENGINEERING_DEFINITION_OF_DONE.md` | | |
