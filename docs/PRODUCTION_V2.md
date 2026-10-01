# Production V2 — unveränderliches Release-Artefakt (Wave 22)

> **Stand 2026-10-01 (Production-V2-Härtung, Feature Freeze).** Seit dem
> Notfallauftrag vom 2026-09-27 (`docs/NOTFALL_WIEDERHERSTELLUNG.md`) ist der
> Artefaktweg der einzige Auslieferungsweg: `deploy.yml` packt das Artefakt
> aus genau dem geprüften Bau (`scripts/release-artefakt.ts`), der Server
> prüft und schaltet um (`deploy/v2/release-aktivieren.sh`) und baut nichts.
> Die Härtung vom 2026-09-30/10-01 hat den Weg zwischen Bau und laufender
> Instanz in Verträge gefasst — Artefakt (Format 2), Identität der Instanz,
> Aktivierung (C3), Ausführer (C4), Rücksprung von Hand — und die Defekte
> behoben, an denen der erste echte Lauf gescheitert wäre (Register
> `docs/PENDENZEN.md`, Abschnitt **P2H**). `scripts/deploy.sh` ist **kein**
> Auslieferungs- und **kein** Rücksprungweg mehr; es bricht ab und nennt die
> beiden Skripte unter `deploy/v2/`. Die Auslieferung läuft nur mit
> `DEPLOY_ENABLED` bzw. `RELEASE_EXECUTOR_ENABLED`; die Infrastruktur V2 ist
> **nicht** abgenommen, und auf einem echten Server ist weder Aktivierung
> noch Rücksprung je gelaufen (V2-3, externer Nachweis ausstehend).

Ursprünglich Stand 2026-09-23, Status damals **PARTIAL** — Packen örtlich
bewiesen, Aktivierung als Entwurf, Pipeline als Vorlage. Abschnitt 4 hält
diese Probe als datierte Messung fest.

## 1. Das Problem, das V2 löst

Bis 2026-09-27 prüfte die Pipeline einen Bau — und ausgeliefert wurde ein anderer:
`deploy.sh` führte auf dem Server `git reset --hard`, `npm ci`, die
React-Korrektur und `next build` **erneut** aus. Derselbe Commit, aber ein
zweiter, ungeprüfter Baum. Zusätzlich (Befund dieser Wave):
`NEXT_PUBLIC_*` wird beim Bau fest eingesetzt, in Server- *und*
Client-Bündel. Die Pipeline baut mit `NEXT_PUBLIC_APP_URL=http://localhost:3000`,
der Server mit der echten Adresse — die beiden Bauten unterscheiden sich also
nachweislich, nicht nur möglicherweise.

Die Härtung fand eine dritte Spielart desselben Problems: Auch ein in der CI
gebautes Artefakt war nicht genau „der geprüfte Bau". Es entstand aus einem
Bau gegen die **Demodatenbank** (vorgerenderte Seiten mit Demodaten), nachdem
der Prüfserver ISR-Seiten in `.next` zurückgeschrieben hatte, und mit
`.next/cache` aus früheren Läufen. Seit 2026-09-30 gilt deshalb: Gebaut wird
gegen eine Datenbank nur mit Konfiguration, ohne Zwischenspeicher, gepackt
**vor** dem ersten Serverstart (P2H-06).

## 2. Der Ablauf

```
CI (deploy.yml, Auftrag „Prüfung")
npm ci → verify:static → Stückliste
  → prisma migrate deploy → scripts/datenbank-schranken.ts      (Datenbanktor)
  → npm run db:seed                                             (nur Konfiguration)
  → npm run build                                               (einmal, ohne .next/cache)
  → Leistungsbudget
  → npx tsx scripts/release-artefakt.ts --ausgabe release       (packen, vor jedem Serverstart)
  → npm run db:seed:demo → Testserver → verify:tests            (gegen genau diesen Bau)
  → Ablage release-<sha>   nur bei Push oder Handstart auf main, nach grünen Prüfreihen

Server (Vertrag C3)
  → deploy/v2/release-aktivieren.sh <archiv> --erwartet-sha256 <hex64>
       Sperre → Summe → Manifest → frisch entpacken → Vorprüfung
       → Migration (mit Sicherung) → Umschalten mit Identitätsprüfung
  → next start aus releases/<commit> über PM2 (ecosystem.config.js im Release)
```

