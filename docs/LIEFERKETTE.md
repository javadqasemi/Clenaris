# Lieferkette (Wave 20)

Stand 2026-09-23. Status: **PARTIAL** — Befunde bewertet und in der
Pipeline verankert; zwei Punkte brauchen eine Prüfung ausserhalb dieses
Rechners (Geheimnissuche, CI-Lauf).

## Grundlagen, die schon standen

- **Sperrdatei** `package-lock.json` (lockfileVersion 3, mit
  `integrity`-Hashes); CI installiert mit `npm ci` — nur die Sperrdatei
  zählt.
- **Node** `.nvmrc` = **22**, `engines.node >= 22.0.0` (seit 2026-09-26;
  vorher 20 / `>= 20.11.0`). Anlass: Der erste CI-Lauf auf Node 20 fand die
  Prüfreihe nicht — `node --test` löst Glob-Muster wie
  `"tests/**/*.test.ts"` erst ab Node 21 selbst auf. Entwickelt, gemessen und
  vollständig geprüft wurde ausschliesslich mit Node 22.23 / npm 10.9; ein CI
  auf 20 prüfte also eine Laufzeit, die nie verifiziert war — und Node 20 ist
  seit April 2026 ohne Sicherheitsupdates. Der Produktionsserver (V2) braucht
  dieselbe Hauptversion (V2-2).
- **Keine `overrides`**, keine Git- oder Tarball-Abhängigkeiten.
- **Eine bewusste Veränderung an `node_modules`:** die React-Korrektur
  (`scripts/react-hydrationskorrektur.mjs`, docs/HYDRATION.md §16), angewendet
  in `postinstall`, `dev` und `build`. Kontrollierte technische Schuld —
  begründet, deterministisch getestet (`hydration-wiederholung.spec.ts`),
  und sie bricht laut ab, wenn die Stelle sich ändert.

## Neu in dieser Wave

In der Prüfstufe von `.github/workflows/deploy.yml` (nicht in der
Auslieferung):

1. `node scripts/react-hydrationskorrektur.mjs --pruefen` direkt nach
   `npm ci` — sichtbar als eigene Stufe statt versteckt im `postinstall`.
2. `npm audit --omit=dev --audit-level=critical` — eine **neue** kritische
   Lücke hält die Auslieferung an. Die Schwelle liegt bei `critical`, weil die
   bekannten Befunde unten bewertet sind; eine tiefere Schwelle wäre von
   Anfang an rot.

Beide Stufen laufen örtlich mit Exit 0. Ob sie in GitHub Actions grün
laufen, ist **EXTERNAL VERIFICATION REQUIRED** (kein Push in dieser Mission).

## `npm audit` — die Befunde, einzeln bewertet

Stand 2026-09-23: 0 critical, 4 high, 3 moderate — alle in Abhängigkeiten
zweiter Ebene.

| Paket (installiert) | Über | Hinweis | Bewertung |
|---|---|---|---|
| `postcss@8.4.31` | `next@15.5.26` (fest gepinnt) | GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849 (high), GHSA-qx2v-qp2m-jg93, GHSA-fxqj-rqcc-2cmp (moderate): XSS beim Stringify, Lesen von `.map`-Dateien über `sourceMappingURL` | **Akzeptiert.** Die Lücken greifen, wenn fremdes CSS verarbeitet wird. Next verarbeitet mit dieser Fassung nur das eigene CSS beim Bau; zur Laufzeit gelangt kein Benutzer-CSS hinein. Das Projekt selbst nutzt `postcss@8.5.28` (behoben). Behebung nur über Next 16 — ein Hauptsprung, in dieser Mission ausgeschlossen |
| `deepmerge-ts@7.1.5` | `@prisma/config@6.19.3` ← `prisma` | GHSA-ggr8-5vv4-36mx (high): Stapelüberlauf bei rekursiven Objekten | **Akzeptiert.** Nur im Prisma-Werkzeug beim Laden der eigenen Konfiguration; keine fremden Eingaben. 6.19.3 ist die letzte 6er und pinnt 7.1.5 exakt; Behebung nur über Prisma 7 (Hauptsprung, ausgeschlossen). `npm audit` meldet „fix available" — das ist dieser Hauptsprung |
| `uuid@8.3.2` | `exceljs` | GHSA-w5hq-g745-h8pq (moderate): fehlende Grenzprüfung, **wenn `buf` übergeben wird** | **Nicht betroffen.** `exceljs` ruft nur `uuidv4()` ohne Puffer auf (`cf-rule-ext-xform.js`). Der angebotene „Fix" ist ein Rückschritt auf `exceljs@3.4.0` |

`next`, `prisma`, `@prisma/config` und `exceljs` erscheinen in der Liste nur
als Träger der drei Pakete oben.

## Next aktualisieren — Prüfliste

**Bei jeder neuen Next-Fassung, auch einer Patch-Fassung:**

1. `npm install next@<fassung>` (die Korrektur läuft über `postinstall` mit).
2. `node scripts/react-hydrationskorrektur.mjs --pruefen`
   - „Korrektur bereits enthalten" für jede Datei → React hat den Fehler
     selbst behoben: Skript und Aufrufe entfernen, docs/HYDRATION.md §16
     nachführen.
   - „erwartete Stelle nicht gefunden" → **nicht** das Muster anpassen, bis
     es passt. Erst prüfen, ob die neue React-Fassung den Fehler noch hat
     (`hydration-wiederholung.spec.ts` ohne Korrektur laufen lassen).
3. `npm run build`, dann die Browser-Reihe: `npm run e2e` mit
   `--retries=0`; `hydration-wiederholung.spec.ts` muss grün sein.
4. `npm audit` neu lesen und diese Tabelle nachführen — Next 16 würde den
   `postcss`-Befund schliessen.

## Offen

- **Geheimnissuche** (`scripts/ci-secret-scan.sh`) braucht Bash; auf diesem
  Rechner nicht verfügbar und nicht ersatzweise installiert. Die Muster sind
  in `auslieferung-absicherung.test.ts` geprüft, der Lauf über das
  Repository **nicht** — **EXTERNAL VERIFICATION REQUIRED** (CI).
- Keine SBOM, keine Signaturprüfung der Pakete (`npm audit signatures`
  braucht Netz zur Registry und wurde nicht ausgeführt).
- Node-Fassung: `.nvmrc` 20 gegen die hier benutzte 22 angleichen, wenn
  Production V2 festgelegt ist.
