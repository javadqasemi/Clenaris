/**
 * Rücksprung von Hand auf ein früheres, aufbewahrtes Release (2026-09-30).
 *
 *   bash deploy/v2/release-ruecksprung.sh --auf <commit, 40 Hex> --erwartet-sha256 <64 Hex> [--port 3000] [--schema-bewusst]
 *
 * Aufgerufen **nur** über `deploy/v2/release-ruecksprung.sh`: Die Hülle hält
 * dieselbe Sperre wie die Aktivierung (`${BASIS}/.release.lock`) und startet
 * dieses Werkzeug aus dem laufenden Release (`readlink -f current`).
 *
 * ---------------------------------------------------------------------------
 *  Warum ein eigenes Werkzeug
 * ---------------------------------------------------------------------------
 *
 * Bis hierher gab es zwei Rücksprünge, und keiner passte zu Production V2:
 * `scripts/deploy.sh` kannte einen — aber `deploy.sh` baut auf dem Server und
 * ist seit dem Notfallauftrag vom 2026-09-27 stillgelegt. Und
 * `release-aktivieren.sh` springt nur **automatisch** zurück, im Augenblick
 * einer gescheiterten Aktivierung. Stellte sich ein Fehler erst Stunden
 * später heraus, blieb nur, den Verweis `current` von Hand umzuhängen und
 * pm2 neu zu laden — ungeprüft, welches Verzeichnis da lag, ohne Blick aufs
 * Schema und ohne Eintrag irgendwo.
 *
 * Dieses Werkzeug macht den Rücksprung zu einer Aktivierung rückwärts, mit
 * denselben Regeln:
 *
 *  • **Nur aus dem aufbewahrten Archiv.** `release-aktivieren.sh` legt jedes
 *    aktivierte Archiv unter `${BASIS}/archiv/` ab. Zurück geht es nur auf
 *    ein Archiv, dessen gemessene Summe der erwarteten (`--erwartet-sha256`,
 *    aus der Zusammenfassung des CI-Laufs oder dem Release Center) **und**
 *    der daneben liegenden `.sha256` entspricht, und dessen `RELEASE.json`
 *    genau den verlangten Commit nennt. Ein Verzeichnis unter `releases/`
 *    wird nie ungeprüft wiederverwendet: Es liegt seit Tagen auf einem
 *    Server, auf dem jeder mit dem Dienstbenutzer schreiben kann.
 *  • **Frisch entpackt.** Aus dem geprüften Archiv, in ein neues Verzeichnis,
 *    dann an die Stelle des alten. Was dort lag, wird ersetzt.
 *  • **Das Schema geht nie mit zurück.** Migrationen laufen nur vorwärts;
 *    eine Rückwärtsmigration ist eine Entscheidung, keine Automatik. Also
 *    wird gefragt, welche Migrationen des laufenden Release das Ziel **nicht**
 *    kennt — sie bleiben in der Datenbank —, und wie sie eingestuft sind
 *    (`security/migrations-vertraeglichkeit.json` des **laufenden** Release,
 *    denn nur das kennt sie). Alles ausser RUECKWAERTSVERTRAEGLICH hält an:
 *    Die ältere Fassung liefe gegen ein Schema, das sie nicht versteht.
 *    `--schema-bewusst` lässt es trotzdem zu — für den Fall, dass jemand die
 *    Folgen kennt und der Rücksprung das kleinere Übel ist. Das steht dann im
 *    Protokoll.
 *  • **Umschalten mit Identitätsprüfung** über `umschaltenMitPruefung` —
 *    dieselbe Stelle wie die Aktivierung: Commit, Build-ID und `belegt`;
 *    scheitert das Ziel, zurück auf das vorher Laufende, und auch das wird
 *    geprüft. Ausgänge wie bei der Aktivierung (Vertrag C3).
 *
 * Kein Bau, kein `npm install`, kein `git`. Ein Rücksprung, der etwas
 * erzeugt, statt ein Geprüftes wiederherzustellen, wäre der Weg, den der
 * Notfallauftrag abgeschafft hat.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { COMMIT_MUSTER, MIGRATION_MUSTER, SHA256_MUSTER, artefaktManifestSchema } from '../src/lib/release/manifest';
import { registerLesen, type Einstufung, type Register } from './migration-kompatibilitaet';
import { echteBefehle, protokollZeile } from './release-umschalten';
import {
  aktivierungProtokollieren,
  auslieferbarBelegt,
  releaseIdentitaetLesen,
  umschaltenMitPruefung,
  ZUSTAND_JE_CODE,
  type Befehle,
  type Identitaet,
  type Umschaltcode,
  type Umschaltzustand,
} from './release/umschaltung';

/** Was der Rücksprung über die Umschaltung hinaus braucht — in der Prüfreihe Attrappen. */
export interface RuecksprungDienste extends Befehle {
  sha256(datei: string): Promise<string>;
  /** Der Text von `RELEASE.json` aus dem Archiv, ohne zu entpacken — `null`, wenn es fehlt. */
  manifestAusArchiv(archiv: string): string | null;
  /** Das Archiv vollständig nach `ziel` entpacken. `false` bei einem Fehler. */
  entpacken(archiv: string, ziel: string): boolean;
  /** `node scripts/react-hydrationskorrektur.mjs --pruefen` im entpackten Baum. */
  hydrationPruefen(verzeichnis: string): boolean;
  /** Verweis `verweis` → `quelle` anlegen (ersetzt einen bestehenden). */
  verknuepfen(quelle: string, verweis: string): void;
}

