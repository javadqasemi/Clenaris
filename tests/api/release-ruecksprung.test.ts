import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ArtefaktManifest } from '../../src/lib/release/manifest';
import { ruecksprung, verbleibendeMigrationen, type RuecksprungAuftrag, type RuecksprungDienste } from '../../scripts/release-ruecksprung';
import {
  aktivPruefen,
  gesundheitAuswerten,
  pm2Lage,
  pm2ProzesseLesen,
  pm2Umgebung,
  releaseIdentitaetLesen,
  umschaltenMitPruefung,
  type Gesundheit,
} from '../../scripts/release/umschaltung';

/**
 * Umschalten und Rücksprung — das Verhalten, rein und mit Attrappen
 * (2026-09-30).
 *
 * `deploy/v2/release-aktivieren.sh` und `deploy/v2/release-ruecksprung.sh`
 * sind Bash und laufen auf dem Entwicklungsrechner (Windows) nicht. Die
 * Regeln, auf die es im Ernstfall ankommt, stehen deshalb in TypeScript
 * (`scripts/release/umschaltung.ts`, `scripts/release-ruecksprung.ts`), und
 * hier werden sie mit einer nachgebauten Welt durchgespielt: echte
 * Verzeichnisse in einem Wegwerfordner (Releases, Archive, Protokoll), dazu
 * Attrappen für den Verweis `current`, pm2 und `/api/health`. Die Attrappe
 * der Gesundheit antwortet, wie die echte Instanz es tut — mit der Identität
 * aus `RELEASE.json` und `.next/BUILD_ID` des Verzeichnisses, das pm2 gerade
 * betreibt. Eine „kranke" Fassung antwortet nicht oder falsch.
 *
 * Jeder Fall legt seine Welt neu an und räumt sie danach weg; keiner braucht
 * Server, Datenbank oder Bash. Dass beide Workflows dieses Werkzeug auf
 * dieselbe Weise aufrufen, prüft `release-ausfuehrer-vorlage.test.ts`.
 */

const NEU = 'a'.repeat(40); // läuft
const ALT = 'b'.repeat(40); // Ziel des Rücksprungs
const BAU_NEU = 'bau-neu-0001';
const BAU_ALT = 'bau-alt-0001';

function manifest(commit: string, buildId: string, migrationen: string[]): ArtefaktManifest {
  return {
    format: 2,
    anwendung: 'clenaris',
    version: commit === NEU ? '1.5.0' : '1.4.0',
    commit,
    unsauber: false,
    buildId,
    distDir: '.next',
    quelleZeitUtc: '2026-09-29T10:00:00.000Z',
    node: 'v22.11.0',
    npm: '10.9.0',
    plattform: 'linux-x64',
    next: '15.5.26',
    sperrdateiSha256: 'c'.repeat(64),
    seitenUrl: 'https://clenaris.qasemi.ch',
    reactKorrektur: 'geprueft',
    mitModulen: true,
    migrationen,
    ci: { lauf: '12345678901', versuch: '1', ereignis: 'push', ref: 'refs/heads/main', repository: 'beispiel/clenaris' },
    auslieferbar: true,
  };
}

const M1 = '20260101000000_eins';
const M2 = '20260102000000_zwei';
const M3 = '20260103000000_drei';

/** Ein entpacktes Release, wie `tar -xzf` es hinterlässt. */
function releaseSchreiben(verzeichnis: string, m: ArtefaktManifest, register?: Record<string, string>): void {
  mkdirSync(join(verzeichnis, '.next'), { recursive: true });
  writeFileSync(join(verzeichnis, 'RELEASE.json'), JSON.stringify(m));
  writeFileSync(join(verzeichnis, '.next', 'BUILD_ID'), `${m.buildId}\n`);
  for (const migration of m.migrationen) {
    mkdirSync(join(verzeichnis, 'prisma', 'migrations', migration), { recursive: true });
    writeFileSync(join(verzeichnis, 'prisma', 'migrations', migration, 'migration.sql'), '-- leer\n');
  }
  if (register) {
    mkdirSync(join(verzeichnis, 'security'), { recursive: true });
    const migrationen = Object.fromEntries(Object.entries(register).map(([k, v]) => [k, { einstufung: v }]));
    writeFileSync(join(verzeichnis, 'security', 'migrations-vertraeglichkeit.json'), JSON.stringify({ stand: '2026-09-30', migrationen }));
  }
}

