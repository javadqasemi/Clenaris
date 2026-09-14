# Aufträge für Claude Code

Je Phase eine Datei. Inhalt in Claude Code im Projektverzeichnis einfügen —
`CLAUDE.md` und `docs/bi/` liegen dort und werden mitgelesen.

## Reihenfolge

```
PHASE-1-KENNZAHLEN.md      → Fundament, zuerst
PHASE-2-COCKPIT.md         → braucht 1
PHASE-4-FINANZPLANUNG.md   → braucht 1
PHASE-3-ZIELE.md           → braucht 1
PHASE-5-RISIKO.md          → unabhängig
PHASE-6-WISSEN.md          → unabhängig
PHASE-7-BERICHTE.md        → braucht 1 bis 4
```

Empfehlung: 1, 2, 4 — danach entscheiden, ob 3, 5 und 6 tatsächlich gepflegt
werden. Am Cockpit sieht man zu diesem Zeitpunkt, was fehlt.

## Vor jedem Auftrag

```bash
git checkout -b fuehrung/phase-N
```

Ein Zweig je Phase. Jede ist rein additiv und für sich auslieferbar.

## Nach jedem Auftrag

```bash
npm run typecheck && npm run lint
npm run docs                       # scheitert bei undokumentierter Route
# Server stoppen, dann:
npm run build && npm run start:built
npm test
```

Und selbst durchklicken. Die Testsuite prüft Statuscodes und Rümpfe, nicht
ob eine Seite brauchbar aussieht.

## Was in jedem Auftrag gilt

Steht in jeder Datei noch einmal, weil sie einzeln eingefügt werden:
deutsche Oberfläche mit `ss` statt `ß`, `defineRoute` für jeden Endpunkt,
Zod-Schemas in `src/lib/validation/`, Fachlogik in `src/server/services/`,
`organizationId` in jeder `where`-Klausel, kein `prisma migrate reset`,
Dateien mit Write/Edit statt PowerShell-Umleitung.
