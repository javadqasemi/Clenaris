# GitHub-Governance

Stand 2026-09-27, fortgeschrieben 2026-10-01 (Production-V2-Härtung:
Workflow, Artefakt, zweiter Auslieferungsweg — Abschnitte 4 und 5). Dieses
Dokument beschreibt, wie das Repository `javadqasemi/Clenaris` auf GitHub
abgesichert ist und was davon **tatsächlich eingestellt** ist. Die
Einstellungen in Abschnitt 1 wurden am 2026-09-27 über die API gelesen; seither
nicht neu gelesen ist, was dort als „seither" markiert ist.

**Angewandt am 2026-09-27** (Auftrag „Enterprise Remediation", Phase 42 — die
Schutzmassnahmen, die der bestehende Plan kostenlos bietet): der Regelsatz aus
Abschnitt 2, Secret Scanning, Push Protection und Dependabot-Warnungen.
**Nicht** verändert: Sichtbarkeit, Standardzweig, Plan, Secrets, Variablen —
das sind Entscheide der Inhaberschaft. Vorher- und Nachher-Stand wurden über
die GitHub-API gelesen; der Nachher-Stand steht unten.

---

## 1. Ist-Stand (über die API gelesen am 2026-09-27, nach dem Anwenden)

| Bereich | Wert |
|---|---|
| Sichtbarkeit | **öffentlich** (unverändert) |
| Standardzweig | am 2026-09-27 gelesen: `feature/crud-rbac-cta`. **Seither `main`** (von der Inhaberschaft am 2026-09-27 umgestellt; nach dieser Lesung nicht erneut über die API bestätigt) |
| Schutz von `main` | **Regelsatz „main schützen" (ID 24071027), `active`**: `deletion`, `non_fast_forward`, `pull_request` (0 Freigaben, Unterhaltungen aufgelöst), `required_status_checks` (`Prüfung`, streng: Zweig aktuell) — `/rules/branches/main` meldet genau diese vier. Umgehungsliste leer |
| Klassischer Zweigschutz | keiner (der Regelsatz ersetzt ihn) |
| Actions erlaubt | alle Aktionen |
| `GITHUB_TOKEN`-Vorgabe | nur lesen; Workflows dürfen keine Pull Requests freigeben |
| Forks | erlaubt; Läufe aus Forks von Erstbeitragenden brauchen eine Freigabe |
| Secret Scanning | **an** (vorher aus) |
| Push Protection | **an** (vorher aus) — ein Push mit erkanntem Geheimnis wird abgewiesen |
| Dependabot-Warnungen | **an** (vorher aus) |
| Dependabot-Sicherheitsupdates | aus — sie eröffnen selbständig Pull Requests; einschalten ist ein Entscheid über den Arbeitsablauf, keine Schutzlücke |
| Umgebung `production` | Zweigregel: nur `main`; Secrets `SERVER_HOST`, `SERVER_PORT`, `SERVER_SSH_KNOWN_HOSTS` — **kein** `SERVER_SSH_KEY`, **kein** `SERVER_USER` |
| Repository-Variablen | keine — insbesondere `DEPLOY_ENABLED` und `RELEASE_EXECUTOR_ENABLED` nicht gesetzt |
| Repository-Secrets | keine |

Folge der letzten drei Zeilen: Der Auslieferungsauftrag wird übersprungen
(`DEPLOY_ENABLED` fehlt), und selbst eingeschaltet scheiterte er an der
ersten Stufe (Schlüssel und Benutzer fehlen), bevor eine Verbindung entsteht.
Die beiden CI-Läufe des Release-Kandidaten (Pull Request #9 und `main`
`67a25f2`, 2026-09-30) endeten entsprechend mit „Prüfung" grün und
„Auslieferung" übersprungen (`docs/PENDENZEN.md` W-12).

