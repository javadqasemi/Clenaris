/**
 * Die Browserreihe im **Diagnosemodus** fahren.
 *
 *   npm run e2e:diagnose                       # alle Fälle
 *   npm run e2e:diagnose -- tests/e2e/gate4d-sperre.spec.ts
 *
 * Setzt `E2E_DIAGNOSE=1` und reicht alles Weitere an Playwright durch.
 * `playwright.config.ts` schaltet damit auf den Entwicklungsserver (Port 3002,
 * eigenes Bauverzeichnis) um, auf dem React Hydrationsabweichungen im
 * Klartext meldet.
 *
 * Ein eigenes Skript statt `cross-env` im npm-Eintrag: Diese Anwendung läuft
 * unter Windows PowerShell, wo `VAR=1 befehl` ein Syntaxfehler ist, und eine
 * weitere Abhängigkeit nur für das Setzen einer Variablen ist der schlechtere
 * Handel.
 *
 * **Ein grüner Diagnoselauf beweist nichts über die Auslieferung.** Er ist ein
 * Untersuchungswerkzeug; die Aussage macht `npm run e2e` gegen den
 * Produktionsbau.
 */

import { spawn } from 'node:child_process';

const argumente = process.argv.slice(2);

console.log('');
console.log('  Browserreihe im Diagnosemodus (Entwicklungsbau, unminifizierte React-Meldungen).');
console.log('  Erwartet einen laufenden `npm run diagnose:server` — sonst startet Playwright ihn selbst.');
console.log('');

const kind = spawn('npx', ['playwright', 'test', ...argumente], {
  stdio: 'inherit',
  // Unter Windows lässt sich `npx.cmd` seit Node 20 nur über die Shell starten
  // (`spawn` scheitert sonst mit `EINVAL`) — die Absicherung gegen
  // CVE-2024-27980. Die Argumente sind fest verdrahtet, nicht zusammengesetzt.
  shell: process.platform === 'win32',
  env: { ...process.env, E2E_DIAGNOSE: '1' },
});

kind.on('exit', (code) => process.exit(code ?? 0));
