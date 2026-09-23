# Datenintegrität (Wave 24)

Stand 2026-09-23. Status: **COMPLETE + VERIFIED** für die Prüfung und den
gefundenen Fehler; **EXTERNAL VERIFICATION REQUIRED** für den Lauf gegen die
Produktionsdatenbank (nicht berührt).

## 1. Die Prüfung

`scripts/datenintegritaet.ts` — nur lesend. Jede Prüfung ist eine Gleichung,
die im Bestand gelten muss; ausgegeben werden Anzahl und höchstens fünf
Kennungen, keine Namen oder Beträge.

```bash
npx tsx scripts/datenintegritaet.ts                    # DATABASE_URL
INTEGRITAET_DATABASE_URL=… npx tsx scripts/datenintegritaet.ts --json bericht.json
```

| Schlüssel | Art | Gleichung |
|---|---|---|
| `rechnung_brutto` | Fehler | Brutto = Netto + MWST |
| `rechnung_bezahlt` | Fehler | bezahlter Betrag = Summe der erfolgreichen Zahlungen |
| `rechnung_saldo` | Fehler | offener Posten = max(0, Brutto − Zahlungen − Gutschriften); storniert/abgeschrieben 0 |
| `rechnung_status_bezahlt` | Fehler | „bezahlt" nur ohne offenen Posten (5 Rappen) |
| `gutschrift_obergrenze` | Fehler | Gutschriften ≤ Brutto der Rechnung |
| `nummern_doppelt` | Fehler | keine Belegnummer doppelt je Organisation |
| `nummern_ueber_zaehler` | Fehler | keine Laufnummer über dem Zähler ihres Jahres |
| `nummern_luecken` | Hinweis | Lücken in den Laufnummern (Art. 957a OR) |
| `lager_negativ` | Fehler | Bestand = Summe der Bewegungen ≥ 0 |
| `mandant_bezug` | Fehler | Rechnung, Gutschrift, Offerte, Einsatz, Vertrag, Reklamation, Besichtigung nur an Kundschaft der eigenen Organisation |
| `offerte_annahme` | Fehler | abgeschlossene Offertannahme ⇒ Offerte angenommen |
| `zeit_freigabe_offen` | Fehler | keine freigegebene Zeit ohne Ende |
| `einsatz_materialaufwand` | Hinweis | Materialaufwand = Summe der Materialzeilen |
| `kundenwert` | Hinweis | Kundenwert = Summe der erfolgreichen Zahlungen |

**Fehler** verletzen eine Regel, die der Code garantiert (Exit 1).
**Hinweise** können einen legitimen Grund haben (Altbestand, Seeds,
Prüfreihen, die an den Triggern vorbei aufräumen) und sind anzusehen.

`tests/api/datenintegritaet.test.ts` läuft dieselben Prüfungen in jedem
`npm test` gegen die Testdatenbank und scheitert an jedem Fehler — damit fällt
auch eine Prüfreihe auf, die Inkonsistentes zurücklässt.

## 2. Gefundener Produktfehler: Saldo ohne Gutschriften

**Befund.** Verbuchen einer Zahlung (`recordPayment`) und Storno einer
Zahlung (`DELETE /api/payments/:id`) bildeten den offenen Posten als
`Brutto − bezahlt`. Seit Wave 13 senken Gutschriften den Saldo; diese beiden
Wege kannten sie nicht. Folge: Rechnung 108.10, Zahlung 20, Gutschrift 32.43 —
wer den Rest von 55.67 bezahlte, behielt einen offenen Posten von 32.43, die
Rechnung blieb „teilweise bezahlt" und wäre gemahnt worden. Ein Storno danach
setzte die Gutschrift ebenso wieder als offen.

Zweiter Befund am selben Ort: `recordPayment` las den bezahlten Betrag vor
der Transaktion und schrieb ihn als Summe zurück — zwei gleichzeitige
Zahlungen hätten einander überschrieben.

**Behebung.** `saldoNeuBilden(tx, invoiceId)` im Rechnungsdienst: Zeile
sperren, Zahlungen und Gutschriften aus den Belegen summieren, Saldo,
bezahlten Betrag und Status daraus setzen. Verbuchen, Storno und Gutschrift
benutzen alle drei diese Funktion. Der Status folgt dem Geld: `PAID` nur mit
Zahlung und ohne Rest; eine vollständig gutgeschriebene Rechnung ist nicht
„bezahlt"; nach einem Storno ohne verbleibende Zahlung zurück auf `SENT` —
oder `ISSUED`, wenn nie versendet (vorher pauschal `SENT`).

**Beweis.** `finanzbelege.test.ts` › „Rest nach einer Gutschrift bezahlen
ergibt ‚bezahlt', der Storno danach berücksichtigt die Gutschrift".

Ob die Produktion betroffene Rechnungen hat, zeigt die Prüfung
`rechnung_saldo` dort — **EXTERNAL VERIFICATION REQUIRED**. Betroffen sein
kann nur eine Rechnung mit Gutschrift *und* einer späteren Zahlung oder einem
Storno; Gutschriften gibt es erst seit Wave 13, und die ist nicht ausgeliefert.

## 3. Stand der Testdatenbank

Alle Fehlerprüfungen 0. Hinweis `nummern_luecken`: 25 — die Prüfreihen für
Finanzbelege entfernen ihre Rechnungen und Gutschriften unter `replica`, der
Zähler bleibt stehen. In einer Produktionsdatenbank muss dieser Wert 0 sein;
jede Lücke dort ist zu erklären.
