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
SHA-256 der Sperrdatei, `seitenUrl` (die kanonische Domain, zur
Nachvollziehbarkeit — seit V2-1 keine Bindung mehr) und `auslieferbar`. Nicht
auslieferbar ist ein Artefakt ohne `node_modules`, aus einem unsauberen Baum
oder aus einem anderen Bauverzeichnis als `.next`.

### Was die Aktivierung prüft, bevor sie etwas ändert

SHA-256 · Manifest (`anwendung`, `auslieferbar`, Commit) · `APP_URL` in
`shared/.env` vorhanden (seit V2-1; vorher „`appUrl` gleich
`NEXT_PUBLIC_APP_URL`") · Node-Hauptversion gleich dem Bau ·
Korrektur im entpackten Baum (`--pruefen`) · bei anstehenden Migrationen
zuerst `db-backup.ts`, ohne geprüfte Sicherung keine Migration. Dann:
atomarer Verweis `current → releases/<commit>`, `pm2 startOrReload`,
Health Check verlangt **genau diesen Commit**; sonst Verweis zurück.

## 3. Voraussetzungen vor dem Umstieg (Blocker)

| Nr. | Punkt | Warum |
|---|---|---|
| ~~V2-1~~ | **Geschlossen 2026-09-26** — siehe [Abschnitt 5](#5-v2-1-laufzeitkonfiguration-geschlossen-2026-09-26) | Umgebungsabhängiges steht zur Laufzeit; derselbe Bau unter zwei Umgebungen bewiesen (`tests/api/laufzeit-konfiguration.test.ts`). Bewusst beim Bau bleibt nur die kanonische Domain der statischen Website |
| **V2-2** | Bau auf **Linux** mit derselben Node-Hauptversion wie der Server | `node_modules` enthält die Prisma-Engine für die Bauplattform. Die Node-Hälfte ist seit 2026-09-26 erledigt (`.nvmrc` 22, `engines` ≥ 22, CI baut damit); offen bleibt, dass der Server Node 22 hat |
| **V2-3** | Aktivierung auf einem **Probeserver** durchspielen: Erstinstallation, zweites Release, absichtlich kaputtes Release (Rücksprung), Artefakt mit falscher Summe, fehlendes `APP_URL`, `auslieferbar=false` | Das Skript ist nie gelaufen |
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

## 5. V2-1: Laufzeitkonfiguration (geschlossen 2026-09-26)

### Was vorher festsass

Next.js setzt jeden Ausdruck `process.env.NEXT_PUBLIC_…` beim Bau als Text
ein, im Server- **und** im Client-Bündel. Das CI baut mit
`http://localhost:3000`. Ein Artefakt aus diesem Lauf hätte in der Produktion
über `absoluteUrl()` jeden Link in E-Mails (Passwort, Einladung, Offerte,
Unterzeichnung, Newsletter), die Stripe-Rücksprünge, die Twilio-Signaturadresse,
PDF-Verweise und die vertraute Herkunft der CSRF-Prüfung auf `localhost`
gerichtet — ohne Fehlermeldung.

### Bestandsaufnahme `NEXT_PUBLIC_*`

| Variable | Verwendet in | Seite | Geheim | Einordnung | Jetzt |
|---|---|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `absoluteUrl`, Herkunftsprüfung, E-Mail-Rahmen, Maps, Canonical, Sitemap, robots | Server (+ statisches HTML) | nein | **B** Laufzeit, je Umgebung | abgelöst durch `APP_URL` (Laufzeit); nur noch Rückfall, zur Laufzeit gelesen |
| `NEXT_PUBLIC_SITE_URL` *(neu)* | Canonical, `metadataBase`, OpenGraph, JSON-LD, Sitemap, robots, SEO-Maske | statisch vorgerendert | nein | **A** Bauzeit, bewusst | `src/lib/seiten-url.ts` — die einzige Datei mit `process.env.NEXT_PUBLIC_` |
| `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` | `<meta>` im Wurzellayout | statisch | nein | **A** Bauzeit | `seiten-url.ts` |
| `NEXT_PUBLIC_GA_MEASUREMENT_ID` | Analytics nach Einwilligung | Client | nein | **B** | `GET /api/public/runtime-config` |
| `NEXT_PUBLIC_GTM_ID` | dito | Client | nein | **B** | dito |
| `NEXT_PUBLIC_FACEBOOK_PIXEL_ID` | dito | Client | nein | **B** | dito |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | statische Karten-URL, Rückfall für den Server-Schlüssel | Server | Browserschlüssel, nach Googles Bauart öffentlich; Referrer-Beschränkung nötig | **B** | Server, zur Laufzeit (`mapsBrowserSchluessel()`); nicht in der Browser-Konfiguration |
| `NEXT_PUBLIC_SUPABASE_URL` | Speichertreiber | Server | nein | **B** | Server, zur Laufzeit (`supabaseAdresse()`) |
| `NEXT_PUBLIC_APP_NAME` | — | — | — | **D** ungenutzt | entfernt |
| `NEXT_PUBLIC_DEFAULT_LOCALE` | — | — | — | **D** | entfernt |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | — (Zahlung läuft über die gehostete Checkout-Seite) | — | — | **D** | entfernt |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | — (Uploads über signierte Tickets des Servers) | — | — | **D** | entfernt |

Klasse **C** („sollte nicht öffentlich sein") ist leer: Kein Geheimnis trägt
einen `NEXT_PUBLIC_`-Namen.

### Wie es jetzt ist

- **`src/lib/laufzeit-konfiguration.ts`** liest die Umgebung zur Laufzeit —
  über einen Verweis auf `process.env`, den der Bau nicht ersetzt.
  `ursprungAus()` verlangt Schema, Host, Port und sonst nichts; ein Pfad,
  Zugangsdaten oder ein anderes Schema werfen. Fehlt `APP_URL` in der
  Produktion, wirft es ebenfalls: Ein lauter Fehler ist besser als ein
  stilles `localhost` in Kundenmails.
- **`GET /api/public/runtime-config`** liefert dem Browser genau
  `PublicRuntimeConfigSchema` (`appUrl`, `analytics.{gaMeasurementId, gtmId,
  facebookPixelId}`), Feld für Feld benannt, `.strict()`. Kennungen ausserhalb
  ihres engen Formats fallen weg, statt in ein Skript zu geraten. Nie die
  ganze Umgebung, nichts aus der Anfrage. `Cache-Control: no-cache`.
- **Vertrauen bleibt beim Server.** Die Herkunftsprüfung liest `APP_URL` aus
  der Server-Umgebung; `X-Forwarded-Host` zählt nur mit erklärtem Proxy
  (`TRUSTED_PROXY_MODE`). Die Browser-Konfiguration bestimmt nichts, was der
  Server glaubt.
- **Die Musterprüfung** (`security:check`, Regel `bauzeit-oeffentlich`,
  blockierend) weist jedes `process.env.NEXT_PUBLIC_` in `src/` ausserhalb von
  `seiten-url.ts` ab — damit der Befund nicht über einen neuen Aufruf
  zurückkehrt.

### Was bewusst beim Bau bleibt — und warum

Die **kanonische Domain** der Website (`NEXT_PUBLIC_SITE_URL`). Rund zwei
Dutzend öffentliche Seiten, `sitemap.xml` und `robots.txt` werden beim Bau
statisch erzeugt; ihr HTML ist dann fertig und liegt in jedem Zwischenspeicher.
Eine Laufzeitherkunft könnte darin nur stehen, wenn diese Seiten bei jedem
Aufruf neu gerendert würden — der Preis wäre die Geschwindigkeit der Website.
Er ist nicht nötig: Die kanonische Domain ist eine **Produktkonstante**, für
jede Umgebung dieselbe (`https://clenaris.qasemi.ch`). Eine Probeumgebung
zeigt ihre Canonicals auf die Produktion — das ist für Suchmaschinen richtig.
Zusätzlich soll ihr Proxy `X-Robots-Tag: noindex` senden (Empfehlung; es gibt
noch keine Probeumgebung, an der das eingerichtet wäre).

Damit gilt: **ein Artefakt für alle Umgebungen**, nicht ein Bau je Umgebung.
Das CI baut mit `NEXT_PUBLIC_SITE_URL=https://clenaris.qasemi.ch` und
`APP_URL=http://localhost:3000`; derselbe Bau wäre auslieferbar.

### Beweis

`tests/api/laufzeit-konfiguration.test.ts`, Teil „Dasselbe Artefakt":
Aus **einem** vorhandenen Bau starten zwei `next start` mit
`APP_URL=https://a.pruef-clenaris.example` bzw.
`https://b.pruef-clenaris.example:8443` und verschiedenen Kennungen, ohne
Neubau. Geprüft:

- jede Instanz liefert ihre eigene Browser-Konfiguration;
- Herkunftsprüfung: A nimmt A an und weist B ab, B umgekehrt;
- ein **tatsächlich versendeter** Link (Newsletter-Bestätigung aus dem
  Postausgang) trägt die Herkunft der jeweiligen Instanz;
- die statische Startseite enthält keinen Laufzeitwert; `robots.txt` ist in
  beiden gleich (die Bauzeitdomain);
- Marker-Geheimnisse aus der Umgebung (Datenbank, JWT, Cron, Schlüssel,
  Stripe, Supabase, Anthropic, Resend, Twilio, SSH, Überwachung) erscheinen in
  keiner Antwort, keiner Mail, keinem HTML;
- `BUILD_ID` und dessen Zeitstempel sind danach unverändert.

Im CI ist dieser Teil Pflicht: Fehlen Bau oder Testdatenbank, scheitert er,
statt sich zu überspringen.

### Kein Verändern beim Start

`start:built` bzw. `pm2 … ecosystem.config.js` startet `next start` — kein
`npm ci`, kein Bau, keine React-Korrektur, kein `prisma generate`, kein
`git pull`. Die Aktivierung (`release-aktivieren.sh`) prüft die Korrektur mit
`--pruefen` und bricht ab, statt sie anzuwenden. Einzig `prisma migrate
deploy` schreibt — ins Schema, nicht in den Baum, und nur nach geprüfter
Sicherung.