| Baustein | Datei | Stand |
|---|---|---|
| Vertrag des Artefakts | `src/lib/release/manifest.ts` (`RELEASE.json` Format 2, `auslieferbarNach`) | eine Form für Packen, Aktivierung, Vorprüfung, Ausführer und laufende Instanz |
| Packen | `scripts/release-artefakt.ts`, Regeln in `scripts/release/artefakt-regeln.ts` | rein geprüft (`tests/api/release-artefakt.test.ts`); örtliche Rauchprobe; erster echter Lauf in der CI steht aus |
| Bauvergleich | `scripts/bau-vergleich.ts` | rein geprüft (`tests/api/bau-vergleich.test.ts`); CI-Auftrag `reproduzierbarkeit` nie gelaufen |
| Identität | `src/lib/release/identitaet.ts`, `GET /api/health` | rein geprüft (`tests/api/release-identitaet.test.ts`) |
| Aktivieren | `deploy/v2/release-aktivieren.sh` | Text geprüft (`tests/api/release-ausfuehrer-vorlage.test.ts`), örtliche Rauchprobe bis zur Umschaltung; auf einem echten Server **nie ausgeführt** |
| Umschalten | `scripts/release-umschalten.ts`, `scripts/release/umschaltung.ts` | mit Attrappen geprüft (`tests/api/release-ruecksprung.test.ts`) |
| Rücksprung von Hand | `deploy/v2/release-ruecksprung.sh`, `scripts/release-ruecksprung.ts` | mit Attrappen geprüft; auf einem Server nie ausgeführt |
| Pipeline | `.github/workflows/deploy.yml` (Prüfung, Packen, Ablage, Auslieferung, Reproduzierbarkeit) | seit 2026-09-27 der direkte Weg; `tests/api/auslieferung-absicherung.test.ts` |
| Release-Ausführer | `deploy/v2/release-ausfuehrer.yml` (Vorlage), `scripts/release-ausfuehrer.ts` | der zweite Weg (Abschnitt 6); `deploy/v2/workflow-ergaenzung.yml` ist seit 2026-09-30 gelöscht (überholte zweite Beschreibung, P2H-15) |
| Korrekturen | `deploy.yml` über `verify:static`; Packen und Aktivierung prüfen RB-001 und RB-002 | — |

### Was das Artefakt enthält — und was nicht

Enthalten (Einschlussliste, nicht Ausschlussliste): `.next` ohne `cache`,
`node_modules` **mit** angewandten Korrekturen, `prisma` (Schema und
Migrationen), `prisma.config.ts` (seit Prisma 7 nötig für `migrate` im
Release), `public`, `scripts`, `src`, `deploy`, `security`, `package.json`,
`package-lock.json`, `next.config.ts`, `ecosystem.config.js`,
`tsconfig.json`, Tailwind-/PostCSS-Konfiguration, `RELEASE.json`.

Nie enthalten: jede `.env*` (auch tief im Inhalt verweigert), von Git
ignorierte Dateien (einzige Ausnahme die erzeugten PDF.js-Dateien unter
`public/pdfjs`), Tests, Doku, Prüfberichte. Die Ausschlüsse sind verankert:
nur `<distDir>/cache`, und `.env*`/`*.tsbuildinfo` nur direkt unter einem
obersten Eintrag — ein Paketordner namens `cache` in `node_modules` bleibt
drin. Nach dem Packen wird das Archiv gegen den Baum abgeglichen (fehlend,
überzählig, doppelt); ein gescheitertes Archiv wird gelöscht.

**Verweigert** wird das Packen ausserdem, wenn der Bau Demodaten trägt
(Kennzeichen aus `prisma/demo-kennzeichen.ts`, der einzigen Quelle, die auch
der Demo-Seed liest), wenn nach dem Bauen ein Server in `.next/server`
geschrieben hat, wenn der Baum unsauber ist (ausser `--unsauber`, dann nie
auslieferbar), wenn `GITHUB_SHA` nicht der ausgecheckte Commit ist oder die
CI-Herkunft nur halb gesetzt ist.

`RELEASE.json` (Format 2) hält: `format`, `anwendung`, `version`
(`package.json`), `commit` (40 Hex), `unsauber`, `buildId`, `distDir`,
`quelleZeitUtc` (Commitzeit, nicht Packzeit), `node`, `npm`, `plattform`,
`next`, `sperrdateiSha256`, `seitenUrl` (die kanonische Domain, nur zur
Nachvollziehbarkeit), `reactKorrektur`, `mitModulen`, `migrationen` (sortiert),
`ci` (`lauf`, `versuch`, `ereignis`, `ref`, `repository`) und `auslieferbar`.
Die Beilage `clenaris-<sha12>.json` daneben trägt dazu `archivSha256`,
`archivGroesseBytes`, `erstelltUtc` und `archivNormalisiert` — die Summe kann
nicht im Archiv stehen, dessen Summe sie ist.

**Auslieferbar** ist nur ein Artefakt aus der CI auf `refs/heads/main`, aus
einem Push oder einem von Hand gestarteten Lauf, vollständig (mit Modulen),
aus einem sauberen Baum und aus `.next`. Ein Pull-Request-Lauf packt zur
Probe; er baut den Zusammenführungs-Commit, der nie auf `main` stand.

