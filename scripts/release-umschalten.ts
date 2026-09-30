/**
 * Umschalten auf ein entpacktes Release — die echten Befehle zu
 * `scripts/release/umschaltung.ts` (2026-09-30).
 *
 *   node <release>/node_modules/tsx/dist/cli.mjs <release>/scripts/release-umschalten.ts artefakt   --verzeichnis <dir>
 *   node … release-umschalten.ts aktiv      --basis <BASIS> --ziel <releases/commit> --erwartet-aus <dir> --port 3000
 *   node … release-umschalten.ts umschalten --basis <BASIS> --ziel <releases/commit> --port 3000
 *
 * Aufgerufen von `deploy/v2/release-aktivieren.sh`, und zwar **aus dem neuen
 * Release** — nie aus `current/`. Das Werkzeug, das eine Fassung
 * einschaltet, ist damit Teil des geprüften Archivs, dessen Summe eben
 * gemessen wurde; ein Werkzeug aus dem laufenden Release wäre Code, den die
 * Prüfung dieses Archivs nie gesehen hat.
 *
 *   artefakt    Ausgang 0: RELEASE.json entspricht Format 2, ist auslieferbar,
 *               und .next/BUILD_ID passt. Sonst 1. Läuft vor jeder Migration.
 *   aktiv       0: das Ziel ist `current` und bestätigt seine Identität;
 *               3: das Ziel ist nicht `current`; 4: es ist `current`, bestätigt
 *               sich aber nicht. Für die wiederholte Aktivierung.
 *   umschalten  0 AKTIV · 10 NICHT_UMGESCHALTET · 20 ZURUECK · 30 UNKLAR
 *               (Vertrag C3); letzte Zeile `UMSCHALTUNG {…}`.
 *
 * Kein Bau, kein `npm`, kein `git`: Dieses Werkzeug setzt einen Verweis,
 * lädt pm2 und fragt `/api/health`. Mehr darf auf dem Server nicht geschehen.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { lstatSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { COMMIT_MUSTER } from '../src/lib/release/manifest';
import {
  aktivPruefen,
  auslieferbarBelegt,
  gesundheitAuswerten,
  pm2Lage,
  pm2ProzesseLesen,
  pm2Umgebung,
  releaseIdentitaetLesen,
  umschaltenMitPruefung,
  type Befehle,
} from './release/umschaltung';

export function protokollZeile(zeile: string): void {
  console.log(`${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}  ${zeile}`);
}

/** Die letzten Zeilen einer pm2-Ausgabe — genug für die Diagnose, ohne das Protokoll zu fluten. */
function schwanz(text: string | null | undefined, zeilen = 8): string {
  return (text ?? '').trim().split(/\r?\n/).slice(-zeilen).join(' | ');
}

/**
 * Die echten Befehle. `appName` und `port` kommen vom Aufrufer, die Umgebung
 * für pm2 aus `pm2Umgebung` — nie ungefiltert aus der SSH-Sitzung.
 */
