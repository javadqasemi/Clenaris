# Lohnabrechnung

> Stand: 23. September 2026 (Wave 9, technischer Ausbau).
> **Keine Aussage „Swiss Payroll compliant".** Die Rechnung ist technisch
> geprüft; Sätze, Tarife, Ziffernzuordnung und Konventionen sind fachlich
> **nicht** bestätigt (§11).

---

## 1. Statusinventar

Begriffe: **IMPLEMENTED** = Ablauf funktioniert Ende zu Ende und ist mit
Prüfungen belegt · **PARTIAL** = funktioniert mit benannten Lücken ·
**MISSING** = fehlt · **EXTERNAL VERIFICATION REQUIRED** = technisch
umgesetzt, fachlich/extern zu bestätigen.

| Punkt | Status | Beleg / Lücke |
|---|---|---|
| Lohnlauf je Monat (idempotent, gleichzeitige Läufe) | IMPLEMENTED | `generatePayslips`; Prüfung „zwei gleichzeitige Läufe" |
| Payslip mit Zeilen (`PayslipLine`) | IMPLEMENTED | Zeilen je Bestandteil, Lohnausweis-Ziffer je Zeile |
| Beitragsrechnung AN: AHV/IV/EO, ALV, UVG-NBU, KTG, BVG | IMPLEMENTED · Sätze EXTERNAL VERIFICATION REQUIRED | `beitraege.ts`, Prüfungen mit festen Zahlen |
| AHV, IV, EO | IMPLEMENTED (zusammen als ein Satz) · EXTERNAL | Satzversion `AHV_IV_EO` |
| ALV (bis Grenze / darüber) | IMPLEMENTED · EXTERNAL | Grenze durch 12 (§5) |
| BVG | IMPLEMENTED · Plan EXTERNAL | koordinierter Lohn, Altersbänder, Art. 66 BVG |
| UVG-BU / NBU | IMPLEMENTED · EXTERNAL | NBU Arbeitnehmende, BU Betrieb |
| KTG | IMPLEMENTED · EXTERNAL | AN- und AG-Anteil je Version |
| Arbeitgeberbeiträge (AHV, ALV, UVG, KTG, FAK, VK, BVG) | IMPLEMENTED · EXTERNAL | informative Zeilen, `employerContributions` |
| Versionierte, stichtagsbezogene Sätze mit Herkunft und Prüfstand | IMPLEMENTED | `PayrollRate`, Ausschlussbedingung, Trigger |
| Historische Abrechnung reproduzierbar | IMPLEMENTED | Momentaufnahme `satzversionen` + gesperrte Versionen + PDF-Bytes |
| Quellensteuer | IMPLEMENTED (Grenze/Motor) · **EXTERNAL VERIFICATION REQUIRED** | Profil, Tarifimport, Prüfung, Handeingabe; **keine Tarife mitgeliefert** |
| Zulagen (beitragspflichtig) / Familienzulagen | IMPLEMENTED · Einstufung EXTERNAL | `PayrollItem` ALLOWANCE / FAMILY_ALLOWANCE |
| Überstunden | IMPLEMENTED | Stunden × Ansatz × Zuschlag, vom Server gerechnet |
| 13. Monatslohn (keiner/jährlich/anteilig/monatlich, Auszahlungsmonat) | IMPLEMENTED · Vertragsauslegung EXTERNAL | Ein-/Austritt, Lohnänderung, unbezahlter Urlaub, Korrektur |
| Ferienentschädigung (Stundenlohn) | IMPLEMENTED · EXTERNAL | aus Ferientagen der Akte (w/(52−w)) |
| Feiertagsentschädigung (Stundenlohn) | IMPLEMENTED · EXTERNAL | vertraglicher Prozentsatz je Person |
| Spesen | IMPLEMENTED | nicht beitragspflichtig, nicht steuerbar |
| Korrekturen | IMPLEMENTED | CORRECTION (±, beitragspflichtig), NET_CORRECTION (±), Verweis auf korrigierte Abrechnung |
| Unbezahlter Urlaub | IMPLEMENTED · Werktage-Konvention EXTERNAL | bewilligte `UNPAID`-Abwesenheiten |
| Ein-/Austritt, Lohnänderung im Monat | IMPLEMENTED · Kalendertage-Konvention EXTERNAL | vorher: immer voller Monatslohn, Ausgetretene fehlten |
| Sperre (Locking) | IMPLEMENTED | Dienst + Trigger auf Abrechnung, Zeilen, Positionen, Sätze |
| Veröffentlichen | IMPLEMENTED | Prüfung, Bestätigung ungeprüfter Sätze, `updatedAt`-Bedingung |
| Payslip-PDF | IMPLEMENTED | einmal beim Veröffentlichen, gespeichert, Prüfsumme |
| Mitarbeiterportal | IMPLEMENTED | `/portal/lohn`: veröffentlichte Abrechnungen, PDF, Lohnausweis-Aufstellungen |
| Verwaltungsoberfläche | IMPLEMENTED | `/admin/lohn`, `/admin/lohn/[id]` |
| Lohnausweis | PARTIAL · **EXTERNAL VERIFICATION REQUIRED** | Aufstellung (Ziffern 1, 7, 8, 9, 10.1, 11, 12, 13.1.1); **nicht** Formular 11 |
| Naturalleistungen, Kantine, Fahrten, Aussendienst | MISSING | Ziffern 2, 3–6, 13.2, 15 des Formulars |
| Jahresabrechnung Ausgleichskasse, ELM/Swissdec | MISSING | eigene Pflicht, eigenes Format |
| Quellensteuer-Jahreskorrektur (Tarif mit Jahresabgleich, Kantone mit Jahresmodell) | MISSING | nur Monatsmodell |