**Reproduzierbar** ist das Archiv mit GNU tar (CI): sortiert, Zeiten auf die
Commitzeit, Besitzer 0, pax ohne atime/ctime, `gzip -n` — gleiche Eingabe,
gleiche SHA-256. Der Bau selbst ist es nicht ganz: Next würfelt Build-ID,
Vorschau- und Aktionsschlüssel. `scripts/bau-vergleich.ts <bauA> <bauB>
[--bericht <datei>]` vergleicht zwei Bauten desselben Stands (gleiches
Verzeichnis, gleiches `NEXT_DIST_DIR`, gleiche Datenbank) und endet nur mit 0,
wenn ausschliesslich diese erwarteten Unterschiede auftreten. Der CI-Auftrag
`reproduzierbarkeit` (nur `workflow_dispatch`) baut zweimal und legt den
Bericht ab — gelaufen ist er noch nie (P2H-21).

### Was die Aktivierung prüft, bevor sie etwas ändert (Vertrag C3)

```
CLENARIS_BASIS=/home/clenaris/clenaris \
  bash release-aktivieren.sh <archiv.tar.gz> --erwartet-sha256 <64 Hex>
```

1. **Sperre** `${BASIS}/.release.lock` (`flock`), gemeinsam mit dem
   Rücksprung — besetzt: Ausgang 11.
2. **Summe:** Die erwartete Summe ist Pflicht und kommt vom Aufrufer, der sie
   gegen die CI-Beilage geprüft hat; sie muss der frischen Messung **und** der
   mitgelieferten `.sha256` entsprechen. Gemessen, gelesen und entpackt wird
   eine **private Kopie** — ein Tausch im Eingang nach dem Messen wirkt nicht.
3. **Manifest** vor dem Entpacken: Format 2, `auslieferbar`, Commit, Build-ID,
   `distDir` `.next`, Version, Node-Hauptversion gleich dem Server; `APP_URL`
   in `shared/.env` vorhanden.
4. **Immer frisch entpacken** nach `releases/<commit>.tmp.<pid>`; `.next/BUILD_ID`
   muss die Build-ID des Manifests sein; volle Schemaprüfung mit dem Werkzeug
   aus genau diesem Archiv. Ein vorhandenes `releases/<commit>` wird nie
   ungeprüft wiederverwendet.
5. **Schon aktiv?** Läuft genau dieses Release und bestätigt sich: 0, nichts
   geändert. Derselbe Commit als **anderer Bau**: 10, das laufende Release
   und sein Archiv bleiben unberührt (ein zweiter Bau desselben Commits ersetzt
   den laufenden nicht).
6. Hydrationskorrektur (RB-001) und Cachezeitkorrektur (RB-002) im entpackten
   Baum (`--pruefen`).
7. **Produktionsvorprüfung** `--phase vor-migration`, bei offenen Migrationen
   `migration-preflight.ts` → `db-backup.ts` (fail-closed) → `prisma migrate
   deploy`; danach die Vorprüfung noch einmal ohne offene Migration. Eine
   BRECHENDE Migration hält an, ausser `CLENARIS_WARTUNGSFENSTER=ja`.
8. **Umschalten** mit dem Werkzeug aus dem **neuen** Release
   (`scripts/release-umschalten.ts`): `current` atomar, PM2 laden, `/api/health`
   bis zu 45-mal im Abstand von 2 s fragen — gesund ist die neue Fassung erst
   nach **drei Antworten in Folge** mit HTTP 200, `version` = Commit,
   `buildId` = Manifest und `identitaet` = `belegt`. Sonst zurück auf die
   vorherige Fassung, die genauso geprüft wird. `pm2 save` nur nach
   bestätigter Identität.
9. **Archiv aufbewahren** — erst jetzt, nach bestätigter Umschaltung:
   `archiv/clenaris-<sha12>.tar.gz` samt `.sha256`. Aufbewahrt werden
   `CLENARIS_RELEASES_KEEP` (Vorgabe 5, mindestens 2) Releases, nie das aktive
   und nie das vorherige, und die Archive im Gleichschritt.

| Ausgang | Zustand | Bedeutung |
|---|---|---|
| 0 | `AKTIV` | neue Fassung läuft, Identität bestätigt (auch: lief schon und bestätigt sich) |
| 10 | `NICHT_UMGESCHALTET` | vor dem Umschalten abgebrochen, `current` unverändert — Migrationen können bereits angewandt sein, das Protokoll sagt es |
| 11 | `GESPERRT` | eine andere Aktivierung oder ein Rücksprung hält die Sperre |
| 20 | `ZURUECK` | umgeschaltet, neue Fassung nicht bestätigt, die vorherige läuft **nachweislich** wieder |
| 30 | `UNKLAR` | alles andere nach dem Umschalten — sofort von Hand prüfen |