const sha256 = (daten: string | Buffer) => createHash('sha256').update(daten).digest('hex');

/**
 * Die nachgebaute Welt eines Servers. `laufend` ist, was pm2 gerade
 * betreibt; `gesundheit()` antwortet aus dessen Dateien, ausser die Fassung
 * steht in `krank` (keine Antwort) oder `falscheAntwort` liefert etwas
 * anderes (etwa eine fremde Build-ID).
 */
class Welt implements RuecksprungDienste {
  verweis: string | null = null;
  laufend: string | null = null;
  readonly krank = new Set<string>();
  falscheAntwort: ((verzeichnis: string) => Gesundheit | null) | null = null;
  readonly neuGeladen: string[] = [];
  readonly gesetzt: string[] = [];
  sicherungen = 0;
  gesundheitsfragen = 0;
  verweisScheitert = false;
  pm2Scheitert = new Set<string>();
  readonly zeilen: string[] = [];
  /** Archivpfad → was darin liegt. */
  readonly inhalt = new Map<string, ArtefaktManifest>();

  verweisLesen() {
    return this.verweis;
  }
  verweisSetzen(_basis: string, ziel: string) {
    if (this.verweisScheitert) throw new Error('EACCES: keine Berechtigung');
    this.verweis = ziel;
    this.gesetzt.push(ziel);
  }
  async pm2Neuladen(verzeichnis: string) {
    this.neuGeladen.push(verzeichnis);
    if (this.pm2Scheitert.has(verzeichnis)) return false;
    this.laufend = verzeichnis;
    return true;
  }
  async pm2Sichern() {
    this.sicherungen++;
    return true;
  }
  async gesundheit(): Promise<Gesundheit | null> {
    this.gesundheitsfragen++;
    const v = this.laufend;
    if (!v || this.krank.has(v)) return null;
    if (this.falscheAntwort) {
      const antwort = this.falscheAntwort(v);
      if (antwort !== undefined && antwort !== null) return antwort;
    }
    const lesung = releaseIdentitaetLesen(v);
    return lesung.ok ? { version: lesung.identitaet.commit, buildId: lesung.identitaet.buildId, identitaet: 'belegt' } : null;
  }
  async schlafen() {}
  protokoll(zeile: string) {
    this.zeilen.push(zeile);
  }
  async sha256(datei: string) {
    return sha256(readFileSync(datei));
  }
  manifestAusArchiv(archiv: string) {
    const m = this.inhalt.get(archiv);
    return m ? JSON.stringify(m) : null;
  }
  entpacken(archiv: string, ziel: string) {
    const m = this.inhalt.get(archiv);
    if (!m) return false;
    releaseSchreiben(ziel, m);
    return true;
  }
  hydrationPruefen() {
    return true;
  }
  verknuepfen(quelle: string, verweis: string) {
    writeFileSync(verweis, `-> ${quelle}`);
  }
}

let basis: string;
let welt: Welt;
let archiv: string;
let archivSumme: string;

/**
 * Ausgangslage jedes Falls: `NEU` läuft (drei Migrationen, Register nach
 * Wahl), `ALT` liegt als aufbewahrtes Archiv bereit (zwei Migrationen). Beim
 * Rücksprung bliebe also `M3` in der Datenbank.
 */