export interface RuecksprungAuftrag {
  basis: string;
  auf?: string;
  erwartetSha256?: string;
  port: number;
  schemaBewusst: boolean;
  /** Ob die Hülle `${BASIS}/.release.lock` hält — siehe `release-ruecksprung.sh`. */
  sperreGehalten: boolean;
  versuche?: number;
  abstandMs?: number;
  /** Anhang für Zwischenverzeichnisse; auf dem Server die Prozessnummer. */
  kennung?: string | number;
}

export interface VerbleibendeMigration {
  migration: string;
  einstufung: Einstufung;
}

export interface RuecksprungErgebnis {
  code: Umschaltcode;
  zustand: Umschaltzustand;
  meldung: string;
  von: string | null;
  nach: string | null;
  verbleibend: VerbleibendeMigration[];
}

const EINSTUFUNGEN: readonly Einstufung[] = ['RUECKWAERTSVERTRAEGLICH', 'RUECKFUELLUNG', 'PROGRAMMWECHSEL', 'BRECHEND'];

/**
 * Welche Migrationen des laufenden Release das Ziel nicht kennt, und wie sie
 * eingestuft sind.
 *
 * Die Einstufung kommt aus dem Register des **laufenden** Release — das des
 * Ziels ist älter und kennt diese Migrationen per Definition nicht. Fehlt ein
 * Eintrag, fehlt das Register oder ist es unlesbar, gilt BRECHEND: Eine
 * Migration, über die niemand geurteilt hat, ist nicht harmlos, nur weil
 * niemand geurteilt hat (dieselbe Regel wie `strengsteEinstufung`).
 */
export function verbleibendeMigrationen(aktuell: string, zielMigrationen: readonly string[]): VerbleibendeMigration[] {
  const verzeichnis = join(aktuell, 'prisma', 'migrations');
  if (!existsSync(verzeichnis)) return [];
  const bekannt = new Set(zielMigrationen);
  let register: Register = { stand: '', migrationen: {} };
  try {
    register = registerLesen(join(aktuell, 'security', 'migrations-vertraeglichkeit.json'));
  } catch {
    /* kein oder kein lesbares Register — alles gilt als BRECHEND */
  }
  return readdirSync(verzeichnis)
    .filter((name) => MIGRATION_MUSTER.test(name) && !bekannt.has(name))
    .sort()
    .map((migration) => {
      const eintrag = register.migrationen?.[migration]?.einstufung;
      return { migration, einstufung: eintrag && EINSTUFUNGEN.includes(eintrag) ? eintrag : 'BRECHEND' };
    });
}

