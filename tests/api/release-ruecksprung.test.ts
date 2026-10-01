import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ArtefaktManifest } from '../../src/lib/release/manifest';
import { ruecksprung, verbleibendeMigrationen, type RuecksprungAuftrag, type RuecksprungDienste } from '../../scripts/release-ruecksprung';
import { AKTIV_AUSGANG, befehlAusfuehren, echteBefehle, type Pm2Antwort } from '../../scripts/release-umschalten';
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
 *
 * Seit 2026-10-01 auch das Werkzeug selbst (`scripts/release-umschalten.ts`,
 * über `befehlAusfuehren` mit derselben Welt): Auf seinen Ausgängen
 * verzweigt `release-aktivieren.sh` — 10 heisst „nichts geändert", 30
 * „sofort von Hand prüfen" —, und vorher prüfte diese Zuordnung nur eine
 * örtliche Rauchprobe. Dazu der Rückfall in `pm2Neuladen` mit einem
 * nachgestellten pm2.
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
 *
 * Archive sind echte Dateien; was „darin" liegt, bestimmt ihr **Inhalt**,
 * nicht ihr Pfad (`inhalt`: Dateiinhalt → Manifest). So sieht die Attrappe
 * dasselbe wie `tar`: Wer eine Kopie liest, liest die Kopie, und wer die
 * Datei nach dem Messen tauscht, bekommt beim nächsten Öffnen den Tausch.
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
  /** pm2 wirft beim Laden eine Ausnahme, statt `false` zu melden — ein unerwarteter Fehler mitten in der Umschaltung. */
  pm2Wirft = false;
  node = '22.11.0';
  readonly zeilen: string[] = [];
  /** Dateiinhalt eines Archivs → was darin liegt. */
  readonly inhalt = new Map<string, ArtefaktManifest>();
  /** Welche Pfade gemessen, gelesen und entpackt wurden — in dieser Reihenfolge. */
  readonly gemessen: string[] = [];
  readonly manifestGelesen: string[] = [];
  readonly entpackt: string[] = [];
  /** Läuft unmittelbar nach dem Messen — für den Tausch zwischen Messen und Entpacken. */
  nachMessen: (() => void) | null = null;

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
    if (this.pm2Wirft) throw new Error('pm2: Verbindung zum Dienst verloren');
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
    this.gemessen.push(datei);
    const summe = sha256(readFileSync(datei));
    this.nachMessen?.();
    return summe;
  }
  nodeVersion() {
    return this.node;
  }
  private liegtIn(archiv: string): ArtefaktManifest | undefined {
    return existsSync(archiv) ? this.inhalt.get(readFileSync(archiv, 'utf8')) : undefined;
  }
  manifestAusArchiv(archiv: string) {
    this.manifestGelesen.push(archiv);
    const m = this.liegtIn(archiv);
    return m ? JSON.stringify(m) : null;
  }
  entpacken(archiv: string, ziel: string) {
    this.entpackt.push(archiv);
    const m = this.liegtIn(archiv);
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

/** Die Bytes des aufbewahrten Archivs von `ALT` — und damit der Schlüssel seines Inhalts in der Welt. */
const ALT_BYTES = `archiv-bytes-${ALT}`;

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
  writeFileSync(archiv, ALT_BYTES);
  archivSumme = sha256(ALT_BYTES);
  writeFileSync(`${archiv}.sha256`, `${archivSumme}  clenaris-${ALT.slice(0, 12)}.tar.gz\n`);

  welt = new Welt();
  welt.inhalt.set(ALT_BYTES, manifest(ALT, BAU_ALT, [M1, M2]));
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

/** Private Kopien des Rücksprungs, die noch in `archiv/` liegen — es dürfen nach keinem Ausgang welche übrig sein. */
function liegengebliebeneKopien(): string[] {
  const ordner = join(basis, 'archiv');
  return existsSync(ordner) ? readdirSync(ordner).filter((n) => n.startsWith('.ruecksprung.')) : [];
}

/** Nichts umgeschaltet, nichts neu geladen, nichts entpackt — und keine Kopie liegen geblieben. */
function unveraendert(): void {
  assert.equal(welt.verweis, join(basis, 'releases', NEU), 'current zeigt unverändert auf das laufende Release');
  assert.deepEqual(welt.neuGeladen, [], 'pm2 wurde nicht angefasst');
  assert.equal(welt.sicherungen, 0);
  assert.equal(existsSync(join(basis, 'releases', ALT)), false, 'nichts entpackt');
  assert.deepEqual(liegengebliebeneKopien(), [], 'die private Kopie ist in jedem Ausgang wieder weg');
  assert.equal(readFileSync(archiv, 'utf8'), ALT_BYTES, 'das aufbewahrte Archiv selbst bleibt unberührt');
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
    welt.inhalt.set(ALT_BYTES, manifest('d'.repeat(40), BAU_ALT, [M1, M2]));
    const e = await ruecksprung(auftrag(), welt);
    assert.equal(e.code, 10);
    assert.match(e.meldung, /nennt d{40}/);
    unveraendert();
  });

  it('verweigert ein Archiv, das keine Auslieferung ist (Probe)', async () => {
    welt.inhalt.set(ALT_BYTES, { ...manifest(ALT, BAU_ALT, [M1, M2]), ci: null });
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

  /**
   * Befund 2026-10-01: Ein von Hand ausgelöster Lauf auf `main` liefert den
   * laufenden Commit als neuen Bau. Bisher fragte die Prüfung die Instanz
   * nach der neuen Build-ID, bekam die alte und meldete „bestätigt sich
   * nicht" — über eine gesunde Instanz.
   */
  it('aktivPruefen: derselbe Commit als anderer Bau ist ein eigener Fall — entschieden ohne Frage an die Instanz', async () => {
    const { vorher } = vorbereiten();
    const fragen = welt.gesundheitsfragen;
    const lage = await aktivPruefen(
      { basis, ziel: vorher, erwartet: { commit: NEU, buildId: 'bau-neu-0002' }, port: 3000, versuche: 3, abstandMs: 0 },
      welt,
    );
    assert.equal(lage, 'anderer-bau');
    assert.equal(welt.gesundheitsfragen, fragen, 'die Dateien unter current genügen');
    assert.ok(welt.zeilen.some((z) => z.includes(`als Bau ${BAU_NEU}`) && z.includes('Bau bau-neu-0002 desselben Commits')));
    assert.deepEqual(welt.gesetzt, []);
    assert.deepEqual(welt.neuGeladen, []);
    // Auch eine kranke Instanz ändert daran nichts: Umgeschaltet wird auf einen zweiten Bau desselben Commits nie.
    welt.krank.add(vorher);
    assert.equal(
      await aktivPruefen({ basis, ziel: vorher, erwartet: { commit: NEU, buildId: 'bau-neu-0002' }, port: 3000, versuche: 3, abstandMs: 0 }, welt),
      'anderer-bau',
    );
  });
});

