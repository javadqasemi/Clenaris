/**
 * Geheimnisprüfung — sucht Zugangsdaten im **verfolgten Bestand**.
 *
 *   npx tsx scripts/security/geheimnisse.ts        # Exitcode 1 bei Fund
 *   bash scripts/ci-secret-scan.sh                  # derselbe Lauf (Hülle)
 *
 * ---------------------------------------------------------------------------
 *  Warum TypeScript und nicht mehr Bash (2026-09-27)
 * ---------------------------------------------------------------------------
 *
 * Bis hierher war `scripts/ci-secret-scan.sh` die einzige Umsetzung. Unter
 * Windows ohne Bash konnte `security:check` die Prüfung deshalb nie
 * ausführen und meldete sie als NICHT GEPRÜFT — jeder örtliche Lauf war damit
 * unvollständig, und ein strenger Gesamtlauf („alles ausgeführt und
 * bestanden") war auf dem Entwicklerrechner unmöglich. Eine zweite,
 * örtliche Nachbildung hätte das behoben und zugleich die eigentliche Gefahr
 * geschaffen: zwei Fassungen derselben Regeln, die auseinanderlaufen.
 *
 * Jetzt gibt es **eine** Umsetzung, und sie läuft überall, wo Node läuft.
 * Das Bash-Skript ruft nur noch diese Datei auf, damit bestehende Aufrufe
 * und Dokumentation gültig bleiben.
 *
 * Die Regeln sind unverändert übernommen, mit ihren Begründungen:
 *
 *  1. Keine verfolgte Umgebungsdatei ausser `*.env.example`.
 *  2. `.gitignore` schliesst `.env` aus.
 *  3. Anbieterschlüssel mit Mindestlänge und **Tokengrenze** davor — ohne
 *     Grenze traf das Resend-Muster `signatu`**`re_`**`quests_…` in rund
 *     sechshundert SQL-Bezeichnern (Auslieferung fünf Tage blockiert).
 *  4. Datenbankverbindungen mit Passwort, ausser nach localhost/127.0.0.1
 *     und reservierten Dokumentationsnamen (`example.*`, `.invalid`,
 *     `.test`, `.localhost`) und ausser `.env.example`.
 *  5. `NEXT_PUBLIC_`-Namen, die nach einem Geheimnis klingen.
 *
 * Reichweite: verfolgter Bestand im Arbeitsbaum, nicht die Historie (die
 * wurde am 2026-09-21 einmalig vollständig geprüft, siehe Bash-Hülle).
 * Ausgenommen sind `docs/` (Beispielantworten), `package-lock.json` und
 * `*.lock` (Prüfsummen). Binärdateien werden übersprungen wie bei
 * `git grep -I`.
 *
 * Ausgegeben wird nur **Datei:Zeile**, nie der gefundene Wert — der Bericht
 * landet als CI-Artefakt, und ein Geheimnis im Bericht wäre ein zweites Leck.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TOKENGRENZE = '(^|[^0-9A-Za-z_])';

export const ANBIETERMUSTER: ReadonlyArray<{ name: string; muster: RegExp }> = [
  { name: 'Stripe (live)', muster: new RegExp(`${TOKENGRENZE}sk_live_[0-9a-zA-Z]{20,}`) },
  { name: 'Stripe (test)', muster: new RegExp(`${TOKENGRENZE}sk_test_[0-9a-zA-Z]{20,}`) },
  { name: 'Stripe Restricted', muster: new RegExp(`${TOKENGRENZE}rk_live_[0-9a-zA-Z]{20,}`) },
  { name: 'Stripe Webhook', muster: new RegExp(`${TOKENGRENZE}whsec_[0-9a-zA-Z]{24,}`) },
  { name: 'Google API', muster: new RegExp(`${TOKENGRENZE}AIza[0-9A-Za-z_-]{35}`) },
  { name: 'Resend', muster: new RegExp(`${TOKENGRENZE}re_[0-9A-Za-z_-]{24,}`) },
  { name: 'Anthropic', muster: new RegExp(`${TOKENGRENZE}sk-ant-[0-9A-Za-z_-]{24,}`) },
  { name: 'OpenAI', muster: new RegExp(`${TOKENGRENZE}sk-proj-[0-9A-Za-z_-]{24,}`) },
  { name: 'Twilio Account SID', muster: new RegExp(`${TOKENGRENZE}AC[0-9a-f]{32}`) },
  { name: 'SendGrid', muster: new RegExp(`${TOKENGRENZE}SG\\.[0-9A-Za-z_-]{20,}\\.[0-9A-Za-z_-]{20,}`) },
  { name: 'AWS Zugriffsschlüssel', muster: new RegExp(`${TOKENGRENZE}AKIA[0-9A-Z]{16}`) },
  { name: 'Privater Schlüssel', muster: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'JSON Web Token', muster: new RegExp(`${TOKENGRENZE}eyJhbGciOi[0-9A-Za-z_-]{30,}`) },
];

export const DB_MUSTER = /postgres(ql)?:\/\/[a-zA-Z0-9_.-]+:[^@/ ":]{8,}@/;
export const DB_AUSNAHMEHOSTS = /@(([a-zA-Z0-9_-]+\.)*(localhost|invalid|test|example\.(com|net|org|ch))|127\.0\.0\.1)(:[0-9]+)?\//;
export const OEFFENTLICHES_GEHEIMNIS = /NEXT_PUBLIC_[A-Z0-9_]*(SECRET|PRIVATE|SERVICE_ROLE|PASSWORD|TOKEN)/;

export interface Fund {
  regel: string;
  datei: string;
  zeile?: number;
}

const istAusgenommen = (datei: string) => datei.startsWith('docs/') || datei === 'package-lock.json' || datei.endsWith('.lock');
const istUmgebungsdatei = (datei: string) => /(^|\/)\.env($|\.)/.test(datei);
const istUmgebungsbeispiel = (datei: string) => /(^|\/)(\.env\.example|[^/]*\.env\.example)$/.test(datei) || /(^|\/)\.env\.[^/]*\.example$/.test(datei);

/**
 * Der Kern auf Zeilen statt auf Dateien — so lässt er sich ohne Repository
 * prüfen (`tests/api/geheimnispruefung.test.ts`, Positiv- und Negativproben).
 */