function aufbauen(einstufungM3: string | null = 'RUECKWAERTSVERTRAEGLICH'): void {
  basis = mkdtempSync(join(tmpdir(), 'clenaris-ruecksprung-'));
  mkdirSync(join(basis, 'shared'), { recursive: true });
  writeFileSync(join(basis, 'shared', '.env'), 'APP_URL=https://beispiel.invalid\n');
  const register: Record<string, string> = { [M1]: 'RUECKWAERTSVERTRAEGLICH', [M2]: 'RUECKWAERTSVERTRAEGLICH' };
  if (einstufungM3) register[M3] = einstufungM3;
  releaseSchreiben(join(basis, 'releases', NEU), manifest(NEU, BAU_NEU, [M1, M2, M3]), register);

  mkdirSync(join(basis, 'archiv'), { recursive: true });
  archiv = join(basis, 'archiv', `clenaris-${ALT.slice(0, 12)}.tar.gz`);
  writeFileSync(archiv, `archiv-bytes-${ALT}`);
  archivSumme = sha256(`archiv-bytes-${ALT}`);
  writeFileSync(`${archiv}.sha256`, `${archivSumme}  clenaris-${ALT.slice(0, 12)}.tar.gz\n`);

  welt = new Welt();
  welt.inhalt.set(archiv, manifest(ALT, BAU_ALT, [M1, M2]));
  welt.verweis = join(basis, 'releases', NEU);
  welt.laufend = join(basis, 'releases', NEU);
}

function auftrag(extra: Partial<RuecksprungAuftrag> = {}): RuecksprungAuftrag {
  return {
    basis,
    auf: ALT,
    erwartetSha256: archivSumme,
    port: 3000,
    schemaBewusst: false,
    sperreGehalten: true,
    versuche: 5,
    abstandMs: 0,
    kennung: 'pruef',
    ...extra,
  };
}