Die letzte Zeile auf stdout ist immer `ERGEBNIS {"code":…,"zustand":"…","commit":"…"}`;
jeder Lauf steht als Zeile in `${BASIS}/aktivierungen.jsonl` (Zeit, Art, von,
nach, Code, Zustand, Migration — keine Werte aus der Umgebung). PM2 bekommt
eine Positivliste der Umgebung (nie `APP_VERSION`, `GITHUB_*`,
`CLENARIS_PRUEF_*`, `CLENARIS_TEST_CACHE_DIR`); übernimmt PM2 beim Neuladen
das Arbeitsverzeichnis nicht, wird die Anwendung aus dem Release neu
gestartet (kurze Unterbrechung; auf einem echten Server ungeprüft, P2H-20).

Verzeichnisaufbau auf dem Server:

```
$BASIS/releases/<commit>/   ein entpacktes Artefakt je Commit
$BASIS/current -> releases/<commit>
$BASIS/archiv/              aktivierte Archive samt .sha256 (für den Rücksprung)
$BASIS/releases-eingang/    Übergabe aus der Pipeline, nach dem Entpacken geleert
$BASIS/shared/.env          Geheimnisse, nie im Artefakt
$BASIS/shared/logs/         Protokolle über Releases hinweg
$BASIS/aktivierungen.jsonl  jede Aktivierung und jeder Rücksprung
$BASIS/.release.lock        gemeinsame Sperre
```

Nicht geprüft wird auf dem Server bisher das Datenbanktor nach der Migration
(P2H-25) — es läuft in der CI und im vollen Prüfweg.

## 3. Voraussetzungen vor dem Umstieg (Blocker)