**Entscheide der Inhaberschaft, nicht Lücken des Codes:** Die Umgebung
`production` hat keine erforderlichen Freigaben (Required reviewers), und wer
Administrationsrecht am Repository hat, kann Regelsatz und Umgebung ändern —
der Workflow kann das weder verhindern noch erkennen. Beides ist bei einer
einzigen pflegenden Person bewusst so (Abschnitt 2, „Freigaben"); mit einer
zweiten Person gehören Required reviewers auf `production`.

---

## 2. Schutz für `main` — angewandt am 2026-09-27

Die Tabelle beschreibt, was gilt, und warum. Folge für die Arbeit: `main`
ändert sich nur noch über einen Pull Request, dessen Prüfung `Prüfung` grün
ist und dessen Zweig auf dem Stand von `main` steht. Ein direkter Push auf
`main` wird abgewiesen — das ist Absicht, weil ein Push dort eine
Auslieferung auslöst, sobald `DEPLOY_ENABLED` gesetzt ist.

**Empfohlen als Regelsatz** (Settings → Rules → Rulesets), nicht als
klassische Zweigschutzregel: Ein Regelsatz ist als Ganzes sichtbar, lässt sich
im Modus „Evaluate" erst beobachten und dann scharf schalten, und er gilt auch
für Administratoren, solange niemand in die Umgehungsliste eingetragen ist.

| Regel | Einstellung | Warum |
|---|---|---|
| Ziel | `refs/heads/main` | Nur der Zweig, der ausgeliefert wird |
| Pull Request verlangt | ja | Kein direkter Push auf den Auslieferungszweig — der Push löst sonst eine Auslieferung aus, sobald `DEPLOY_ENABLED` gesetzt ist |
| Erforderliche Prüfung | **`Prüfung`** (Auftrag `qualitaet`, Quelle GitHub Actions) | Der Name der Prüfung ist der `name:` des Auftrags, nicht seine ID. Ohne diese Regel ist ein roter Lauf nur eine Meinung |
| Zweig muss aktuell sein | ja | Die Prüfung soll den Stand sehen, der nach dem Zusammenführen entsteht |
| Force-Push sperren | ja | Umgeschriebene Geschichte auf `main` hebt die Zuordnung Lauf ↔ Commit auf, auf der der Health Check (`version` = Commit) aufbaut |
| Löschen sperren | ja | |
| Unterhaltungen aufgelöst | ja | Ein offener Einwand in der Durchsicht blockiert das Zusammenführen |
| Lineare Geschichte | optional | Nicht nötig für die Sicherheit; eine Stilfrage |
| Signierte Commits | nein (vorerst) | Heute wird über GitHub Desktop ohne Signaturschlüssel committet; die Regel sperrte die eigene Arbeit aus |
| Umgehungsliste | leer | Eine Ausnahme für die Inhaberschaft macht jede Regel zur Empfehlung |

### Freigaben (Approvals) — Optionen, keine Vorgabe

Das Repository hat heute **eine** Person mit Schreibrecht. GitHub lässt die
eigene Freigabe eines eigenen Pull Requests nicht zu.

| Option | Folge |
|---|---|
| **0 Freigaben** + Prüfung `Prüfung` verpflichtend | **Empfohlen, solange eine Person pflegt.** Schutz kommt aus dem Tor, nicht aus einer Unterschrift. Kein Aussperren |
| 1 Freigabe, Inhaberschaft in der Umgehungsliste | Sieht streng aus, ist es nicht: Jede Zusammenführung wäre eine Umgehung |
| 1 Freigabe durch eine zweite Person | Richtig, sobald es eine zweite Person gibt. Dann zusätzlich: „Freigaben bei neuem Push verwerfen" und „letzter Push braucht eine Freigabe durch jemand anderen" |

Für die Auslieferung selbst gibt es unabhängig davon die Umgebung
`production`: Dort lässt sich eine **Freigabe vor der Auslieferung**
einschalten (Required reviewers), ohne den Workflow zu ändern.

### Regelsatz (so angewandt, ID 24071027)

```json
{
  "name": "main schützen",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [{ "context": "Prüfung", "integration_id": 15368 }]
      }
    }
  ]
}
```

`integration_id` 15368 ist die GitHub-Actions-App. Der Modus `evaluate` ist
GitHub Enterprise vorbehalten; angewandt wurde deshalb direkt `active`. Der
Name `Prüfung` ist der des Auftrags in `deploy.yml` und erscheint so in jedem
Lauf dieses Zweigs (zuletzt Lauf 36309577672, grün). **Nachzuprüfen beim
ersten Pull Request auf `main`:** In „Rule insights" muss die Prüfung unter
genau diesem Namen erkannt werden; sonst blockiert der Regelsatz das
Zusammenführen, bis der Name angepasst ist (Settings → Rules → Rulesets).
Aufheben: Regelsatz löschen oder auf `disabled` stellen.

### Unterstützt der Plan das?

- Der Plan des Kontos ist mit dem vorhandenen Zugang **nicht lesbar**
  (`/user` liefert kein `plan`). Die folgende Aussage stützt sich deshalb auf
  die dokumentierten Regeln von GitHub, nicht auf eine Abfrage:
- **Öffentliches Repository:** Zweigschutz und Regelsätze sind in jedem Plan
  verfügbar, auch in GitHub Free. Die Lese-Endpunkte antworten
  entsprechend (`/rulesets` 200, leere Liste).
- **Privates Repository:** In GitHub Free gibt es weder Zweigschutz noch
  Regelsätze; dafür braucht es GitHub Pro (persönliches Konto) oder Team.
  **Wer auf privat umstellt, verliert auf Free den Schutz von `main`.**

### Standardzweig

Am 2026-09-27 war der Standardzweig `feature/crud-rbac-cta`, ausgeliefert
wurde `main`. Empfohlen war, `main` zum Standardzweig zu machen — sonst zielen
neue Pull Requests standardmässig auf einen Zweig ohne Tor, und
Dependabot/Secret-Scanning-Meldungen beziehen sich auf den falschen Zweig. Die
Inhaberschaft hat das umgesetzt: **Standardzweig ist `main`** (seit
2026-09-27; Abschnitt 1).

---

## 3. Sichtbarkeit — Entscheid der Inhaberschaft

**Nicht verändert.** Die Abwägung:

| | Öffentlich (heute) | Privat |
|---|---|---|
| Zweigschutz/Regelsätze auf Free | ja | **nein** (Pro/Team nötig) |
| Secret Scanning, Push Protection | kostenlos verfügbar (seit 2026-09-27 **an**) | nur mit GitHub Advanced Security |
| Actions-Minuten | unbegrenzt auf Standardläufern | 2 000 Minuten/Monat auf Free; ein Lauf dieses Workflows dauert gut 20 Minuten |
| Artefakte (Sicherheitsbericht, SBOM, bei Fehlschlag Server-Protokoll und Browserbericht) | für jedes angemeldete GitHub-Konto herunterladbar | nur mit Leserecht |
| Offengelegt | Quelltext eines kommerziellen Produkts; Betriebsdokumentation mit Domain, Aufbau, früherer Serveradresse (u. a. `docs/NEXT_DEVELOPMENT_AUDIT.md`, `docs/DEPLOYMENT.md`, `ops/security-monitor/`), Liste akzeptierter Abhängigkeitsbefunde | nichts davon |

**Empfehlung: privat, zusammen mit GitHub Pro**, damit der Schutz von `main`
bleibt. Der Quelltext ist ein Geschäftsgut, und die Betriebsdokumentation
beschreibt die Angriffsfläche genauer, als ein Fremder sie sonst kennte.
Bleibt das Repository auf Free, ist **öffentlich mit Regelsatz** besser als
**privat ohne** — dann aber Secret Scanning und Push Protection einschalten,
denn beides ist für öffentliche Repositories kostenlos.

Was eine Umstellung **nicht** leistet: Was bereits öffentlich war, ist
kopiert — Forks, Klone, Archive. Eine Umstellung schützt ab dem Zeitpunkt der
Umstellung, sie holt nichts zurück. Geheimnisse standen nach der
Geheimnisprüfung (`scripts/ci-secret-scan.sh`, im CI bestanden) keine im
verfolgten Bestand.

---

## 4. Workflow-Sicherheit (`.github/workflows/deploy.yml`)

### Aktionen festlegen

Jede fremde Aktion ist auf einen **Commit-Hash** festgelegt, mit dem
Versions-Tag als Kommentar. Aufgelöst am 2026-09-26 über die GitHub-API; das
schwebende `v4` und das genaue Tag zeigten jeweils auf denselben Commit, es
läuft also derselbe Code wie vorher.

| Aktion | Commit | Tag |
|---|---|---|
| `actions/checkout` | `11d5960a326750d5838078e36cf38b85af677262` | v4.4.0 |
| `actions/setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | v4.4.0 |
| `actions/upload-artifact` | `ea165f8d65b6e75b540449e92b4886f43607fa02` | v4.6.2 |
| `actions/download-artifact` | `d3f86a106a0bac45b974a628896c90dbdf5c8093` | v4.3.0 |

`actions/cache` (für `.next/cache`) wird seit 2026-09-30 nicht mehr benutzt
(siehe „Zwischenspeicher"); `actions/download-artifact` holt im Auftrag
`auslieferung` das Artefakt desselben Laufs. Dieselben Festlegungen gelten in
der Vorlage `deploy/v2/release-ausfuehrer.yml`;
`tests/api/auslieferung-absicherung.test.ts` („jede `uses:`-Zeile nennt einen
40-stelligen Commit") prüft Workflows und Vorlagen.

Aktualisieren: neues Tag über die API zu einem Commit auflösen (bei
annotierten Tags das Tag-Objekt dereferenzieren), Hash **und** Kommentar
ersetzen, Lauf abwarten. Neuere Hauptversionen (checkout v5+, setup-node v5+,
upload-artifact v5+, cache v5+) gibt es; ein Wechsel ist eine eigene Änderung
mit eigenem Lauf, nicht Teil einer Härtung. Empfehlung: Dependabot für
`github-actions` einschalten, damit Hash-Aktualisierungen als Pull Request
kommen.

### Rechte

- Workflow-weit `permissions: contents: read`; der Auftrag `qualitaet` erbt
  genau das (Checkout). Artefakte und Zwischenspeicher laufen über den
  Laufzeit-Token der Actions, nicht über `GITHUB_TOKEN`-Rechte.
- Auftrag `auslieferung`: `permissions: {}` — er checkt nichts aus.
- `actions/checkout` mit `persist-credentials: false`: kein Token bleibt in
  `.git/config` liegen, wo jedes Skript der Prüfreihe — auch eine
  kompromittierte Abhängigkeit aus `npm ci` — es lesen könnte.

### Pull Requests aus fremder Hand

| Frage | Befund |
|---|---|
| `pull_request_target` | nicht verwendet — der Code eines Pull Requests läuft nie mit Secrets |
| Secrets im Qualitätstor | keine; nur Wegwerfwerte in der Auftragsumgebung |
| Checkout fremden Codes mit erhöhten Rechten | nein; `pull_request` läuft mit Lesetoken |
| Skript-Einschleusung über `${{ github.event.* }}`, Zweignamen, Titel | keine solchen Ausdrücke; seit 2026-09-26 steht **kein** `${{ }}` mehr im Text eines `run:`-Blocks — Werte kommen über `env:` |
| Auslieferung aus einem Pull Request | ausgeschlossen (`github.event_name != 'pull_request'`), zusätzlich Umgebung `production` nur für `main` |
| `workflow_run`-Ketten, die Artefakte eines Pull Requests weiterverarbeiten | keine — Artefakte aus Pull Requests werden nirgends ausgeführt oder ausgeliefert |
| Läufe aus Forks | Erstbeitragende brauchen eine Freigabe (Repository-Einstellung, s. 1). Empfehlung bei öffentlichem Repository: „Require approval for all outside collaborators" |

### Zwischenspeicher

| Speicher | Schlüssel | Bewertung |
|---|---|---|
| `~/.npm` (`setup-node`, `cache: npm`) | Hash von `package-lock.json` | `npm ci` prüft jedes Paket gegen die `integrity`-Summe der Sperrdatei; ein vergifteter Zwischenspeicher scheitert daran. `node_modules` selbst wird **nicht** zwischengespeichert |
| ~~`.next/cache` (`actions/cache`)~~ | — | **seit 2026-09-30 entfernt.** Bis dahin geschlüsselt über Betriebssystem, Sperrdatei und Quelltext mit Rückfallschlüsseln; der Schlüssel übersah Konfiguration, `public/` und das Schema, und das ausgelieferte Bündel hing von einem früheren Lauf ab |
| Prisma-Engines | nicht zwischengespeichert; bei `npm ci` geladen | Netzabhängigkeit (`binaries.prisma.sh`), siehe `PREPRODUCTION_READINESS.md` §1 |

**Für Production V2 umgesetzt (2026-09-30):** Das CI baut das Artefakt, das
ausgeliefert wird (`scripts/release-artefakt.ts`), und dieser Bau läuft
**ohne** Zwischenspeicher — ein Artefakt soll von nichts abhängen, was ein
anderer Lauf hinterlassen hat. Es entsteht ausserdem aus einem Bau gegen eine
Datenbank nur mit Konfiguration und wird vor dem ersten Serverstart gepackt
(`docs/PRODUCTION_V2.md` §2). `tests/api/auslieferung-absicherung.test.ts`
„baut ohne Zwischenspeicher aus früheren Läufen" hält das fest.

### Artefakte

| Artefakt | Wann | Aufbewahrung | Inhalt und Bewertung |
|---|---|---|---|
| `sicherheitsbericht` | immer | 90 Tage | JSON der Sicherheitsprüfung + CycloneDX-Stückliste. Die Geheimnisprüfung meldet nur **Datei:Zeile**, nie einen Wert; `npm audit`-Befunde und Stückliste folgen aus der öffentlichen Sperrdatei. Keine Geheimnisse, keine Personendaten. 90 Tage, weil der Bericht der Nachweis zu einem Commit ist |
| `feature-integrity-report` | immer | 14 Tage | Heuristik über den Quelltext; beratend |
| `playwright-bericht` | nur bei Fehlschlag | 7 Tage | Bildschirmfotos und Spuren gegen **Demodaten** der Wegwerfdatenbank; seit 2026-09-30 auch der JSON-Bericht der Browserreihe in `test-results/` |
| `server-log` | nur bei Fehlschlag | 7 Tage | Protokoll des Testservers; enthält nur Wegwerfwerte des Laufs |
| `release-<sha>` | nur bei Push oder Handstart auf `main`, nach grünen Prüfreihen | 30 Tage | das Release-Artefakt: Archiv `clenaris-<sha12>.tar.gz`, `.sha256`, Beilage `clenaris-<sha12>.json`. Gebaut ohne Demodaten und ohne Umgebungsdateien (das Packen verweigert beides); enthält den Quelltext und `node_modules` — also nichts, was das öffentliche Repository und die Sperrdatei nicht ohnehin zeigen. Ein Pull-Request-Lauf packt zur Probe, legt aber nichts ab |
| `bau-vergleich` | nur im Auftrag `reproduzierbarkeit` (`workflow_dispatch`) | 30 Tage | Bericht `bau-vergleich.json` zweier Bauten desselben Commits; Auszüge mit geschwärzten Schlüsseln |

Bei öffentlichem Repository kann jedes angemeldete GitHub-Konto diese
Artefakte laden. Das ist für den heutigen Inhalt vertretbar, und es ist ein
weiterer Grund für „privat" in Abschnitt 3.

---

## 5. Auslieferung — fail-closed, überprüft am 2026-09-26, fortgeschrieben 2026-10-01

1. Kein Pull Request löst sie aus.
2. `vars.DEPLOY_ENABLED == 'true'` — nicht gesetzt, also übersprungen.
3. Seit 2026-09-30 zusätzlich `github.ref == 'refs/heads/main'` am Auftrag:
   Auch ein Handstart auf einem anderen Zweig beginnt gar nicht erst.
4. Umgebung `production` — nur für `main`.
5. `SERVER_SSH_KEY`, `SERVER_USER` fehlen in der Umgebung; die erste Stufe
   bricht dann mit einer benannten Fehlermeldung ab.
6. Kein Host im Workflow oder in einem Skript: Das Ziel kommt ausschliesslich
   aus `secrets.SERVER_HOST`, ohne Rückfall; die frühere Serveradresse steht
   in keiner Zeile, die ausgeführt wird. `scripts/deploy.sh` ist eine Absage.
7. `known_hosts` ist Pflicht; ohne passenden Eintrag keine Verbindung.
8. **Ausgeliefert wird nur das Artefakt dieses Laufs**, in der CI gebaut und
   geprüft: Die Beilage muss genau diesen Commit, genau diesen Lauf, `main`,
   `auslieferbar` und die gemessene Summe nennen; der Server bekommt die Summe
   als `--erwartet-sha256` und aktiviert mit dem Skript aus dem Archiv
   (Vertrag C3). Anwendungsgeheimnisse reisen nicht durch die Pipeline.

**Zweiter Weg: der Release-Ausführer.** Die Vorlage
`deploy/v2/release-ausfuehrer.yml` liegt bewusst nicht unter
`.github/workflows`. Kopiert läuft sie nur nach Zeitplan oder von Hand, nur
mit `vars.RELEASE_EXECUTOR_ENABLED == 'true'`, in der Umgebung `production`,
mit denselben Server-Secrets wie `deploy.yml` plus `RELEASE_EXECUTOR_TOKEN`
und `RELEASE_EXECUTOR_SIGNING_KEY` und mit `actions: read`, um das Artefakt
eines grünen Push-Laufs auf `main` zu holen. Beide Wege bleiben (Entscheid der
Betreiberin, 2026-09-30) und teilen die Nebenläufigkeitsgruppe
`clenaris-auslieferung-production`. **Der direkte Weg umgeht die Freigabe im
Release Center** — seine Freigabe ist das Zusammenführen nach `main`
(`docs/PRODUCTION_V2.md` §9).

Weder `auslieferung` noch der Ausführer wurde je gegen einen Server
ausgelöst.
