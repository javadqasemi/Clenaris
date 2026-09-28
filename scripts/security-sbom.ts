/**
 * `npm run security:sbom` — Stückliste der Laufzeitabhängigkeiten im
 * CycloneDX-Format (Sicherheitsautomation, 2026-09-26).
 *
 * Ohne neues Werkzeug: `npm sbom` gehört seit npm 10 zu npm selbst und liest
 * `package-lock.json`. Geschrieben wird nach `security-reports/`, nicht ins
 * Repository — eine Stückliste beschreibt einen Bau und gehört als Artefakt
 * zur Freigabe (`docs/SECURITY_AUTOMATION.md`).
 *
 * Nur Laufzeitabhängigkeiten (`--omit dev`): Das ist, was ausgeliefert wird.
 * Wer die Werkzeugkette prüfen will, ruft `npm sbom` ohne die Einschränkung auf.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const wurzel = join(__dirname, '..');
const r = spawnSync('npm', ['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev', '--sbom-type', 'application'], {
  cwd: wurzel,
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
  shell: process.platform === 'win32',
});

if (r.status !== 0) {
  console.error(`npm sbom scheiterte (${r.status}): ${(r.stderr || r.stdout).slice(0, 500)}`);
  process.exit(1);
}

let stueckliste: { components?: unknown[]; bomFormat?: string; specVersion?: string };
try {
  stueckliste = JSON.parse(r.stdout);
} catch {
  console.error('npm sbom lieferte kein JSON.');
  process.exit(1);
}

const ordner = join(wurzel, 'security-reports');
mkdirSync(ordner, { recursive: true });
const ziel = join(ordner, 'sbom-cyclonedx.json');
writeFileSync(ziel, r.stdout);
console.log(`✓ ${stueckliste.bomFormat} ${stueckliste.specVersion}: ${stueckliste.components?.length ?? 0} Komponenten → security-reports/sbom-cyclonedx.json`);