---

## 2. Die Sätze: Versionen statt Jahreszeilen

`PayrollRate` — je Organisation und **Beitragsart** (`AHV_IV_EO`, `ALV`,
`ALV_SOLIDARITY`, `UVG_NBU`, `UVG_BU`, `KTG`, `FAK`, `VK`, `BVG`) Versionen
mit `validFrom`/`validUntil` (einschliesslich), Arbeitnehmer- und
Arbeitgeberanteil, Schwellen (`thresholdMin`/`thresholdMax`), Parametern
(BVG: Eintrittsschwelle, Koordinationsabzug, Mindest- und Obergrenze,
Altersbänder), **Herkunft** (`source`, `reference`) und **Prüfstand**
(`verification`, `verifiedAt`, `verifiedById`, `verificationNote`).

- **Keine Überschneidung je Art** — Ausschlussbedingung
  `payroll_rates_ueberlappungsfrei` (btree_gist, `daterange … '[]'`). Seit
  2026-09-30 steht sie mit `withholding_tax_profiles_ueberlappungsfrei`, den
  Prüfbedingungen des Lohns (`payroll_rates_prozent`, `payroll_rates_zeitraum`,
  `payroll_items_monat`, `employee_payroll_profiles_monat`,
  `withholding_tax_*`) und den Lohn-Triggern samt Funktionsrumpf im Register
  `security/datenbank-schranken.json`; das Datenbanktor
  (`scripts/datenbank-schranken.ts`) meldet eine fehlende, nicht validierte
  oder abgeschaltete Schranke — `migrate dev` kann sie damit nicht mehr
  unbemerkt verwerfen.
- **Gerechnet wird mit der Version am letzten Tag des Monats.** Die
  Abrechnung speichert die Kennungen (`rateVersionIds`) und eine
  Momentaufnahme (`breakdown.satzversionen`).
- **Unveränderlich, sobald benutzt.** Hat eine veröffentlichte Abrechnung mit
  einer Version gerechnet, lehnt der Dienst Wertänderungen ab, und der Trigger
  `payroll_rates_unveraenderlich` verweigert sie ebenfalls. Erlaubt bleiben
  Prüfvermerk und Ende. Eine neue Version darf eine benutzte Vorgängerin nur
  nach deren letztem veröffentlichten Monat schliessen.
- **Fehlt eine Version**, legt der Lauf eine **ungeprüfte** an: Werte der
  vorigen Version, sonst die Vorbelegung (`SAETZE_2026`, für UVG-BU, FAK und
  VK **0** — ein unbekannter Satz wird nicht geraten). Die Migration hat die
  alten Jahreszeilen (`PayrollSetting`) als ungeprüfte Versionen übernommen;
  `PayrollSetting` wird nicht mehr geschrieben.