export function echteBefehle(appName: string, port: number, protokoll: (zeile: string) => void = protokollZeile): Befehle {
  // `NODE_ENV` setzt `pm2Umgebung` bereits; hier steht es noch einmal nur für
  // den Typ `ProcessEnv`, der es als Pflichtfeld kennt.
  const umgebung: NodeJS.ProcessEnv = { ...pm2Umgebung(process.env, port), NODE_ENV: 'production' };
  const pm2 = (...args: string[]): SpawnSyncReturns<string> =>
    spawnSync('pm2', args, { env: umgebung, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const lage = (verzeichnis: string) => pm2Lage(pm2ProzesseLesen(pm2('jlist').stdout ?? ''), appName, verzeichnis);
  const gelungen = (r: SpawnSyncReturns<string>, was: string) => {
    if (r.status === 0) return true;
    protokoll(`pm2 ${was} gescheitert (Ausgang ${r.status ?? r.error?.message ?? 'unbekannt'}): ${schwanz(r.stderr || r.stdout)}`);
    return false;
  };

  return {
    verweisLesen(basis) {
      const verweis = join(basis, 'current');
      try {
        lstatSync(verweis);
        return realpathSync(verweis);
      } catch {
        // Kein Verweis oder einer ins Leere — beides heisst: nichts aktiv, worauf man sich verlassen könnte.
        return null;
      }
    },

    verweisSetzen(basis, ziel) {
      const neu = join(basis, `current.tmp.${process.pid}`);
      rmSync(neu, { force: true });
      symlinkSync(ziel, neu);
      // `rename` über einen bestehenden Verweis ersetzt ihn in einem Schritt
      // (wie `mv -T`); es folgt dem alten Verweis dabei nicht.
      renameSync(neu, join(basis, 'current'));
    },

    async pm2Neuladen(verzeichnis) {
      const konfiguration = join(verzeichnis, 'ecosystem.config.js');
      const vorher = lage(verzeichnis);
      const erster =
        vorher === 'fehlt'
          ? pm2('start', konfiguration, '--env', 'production')
          : pm2('startOrReload', konfiguration, '--env', 'production', '--update-env');
      if (!gelungen(erster, vorher === 'fehlt' ? 'start' : 'startOrReload')) return false;
      if (lage(verzeichnis) === 'hier') return true;

      // Siehe `pm2Lage`: Das Neuladen hat das Arbeitsverzeichnis nicht
      // übernommen. Lieber einige Sekunden ohne Anwendung als eine
      // Umschaltung, nach der still die alte Fassung weiterläuft.
      protokoll('pm2 hat das Arbeitsverzeichnis beim Neuladen nicht übernommen — Neustart aus dem Release (kurze Unterbrechung).');
      gelungen(pm2('delete', appName), 'delete');
      if (!gelungen(pm2('start', konfiguration, '--env', 'production'), 'start')) return false;
      return lage(verzeichnis) === 'hier';
    },

    async pm2Sichern() {
      return gelungen(pm2('save'), 'save');
    },

    async gesundheit(p) {
      try {
        const antwort = await fetch(`http://127.0.0.1:${p}/api/health`, {
          signal: AbortSignal.timeout(5000),
          headers: { 'cache-control': 'no-cache' },
        });
        return gesundheitAuswerten(antwort.status, await antwort.text());
      } catch {
        return null;
      }
    },

    schlafen: (ms) => new Promise((fertig) => setTimeout(fertig, ms)),
    protokoll,
  };
}

function argument(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function zahl(name: string, vorgabe: number, min: number, max: number): number {
  const roh = argument(name);
  if (roh === undefined) return vorgabe;
  const wert = Number(roh);
  if (!Number.isInteger(wert) || wert < min || wert > max) throw new Error(`--${name} muss eine ganze Zahl von ${min} bis ${max} sein.`);
  return wert;
}

function pflichtpfad(name: string): string {
  const wert = argument(name);
  if (!wert) throw new Error(`--${name} fehlt.`);
  return realpathSync(wert);
}

/**
 * Das Ziel muss ein Commit-Verzeichnis unter `<basis>/releases/` sein. Ein
 * beliebiges Verzeichnis dürfte dieses Werkzeug sonst zu `current` machen —
 * auch eines, das nie aus einem geprüften Archiv entpackt wurde.
 */
function zielPruefen(basis: string, ziel: string): void {
  const releases = resolve(basis, 'releases');
  if (resolve(ziel, '..') !== releases || !COMMIT_MUSTER.test(basename(ziel))) {
    throw new Error(`${ziel} ist kein Release-Verzeichnis unter ${releases}/<commit>.`);
  }
}

/** Ab hier kann `current` verändert sein — ein unerwarteter Fehler danach ist UNKLAR, davor NICHT_UMGESCHALTET. */
let umschaltungBegonnen = false;

async function main(): Promise<number> {
  const befehl = process.argv[2];
  const port = zahl('port', Number(process.env.DEPLOY_PORT ?? 3000), 1, 65535);
  const appName = process.env.PM2_APP_NAME?.trim() || 'clenaris';

  if (befehl === 'artefakt') {
    const verzeichnis = pflichtpfad('verzeichnis');
    const lesung = releaseIdentitaetLesen(verzeichnis);
    if (!lesung.ok) {
      protokollZeile(`FEHLER: ${lesung.grund}`);
      return 1;
    }
    if (!auslieferbarBelegt(lesung.manifest)) {
      protokollZeile('FEHLER: Das Manifest ist nicht auslieferbar (Probe, unsauberer Baum, ohne Module oder nicht aus einem Push/Dispatch auf main).');
      return 1;
    }
    protokollZeile(`Artefakt       : ${lesung.identitaet.commit} (Version ${lesung.manifest.version}, Build ${lesung.identitaet.buildId}) — Format 2, auslieferbar.`);
    return 0;
  }

  if (befehl === 'aktiv') {
    const basis = pflichtpfad('basis');
    const erwartet = releaseIdentitaetLesen(pflichtpfad('erwartet-aus'));
    if (!erwartet.ok) {
      protokollZeile(`FEHLER: ${erwartet.grund}`);
      return 1;
    }
    const lage = await aktivPruefen(
      { basis, ziel: pflichtpfad('ziel'), erwartet: erwartet.identitaet, port },
      echteBefehle(appName, port),
    );
    return lage === 'aktiv' ? 0 : lage === 'nicht-aktiv' ? 3 : 4;
  }

  if (befehl === 'umschalten') {
    /*
      Nur unter der Sperre von `release-aktivieren.sh`. Das ist kein Schloss —
      Node kann kein `flock` halten —, sondern ein Riegel gegen den
      naheliegenden Irrtum, dieses Werkzeug von Hand neben einer laufenden
      Aktivierung aufzurufen: Zwei Umschaltungen gleichzeitig prüften jede die
      Identität der anderen.
    */
    if (!process.env.CLENARIS_RELEASE_SPERRE) {
      protokollZeile('FEHLER: Ohne gehaltene Sperre (CLENARIS_RELEASE_SPERRE) wird nicht umgeschaltet — über deploy/v2/release-aktivieren.sh oder deploy/v2/release-ruecksprung.sh aufrufen.');
      return 10;
    }
    const basis = pflichtpfad('basis');
    const ziel = pflichtpfad('ziel');
    zielPruefen(basis, ziel);
    const lesung = releaseIdentitaetLesen(ziel);
    if (!lesung.ok) {
      protokollZeile(`FEHLER: ${lesung.grund}`);
      return 10;
    }
    if (!auslieferbarBelegt(lesung.manifest) || lesung.identitaet.commit !== basename(ziel)) {
      protokollZeile('FEHLER: Manifest nicht auslieferbar oder Commit passt nicht zum Verzeichnisnamen — nicht umgeschaltet.');
      return 10;
    }
    umschaltungBegonnen = true;
    const ergebnis = await umschaltenMitPruefung(
      { basis, ziel, erwartet: lesung.identitaet, port, versuche: zahl('versuche', 45, 1, 600) },
      echteBefehle(appName, port),
    );
    protokollZeile(ergebnis.meldung);
    console.log(`UMSCHALTUNG ${JSON.stringify({ code: ergebnis.code, zustand: ergebnis.zustand })}`);
    return ergebnis.code;
  }

  protokollZeile('Befehl: artefakt | aktiv | umschalten');
  return 1;
}

if (process.argv[1] && /release-umschalten\.(ts|js)$/.test(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (fehler) => {
      protokollZeile(`FEHLER: ${fehler instanceof Error ? fehler.message : String(fehler)}`);
      // Ein unerwarteter Fehler: Vor `umschaltenMitPruefung` ist nichts
      // umgeschaltet (10) — etwa ein fehlendes Verzeichnis. Darin fängt die
      // Umschaltung ihre Fehler selbst ab; was trotzdem durchschlägt, ist
      // ungeklärt und heisst 30.
      if (process.argv[2] === 'umschalten') process.exit(umschaltungBegonnen ? 30 : 10);
      process.exit(1);
    },
  );
}