function protokollzeilen(): Record<string, unknown>[] {
  const datei = join(basis, 'aktivierungen.jsonl');
  if (!existsSync(datei)) return [];
  return readFileSync(datei, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((z) => JSON.parse(z) as Record<string, unknown>);
}

/** Nichts umgeschaltet, nichts neu geladen, nichts entpackt. */
function unveraendert(): void {
  assert.equal(welt.verweis, join(basis, 'releases', NEU), 'current zeigt unverändert auf das laufende Release');
  assert.deepEqual(welt.neuGeladen, [], 'pm2 wurde nicht angefasst');
  assert.equal(welt.sicherungen, 0);
  assert.equal(existsSync(join(basis, 'releases', ALT)), false, 'nichts entpackt');
}

describe('Rücksprung von Hand (scripts/release-ruecksprung.ts)', () => {
  beforeEach(() => aufbauen());
  afterEach(() => rmSync(basis, { recursive: true, force: true }));

  it('verweigert ohne erwartete Summe — nichts umgeschaltet', async () => {
    const e = await ruecksprung(auftrag({ erwartetSha256: undefined }), welt);
    assert.equal(e.code, 10);
    assert.equal(e.zustand, 'NICHT_UMGESCHALTET');
    assert.match(e.meldung, /--erwartet-sha256/);
    unveraendert();
  });

  it('verweigert mit falscher erwarteter Summe — nichts umgeschaltet', async () => {
    const e = await ruecksprung(auftrag({ erwartetSha256: 'f'.repeat(64) }), welt);
    assert.equal(e.code, 10);
    assert.match(e.meldung, /nicht die erwartete/);
    unveraendert();
  });

  it('verweigert, wenn die .sha256 neben dem Archiv etwas anderes sagt', async () => {
    writeFileSync(`${archiv}.sha256`, `${'e'.repeat(64)}  clenaris-${ALT.slice(0, 12)}.tar.gz\n`);
    const e = await ruecksprung(auftrag(), welt);
    assert.equal(e.code, 10);
    assert.match(e.meldung, /\.sha256/);
    unveraendert();
  });

  it('verweigert, wenn RELEASE.json im Archiv einen anderen Commit nennt', async () => {
    welt.inhalt.set(archiv, manifest('d'.repeat(40), BAU_ALT, [M1, M2]));
    const e = await ruecksprung(auftrag(), welt);
    assert.equal(e.code, 10);
    assert.match(e.meldung, /nennt d{40}/);
    unveraendert();
  });

  it('verweigert ein Archiv, das keine Auslieferung ist (Probe)', async () => {
    welt.inhalt.set(archiv, { ...manifest(ALT, BAU_ALT, [M1, M2]), ci: null });
    const e = await ruecksprung(auftrag(), welt);
    assert.equal(e.code, 10);
    unveraendert();
  });

  it('Ziel bereits aktiv → nichts zu tun', async () => {
    releaseSchreiben(join(basis, 'releases', ALT), manifest(ALT, BAU_ALT, [M1, M2]));
    welt.verweis = join(basis, 'releases', ALT);
    welt.laufend = join(basis, 'releases', ALT);
    const e = await ruecksprung(auftrag(), welt);
    assert.equal(e.code, 10);
    assert.match(e.meldung, /bereits aktiv — nichts zu tun/);
    assert.deepEqual(welt.gesetzt, []);
    assert.deepEqual(welt.neuGeladen, []);
    assert.equal(welt.sicherungen, 0);
  });

  it('ohne gehaltene Sperre geschieht nichts', async () => {
    const e = await ruecksprung(auftrag({ sperreGehalten: false }), welt);
    assert.equal(e.code, 10);
    assert.match(e.meldung, /release-ruecksprung\.sh/);
    unveraendert();
  });

  it('entpackt frisch, schaltet um, prüft die Identität und sichert pm2', async () => {
    // Ein altes, verändertes Verzeichnis liegt schon da — es darf nicht
    // wiederverwendet werden.
    const ziel = join(basis, 'releases', ALT);
    releaseSchreiben(ziel, manifest(ALT, 'manipulierter-bau', [M1, M2]));
    writeFileSync(join(ziel, 'manipuliert.txt'), 'nachträglich eingelegt');

    const e = await ruecksprung(auftrag(), welt);
    assert.equal(e.code, 0, e.meldung);
    assert.equal(e.zustand, 'AKTIV');
    assert.equal(welt.verweis, ziel);
    assert.deepEqual(welt.neuGeladen, [ziel]);
    assert.equal(welt.sicherungen, 1, 'pm2 save nach bestätigter Identität');
    assert.ok(welt.gesundheitsfragen >= 3, 'mehrere Antworten in Folge bestätigen die Identität');
    assert.equal(existsSync(join(ziel, 'manipuliert.txt')), false, 'das alte Verzeichnis ist ersetzt');
    assert.equal(readFileSync(join(ziel, '.next', 'BUILD_ID'), 'utf8').trim(), BAU_ALT);
    assert.ok(existsSync(join(ziel, '.env')) && existsSync(join(ziel, 'logs')), '.env und logs verknüpft');
    assert.equal(existsSync(`${ziel}.tmp.pruef`) || existsSync(`${ziel}.alt.pruef`), false, 'keine Zwischenverzeichnisse übrig');
  });

  it('rote Identität → zurück auf das Vorherige, und das wird ebenfalls geprüft (20)', async () => {
    const ziel = join(basis, 'releases', ALT);
    welt.krank.add(ziel);
    const e = await ruecksprung(auftrag(), welt);
    assert.equal(e.code, 20, e.meldung);
    assert.equal(e.zustand, 'ZURUECK');
    assert.equal(welt.verweis, join(basis, 'releases', NEU));
    assert.deepEqual(welt.neuGeladen, [ziel, join(basis, 'releases', NEU)]);
    assert.equal(welt.laufend, join(basis, 'releases', NEU));
    assert.equal(welt.sicherungen, 1, 'gesichert wird nach dem bestätigten Rücksprung');
  });

  it('auch das Vorherige bestätigt sich nicht → 30, keine pm2-Sicherung', async () => {
    welt.krank.add(join(basis, 'releases', ALT));
    welt.krank.add(join(basis, 'releases', NEU));
    const e = await ruecksprung(auftrag(), welt);
    assert.equal(e.code, 30);
    assert.equal(e.zustand, 'UNKLAR');
    assert.equal(welt.sicherungen, 0, 'ein ungeklärter Zustand wird nicht für den Neustart festgeschrieben');
  });

  it('die Build-ID zählt, nicht nur der Commit', async () => {
    const ziel = join(basis, 'releases', ALT);
    welt.falscheAntwort = (v) => (v === ziel ? { version: ALT, buildId: 'anderer-bau', identitaet: 'belegt' } : null);
    const e = await ruecksprung(auftrag(), welt);
    assert.equal(e.code, 20, 'richtiger Commit, falscher Bau: nicht bestätigt');
  });

  it('eine widersprüchliche Identität gilt nicht als bestätigt', async () => {
    const ziel = join(basis, 'releases', ALT);
    welt.falscheAntwort = (v) => (v === ziel ? { version: ALT, buildId: BAU_ALT, identitaet: 'widerspruechlich' } : null);
    const e = await ruecksprung(auftrag(), welt);
    assert.equal(e.code, 20);
  });

  it('jeder Versuch steht in aktivierungen.jsonl — auch die Verweigerung', async () => {
    await ruecksprung(auftrag({ erwartetSha256: 'f'.repeat(64) }), welt);
    await ruecksprung(auftrag(), welt);
    const zeilen = protokollzeilen();
    assert.equal(zeilen.length, 2);
    assert.deepEqual(
      zeilen.map((z) => [z.art, z.von, z.nach, z.code, z.zustand]),
      [
        ['ruecksprung', NEU, ALT, 10, 'NICHT_UMGESCHALTET'],
        ['ruecksprung', NEU, ALT, 0, 'AKTIV'],
      ],
    );
    for (const z of zeilen) assert.match(String(z.zeitUtc), /^\d{4}-\d{2}-\d{2}T/);
    assert.doesNotMatch(readFileSync(join(basis, 'aktivierungen.jsonl'), 'utf8'), /APP_URL|beispiel\.invalid/, 'nichts aus der Umgebung');
  });
});

describe('Rücksprung — das Schema geht nie mit zurück', () => {
  afterEach(() => rmSync(basis, { recursive: true, force: true }));

  it('verweigert, wenn eine BRECHENDE Migration zurückbliebe', async () => {
    aufbauen('BRECHEND');
    const e = await ruecksprung(auftrag(), welt);
    assert.equal(e.code, 10);
    assert.match(e.meldung, /--schema-bewusst/);
    assert.deepEqual(e.verbleibend, [{ migration: M3, einstufung: 'BRECHEND' }]);
    unveraendert();
  });

  it('… ausser mit --schema-bewusst, und das steht im Protokoll', async () => {
    aufbauen('BRECHEND');
    const e = await ruecksprung(auftrag({ schemaBewusst: true }), welt);
    assert.equal(e.code, 0, e.meldung);
    assert.ok(welt.zeilen.some((z) => /WARNUNG: --schema-bewusst/.test(z)));
    const [zeile] = protokollzeilen();
    assert.equal(zeile?.schemaBewusst, true);
    assert.deepEqual(zeile?.verbleibendeMigrationen, [`${M3}:BRECHEND`]);
  });

  it('eine Migration ohne Einstufung gilt als BRECHEND', async () => {
    aufbauen(null);
    const e = await ruecksprung(auftrag(), welt);
    assert.equal(e.code, 10);
    assert.deepEqual(e.verbleibend, [{ migration: M3, einstufung: 'BRECHEND' }]);
  });

  it('auch PROGRAMMWECHSEL und RUECKFUELLUNG halten an — nur RUECKWAERTSVERTRAEGLICH nicht', async () => {
    for (const einstufung of ['PROGRAMMWECHSEL', 'RUECKFUELLUNG']) {
      aufbauen(einstufung);
      const e = await ruecksprung(auftrag(), welt);
      assert.equal(e.code, 10, einstufung);
      rmSync(basis, { recursive: true, force: true });
    }
    aufbauen('RUECKWAERTSVERTRAEGLICH');
    const e = await ruecksprung(auftrag(), welt);
    assert.equal(e.code, 0, e.meldung);
  });

  it('eingestuft wird mit dem Register des laufenden Release, und ohne Register gilt alles als BRECHEND', () => {
    aufbauen('RUECKWAERTSVERTRAEGLICH');
    const aktuell = join(basis, 'releases', NEU);
    assert.deepEqual(verbleibendeMigrationen(aktuell, [M1, M2]), [{ migration: M3, einstufung: 'RUECKWAERTSVERTRAEGLICH' }]);
    rmSync(join(aktuell, 'security'), { recursive: true, force: true });
    assert.deepEqual(verbleibendeMigrationen(aktuell, [M1, M2]), [{ migration: M3, einstufung: 'BRECHEND' }]);
    assert.deepEqual(verbleibendeMigrationen(aktuell, [M1, M2, M3]), [], 'kennt das Ziel alle, bleibt nichts zurück');
  });
});

describe('Umschalten mit Identitätsprüfung (scripts/release/umschaltung.ts)', () => {
  afterEach(() => rmSync(basis, { recursive: true, force: true }));

  function vorbereiten(): { ziel: string; vorher: string } {
    aufbauen();
    const ziel = join(basis, 'releases', ALT);
    releaseSchreiben(ziel, manifest(ALT, BAU_ALT, [M1, M2]));
    return { ziel, vorher: join(basis, 'releases', NEU) };
  }
  const erwartet = { commit: ALT, buildId: BAU_ALT };

  it('ohne vorheriges Release und ohne Bestätigung → 30', async () => {
    const { ziel } = vorbereiten();
    welt.verweis = null;
    welt.laufend = null;
    welt.krank.add(ziel);
    const e = await umschaltenMitPruefung({ basis, ziel, erwartet, port: 3000, versuche: 3, abstandMs: 0 }, welt);
    assert.equal(e.code, 30);
    assert.equal(welt.sicherungen, 0);
  });

  it('lässt sich der Verweis nicht setzen → 10, current unverändert, pm2 unberührt', async () => {
    const { ziel, vorher } = vorbereiten();
    welt.verweisScheitert = true;
    const e = await umschaltenMitPruefung({ basis, ziel, erwartet, port: 3000, versuche: 3, abstandMs: 0 }, welt);
    assert.equal(e.code, 10);
    assert.equal(welt.verweis, vorher);
    assert.deepEqual(welt.neuGeladen, []);
  });

  it('scheitert pm2 beim Laden der neuen Fassung, geht es zurück (20)', async () => {
    const { ziel, vorher } = vorbereiten();
    welt.pm2Scheitert.add(ziel);
    const e = await umschaltenMitPruefung({ basis, ziel, erwartet, port: 3000, versuche: 3, abstandMs: 0 }, welt);
    assert.equal(e.code, 20);
    assert.equal(welt.verweis, vorher);
  });

  it('verlangt mehrere bestätigende Antworten in Folge — ein halb neu geladener Cluster genügt nicht', async () => {
    const { ziel, vorher } = vorbereiten();
    // Zwei Arbeiter, einer noch alt: Die Antworten wechseln sich ab.
    let n = 0;
    welt.falscheAntwort = (v) => {
      if (v !== ziel) return null;
      n++;
      return n % 2 === 0 ? { version: NEU, buildId: BAU_NEU, identitaet: 'belegt' } : null;
    };
    const e = await umschaltenMitPruefung({ basis, ziel, erwartet, port: 3000, versuche: 10, abstandMs: 0 }, welt);
    assert.equal(e.code, 20, 'jede zweite Antwort stammt vom alten Arbeiter — nie drei in Folge');
    assert.equal(welt.verweis, vorher);
  });

  it('das vorherige Release ohne belegbare Identität → 30 statt eines behaupteten Rücksprungs', async () => {
    const { ziel, vorher } = vorbereiten();
    welt.krank.add(ziel);
    rmSync(join(vorher, 'RELEASE.json'));
    const e = await umschaltenMitPruefung({ basis, ziel, erwartet, port: 3000, versuche: 3, abstandMs: 0 }, welt);
    assert.equal(e.code, 30);
    assert.match(e.meldung, /keine belegbare Identität/);
  });

  it('aktivPruefen: aktiv, nicht aktiv, aktiv aber unbestätigt', async () => {
    const { ziel, vorher } = vorbereiten();
    const auftragAktiv = { basis, ziel: vorher, erwartet: { commit: NEU, buildId: BAU_NEU }, port: 3000, versuche: 3, abstandMs: 0 };
    assert.equal(await aktivPruefen(auftragAktiv, welt), 'aktiv');
    assert.equal(await aktivPruefen({ ...auftragAktiv, ziel }, welt), 'nicht-aktiv');
    welt.krank.add(vorher);
    assert.equal(await aktivPruefen(auftragAktiv, welt), 'aktiv-unbestaetigt');
    assert.deepEqual(welt.gesetzt, [], 'die Prüfung schaltet nie um');
    assert.deepEqual(welt.neuGeladen, [], 'und lädt nichts neu');
  });
});

describe('Umschalten — reine Bausteine', () => {
  it('gesundheitAuswerten: nur ein 200 mit lesbarem Rumpf zählt', () => {
    const rumpf = JSON.stringify({ data: { status: 'ok', version: NEU, buildId: BAU_NEU, identitaet: 'belegt' } });
    assert.deepEqual(gesundheitAuswerten(200, rumpf), { version: NEU, buildId: BAU_NEU, identitaet: 'belegt' });
    assert.equal(gesundheitAuswerten(503, rumpf), null, 'ohne Datenbank nicht gesund');
    assert.equal(gesundheitAuswerten(200, '<html>'), null);
    assert.deepEqual(gesundheitAuswerten(200, JSON.stringify({ data: { version: 7 } })), { version: null, buildId: null, identitaet: null });
  });

  it('releaseIdentitaetLesen: BUILD_ID muss zum Manifest passen, distDir bleibt im Release', () => {
    const v = mkdtempSync(join(tmpdir(), 'clenaris-identitaet-'));
    try {
      releaseSchreiben(v, manifest(NEU, BAU_NEU, [M1]));
      const gut = releaseIdentitaetLesen(v);
      assert.ok(gut.ok && gut.identitaet.commit === NEU && gut.identitaet.buildId === BAU_NEU);
      writeFileSync(join(v, '.next', 'BUILD_ID'), 'anderer-bau');
      assert.equal(releaseIdentitaetLesen(v).ok, false);
      writeFileSync(join(v, 'RELEASE.json'), JSON.stringify({ ...manifest(NEU, BAU_NEU, [M1]), distDir: '../../fremd' }));
      assert.equal(releaseIdentitaetLesen(v).ok, false);
      writeFileSync(join(v, 'RELEASE.json'), JSON.stringify({ ...manifest(NEU, BAU_NEU, [M1]), format: 1 }));
      assert.equal(releaseIdentitaetLesen(v).ok, false, 'Format 1 hat keinen belastbaren Vertrag');
    } finally {
      rmSync(v, { recursive: true, force: true });
    }
  });

  it('pm2Umgebung: nie APP_VERSION, GITHUB_*, CLENARIS_PRUEF_* — und nur, was pm2 braucht', () => {
    const umgebung = pm2Umgebung(
      {
        PATH: '/usr/bin',
        HOME: '/home/clenaris',
        APP_VERSION: 'b'.repeat(40),
        GITHUB_SHA: 'c'.repeat(40),
        CLENARIS_PRUEF_RELEASE_MANIFEST: '/tmp/fremd.json',
        DATABASE_URL: 'postgresql://irgendwo/fremd',
        PM2_APP_NAME: 'clenaris',
      },
      3100,
    );
    assert.deepEqual(Object.keys(umgebung).sort(), ['HOME', 'NODE_ENV', 'PATH', 'PM2_APP_NAME', 'PORT']);
    assert.equal(umgebung.PORT, '3100');
    assert.equal(umgebung.NODE_ENV, 'production');
  });

  it('pm2Lage: erkennt, ob pm2 wirklich aus dem Release läuft', () => {
    const jlist =
      'Hinweis vor dem JSON\n' +
      JSON.stringify([
        { name: 'clenaris', pm2_env: { pm_cwd: '/srv/clenaris/releases/aaa', status: 'online' } },
        { name: 'clenaris', pm2_env: { pm_cwd: '/srv/clenaris/releases/aaa', status: 'online' } },
        { name: 'anderes', pm2_env: { pm_cwd: '/srv/anderes', status: 'online' } },
      ]);
    const prozesse = pm2ProzesseLesen(jlist);
    assert.equal(prozesse.length, 3);
    assert.equal(pm2Lage(prozesse, 'clenaris', '/srv/clenaris/releases/aaa'), 'hier');
    assert.equal(pm2Lage(prozesse, 'clenaris', '/srv/clenaris/releases/bbb'), 'anderswo', 'Neuladen hat das Verzeichnis nicht übernommen');
    assert.equal(pm2Lage(prozesse, 'fehlt', '/srv/clenaris/releases/aaa'), 'fehlt');
    assert.deepEqual(pm2ProzesseLesen('kein json'), []);
  });
});