- **Veröffentlichen mit ungeprüften Sätzen** verlangt die ausdrückliche
  Bestätigung `trotzUngepruefterSaetze: true` (sonst 422) und steht so im
  Prüfprotokoll. Das PDF trägt dann einen Hinweis.

Endpunkte: `GET/POST /api/payroll/rates`, `PATCH /api/payroll/rates/:id`,
`POST /api/payroll/rates/:id/verify`. `/api/payroll/settings` ist entfallen.

---

## 3. Die Rechnung

`src/lib/payroll/beitraege.ts` (Beiträge) und
`src/lib/payroll/lohnbestandteile.ts` (Zeilen) — rein, ohne Datenbank,
geprüft in `tests/api/lohnbestandteile.test.ts` und
`tests/api/lohnabrechnung.test.ts`.

```
  Grundlohn (anteilig nach Kalendertagen)      EARNING
− unbezahlter Urlaub                           EARNING (negativ)
+ Überstunden, Zulagen, Korrekturen            EARNING
+ Ferien-/Feiertagsentschädigung (Stundenlohn) EARNING
+ 13. Monatslohn                               EARNING
= Bruttolohn  → AHV/IV/EO, ALV, UVG-NBU, KTG, BVG
− Quellensteuer (Tarif oder von Hand)          DEDUCTION
− andere Abzüge                                DEDUCTION
+ Spesen, Familienzulagen, Netto-Korrekturen   PAYMENT
= Auszahlung
  Arbeitgeberbeiträge                          EMPLOYER (informativ)
```

**Koordinierter Lohn, Alter, Rundung** — unverändert: Eintrittsschwelle →
Obergrenze → Koordinationsabzug → Mindestbetrag; Alter am 31. Dezember; ohne
Geburtsdatum kein BVG-Abzug; Rundung je Beitragsart auf Rappen.

**Jahreslohn für ALV-Grenze und BVG:** Monatslohn am Monatsende × 12, × 13
wenn ein 13. vereinbart ist; Stundenlohn: Pensum auf 42-Stunden-Woche × 52 ×
Ansatz. Beides Annahmen, in der Herleitung festgehalten.

---

## 4. Grundlohn, Ein- und Austritt, Lohnänderung

- **Monatslohn nach Kalendertagen:** Jeder angestellte Tag zählt mit dem
  Lohn (× Pensum), der an ihm galt, als `1 / Tage im Monat`. Eintritt am 20.
  April = 11/30; Lohnänderung am 16. = zwei Abschnitte. **Vorher** zahlte der
  Lauf immer einen ganzen Monatslohn zum Stand des Monatsletzten.
- **Wer im Monat austritt, wird abgerechnet.** Vorher schloss der Lauf
  `active = false` aus — der Austrittsmonat fehlte. Nach dem Austrittsmonat
  erscheint die Person nicht mehr, ausser es gibt offene Positionen (Korrektur
  nach dem Austritt).
- **Stundenlohn:** freigegebene Erfassungen × Satz der Lohnhistorie am
  Zürcher Kalendertag der Arbeit (sonst Schnappschuss, sonst Akte). Im Monat
  eines Wechsels zwischen Stunden- und Monatslohn werden Stunden an Tagen ohne
  Monatslohn als eigene Grundlohnzeile bezahlt.
- **Unbezahlter Urlaub:** bewilligte `UNPAID`-Abwesenheiten, Werktage Mo–Fr
  im Anstellungszeitraum (halber Tag = 0,5); Abzug = Monatslohn ÷ Werktage
  des Monats × Tage. Feiertage werden dabei nicht ausgenommen.
- **Monatsgrenze** ist Mitternacht in Zürich.

---

## 5. Positionen, Korrekturen, 13. Monatslohn

`PayrollItem` (`/api/payroll/items`) — je Person und Monat:

| Art | Wirkung |
|---|---|
| `OVERTIME` | Stunden × Ansatz × (1 + Zuschlag) — **Betrag rechnet der Server**; ein mitgeschickter Betrag wird abgewiesen |
| `ALLOWANCE` | beitragspflichtige Zulage |
| `FAMILY_ALLOWANCE` | Auszahlung, nicht AHV-pflichtig, steuerbar (Ziffer 7) |
| `EXPENSE` | Spesen — weder beitragspflichtig noch steuerbar (Ziffer 13.1.1) |
| `CORRECTION` | ± beitragspflichtiger Lohn |
| `NET_CORRECTION` | ± Auszahlung ohne Beiträge |
| `DEDUCTION` | Abzug (Vorschuss, Pfändung) |
| `WITHHOLDING_TAX_MANUAL` | Quellensteuer von Hand, ersetzt den Tarif; höchstens eine je Monat (Teilindex) |

- **Nicht in einen veröffentlichten Monat** (422). Eine Korrektur gehört in
  einen **späteren** offenen Monat und verweist mit `correctsPayslipId` auf die
  korrigierte Abrechnung.
- Eine eingeflossene Position einer veröffentlichten Abrechnung ist
  unveränderlich (Dienst und Trigger `payroll_items_unveraenderlich`).

**13. Monatslohn** (`EmployeePayrollProfile`, `/api/payroll/profiles/:id`) —
**vertraglich, nie als gesetzliche Pflicht dargestellt**:

| Art | Rechnung |
|---|---|
| `NONE` | keiner |
| `MONTHLY` | jeden Monat 1/12 des Grundlohns (nach unbezahltem Urlaub) |
| `PRO_RATA` | im Auszahlungsmonat oder Austrittsmonat 1/12 der Jahresgrundlöhne − bereits Ausgerichtetes |
| `ANNUAL` | im Auszahlungsmonat ein Monatslohn, bei unterjähriger Anstellung nach Kalendertagen; beim Austritt anteilig; ohne Monatslohn wie `PRO_RATA`; nie doppelt |

Ein-/Austritt, Lohnänderung und unbezahlter Urlaub sind in `PRO_RATA` von
selbst berücksichtigt, weil sie in den Grundlöhnen stehen. Korrekturen des
Grundlohns fliessen nicht in die 13.-Basis (nur `BASE`/`UNPAID_LEAVE`).

---

## 6. Quellensteuer — Motor und Grenze

**Clenaris liefert keine Tarife und rechnet keinen Satz ohne Quelle.**

- `WithholdingTaxProfile`: Kanton, Tarifcode, Kirchensteuer, Kinder, mit
  Gültigkeit; keine Überschneidung (Ausschlussbedingung). Konfession und
  Kinderzahl sind im Prüfprotokoll geschwärzt.
- `WithholdingTaxRate`: Tarifzeilen je Kanton/Jahr/Tarif/Einkommensstufe,
  **nur eingelesen** (`POST /api/payroll/withholding/rates`, `source`
  Pflicht, ungeprüft, stapelweise bestätigbar), nie überschrieben.
- **Rechnung:** Profil am letzten angestellten Tag des Monats → Tarifzeile
  nach steuerbarem Monatseinkommen (Lohn + Familienzulagen, ohne Spesen) →
  Satz × Bemessung. Herkunft (`satzId`, Quelle) in der Herleitung.
- **Ohne Tarifzeile:** keine Quellensteuer, sondern `reviewRequired` mit
  Begründung. Veröffentlicht wird erst nach Prüfung (Notiz Pflicht) oder mit
  einer von Hand erfassten Quellensteuer.
- **Nach dem Veröffentlichen:** Profilinhalte im Zeitraum sind gesperrt; ein
  Tarifwechsel ist ein neues Profil ab dem Wechseltag.
- Ein ungeprüfter Tarif zählt wie ein ungeprüfter Beitragssatz
  (`unverifiedRates`).

**Nicht umgesetzt:** Jahresmodell (GE, VD, VS, FR, TI), rückwirkende
Tarifkorrektur, Abrechnung mit der Steuerverwaltung, Satzbestimmungslohn bei
mehreren Arbeitgebern.

---

## 7. Veraltete Abrechnungen