// ---------------------------------------------------------------------------
//  Das Werkzeug selbst — die Ausgänge, auf denen release-aktivieren.sh verzweigt
// ---------------------------------------------------------------------------

describe('Umschaltwerkzeug — Ausgänge des Vertrags (scripts/release-umschalten.ts)', () => {
  afterEach(() => rmSync(basis, { recursive: true, force: true }));

  const SPERRE = { CLENARIS_RELEASE_SPERRE: '/srv/clenaris/.release.lock' };

  /** `NEU` läuft, `ALT` liegt entpackt unter releases/ — wie nach Schritt 6 der Aktivierung. */
  function vorbereiten(): { ziel: string; vorher: string } {
    aufbauen();
    const ziel = join(basis, 'releases', ALT);
    releaseSchreiben(ziel, manifest(ALT, BAU_ALT, [M1, M2]));
    return { ziel, vorher: join(basis, 'releases', NEU) };
  }

  async function werkzeug(argv: string[], env: Record<string, string> = {}): Promise<{ code: number; ausgabe: string[] }> {
    const ausgabe: string[] = [];
    const code = await befehlAusfuehren({ argv, env, befehle: () => welt, protokoll: (z) => welt.protokoll(z), ausgabe: (z) => ausgabe.push(z) });
    return { code, ausgabe };
  }

  it('umschalten ohne gehaltene Sperre → 10, nichts angefasst', async () => {
    const { ziel } = vorbereiten();
    const { code } = await werkzeug(['umschalten', '--basis', basis, '--ziel', ziel, '--versuche', '3']);
    assert.equal(code, 10);
    assert.ok(welt.zeilen.some((z) => /CLENARIS_RELEASE_SPERRE/.test(z)));
    assert.equal(welt.verweis, join(basis, 'releases', NEU), 'current unverändert');
    assert.deepEqual(welt.gesetzt, []);
    assert.deepEqual(welt.neuGeladen, []);
  });

  it('umschalten auf ein Ziel ausserhalb von releases/<commit> → 10, nichts angefasst', async () => {
    vorbereiten();
    const fremd = join(basis, 'fremd', ALT);
    releaseSchreiben(fremd, manifest(ALT, BAU_ALT, [M1, M2]));
    const ohneCommit = join(basis, 'releases', 'irgendwas');
    releaseSchreiben(ohneCommit, manifest(ALT, BAU_ALT, [M1, M2]));
    for (const ziel of [fremd, ohneCommit]) {
      const { code } = await werkzeug(['umschalten', '--basis', basis, '--ziel', ziel, '--versuche', '3'], SPERRE);
      assert.equal(code, 10, ziel);
    }
    assert.ok(welt.zeilen.some((z) => /kein Release-Verzeichnis/.test(z)));
    assert.deepEqual(welt.gesetzt, []);
    assert.deepEqual(welt.neuGeladen, []);
  });

  it('umschalten auf eine Probe → 10, nichts angefasst', async () => {
    const { ziel } = vorbereiten();
    writeFileSync(join(ziel, 'RELEASE.json'), JSON.stringify({ ...manifest(ALT, BAU_ALT, [M1, M2]), ci: null }));
    const { code } = await werkzeug(['umschalten', '--basis', basis, '--ziel', ziel, '--versuche', '3'], SPERRE);
    assert.equal(code, 10);
    assert.deepEqual(welt.gesetzt, []);
  });

  it('umschalten, wenn der Commit nicht zum Verzeichnisnamen passt → 10, nichts angefasst', async () => {
    vorbereiten();
    const ziel = join(basis, 'releases', 'c'.repeat(40));
    releaseSchreiben(ziel, manifest(ALT, BAU_ALT, [M1, M2]));
    const { code } = await werkzeug(['umschalten', '--basis', basis, '--ziel', ziel, '--versuche', '3'], SPERRE);
    assert.equal(code, 10);
    assert.deepEqual(welt.gesetzt, []);
  });

  it('umschalten mit fehlendem Verzeichnis oder unzulässigen Versuchen → 10, vor jedem Umschalten', async () => {
    const { ziel } = vorbereiten();
    assert.equal((await werkzeug(['umschalten', '--basis', basis, '--ziel', join(basis, 'releases', 'f'.repeat(40))], SPERRE)).code, 10);
    assert.equal((await werkzeug(['umschalten', '--basis', basis, '--ziel', ziel, '--versuche', '0'], SPERRE)).code, 10);
    assert.deepEqual(welt.gesetzt, []);
  });

  it('umschalten mit Sperre auf ein gesundes Ziel → 0, Schlusszeile UMSCHALTUNG', async () => {
    const { ziel } = vorbereiten();
    const { code, ausgabe } = await werkzeug(['umschalten', '--basis', basis, '--ziel', ziel, '--versuche', '3'], SPERRE);
    assert.equal(code, 0);
    assert.deepEqual(ausgabe, ['UMSCHALTUNG {"code":0,"zustand":"AKTIV"}']);
    assert.equal(welt.laufend, realpathSync(ziel));
    assert.equal(welt.sicherungen, 1);
  });

  it('umschalten mit krankem Ziel → 20 über das Werkzeug, mit derselben Schlusszeile', async () => {
    const { ziel } = vorbereiten();
    welt.krank.add(realpathSync(ziel));
    const { code, ausgabe } = await werkzeug(['umschalten', '--basis', basis, '--ziel', ziel, '--versuche', '3'], SPERRE);
    assert.equal(code, 20);
    assert.deepEqual(ausgabe, ['UMSCHALTUNG {"code":20,"zustand":"ZURUECK"}']);
  });

  it('ein unerwarteter Fehler nach dem Umschalten → 30, nie 10', async () => {
    const { ziel } = vorbereiten();
    welt.pm2Wirft = true;
    const { code } = await werkzeug(['umschalten', '--basis', basis, '--ziel', ziel, '--versuche', '3'], SPERRE);
    assert.equal(code, 30, 'der Verweis ist gesetzt — „nichts geändert" wäre gelogen');
    assert.equal(welt.verweis, realpathSync(ziel));
    assert.ok(welt.zeilen.some((z) => /FEHLER: pm2: Verbindung zum Dienst verloren/.test(z)));
  });

  it('aktiv: 0 bestätigt, 3 nicht aktiv, 4 unbestätigt, 5 derselbe Commit als anderer Bau', async () => {
    const { ziel, vorher } = vorbereiten();
    const aktiv = (zielPfad: string, erwartetAus: string) =>
      werkzeug(['aktiv', '--basis', basis, '--ziel', zielPfad, '--erwartet-aus', erwartetAus, '--port', '3000']);
    welt.verweis = realpathSync(vorher);
    welt.laufend = realpathSync(vorher);
    assert.equal((await aktiv(vorher, vorher)).code, 0);
    assert.equal((await aktiv(ziel, ziel)).code, 3);
    const zweiterBau = join(basis, 'zweiter-bau');
    releaseSchreiben(zweiterBau, manifest(NEU, 'bau-neu-0002', [M1, M2, M3]));
    assert.equal((await aktiv(vorher, zweiterBau)).code, 5);
    welt.krank.add(realpathSync(vorher));
    assert.equal((await aktiv(vorher, vorher)).code, 4);
    assert.deepEqual(welt.gesetzt, [], 'aktiv schaltet nie um');
    assert.deepEqual(welt.neuGeladen, []);
  });

  it('artefakt: 0 für eine Auslieferung, 1 für eine Probe oder ein unbekanntes Verzeichnis; unbekannter Befehl → 1', async () => {
    const { ziel } = vorbereiten();
    assert.equal((await werkzeug(['artefakt', '--verzeichnis', ziel])).code, 0);
    writeFileSync(join(ziel, 'RELEASE.json'), JSON.stringify({ ...manifest(ALT, BAU_ALT, [M1, M2]), ci: null }));
    assert.equal((await werkzeug(['artefakt', '--verzeichnis', ziel])).code, 1);
    assert.equal((await werkzeug(['artefakt', '--verzeichnis', join(basis, 'gibt-es-nicht')])).code, 1);
    assert.equal((await werkzeug(['irgendwas'])).code, 1);
  });

  it('AKTIV_AUSGANG ist die Tabelle, auf der release-aktivieren.sh verzweigt', () => {
    assert.deepEqual(AKTIV_AUSGANG, { aktiv: 0, 'nicht-aktiv': 3, 'aktiv-unbestaetigt': 4, 'anderer-bau': 5 });
  });
});

