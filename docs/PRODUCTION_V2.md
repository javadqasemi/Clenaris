# Production V2 — unveränderliches Release-Artefakt (Wave 22)

Stand 2026-09-23. Status: **PARTIAL** — Packen örtlich bewiesen,
Aktivierung als Entwurf, Pipeline als Vorlage. **Die heutige Auslieferung ist
unverändert**: `.github/workflows/deploy.yml` (Auftrag `auslieferung`) und
`scripts/deploy.sh` wurden nicht angefasst, kein Server wurde berührt.

## 1. Das Problem, das V2 löst

Heute prüft die Pipeline einen Bau — und ausgeliefert wird ein anderer:
`deploy.sh` führt auf dem Server `git reset --hard`, `npm ci`, die
React-Korrektur und `next build` **erneut** aus. Derselbe Commit, aber ein
zweiter, ungeprüfter Baum. Zusätzlich (Befund dieser Wave):
`NEXT_PUBLIC_*` wird beim Bau fest eingesetzt, in Server- *und*
Client-Bündel. Die Pipeline baut mit `NEXT_PUBLIC_APP_URL=http://localhost:3000`,
der Server mit der echten Adresse — die beiden Bauten unterscheiden sich also
nachweislich, nicht nur möglicherweise.

## 2. Der Ablauf

```
npm ci
  → node scripts/react-hydrationskorrektur.mjs --pruefen   (Korrektur bewiesen)
  → lint · typecheck · docs · Merkmalsprüfung
  → npm run build                                           (einmal)
  → test:server · npm test · npm run e2e                    (gegen genau diesen Bau)
  → npx tsx scripts/release-artefakt.ts --ausgabe release   (packen, nicht bauen)
  → Artefakt + SHA-256 + Manifest in der CI-Ablage
  → Server: deploy/v2/release-aktivieren.sh <archiv>        (prüfen, entpacken, umschalten)
  → npm run start:built  (über PM2, ecosystem.config.js)
```

| Baustein | Datei | Stand |
|---|---|---|
| Packen | `scripts/release-artefakt.ts` | **örtlich geprüft** (Probe, siehe 4) |
| Aktivieren | `deploy/v2/release-aktivieren.sh` | Entwurf, **nie ausgeführt** (kein Bash hier, kein Server) |
| Pipeline | `deploy/v2/workflow-ergaenzung.yml` | Vorlage, liegt ausserhalb von `.github/workflows` und läuft nicht |
| Korrektur in CI | `deploy.yml`, Stufe „React-Hydrationskorrektur ist angewendet" | seit Wave 20 in der Prüfstufe |

### Was das Artefakt enthält — und was nicht

Enthalten (Einschlussliste, nicht Ausschlussliste): `.next` ohne `cache`,
`node_modules` **mit** angewandter Korrektur, `prisma` (Schema und
Migrationen), `public`, `scripts`, `src`, `deploy`, `package.json`,
`package-lock.json`, `next.config.ts`, `ecosystem.config.js`,
`tsconfig.json`, Tailwind-/PostCSS-Konfiguration, `RELEASE.json`.

Nie enthalten: jede `.env*` (das Skript prüft das Archiv nach dem Packen
noch einmal), Tests, Doku, Prüfberichte.

`RELEASE.json` hält Commit, Build-ID, Node/npm/Plattform, Next-Fassung,
SHA-256 der Sperrdatei, `appUrl` und `auslieferbar`. Nicht auslieferbar ist
ein Artefakt ohne `node_modules`, aus einem unsauberen Baum oder aus einem
anderen Bauverzeichnis als `.next`.

### Was die Aktivierung prüft, bevor sie etwas ändert

SHA-256 · Manifest (`anwendung`, `auslieferbar`, Commit) · `appUrl` gleich
`NEXT_PUBLIC_APP_URL` des Servers · Node-Hauptversion gleich dem Bau ·
Korrektur im entpackten Baum (`--pruefen`) · bei anstehenden Migrationen
zuerst `db-backup.ts`, ohne geprüfte Sicherung keine Migration. Dann:
atomarer Verweis `current → releases/<commit>`, `pm2 startOrReload`,
Health Check verlangt **genau diesen Commit**; sonst Verweis zurück.

## 3. Voraussetzungen vor dem Umstieg (Blocker)

| Nr. | Punkt | Warum |
|---|---|---|
| **V2-1** | **`NEXT_PUBLIC_*` zur Laufzeit statt beim Bau** — oder die Pipeline baut mit den Produktionswerten | Ein Artefakt ist heute an die Adresse gebunden, für die es gebaut wurde. Empfohlen: serverseitig ein eigenes `APP_URL` (Laufzeit) statt `NEXT_PUBLIC_APP_URL` (rund ein Dutzend Fundstellen ausserhalb von `env.ts`, u. a. `handler.ts`, `email/layout.ts`, `sitemap.ts`, `twilio`-Webhook); für den Client die wenigen öffentlichen Schlüssel (Maps, Stripe, Analytics) über das Wurzellayout ausliefern. Baut die Pipeline stattdessen mit Produktionswerten, müssen die Prüfreihen das aushalten: `gate3-pdf-viewer.spec.ts` vergleicht Ursprünge, und Analytics-Kennungen würden aus CI feuern |
| **V2-2** | Bau auf **Linux** mit derselben Node-Hauptversion wie der Server | `node_modules` enthält die Prisma-Engine für die Bauplattform; `.nvmrc` sagt 20, entwickelt wird mit 22 |
| **V2-3** | Aktivierung auf einem **Probeserver** durchspielen: Erstinstallation, zweites Release, absichtlich kaputtes Release (Rücksprung), Artefakt mit falscher Summe, falscher `appUrl`, `auslieferbar=false` | Das Skript ist nie gelaufen |
| **V2-4** | Verzeichnisaufbau `releases/`, `shared/.env`, `shared/logs` einrichten; `ecosystem.config.js` aus `current/` | Heute liegt alles in einem Arbeitsbaum |
| **V2-5** | CI-Ablage: Grösse des Artefakts mit `node_modules` messen (örtliche Probe ohne Module: 18 MB) und Aufbewahrung festlegen | Nicht gemessen |
| **V2-6** | Sicherungs-Blocker aus `docs/BACKUP_DR.md` (B-DR-1 bis B-DR-3) | Eine schnellere Auslieferung ändert nichts daran, dass die Daten nicht gesichert sind |

## 4. Örtliche Probe (durchgeführt)

`NEXT_PUBLIC_*` wie im Testbau, `NEXT_DIST_DIR=.next-audit`, `--ohne-module
--unsauber` (Windows, Arbeitsbaum mit der bewusst nicht eingecheckten
`CLAUDE.md`):

- Archiv 18 MB, 6 658 Einträge, SHA-256-Datei und Manifest geschrieben,
  „Auslieferbar: nein (Probe)", `appUrl` aus denselben `.env`-Dateien wie
  `next build` (`@next/env`);
- Inhalt oberste Ebene: `.next-audit`, `deploy`, `ecosystem.config.js`,
  `next.config.ts`, `package.json`, `package-lock.json`,
  `postcss.config.mjs`, `prisma`, `public`, `RELEASE.json`, `scripts`, `src`,
  `tailwind.config.ts`, `tsconfig.json`;
- keine `.env*`, kein `cache`; `RELEASE.json` danach aus dem Arbeitsbaum
  entfernt.

Nicht geprüft: ein vollständiges Artefakt mit `node_modules`, die Aktivierung,
irgendetwas auf einem Server — **EXTERNAL VERIFICATION REQUIRED**.
