# Lieferkette (Wave 20)

Stand 2026-09-23, nachgeführt 2026-10-01 (Prisma 7, Herkunft des Artefakts).
Status: **PARTIAL** — Befunde bewertet und in der Pipeline verankert;
Geheimnissuche und CI-Lauf sind inzwischen belegt, offen sind die
Paketsignaturen und der Nachweis der Reproduzierbarkeit in der CI.

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
- **Eine `override`** seit dem Umstieg auf Prisma 7 (2026-09-29, PR7-06):
  `mysql2` auf `^3.22.0`, weil `prisma@7.10.0` eine Fassung mit einem hohen
  Befund zieht und die Anwendung MySQL gar nicht benutzt. Keine Git- oder
  Tarball-Abhängigkeiten.
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
| `deepmerge-ts@7.1.5` | `@prisma/config@7.10.0` ← `prisma` (Stand 2026-10-01; am 2026-09-23 noch `@prisma/config@6.19.3`) | GHSA-ggr8-5vv4-36mx (high): Stapelüberlauf bei rekursiven Objekten | **Akzeptiert.** Nur im Prisma-Werkzeug (Kommandozeile, `prisma.config.ts` laden — Bau, Migration, auch `migrate` im entpackten Release); keine fremden Eingaben, die Laufzeit benutzt `@prisma/client` mit Treiberadapter. **Die frühere Begründung ist überholt:** Sie lautete „6.19.3 pinnt 7.1.5 exakt, Behebung nur über Prisma 7". Seit dem Umstieg auf Prisma 7.10 (PR7) pinnt `@prisma/config@7.10.0` dieselbe Fassung 7.1.5 exakt (gelesen aus `package-lock.json`) — der Hauptsprung hat den Befund nicht behoben. Die Bewertung in `security/akzeptierte-befunde.json` (befristet bis 2026-12-31) nennt noch den alten Grund und gehört beim nächsten Durchgang nachgeführt (`docs/PENDENZEN.md` P2H-71). Was `npm audit` heute als Behebung anbietet, ist ohne Netz nicht gelesen |
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

## Herkunft des ausgelieferten Artefakts (seit 2026-09-30)

Was in die Produktion geht, ist kein Bau vom Server, sondern das Archiv, das
die CI aus genau dem geprüften Bau packt (`scripts/release-artefakt.ts`,
`docs/PRODUCTION_V2.md` §2). Für die Lieferkette heisst das:

- **Herkunft im Manifest.** `RELEASE.json` (Format 2) nennt Commit, Version,
  Node/npm/Plattform, Next-Fassung, SHA-256 der Sperrdatei, die angewandte
  React-Korrektur und die CI-Herkunft (Lauf, Versuch, Ereignis, Ref,
  Repository). Auslieferbar ist nur ein Artefakt aus einem Push- oder
  Handstart-Lauf auf `main`, mit Modulen, aus einem sauberen Baum.
- **`node_modules` reisen mit** — mit beiden Korrekturen (RB-001
  Hydration, RB-002 Cachezeit), die Packen und Aktivierung je mit `--pruefen`
  verlangen. Auf dem Server wird nichts installiert und nichts nachgeladen
  (kein `npm`, kein `npx`).
- **Summe ausserhalb des Kanals.** Die Aktivierung verlangt die erwartete
  SHA-256 als Argument; sie kommt aus der Beilage der CI, nicht aus der
  `.sha256` neben dem Archiv.
- **Ohne Bauzwischenspeicher.** `.next/cache` wird in der CI nicht mehr
  wiederhergestellt — ein ausgelieferter Bau hängt von nichts ab, was ein
  früherer Lauf hinterlassen hat (`docs/GITHUB_GOVERNANCE.md` §4).
- **Reproduzierbarkeit.** Das Archiv ist mit GNU tar normalisiert (Reihenfolge,
  Zeiten, Besitzer, `gzip -n`): Dieselbe Eingabe ergibt dieselbe SHA-256 —
  örtlich bewiesen, auf dem CI-Rechner noch nicht. Der Bau selbst ist nicht
  bitgleich (Build-ID, Vorschau- und Aktionsschlüssel würfelt Next);
  `scripts/bau-vergleich.ts` vergleicht zwei Bauten desselben Commits und
  lässt nur diese Unterschiede zu. Der CI-Auftrag `reproduzierbarkeit`
  (nur von Hand) ist noch nie gelaufen (`docs/PENDENZEN.md` P2H-21).

## Offen

- ~~**Geheimnissuche** braucht Bash~~ — erledigt seit 2026-09-27: `npm run
  security:secrets` (`scripts/security/geheimnisse.ts`, TypeScript) läuft
  örtlich und in `verify:static`; `scripts/ci-secret-scan.sh` ist nur noch
  die Hülle.
- ~~Keine SBOM~~ — `npm run security:sbom` (CycloneDX), Stufe in der CI und
  als Artefakt `sicherheitsbericht` abgelegt. Offen bleibt die
  Signaturprüfung der Pakete (`npm audit signatures` braucht Netz zur
  Registry und wurde nicht ausgeführt).
- ~~Node-Fassung angleichen~~ — erledigt: `.nvmrc` 22, `engines` ≥ 22; die
  Aktivierung verweigert ein Artefakt mit anderer Node-Hauptversion als der
  Server (V2-2: Node 22 auf dem Server).
- Ein `npm audit`-Lauf ohne Netz liefert einen leeren Bericht, den
  `security:check` heute als bestanden wertet (`docs/PENDENZEN.md` P2H-43) —
  ein Lauf ohne Registry ist kein Nachweis.