describe('Umschaltwerkzeug — pm2 neu laden, auch wenn pm2 das Verzeichnis nicht übernimmt', () => {
  /**
   * Ein nachgestelltes pm2: `jlist` antwortet aus `lagen` (eine Antwort je
   * Aufruf, die letzte bleibt stehen), jeder andere Befehl aus `ausgaenge`.
   */
  function pm2Attrappe(lagen: string[][], ausgaenge: Record<string, number> = {}) {
    const aufrufe: string[][] = [];
    let n = 0;
    const aufruf = (args: string[]): Pm2Antwort => {
      aufrufe.push(args);
      if (args[0] === 'jlist') {
        const verzeichnisse = lagen[Math.min(n++, lagen.length - 1)] ?? [];
        return { status: 0, stdout: JSON.stringify(verzeichnisse.map((v) => ({ name: 'clenaris', pm2_env: { pm_cwd: v, status: 'online' } }))), stderr: '' };
      }
      return { status: ausgaenge[args[0]!] ?? 0, stdout: '', stderr: ausgaenge[args[0]!] ? 'pm2 meldet einen Fehler' : '' };
    };
    return { aufruf, aufrufe };
  }
  const ALTES = join(tmpdir(), 'clenaris-pm2', 'releases', ALT);
  const NEUES = join(tmpdir(), 'clenaris-pm2', 'releases', NEU);
  const ruhig = () => {};

  it('übernimmt das Neuladen das Verzeichnis, bleibt es beim startOrReload mit --update-env', async () => {
    const pm2 = pm2Attrappe([[ALTES], [NEUES]]);
    assert.equal(await echteBefehle('clenaris', 3000, ruhig, pm2.aufruf).pm2Neuladen(NEUES), true);
    assert.deepEqual(
      pm2.aufrufe.map((a) => a[0]),
      ['jlist', 'startOrReload', 'jlist'],
    );
    assert.deepEqual(pm2.aufrufe[1], ['startOrReload', join(NEUES, 'ecosystem.config.js'), '--env', 'production', '--update-env']);
  });

  it('läuft danach still die alte Fassung, wird gelöscht und aus dem Release neu gestartet', async () => {
    const zeilen: string[] = [];
    const pm2 = pm2Attrappe([[ALTES], [ALTES], [NEUES]]);
    assert.equal(await echteBefehle('clenaris', 3000, (z) => zeilen.push(z), pm2.aufruf).pm2Neuladen(NEUES), true);
    assert.deepEqual(
      pm2.aufrufe.map((a) => a[0]),
      ['jlist', 'startOrReload', 'jlist', 'delete', 'start', 'jlist'],
    );
    assert.deepEqual(pm2.aufrufe[3], ['delete', 'clenaris']);
    assert.ok(zeilen.some((z) => /Arbeitsverzeichnis beim Neuladen nicht übernommen/.test(z)));
  });

  it('läuft auch nach dem Neustart nicht aus dem Release → false, damit die Umschaltung zurückspringt', async () => {
    const pm2 = pm2Attrappe([[ALTES]]);
    assert.equal(await echteBefehle('clenaris', 3000, ruhig, pm2.aufruf).pm2Neuladen(NEUES), false);
  });

  it('läuft noch nichts, wird gestartet statt neu geladen; scheitert pm2, ist das Ergebnis false ohne Löschen', async () => {
    const leer = pm2Attrappe([[], [NEUES]]);
    assert.equal(await echteBefehle('clenaris', 3000, ruhig, leer.aufruf).pm2Neuladen(NEUES), true);
    assert.deepEqual(leer.aufrufe.map((a) => a[0]), ['jlist', 'start', 'jlist']);

    const kaputt = pm2Attrappe([[ALTES]], { startOrReload: 1 });
    assert.equal(await echteBefehle('clenaris', 3000, ruhig, kaputt.aufruf).pm2Neuladen(NEUES), false);
    assert.deepEqual(kaputt.aufrufe.map((a) => a[0]), ['jlist', 'startOrReload'], 'kein delete nach einem gescheiterten Neuladen');
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

  /**
   * `CLENARIS_TEST_CACHE_DIR` steht mit Absicht in der Eingabe: Die Variable
   * schaltet einen Produktionsbau auf den Testprüfer für Dateien, auf
   * Dateizähler für Rate-Limits und einen Dateipostausgang um
   * (`src/lib/security/malware/index.ts`). Aus einer SSH-Sitzung darf sie nie
   * in die Produktion gelangen — die Positivliste lässt sie deshalb gar nicht
   * erst durch, statt sich auf eine Sperrliste zu verlassen.
   */
  it('pm2Umgebung: nie APP_VERSION, GITHUB_*, CLENARIS_PRUEF_* — und nur, was pm2 braucht', () => {
    const umgebung = pm2Umgebung(
      {
        PATH: '/usr/bin',
        HOME: '/home/clenaris',
        APP_VERSION: 'b'.repeat(40),
        GITHUB_SHA: 'c'.repeat(40),
        CLENARIS_PRUEF_RELEASE_MANIFEST: '/tmp/fremd.json',
        CLENARIS_TEST_CACHE_DIR: '/tmp/pruefreihe',
        CLENARIS_UMGEBUNG: 'test',
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