function verweigert(meldung: string, von: string | null = null, nach: string | null = null, verbleibend: VerbleibendeMigration[] = []): RuecksprungErgebnis {
  return { code: 10, zustand: ZUSTAND_JE_CODE[10], meldung, von, nach, verbleibend };
}

/** Der Rücksprung selbst — ohne Protokolldatei; die schreibt `ruecksprung()` für jeden Ausgang. */
export async function ruecksprungAusfuehren(a: RuecksprungAuftrag, d: RuecksprungDienste): Promise<RuecksprungErgebnis> {
  if (!a.sperreGehalten) {
    return verweigert('Ohne gehaltene Sperre wird nicht zurückgesprungen — über deploy/v2/release-ruecksprung.sh aufrufen.');
  }
  if (!a.auf || !COMMIT_MUSTER.test(a.auf)) return verweigert('--auf <Commit, 40 Hexzeichen> fehlt oder ist ungültig.');
  const erwartet = a.erwartetSha256?.trim().toLowerCase() ?? '';
  if (!SHA256_MUSTER.test(erwartet)) {
    return verweigert('--erwartet-sha256 <64 Hexzeichen> fehlt oder ist ungültig — ohne erwartete Summe kein Rücksprung.', null, a.auf);
  }

  const aktuell = d.verweisLesen(a.basis);
  if (!aktuell) {
    return verweigert('Kein aktives Release (current fehlt) — ohne Ausgangspunkt kein Rücksprung; eine Erstinstallation ist Sache von release-aktivieren.sh.', null, a.auf);
  }
  const von = basename(aktuell);
  const ziel = join(a.basis, 'releases', a.auf);
  if (resolve(aktuell) === resolve(ziel)) return verweigert(`${a.auf} ist bereits aktiv — nichts zu tun.`, von, a.auf);

  // --- Archiv ---------------------------------------------------------------
  const archiv = join(a.basis, 'archiv', `clenaris-${a.auf.slice(0, 12)}.tar.gz`);
  if (!existsSync(archiv) || !existsSync(`${archiv}.sha256`)) {
    return verweigert(`Kein aufbewahrtes Archiv für ${a.auf} (${archiv} samt .sha256) — ohne geprüftes Archiv kein Rücksprung.`, von, a.auf);
  }
  const gemessen = await d.sha256(archiv);
  const notiert = readFileSync(`${archiv}.sha256`, 'utf8').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (gemessen !== erwartet) {
    return verweigert(`SHA-256 des aufbewahrten Archivs (${gemessen}) ist nicht die erwartete (${erwartet}).`, von, a.auf);
  }
  if (gemessen !== notiert) {
    return verweigert(`SHA-256 des aufbewahrten Archivs stimmt nicht mit seiner .sha256-Datei überein (${notiert || 'leer'}).`, von, a.auf);
  }

  const manifestText = d.manifestAusArchiv(archiv);
  let manifestRoh: unknown = null;
  try {
    manifestRoh = manifestText === null ? null : JSON.parse(manifestText);
  } catch {
    /* unten als ungültig gemeldet */
  }
  const manifest = artefaktManifestSchema.safeParse(manifestRoh);
  if (!manifest.success) return verweigert('RELEASE.json im Archiv fehlt oder entspricht nicht Format 2.', von, a.auf);
  if (manifest.data.commit !== a.auf) {
    return verweigert(`RELEASE.json im Archiv nennt ${manifest.data.commit}, verlangt ist ${a.auf}.`, von, a.auf);
  }
  if (!auslieferbarBelegt(manifest.data)) return verweigert('Das Archiv ist nicht auslieferbar (Probe).', von, a.auf);

  // --- Schema ---------------------------------------------------------------
  const verbleibend = verbleibendeMigrationen(aktuell, manifest.data.migrationen);
  const bedenklich = verbleibend.filter((m) => m.einstufung !== 'RUECKWAERTSVERTRAEGLICH');
  if (verbleibend.length > 0) {
    d.protokoll(`Schema bleibt  : ${verbleibend.length} Migration(en) des laufenden Release kennt ${a.auf.slice(0, 12)} nicht — sie bleiben angewandt.`);
    for (const m of verbleibend) d.protokoll(`                 ${m.einstufung.padEnd(24)} ${m.migration}`);
  }
  if (bedenklich.length > 0 && !a.schemaBewusst) {
    return verweigert(
      `${bedenklich.length} verbleibende Migration(en) sind nicht rückwärtsverträglich (${bedenklich.map((m) => `${m.migration}: ${m.einstufung}`).join('; ')}). ` +
        'Die ältere Fassung liefe gegen ein Schema, das sie nicht kennt. Nur mit --schema-bewusst, wenn die Folgen bekannt sind.',
      von,
      a.auf,
      verbleibend,
    );
  }
  if (bedenklich.length > 0) d.protokoll('WARNUNG: --schema-bewusst — Rücksprung trotz nicht rückwärtsverträglicher Migrationen.');

  if (!existsSync(join(a.basis, 'shared', '.env'))) return verweigert(`${join(a.basis, 'shared', '.env')} fehlt.`, von, a.auf, verbleibend);

  // --- Frisch entpacken -----------------------------------------------------
  const kennung = String(a.kennung ?? process.pid);
  const neu = `${ziel}.tmp.${kennung}`;
  const alt = `${ziel}.alt.${kennung}`;
  let identitaet: Identitaet | null = null;
  try {
    rmSync(neu, { recursive: true, force: true });
    mkdirSync(neu, { recursive: true });
    if (!d.entpacken(archiv, neu)) return verweigert(`Entpacken von ${archiv} gescheitert.`, von, a.auf, verbleibend);
    const lesung = releaseIdentitaetLesen(neu);
    if (!lesung.ok) return verweigert(lesung.grund, von, a.auf, verbleibend);
    if (lesung.identitaet.commit !== a.auf || lesung.identitaet.buildId !== manifest.data.buildId) {
      return verweigert('Der entpackte Baum nennt eine andere Identität als das Manifest des Archivs.', von, a.auf, verbleibend);
    }
    if (!d.hydrationPruefen(neu)) return verweigert('React-Hydrationskorrektur im entpackten Baum nicht vorhanden.', von, a.auf, verbleibend);
    d.verknuepfen(join(a.basis, 'shared', '.env'), join(neu, '.env'));
    mkdirSync(join(a.basis, 'shared', 'logs'), { recursive: true });
    d.verknuepfen(join(a.basis, 'shared', 'logs'), join(neu, 'logs'));

    // Was unter releases/<commit> lag, wird ersetzt, nie wiederverwendet.
    let ersetzt = false;
    try {
      lstatSync(ziel);
      rmSync(alt, { recursive: true, force: true });
      renameSync(ziel, alt);
      ersetzt = true;
    } catch (fehler) {
      if ((fehler as NodeJS.ErrnoException).code !== 'ENOENT') throw fehler;
    }
    renameSync(neu, ziel);
    if (ersetzt) {
      rmSync(alt, { recursive: true, force: true });
      d.protokoll(`Ersetzt        : releases/${a.auf} durch die frische Entpackung.`);
    }
    identitaet = lesung.identitaet;
  } catch (fehler) {
    return verweigert(`Vorbereiten gescheitert: ${fehler instanceof Error ? fehler.message : String(fehler)}`, von, a.auf, verbleibend);
  } finally {
    rmSync(neu, { recursive: true, force: true });
  }

  if (!identitaet) return verweigert('Vorbereiten ohne Ergebnis abgebrochen.', von, a.auf, verbleibend);

  // --- Umschalten -----------------------------------------------------------
  const umschaltung = await umschaltenMitPruefung(
    { basis: a.basis, ziel, erwartet: identitaet, port: a.port, versuche: a.versuche ?? 45, abstandMs: a.abstandMs },
    d,
  );
  return { code: umschaltung.code, zustand: umschaltung.zustand, meldung: umschaltung.meldung, von, nach: a.auf, verbleibend };
}