Eine berechnete, **unveröffentlichte** Abrechnung wird als veraltet markiert
(`reviewRequired`, Grund beginnt mit „Grundlagen seit der Berechnung
geändert"), wenn sich danach etwas ändert, das sie trägt: Lohnposition,
Lohnvereinbarung, Quellensteuerprofil oder -tarif, Satzversion, Lohnstamm,
Ein-/Austritt, Zeitfreigabe oder deren Aufhebung, bewilligter unbezahlter
Urlaub. **Eine veraltete Abrechnung wird nicht „freigegeben", sondern neu
gerechnet** (422 auf die Prüffreigabe); der nächste Lauf setzt die Markierung
zurück. Ohne diese Regel würde die alte Zahl veröffentlicht.

---

## 8. Veröffentlichen, PDF, Unveränderlichkeit

1. Offene Prüfungen → übersprungen mit Grund.
2. Ungeprüfte Sätze → nur mit `trotzUngepruefterSaetze: true`.
3. PDF aus den gespeicherten Zeilen rendern (`PayslipDocument`), ablegen
   (`<org>/payroll/payslips/<id>.pdf`), als `FileAsset` im Bereich `PAYROLL`
   registrieren (nicht öffentlich, `uploadedById` leer, Herkunft
   `SYSTEM_GENERATED`), Prüfsumme festhalten.
4. **Bedingtes Schreiben** `published=false AND updatedAt=<gelesen>` — ein
   Nachlauf zwischen Lesen und Veröffentlichen hängt kein PDF alter Zeilen an
   neue Zeilen.

**Herunterladen** (`/api/payroll/payslips/:id/pdf`): gespeicherte Bytes,
Prüfsummenvergleich, kein Neurendern; jeder Abruf im Prüfprotokoll.
Mitarbeitende nur die eigene veröffentlichte (Bedingung in der Abfrage, sonst
404). Über den allgemeinen Dateiweg ist `PAYROLL` nur mit `payslip:read_all`
lesbar; die Mediathek zeigt Lohndokumente nicht und kann Signatur- und
Lohnbelege weder löschen noch umordnen.

**Datenbank-Trigger** (Migration `20260923130000_lohn_ausbau`):
`payslips_unveraenderlich`, `payslip_lines_unveraenderlich`,
`payroll_items_unveraenderlich`, `payroll_rates_unveraenderlich`,
`salary_certificates_unveraenderlich`. Kaskaden aus dem Löschen einer ganzen
Personalakte sind erlaubt (`pg_trigger_depth() > 1`).

---

## 9. Lohnausweis-Aufstellung

`SalaryCertificate` (`/api/payroll/certificates`): Verdichtung der
**veröffentlichten** Abrechnungen eines Jahres auf die Ziffern 1, 7, 8, 9,
10.1, 11, 12 und 13.1.1 (Zuordnung je Zeile in `certificateField`, Tabelle
`LOHNAUSWEIS_ZIFFER`). Entwurf wird bei jedem Erstellen neu verdichtet;
**Abschliessen** erzeugt das PDF und macht die Version unveränderlich; eine
Korrektur ist eine neue Version. Mitarbeitende sehen nur eigene
abgeschlossene Aufstellungen.

**Das ist nicht das amtliche Formular 11.** Das PDF sagt es auf der ersten
Seite. Nicht erfasst: Naturalleistungen, Kantine, Fahrkosten, Aussendienst,
Bemerkungen (Ziffer 15), Kapitalleistungen, Beteiligungen.

---

## 10. Wer was darf

| Berechtigung | Erlaubt | Rollen |
|---|---|---|
| `payslip:read_own` | eigene **veröffentlichte** Abrechnungen, eigenes PDF, eigene abgeschlossene Lohnausweis-Aufstellungen | Angestellte |
| `payslip:create` | Lauf, Positionen, Lohnvereinbarungen, Quellensteuerprofile, Aufstellung verdichten, Sätze/Tarife lesen | ADMIN, SUPER_ADMIN |
| `payslip:read_all` | alle Abrechnungen, `/admin/lohn`, Dateiweg `PAYROLL` | ADMIN, SUPER_ADMIN |
| `payslip:publish` | Veröffentlichen, Prüfung freigeben, Satzversionen anlegen/ändern/bestätigen, Tarife einlesen/bestätigen, Aufstellung abschliessen | ADMIN, SUPER_ADMIN |

**Die Betriebsleitung hat keines davon.** Alle Abfragen filtern nach
`organizationId`; die Prüfreihe belegt mit einer fremden Organisation, dass
deren Sätze, Tarife und Positionen weder gezeigt noch verrechnet werden.

**Prüfprotokoll:** Beträge, Bezeichnungen und Notizen von Positionen, die
Quellensteuerdaten (Kanton, Tarif, Kirchensteuer, Kinder), die
Lohnvereinbarungen und die Felder der Aufstellung sind je Entität geschwärzt
(`src/lib/sensitive-fields.ts`).

---

## 11. Fachliche Prüfung — EXTERNAL VERIFICATION REQUIRED

Technisch geprüft ist, dass die Rechnung tut, was hier steht. **Nicht**
geprüft — und vor produktivem Einsatz durch Treuhand, Ausgleichskasse,
Versicherer bzw. Steuerverwaltung zu bestätigen:

1. alle Beitragssätze, Schwellen und Grenzen je Jahr (AHV/IV/EO, ALV, UVG-BU/NBU, KTG, FAK, VK, BVG-Plan);
2. Quellensteuertarife je Kanton/Jahr — und dass das Monatsmodell für die betroffenen Kantone genügt;
3. Kalendertage als Anteilskonvention bei Ein-/Austritt und Lohnänderung (Alternative: 30er-Monat);
4. Werktage-Konvention beim unbezahlten Urlaub (Feiertage nicht ausgenommen);
5. Einstufung der Familienzulagen (nicht AHV-pflichtig, steuerbar) und der Zulagenarten;
6. Ferienentschädigung w/(52−w) und Feiertagsprozentsatz gemäss GAV;
7. Auslegung des 13. Monatslohns je Arbeitsvertrag, insbesondere beim Austritt;
8. ALV-Grenze monatlich durch 12 statt laufender Jahressumme;
9. Zuordnung der Zeilen zu den Lohnausweis-Ziffern.

Bis dahin: **keine vollständige Schweizer Lohnbuchhaltung und keine
Konformitätsaussage**, sondern eine nachvollziehbare, versionierte,
unveränderlich abgeschlossene Abrechnung mit ausgewiesener Herkunft jedes
Satzes.

---

## 12. Wo was steht

| Datei | Inhalt |
|---|---|
| `src/lib/payroll/beitraege.ts` | Beiträge AN/AG — rein |
| `src/lib/payroll/lohnbestandteile.ts` | Zeilen, 13., Quellensteuer, Auszahlung — rein |
| `src/server/services/payroll.service.ts` | Lauf, Prüfung, Veröffentlichen, PDF, Lesen |
| `src/server/services/payroll-rates.service.ts` | Satzversionen |
| `src/server/services/payroll-stamm.service.ts` | Vereinbarungen, Positionen, Quellensteuer |
| `src/server/services/payroll-veraltet.ts` | Veraltet-Markierung |
| `src/server/services/salary-certificate.service.ts` | Lohnausweis-Aufstellung |
| `src/lib/pdf/payroll-documents.tsx` | PDF-Dokumente |
| `src/app/api/payroll/**` | 27 Operationen |
| `src/app/(app)/admin/lohn/**`, `src/app/(app)/portal/lohn` | Oberflächen |
| `prisma/migrations/20260923130000_lohn_ausbau` | Modelle, Ausschlussbedingungen, Teilindex, Trigger, Übernahme der Jahreszeilen |
| `tests/api/lohnbestandteile.test.ts` | 24 Prüfungen der reinen Rechnung |
| `tests/api/lohnabrechnung.test.ts` | Beitragsrechnung und Ablauf über HTTP (55 Prüfungen, Stand 2026-10-01) |
| `security/datenbank-schranken.json`, `scripts/datenbank-schranken.ts` | Register und Tor der handgeschriebenen Lohn-Schranken (Ausschluss-, Prüfbedingungen, Trigger, Funktionsrümpfe) — `tests/api/datenbank-schranken.test.ts` |