| Nr. | Punkt | Warum |
|---|---|---|
| ~~V2-1~~ | **Geschlossen 2026-09-26** — siehe [Abschnitt 5](#5-v2-1-laufzeitkonfiguration-geschlossen-2026-09-26) | Umgebungsabhängiges steht zur Laufzeit; derselbe Bau unter zwei Umgebungen bewiesen (`tests/api/laufzeit-konfiguration.test.ts`). Bewusst beim Bau bleibt nur die kanonische Domain der statischen Website |
| **V2-2** | Bau auf **Linux** mit derselben Node-Hauptversion wie der Server | `node_modules` enthält die Prisma-Engine für die Bauplattform. Die Node-Hälfte ist seit 2026-09-26 erledigt (`.nvmrc` 22, `engines` ≥ 22, CI baut damit); offen bleibt, dass der Server Node 22 hat — die Aktivierung und der Rücksprung verweigern eine abweichende Hauptversion |
| **V2-3** | Aktivierung und Rücksprung auf einem **Probeserver** durchspielen: Erstinstallation, zweites Release, absichtlich kaputtes Release (Ausgang 20), Artefakt mit falscher Summe, fehlendes `APP_URL`, `auslieferbar=false`, besetzte Sperre (11), zweiter Bau desselben Commits, Rücksprung mit und ohne `--schema-bewusst`, PM2-Neuladen mit Verzeichniswechsel — dazu der Release-Ausführer (Abschnitt 6) mit echter GitHub-Umgebung (P2H-20) | Die Skripte sind nie auf einem Server gelaufen; unter Windows fehlen `flock`, PM2 und das Recht für Symlinks |
| **V2-4** | Verzeichnisaufbau nach Abschnitt 2 einrichten (`releases/`, `archiv/`, `releases-eingang/`, `shared/.env`, `shared/logs`) | `ecosystem.config.js` läuft aus dem Release-Verzeichnis (`__dirname`), PM2 nur über das Umschaltwerkzeug |
| **V2-5** | CI-Ablage: Grösse des Artefakts mit `node_modules` messen (örtliche Probe ohne Module: 18 MB) und Aufbewahrung festlegen | Nicht gemessen |
| **V2-6** | Sicherungs-Blocker aus `docs/BACKUP_DR.md` (B-DR-1 bis B-DR-3) | Eine schnellere Auslieferung ändert nichts daran, dass die Daten nicht gesichert sind |

## 4. Örtliche Probe (2026-09-23, datierte Messung)

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

Damals fehlten `prisma.config.ts` und `security` im Inhalt (seit 2026-09-30
enthalten), und `RELEASE.json` wurde in die Wurzel des Repositories
geschrieben (heute nie mehr). Nicht geprüft: ein vollständiges Artefakt mit
`node_modules`, die Aktivierung, irgendetwas auf einem Server — **EXTERNAL
VERIFICATION REQUIRED**.

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

Dazu seit 2026-09-30 eine Laufzeitvariable ohne `NEXT_PUBLIC_`-Namen, die
Server **und** Browser betrifft:

| Variable | Wirkung | Vorgabe |
|---|---|---|
| `CLENARIS_BESUCHSMESSUNG` | Nur der Wert `an` schaltet die eigene Besuchsmessung ein (Server über `serverEnv()`, Browser über das Feld `besuchsmessung` aus `GET /api/public/runtime-config`). Ausgeschaltet antwortet `POST /api/public/traffic` mit 204 ohne Speichern; der Browser sendet nichts | aus — eingeschaltet wird erst nach der Rechtsprüfung (TA-02); die Produktionsvorprüfung warnt bei `an` |

### Wie es jetzt ist

- **`src/lib/laufzeit-konfiguration.ts`** liest die Umgebung zur Laufzeit —
  über einen Verweis auf `process.env`, den der Bau nicht ersetzt.
  `ursprungAus()` verlangt Schema, Host, Port und sonst nichts; ein Pfad,
  Zugangsdaten oder ein anderes Schema werfen. Fehlt `APP_URL` in der
  Produktion, wirft es ebenfalls: Ein lauter Fehler ist besser als ein
  stilles `localhost` in Kundenmails.
- **`GET /api/public/runtime-config`** liefert dem Browser genau
  `PublicRuntimeConfigSchema` (`appUrl`, `analytics.{gaMeasurementId, gtmId,
  facebookPixelId}`, seit 2026-09-30 `besuchsmessung`), Feld für Feld benannt,
  `.strict()`. Kennungen ausserhalb ihres engen Formats fallen weg, statt in
  ein Skript zu geraten. Nie die ganze Umgebung, nichts aus der Anfrage.
  `Cache-Control: no-cache`.
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

Ebenso beim Bau fest: die **Inhaltsrichtlinie** — Next friert die Antwortköpfe
beim Bau in `.next/routes-manifest.json` ein. Deshalb entscheidet über
`'unsafe-eval'` die Next-Phase und keine Umgebungsvariable: Eine Variable,
die beim Bau gesetzt war, reiste still im Artefakt mit
(`src/lib/security/inhaltsrichtlinie.ts`, `docs/SECURITY_STANDARD.md` C6).

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
- `BUILD_ID` und dessen Zeitstempel sind danach unverändert;
- seit 2026-09-30: Instanz A mit `CLENARIS_BESUCHSMESSUNG=an` speichert,
  Instanz B ohne speichert nichts.

Im CI ist dieser Teil Pflicht: Fehlen Bau oder Testdatenbank, scheitert er,
statt sich zu überspringen. Die beiden Instanzen starten seit 2026-09-30 mit
`next start -p 0` und tragen eine Beweissicherung für den Fall W-11
(`tests/helpers/instanz-diagnose.ts`, `docs/PENDENZEN.md` W-11).

### Kein Verändern beim Start

`start:built` bzw. `pm2 … ecosystem.config.js` startet `next start` — kein
`npm ci`, kein Bau, keine React-Korrektur, kein `prisma generate`, kein
`git pull`. Die Aktivierung (`release-aktivieren.sh`) prüft die Korrekturen
mit `--pruefen` und bricht ab, statt sie anzuwenden. Einzig `prisma migrate
deploy` schreibt — ins Schema, nicht in den Baum, und nur nach geprüfter
Sicherung.

## 6. Release-Ausführer: vom Update Center zum Artefakt (2026-09-27, neu gefasst 2026-09-30)

Bis 2026-09-27 hielt das Update Center (`/admin/updates`) Entscheidungen fest
— freigegeben, terminiert — und dann geschah nichts. Der Weg dazwischen ist im
Repository gebaut und geprüft; angeschlossen wird er mit dem Umstieg auf V2.
Die Härtung hat ihn nach Vertrag C4 neu geschnitten: Die Vorlage vom
2026-09-27 wäre beim ersten Lauf gescheitert (andere Secret-Namen als
`deploy.yml`, Aktivierungsskript aus `current/`, ohne Port und
Wirtsschlüsselprüfung, Ausdrücke im Skripttext, ROLLED_BACK aus einer zweiten
Frage an die Instanz — P2H-14).

```
Update Center: Version freigeben + terminieren          (Systemverantwortung, Prüfprotokoll)
  → plan       fälligen Auftrag holen                    GET  /api/cron/release-auftraege   neu | fortsetzen | nichts
  → ci-lauf    grünen Push-Lauf von deploy.yml auf main  gh run list …   (genau dieser Commit, sonst Abbruch)
  → abholen    Artefakt laden, messen, Beilage prüfen    = Release.artifactSha256; dann POST …/uebernehmen
                                                         mit commit + zielVersion   SCHEDULED → DEPLOYING
  → aktivieren release-aktivieren.sh AUS DEM ARCHIV, mit --erwartet-sha256 (Abschnitt 2)
  → melden     Ausgang der Aktivierung                   POST …/ergebnis   → SUCCEEDED | ROLLED_BACK | FAILED
  → identitaet laufende Identität (Diagnose)
```

| Teil | Wo |
|---|---|
| Schnittstelle der Anwendung | `src/app/api/cron/release-auftraege/**`, `src/server/services/release-ausfuehrung.service.ts`, Regeln rein in `src/lib/release/ausfuehrungsregeln.ts` |
| Signatur (beide Seiten dieselbe Datei) | `src/lib/release/ausfuehrer-signatur.ts` |
| Werkzeug | `scripts/release-ausfuehrer.ts` — `plan`, `ci-lauf --datei <json> --commit <sha40>`, `abholen --verzeichnis <dir> --auftrag <id> --ci-lauf <id> --ci-url <url>`, `melden --auftrag <id> --aktivierung <Ausgang oder leer> [--meldung <text>]`, `identitaet` |
| Workflow-Vorlage | `deploy/v2/release-ausfuehrer.yml` — **nicht** unter `.github/workflows`; Auslöser nur Zeitplan (`*/15`) und `workflow_dispatch`, fail-closed über `vars.RELEASE_EXECUTOR_ENABLED`, Umgebung `production` |
| Prüfung | `tests/api/release-center.test.ts` (Block „Release-Ausführer", echte Signaturen, echtes Werkzeug gegen den Testserver; Block „ohne Server" rein), `tests/api/release-ausfuehrer-vorlage.test.ts` (Text der Vorlage und beider Wege), `tests/api/release-identitaet.test.ts` (Regeln gegen jeden Identitätszustand) |

**Umgebung des Werkzeugs:** `CLENARIS_URL`, `RELEASE_EXECUTOR_TOKEN`,
`RELEASE_EXECUTOR_SIGNING_KEY`, `UMGEBUNG`, `AUSFUEHRER`
(`github-actions/production`), `SCHLUESSEL` (`github-actions-lauf-<run_id>`,
16–120 Zeichen), `GITHUB_OUTPUT`, `AUSFUEHRER_WIEDERHOLUNGEN` (Vorgabe 6, je
10 s Pause). Die Vorlage liest dieselben Secrets wie `deploy.yml`
(`SERVER_SSH_KEY`, `SERVER_SSH_KNOWN_HOSTS`, `SERVER_HOST`, `SERVER_PORT`,
`SERVER_USER`, `APP_DIRECTORY`) plus `RELEASE_EXECUTOR_TOKEN` und
`RELEASE_EXECUTOR_SIGNING_KEY`, dazu die Variablen `CLENARIS_URL` und
`RELEASE_EXECUTOR_ENABLED`. Jede Schrittausgabe wird je Schlüssel gegen ihre
Form geprüft und ganz oder gar nicht geschrieben; ein Archivpfad ist ein
Shell-Wort ohne Leerzeichen und ohne führendes `-` oder `~`.

**Ausgänge des Werkzeugs (C4):** 0 getan — bei `melden` heisst das genau:
SUCCEEDED festgehalten; 1 Fehler, nichts Belastbares geschehen (bei `melden`:
Meldung nicht angenommen, der Auftrag bleibt in Ausführung); 2 nur `melden`:
angenommen, aber kein Erfolg (FAILED oder ROLLED_BACK). `melden` übersetzt den
Ausgang der Aktivierung: 0 → AKTIV, 20 → ZURUECK, 10 → NICHT_UMGESCHALTET,
11 → GESPERRT, 255 → NICHT_VERBUNDEN, 30/leer/sonst → UNKLAR.

**Was die Anwendung prüft, bevor sie einen Auftrag hergibt:** Bearer
`RELEASE_EXECUTOR_TOKEN` *und* HMAC-SHA256 mit `RELEASE_EXECUTOR_SIGNING_KEY`
über Methode, Pfad, Zeit (±5 Minuten) und Rohrumpf · Umgebung des Ausführers =
`CLENARIS_UMGEBUNG` der Instanz · Auftrag terminiert und fällig · der laufende
Stand ist **belegt** (Identität) und älter als das Ziel · CI bestanden, Commit
und Prüfsumme eingetragen · gemessene Prüfsumme = Prüfsumme des Release ·
Commit (40 Hex) und Zielversion der gemessenen Beilage = die des Release (422
bei Abweichung) · eine Ausführung je Umgebung (Beratungssperre, sonst 409).
Idempotent über den Ausführungsschlüssel: derselbe Lauf erneut → dieselbe
Antwort, ein abgebrochener Lauf setzt über `inAusfuehrung` fort; ein anderer
→ 409. Jeder Übergang steht im Prüfprotokoll (ohne Benutzer, mit Ausführer,
Commit, Prüfsumme, CI-Nachweis, gemeldeter Aktivierung und beobachteter
Identität).

**Das Ergebnis entscheidet der Server, nicht der Ausführer:**

- **SUCCEEDED** nur mit Aktivierung `AKTIV` **und** einer Instanz, die das
  Ziel belegt (Commit und Version des Ziels, `identitaet=belegt`). Meldet der
  Ausführer „erfolgreich", die Instanz aber etwas anderes, wird FAILED
  festgehalten.
- **ROLLED_BACK** nur mit Aktivierung `ZURUECK` (Ausgang 20) **und** einer
  Instanz, die die Ausgangsversion mit anderem Commit belegt. Früher genügte
  „Aktivierung rot, und eine zweite Frage liefert die alte Version" — ein
  Netzabbruch vor der Aktivierung sah dann wie ein Rücksprung aus.
- **FAILED** in jedem anderen Fall.
- Ein Auftrag, der über **zwei Stunden** in DEPLOYING hängt (Ausführer
  abgebrochen, Meldung verloren), wird vom Stundenlauf (`/api/cron/hourly`,
  Teilaufgabe `releaseAusfuehrungen`) anhand der Identität abgeschlossen:
  SUCCEEDED, wenn die Instanz das Ziel belegt, sonst FAILED.

**Was die Anwendung nicht bekommt:** SSH-Schlüssel, GitHub-Token, Zieladresse.
Sie ruft niemanden an; der Ausführer holt ab. Ein übernommenes Konto der
Systemverantwortung kann einen Termin setzen — ausgeführt wird nur, was CI
bestanden hat und dessen Bytes stimmen.

**Rücksprung:** Jeder Auftrag nennt `ruecksprung.aufVersion` (die Version beim
Freigeben) und ob das Schema zurückbleibt (`schemaBleibt`, sobald Migrationen
dabei sind — Migrationen laufen nur vorwärts). `release-aktivieren.sh`
springt bei nicht bestätigter Identität selbst zurück und prüft die vorherige
Fassung; ROLLED_BACK folgt allein aus Ausgang 20. Einen späteren Rücksprung
von Hand beschreibt Abschnitt 8.

## 7. Identität der laufenden Instanz (seit 2026-09-30)

Bis hierher nannte `/api/health` als Version den Wert von `APP_VERSION`, den
die Aktivierung über PM2 selbst setzte, und das Update Center nahm für
Prüfumgebungen `CLENARIS_VERSION` — Behauptungen der Umgebung, nicht des
Artefakts. Ein Verzeichnis A mit `APP_VERSION=<B>` meldete sich als B, und
die Aktivierung hielt das für den Beweis.

Jetzt belegt die Instanz ihren Stand aus zwei Dateien, die mit dem Artefakt
reisen (`src/lib/release/identitaet.ts`): `RELEASE.json` und
`<distDir>/BUILD_ID`. Belegt ist der Stand nur, wenn das Manifest den Vertrag
erfüllt, beide dieselbe Build-ID nennen, das Manifest das Bauverzeichnis der
Instanz beschreibt und seine Version die eingebaute (`package.json`) ist.

| Zustand | Bedeutung |
|---|---|
| `belegt` | Manifest und Bau passen zusammen — Commit und Version gelten |
| `ohne-manifest` | kein `RELEASE.json` (Entwicklung, Prüfbau, Altstand) |
| `widerspruechlich` | gültiges Manifest, aber nicht für diesen Bau |
| `ungueltig` | Manifest unlesbar, Format 1 oder fremd |

`GET /api/health` liefert `version` (der Commit — **nur** wenn belegt, sonst
`null`), `buildId` (in jedem Zustand, sofern lesbar), `release` (die
semantische Version, nur wenn belegt) und `identitaet`. Der Statuscode hängt
weiterhin nur an der Datenbank. Den Grund einer fehlenden Belegung zeigt die
Sicherheitszentrale der Systemverantwortung, nicht der unangemeldete
Endpunkt. `APP_VERSION` und `CLENARIS_VERSION` werden nirgends mehr gelesen;
die Produktionsvorprüfung verlangt `RELEASE.json`, `BUILD_ID`-Gleichheit,
Format 2 und `auslieferbar` nach der Regel.

Der Prüfserver hat kein gepacktes Artefakt; `CLENARIS_PRUEF_RELEASE_MANIFEST`
reicht ihm ein Manifest herein — wirksam **nur** bei `CLENARIS_UMGEBUNG=test`,
in jeder anderen Umgebung ignoriert und in der Produktionsvorprüfung ein
Fehler.

## 8. Rücksprung von Hand (seit 2026-09-30)

`scripts/deploy.sh` kannte einen Rücksprung — aber nur, indem es auf dem
Server neu baute; seit dem Notfallauftrag ist es stillgelegt. Die Aktivierung
springt nur im Augenblick einer gescheiterten Umschaltung zurück. Für einen
Fehler, der erst Stunden später auffällt, gibt es jetzt einen eigenen Weg:

```
CLENARIS_BASIS=/home/clenaris/clenaris \
  bash deploy/v2/release-ruecksprung.sh --auf <Commit, 40 Hex> --erwartet-sha256 <64 Hex> \
                                        [--port 3000] [--schema-bewusst]
```

- Die Hülle hält dieselbe Sperre wie die Aktivierung und startet
  `scripts/release-ruecksprung.ts` aus dem **laufenden** Release
  (`readlink -f current`) — nur es kennt seine eigenen Migrationen und deren
  Einstufung.
- Zurück geht es nur auf ein Archiv unter `${BASIS}/archiv/`, dessen Summe
  der erwarteten **und** der daneben liegenden `.sha256` entspricht und dessen
  `RELEASE.json` genau `--auf` nennt. Die erwartete Summe kommt aus der
  Zusammenfassung des CI-Laufs oder aus dem Release Center
  (`Release.artifactSha256`), nicht vom Server.
- Gemessen, gelesen und entpackt wird eine private Kopie, frisch in ein neues
  Verzeichnis; eine abweichende Node-Hauptversion wird vor dem Entpacken
  verweigert.
- **Das Schema geht nie mit zurück.** Migrationen des laufenden Release, die
  das Ziel nicht kennt, bleiben in der Datenbank. Ist eine davon nicht
  RUECKWAERTSVERTRAEGLICH (oder ohne Einstufung), wird verweigert — ausser
  mit `--schema-bewusst`, und das steht dann im Protokoll.
- Umgeschaltet und geprüft wird mit derselben Stelle wie bei der Aktivierung;
  Ausgänge 0/10/11/20/30, `ERGEBNIS`-Zeile, Eintrag in `aktivierungen.jsonl`.
  Ist das Ziel bereits aktiv: 10, nichts zu tun.
- Kein Bau, kein `npm`, kein `git`, keine Rückwärtsmigration.

## 9. Zwei Wege in die Produktion

Beide bleiben (Entscheid der Betreiberin, 2026-09-30), und beide folgen
demselben Vertrag — Aktivierungsskript aus dem geprüften Archiv, erwartete
Summe als Pflichtargument, Erfolg nur bei bestätigter Identität:

| Weg | Auslöser | Schalter | Freigabe |
|---|---|---|---|
| Auftrag `auslieferung` in `.github/workflows/deploy.yml` | jeder grüne Push auf `main` (bzw. Handstart auf `main`) | `vars.DEPLOY_ENABLED == 'true'` | **keine Freigabe im Release Center** — der direkte Weg umgeht sie; die Freigabe ist das Zusammenführen nach `main` |
| Release-Ausführer (Vorlage `deploy/v2/release-ausfuehrer.yml`) | Zeitplan oder Handstart, nur für freigegebene und terminierte Aufträge | `vars.RELEASE_EXECUTOR_ENABLED == 'true'` | Freigabe und Termin im Update Center |

Beide Aufträge gehören zur Nebenläufigkeitsgruppe
`clenaris-auslieferung-production`: Nie laufen zwei Aktivierungen zugleich.
GitHub hält je Gruppe höchstens **einen** wartenden Lauf; ein weiterer
verdrängt ihn (`cancelled`, auf dem Server ist nichts geschehen). Beide Wege
gleichzeitig einzuschalten ist deshalb nicht der vorgesehene Zustand
(`docs/PENDENZEN.md` P2H-19).

## 10. Offen

| Nr. | Punkt | Art |
|---|---|---|
| V2-2 … V2-6 | Abschnitt 3 | extern |
| P2H-20 | Aktivierung, Rücksprung und Ausführer auf einem Linux-Probeserver; `/api/health` mit `identitaet=belegt` auf V2 | extern |
| P2H-21 | erster Lauf des Auftrags `reproduzierbarkeit` | extern (GitHub) |
| P2H-25 | Datenbanktor nach der Migration auch auf dem Server | intern |
| P2H-22 | Prüfung von aussen entfällt ohne `API_URL` (bewusst; bindend ist die Prüfung auf dem Server) | intern, Pflege |
| P2H-23 | Update Center zeigt „belegt" noch nicht | intern, Pflege |

Keine Ausführung gegen die Produktion ohne gesonderte Freigabe — **EXTERNAL
VERIFICATION REQUIRED**.