/**
 * Rücksprung samt Eintrag in `${BASIS}/aktivierungen.jsonl` — für **jeden**
 * Ausgang, auch die Verweigerung. Wer später liest, warum um drei Uhr
 * niemand zurückgesprungen ist, findet dort den Versuch und seinen Grund.
 */
export async function ruecksprung(a: RuecksprungAuftrag, d: RuecksprungDienste): Promise<RuecksprungErgebnis> {
  const e = await ruecksprungAusfuehren(a, d);
  aktivierungProtokollieren(
    a.basis,
    {
      zeitUtc: new Date().toISOString(),
      art: 'ruecksprung',
      von: e.von,
      nach: e.nach,
      code: e.code,
      zustand: e.zustand,
      schemaBewusst: a.schemaBewusst,
      verbleibendeMigrationen: e.verbleibend.map((m) => `${m.migration}:${m.einstufung}`),
    },
    d.protokoll,
  );
  return e;
}

function argument(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sha256Datei(pfad: string): Promise<string> {
  return new Promise((ok, fehler) => {
    const h = createHash('sha256');
    createReadStream(pfad)
      .on('data', (teil) => h.update(teil))
      .on('end', () => ok(h.digest('hex')))
      .on('error', fehler);
  });
}

async function main(): Promise<number> {
  const basis = realpathSync(argument('basis') ?? process.env.CLENARIS_BASIS ?? '/home/clenaris/clenaris');
  const port = Number(argument('port') ?? process.env.DEPLOY_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port muss eine Portnummer sein.');
  const appName = process.env.PM2_APP_NAME?.trim() || 'clenaris';

  const dienste: RuecksprungDienste = {
    ...echteBefehle(appName, port),
    sha256: sha256Datei,
    manifestAusArchiv(archiv) {
      const r = spawnSync('tar', ['-xzOf', archiv, 'RELEASE.json'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
      return r.status === 0 ? r.stdout : null;
    },
    entpacken(archiv, ziel) {
      const r = spawnSync('tar', ['-xzf', archiv, '-C', ziel, '--no-same-owner'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.status !== 0) protokollZeile(`tar: ${(r.stderr ?? '').trim().split(/\r?\n/).slice(-5).join(' | ')}`);
      return r.status === 0;
    },
    hydrationPruefen(verzeichnis) {
      const r = spawnSync(process.execPath, [join(verzeichnis, 'scripts', 'react-hydrationskorrektur.mjs'), '--pruefen'], {
        cwd: verzeichnis,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      return r.status === 0;
    },
    verknuepfen(quelle, verweis) {
      rmSync(verweis, { force: true });
      symlinkSync(quelle, verweis);
    },
  };

  const auf = argument('auf');
  const e = await ruecksprung(
    {
      basis,
      auf,
      erwartetSha256: argument('erwartet-sha256'),
      port,
      schemaBewusst: process.argv.includes('--schema-bewusst'),
      sperreGehalten: Boolean(process.env.CLENARIS_RELEASE_SPERRE),
    },
    dienste,
  );
  protokollZeile(e.meldung);
  console.log(`ERGEBNIS ${JSON.stringify({ code: e.code, zustand: e.zustand, commit: auf && COMMIT_MUSTER.test(auf) ? auf : '' })}`);
  return e.code;
}

if (process.argv[1] && /release-ruecksprung\.(ts|js)$/.test(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (fehler) => {
      protokollZeile(`FEHLER: ${fehler instanceof Error ? fehler.message : String(fehler)}`);
      // Vor dem Umschalten (etwa eine unlesbare Basis) ist nichts geändert.
      // Innerhalb fängt die Umschaltung ihre Fehler selbst ab.
      console.log(`ERGEBNIS ${JSON.stringify({ code: 10, zustand: 'NICHT_UMGESCHALTET', commit: '' })}`);
      process.exit(10);
    },
  );
}