export function zeilenPruefen(datei: string, text: string): Fund[] {
  if (istAusgenommen(datei)) return [];
  const funde: Fund[] = [];
  const zeilen = text.split(/\r?\n/);
  zeilen.forEach((inhalt, i) => {
    for (const { name, muster } of ANBIETERMUSTER) {
      if (muster.test(inhalt)) funde.push({ regel: `${name} gefunden`, datei, zeile: i + 1 });
    }
    if (!/(^|\/)\.env\.example$/.test(datei) && DB_MUSTER.test(inhalt) && !DB_AUSNAHMEHOSTS.test(inhalt)) {
      funde.push({ regel: 'Datenbankverbindung mit Passwort', datei, zeile: i + 1 });
    }
    if (OEFFENTLICHES_GEHEIMNIS.test(inhalt)) funde.push({ regel: 'Geheimnis im Browser-Bündel', datei, zeile: i + 1 });
  });
  return funde;
}

export function dateienPruefen(dateien: string[], lesen: (datei: string) => Buffer | null, gitignore: string): Fund[] {
  const funde: Fund[] = [];
  for (const datei of dateien) {
    if (istUmgebungsdatei(datei) && !istUmgebungsbeispiel(datei)) funde.push({ regel: 'Umgebungsdatei ist verfolgt', datei });
  }
  if (!/^\.env$/m.test(gitignore)) funde.push({ regel: '.gitignore schliesst `.env` nicht aus', datei: '.gitignore' });
  for (const datei of dateien) {
    const inhalt = lesen(datei);
    if (!inhalt) continue;
    // Wie `git grep -I`: eine Datei mit NUL-Byte am Anfang ist binär.
    if (inhalt.subarray(0, 8000).includes(0)) continue;
    funde.push(...zeilenPruefen(datei, inhalt.toString('utf8')));
  }
  return funde;
}

/** Git suchen — im PATH oder im Git von GitHub Desktop (dieser Rechner). */
export function gitFinden(): string | null {
  const kandidaten = [process.env.GIT, 'git'];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const desktop = join(process.env.LOCALAPPDATA, 'GitHubDesktop');
    if (existsSync(desktop)) {
      for (const d of readdirSync(desktop).filter((n) => n.startsWith('app-')).sort().reverse()) {
        kandidaten.push(join(desktop, d, 'resources', 'app', 'git', 'cmd', 'git.exe'));
      }
    }
  }
  for (const k of kandidaten) {
    if (!k) continue;
    if (spawnSync(k, ['--version'], { encoding: 'utf8' }).status === 0) return k;
  }
  return null;
}

/** Der ganze Lauf über den verfolgten Bestand. Wirft, wenn Git fehlt. */
export function geheimnisseImBestand(wurzel: string): { funde: Fund[]; dateien: number } {
  const git = gitFinden();
  if (!git) throw new Error('Git nicht gefunden — ohne `git ls-files` kein verfolgter Bestand.');
  const r = spawnSync(git, ['ls-files', '-z'], { cwd: wurzel, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ls-files scheiterte: ${r.stderr}`);
  const dateien = r.stdout.split('\0').filter(Boolean);
  const gitignore = existsSync(join(wurzel, '.gitignore')) ? readFileSync(join(wurzel, '.gitignore'), 'utf8') : '';
  const funde = dateienPruefen(
    dateien,
    (datei) => {
      try {
        return readFileSync(join(wurzel, datei));
      } catch {
        return null; // im Index, aber im Arbeitsbaum gelöscht
      }
    },
    gitignore,
  );
  return { funde, dateien: dateien.length };
}

if (require.main === module) {
  console.log('Suche nach Zugangsdaten im verfolgten Bestand …');
  const { funde, dateien } = geheimnisseImBestand(join(__dirname, '..', '..'));
  for (const f of funde) console.log(`  ✗ ${f.regel}: ${f.datei}${f.zeile ? `:${f.zeile}` : ''}`);
  if (funde.length > 0) {
    console.log(`\n${funde.length} Fund(e). Die Auslieferung bricht ab.`);
    console.log('Ein einmal veröffentlichter Schlüssel ist verbrannt: erst beim Anbieter widerrufen,');
    console.log('dann aus der Historie entfernen — das Entfernen allein genügt nicht.');
    process.exit(1);
  }
  console.log(`  ✓ Keine Zugangsdaten im verfolgten Bestand gefunden (${dateien} Dateien).`);
}
