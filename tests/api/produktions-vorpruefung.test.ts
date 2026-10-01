import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnvConfig } from '@next/env';

import {
  istOeffentlichesPasswort,
  oeffentlicheZugangsdatenErlaubt,
  passwortHierGesperrt,
} from '../../src/lib/auth/oeffentliche-zugangsdaten';
import { hashPassword } from '../../src/lib/auth/password';
import { BusinessRuleError } from '../../src/lib/errors';
import { databaseNameOf, istTestdatenbank, oeffentlicheKontenErlaubt, produktivesSystem } from '../../prisma/seed-guard';
import { auswerten, releasePruefen, umgebungPruefen, type Pruefung } from '../../scripts/production-preflight';
import { migrationEinstufen, reiheEinstufen, registerLesen, strengsteEinstufung, torPruefen } from '../../scripts/migration-kompatibilitaet';
import { ACCOUNTS } from '../helpers/accounts';
import { post, requireServer } from '../helpers/client';
import { PRUEF_ARTEFAKT_COMMIT, PRUEF_BUILD_ID, pruefManifest, pruefVerzeichnis } from '../helpers/pruefartefakt';
import { testDb, testDbSchliessen } from '../helpers/testdb';

/**
 * Notfallauftrag 2026-09-27 — was nicht wiederkommen darf.
 *
 * Der Befund: Auf dem Produktionsserver war die Verwaltung mit den
 * Demozugängen aus dem öffentlichen Repository anmeldbar. Die Ursache waren
 * drei Wege, die einander nicht kannten — der Konfigurations-Seed legte
 * Demokonten mit veröffentlichtem Passwort an, seine Produktionsschranke
 * prüfte nur die Länge und nur `process.env.NODE_ENV`, und die Anmeldung
 * wusste von alldem nichts.
 *
 * Die Fälle hier sind so gebaut, dass sie gegen den Stand vor dem Auftrag
 * **scheitern**: Die Produktionsinstanz unten liess sich damals mit dem
 * Demopasswort anmelden (200 statt 401), `hashPassword` nahm es an, der
 * Demo-Seed lief mit `ALLOW_DEMO_SEED=ja` auch in der Produktion, und
 * `seed.ts` nahm `Admin#2026Clenaris` als Produktionspasswort hin.
 *
 * Ebenen wie in `laufzeit-konfiguration.test.ts`: rein (Regeln dort, wo sie
 * stehen), als Kindprozess (Seeds und Vorprüfung, wie sie auf einem Server
 * aufgerufen werden) und über HTTP gegen eine eigens gestartete
 * Produktionsinstanz ohne Prüfkennzeichen.
 */

const WURZEL = join(__dirname, '..', '..');
const IM_CI = Boolean(process.env.CI);

/** Umgebung für einen Block setzen und danach zurückstellen. */
function mitUmgebung<T>(werte: Record<string, string | undefined>, f: () => T): T {
  const vorher: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(werte)) {
    vorher[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return f();
  } finally {
    for (const [k, v] of Object.entries(vorher)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Datenbankadressen auf `.invalid`: nie auflösbar, und die Geheimnisprüfung
// hält sie zu Recht nicht für echte Zugangsdaten.
const PROD_DB = 'postgresql://pruef-nutzer@pruef-db.invalid:5432/clenaris';
const TEST_DB = 'postgresql://pruef-nutzer@pruef-db.invalid:5432/clenaris_test';
const VORSCHAU_DB = 'postgresql://pruef-nutzer@pruef-db.invalid:5432/clenaris_preview';

// ---------------------------------------------------------------------------
//  1. Die Regel selbst
// ---------------------------------------------------------------------------

describe('Öffentlich bekannte Passwörter — wo sie gelten dürfen (rein)', () => {
  it('erkennt jedes veröffentlichte Passwort, auch mit anderer Gross-/Kleinschreibung', () => {
    for (const pw of ['Demo#2026Clenaris', 'Admin#2026Clenaris', 'System#2026Clenaris', 'Preview#2026Admin', ' demo#2026clenaris ']) {
      assert.ok(istOeffentlichesPasswort(pw), pw);
    }
    assert.ok(!istOeffentlichesPasswort('Ein-eigenes#Passwort-2026'));
  });

  it('Produktion ohne Prüfkennzeichen: gesperrt', () => {
    assert.equal(passwortHierGesperrt('Demo#2026Clenaris', { NODE_ENV: 'production', DATABASE_URL: PROD_DB }), true);
  });

  it('Produktion mit CLENARIS_UMGEBUNG=test, aber gegen eine echte Datenbank: gesperrt', () => {
    assert.equal(
      passwortHierGesperrt('Demo#2026Clenaris', { NODE_ENV: 'production', CLENARIS_UMGEBUNG: 'test', DATABASE_URL: PROD_DB }),
      true,
      'ein einzelner Tippfehler in der .env darf die Demozugänge nicht öffnen',
    );
  });

  it('Produktion gegen eine Testdatenbank, aber ohne Kennzeichen: gesperrt', () => {
    assert.equal(passwortHierGesperrt('Demo#2026Clenaris', { NODE_ENV: 'production', DATABASE_URL: TEST_DB }), true);
  });

  it('Test- und Vorschauserver (Kennzeichen und Wegwerf-Datenbank): erlaubt', () => {
    assert.equal(oeffentlicheZugangsdatenErlaubt({ NODE_ENV: 'production', CLENARIS_UMGEBUNG: 'test', DATABASE_URL: TEST_DB }), true);
    assert.equal(oeffentlicheZugangsdatenErlaubt({ NODE_ENV: 'production', CLENARIS_UMGEBUNG: 'preview', DATABASE_URL: VORSCHAU_DB }), true);
  });

  it('Entwicklung: erlaubt', () => {
    assert.equal(oeffentlicheZugangsdatenErlaubt({ NODE_ENV: 'development', DATABASE_URL: PROD_DB }), true);
  });

  it('hashPassword weist das veröffentlichte Passwort in der Produktion mit 422 und Feld ab', async () => {
    await mitUmgebung({ NODE_ENV: 'production', CLENARIS_UMGEBUNG: undefined, DATABASE_URL: PROD_DB }, async () => {
      await assert.rejects(
        () => hashPassword('Demo#2026Clenaris'),
        (error: unknown) => {
          assert.ok(error instanceof BusinessRuleError);
          assert.equal(error.status, 422);
          assert.deepEqual((error.details as { field: string }[])[0]!.field, 'password');
          return true;
        },
      );
    });
  });

  it('hashPassword nimmt ein eigenes Passwort in der Produktion an', async () => {
    const hash = await mitUmgebung({ NODE_ENV: 'production', CLENARIS_UMGEBUNG: undefined, DATABASE_URL: PROD_DB }, () =>
      hashPassword('Ein-eigenes#Passwort-2026'),
    );
    assert.match(hash, /^\$argon2id\$/);
  });
});

// ---------------------------------------------------------------------------
//  2. Seeds
// ---------------------------------------------------------------------------

describe('Seeds: nie Demokonten mit veröffentlichtem Passwort in der Produktion', () => {
  /**
   * `umgebungswert()` liest `.env` im Arbeitsverzeichnis nach. Damit eine
   * örtliche `.env` die Fälle nicht beeinflusst, laufen sie in einem leeren
   * Verzeichnis.
   */
  let leer = '';
  let vorher = '';
  before(() => {
    leer = mkdtempSync(join(tmpdir(), 'clenaris-seed-'));
    vorher = process.cwd();
    process.chdir(leer);
  });
  after(() => {
    process.chdir(vorher);
    rmSync(leer, { recursive: true, force: true });
  });

  const neutral = { NODE_ENV: undefined, CLENARIS_UMGEBUNG: undefined, ALLOW_DEMO_SEED: undefined };

  it('NODE_ENV=production ist ein produktives System — auch mit ALLOW_DEMO_SEED=ja und Testdatenbank', () => {
    mitUmgebung({ ...neutral, NODE_ENV: 'production', ALLOW_DEMO_SEED: 'ja', DATABASE_URL: TEST_DB }, () => {
      assert.equal(produktivesSystem(), true);
      assert.equal(oeffentlicheKontenErlaubt(), false);
    });
  });

  it('CLENARIS_UMGEBUNG=production ohne NODE_ENV ist ebenfalls produktiv', () => {
    mitUmgebung({ ...neutral, CLENARIS_UMGEBUNG: 'production', DATABASE_URL: PROD_DB }, () => {
      assert.equal(oeffentlicheKontenErlaubt(), false);
    });
  });

  it('Entwicklung gegen eine echte Datenbank ohne ALLOW_DEMO_SEED: keine Demokonten', () => {
    mitUmgebung({ ...neutral, DATABASE_URL: PROD_DB }, () => assert.equal(oeffentlicheKontenErlaubt(), false));
  });

  it('Entwicklung gegen die Test- oder Vorschaudatenbank: deterministische Demokonten bleiben', () => {
    mitUmgebung({ ...neutral, DATABASE_URL: TEST_DB }, () => assert.equal(oeffentlicheKontenErlaubt(), true));
    mitUmgebung({ ...neutral, DATABASE_URL: VORSCHAU_DB }, () => assert.equal(oeffentlicheKontenErlaubt(), true));
  });

  it('der Demo-Seed bricht in der Produktion ab — auch mit ALLOW_DEMO_SEED=ja', () => {
    const lauf = spawnSync(process.execPath, [join(WURZEL, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(WURZEL, 'prisma', 'seed-guard.ts')], {
      cwd: leer,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production', ALLOW_DEMO_SEED: 'ja', DATABASE_URL: TEST_DB, CLENARIS_UMGEBUNG: '' },
    });
    assert.equal(lauf.status, 1, lauf.stdout + lauf.stderr);
    assert.match(lauf.stderr, /produktives System/);
  });

  it('der Demo-Seed läuft gegen die Testdatenbank ausserhalb der Produktion weiter', () => {
    const lauf = spawnSync(process.execPath, [join(WURZEL, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(WURZEL, 'prisma', 'seed-guard.ts')], {
      cwd: leer,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'development', ALLOW_DEMO_SEED: '', DATABASE_URL: TEST_DB, CLENARIS_UMGEBUNG: '' },
    });
    assert.equal(lauf.status, 0, lauf.stdout + lauf.stderr);
  });

  it('seed.ts weist in der Produktion das veröffentlichte Startpasswort ab — ohne es auszugeben', () => {
    const lauf = spawnSync(process.execPath, [join(WURZEL, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(WURZEL, 'prisma', 'seed.ts')], {
      cwd: leer,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        CLENARIS_UMGEBUNG: '',
        ALLOW_DEMO_SEED: '',
        DATABASE_URL: PROD_DB,
        DIRECT_URL: PROD_DB,
        SEED_ADMIN_PASSWORD: 'Admin#2026Clenaris',
        SEED_SUPERADMIN_PASSWORD: 'System#2026Clenaris',
      },
    });
    assert.notEqual(lauf.status, 0);
    const ausgabe = lauf.stdout + lauf.stderr;
    assert.match(ausgabe, /öffentlich bekanntes Passwort/);
    assert.ok(!ausgabe.includes('Admin#2026Clenaris') && !ausgabe.includes('System#2026Clenaris'), 'kein Passwort in der Ausgabe');
    assert.ok(!/Organisation:/.test(ausgabe), 'abgebrochen, bevor irgendetwas geschrieben wurde');
  });

  it('seed.ts verlangt ausserhalb eines Wegwerf-Systems eigene Startpasswörter', () => {
    const lauf = spawnSync(process.execPath, [join(WURZEL, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(WURZEL, 'prisma', 'seed.ts')], {
      cwd: leer,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, NODE_ENV: 'production', CLENARIS_UMGEBUNG: '', DATABASE_URL: PROD_DB, DIRECT_URL: PROD_DB, SEED_ADMIN_PASSWORD: '', SEED_SUPERADMIN_PASSWORD: '' },
    });
    assert.notEqual(lauf.status, 0);
    assert.match(lauf.stdout + lauf.stderr, /SEED_ADMIN_PASSWORD fehlt/);
  });
});

// ---------------------------------------------------------------------------
//  3. Produktionsvorprüfung
// ---------------------------------------------------------------------------

const GEHEIM = {
  JWT_SECRET: 'vorpruefung-marker-jwt-0123456789abcdef0123456789',
  CRON_SECRET: 'vorpruefung-marker-cron-0123456789abcdef0123456789',
  ENCRYPTION_KEY: 'c0ffee00'.repeat(8),
  DATABASE_URL: 'postgresql://vorpruefung-nutzer:vorpruefung-marker-dbpw@vorpruefung-db.invalid:5432/clenaris',
  DIRECT_URL: 'postgresql://vorpruefung-nutzer:vorpruefung-marker-dbpw@vorpruefung-db.invalid:5432/clenaris',
  SECURITY_REPORT_TOKEN: 'vorpruefung-marker-bericht-0123456789abcdef012345',
} as const;

const GUTE_UMGEBUNG = {
  ...GEHEIM,
  NODE_ENV: 'production',
  CLENARIS_UMGEBUNG: 'production',
  APP_URL: 'https://clenaris.qasemi.ch',
  NEXT_PUBLIC_SITE_URL: 'https://clenaris.qasemi.ch',
  TRUSTED_PROXY_MODE: 'SINGLE_REVERSE_PROXY',
  CLAMAV_HOST: '127.0.0.1',
  REDIS_URL: 'redis://127.0.0.1:6379',
};

/**
 * Das Release-Verzeichnis, aus dem „gestartet" wird (seit 2026-09-30): ein
 * auslieferbares `RELEASE.json` mit passender `.next/BUILD_ID`. Bis dahin
 * stand in `GUTE_UMGEBUNG` ein `APP_VERSION` mit 40 Zeichen, und die
 * Vorprüfung nahm den Stand damit als „belegt über APP_VERSION" hin — genau
 * der Rückfall, der entfernt wurde. Eine vollständige Produktion hat jetzt
 * ein Artefakt, keine Variable.
 */
const ARTEFAKT = pruefVerzeichnis();
const OHNE_MANIFEST = pruefVerzeichnis({ manifest: null });
/*
  `.env.example` in beide Verzeichnisse: Der Fall „als Kindprozess" läuft mit
  dem Release-Verzeichnis als Arbeitsverzeichnis, und `beispielwerte()` liest
  `.env.example` von dort. Ohne die Kopie verglich der Kindprozess seit dem
  Umzug aus `WURZEL` gegen eine leere Liste — der Abgleich mit den
  Beispielwerten lief als Prozess nirgends mehr, und ein Fehler beim Lesen der
  Datei fiele keinem Fall auf (die reinen Fälle reichen eine leere Liste
  herein). Die Kopie stellt den Stand vor dem Umzug wieder her.
*/
for (const d of [ARTEFAKT, OHNE_MANIFEST]) copyFileSync(join(WURZEL, '.env.example'), join(d, '.env.example'));
after(() => {
  for (const d of [ARTEFAKT, OHNE_MANIFEST]) rmSync(d, { recursive: true, force: true });
});

function fehlerIds(p: Pruefung[]): string[] {
  return p.filter((x) => x.stand === 'FEHLER').map((x) => x.id);
}

describe('Produktionsvorprüfung (rein)', () => {
  const beispiele = new Map<string, string>();

  it('eine vollständige Produktionsumgebung hat keinen Fehler', () => {
    assert.deepEqual(fehlerIds(umgebungPruefen(GUTE_UMGEBUNG, beispiele, ARTEFAKT)), []);
  });

  it('Demozugänge, Demo-Seed, Testkennzeichen und Altdateien sind je ein Fehler', () => {
    const ids = fehlerIds(
      umgebungPruefen(
        {
          ...GUTE_UMGEBUNG,
          ALLOW_DEMO_SEED: 'ja',
          CLENARIS_TEST_CACHE_DIR: '/tmp/x',
          CLENARIS_LEGACY_FILES: 'allow',
          SEED_ADMIN_PASSWORD: 'Admin#2026Clenaris',
          CLENARIS_UMGEBUNG: 'test',
        },
        beispiele,
        ARTEFAKT,
      ),
    );
    for (const id of ['schalter-allow_demo_seed', 'schalter-clenaris_test_cache_dir', 'schalter-clenaris_legacy_files', 'startpasswort-seed_admin_password', 'umgebung']) {
      assert.ok(ids.includes(id), `${id} fehlt in ${ids.join(', ')}`);
    }
  });

  it('bekannte Werte aus CI und Prüfreihe sind keine Produktionsgeheimnisse', () => {
    const ids = fehlerIds(umgebungPruefen({ ...GUTE_UMGEBUNG, JWT_SECRET: 'ci-nur-fuer-den-testlauf-mindestens-32-zeichen', CRON_SECRET: 'ci-cron-secret' }, beispiele, ARTEFAKT));
    assert.ok(ids.includes('geheimnis-jwt_secret') && ids.includes('geheimnis-cron_secret'), ids.join(', '));
  });

  it('eine Testdatenbank, localhost als Herkunft und fehlendes DIRECT_URL sind Fehler', () => {
    const ids = fehlerIds(
      umgebungPruefen({ ...GUTE_UMGEBUNG, DATABASE_URL: TEST_DB, DIRECT_URL: '', APP_URL: 'http://localhost:3000' }, beispiele, ARTEFAKT),
    );
    for (const id of ['datenbank-database_url', 'datenbank-direct_url', 'app-url']) assert.ok(ids.includes(id), id);
  });

  it('eine nackte IP als Herkunft ist ein Fehler (Ursprung an Cloudflare vorbei)', () => {
    assert.ok(fehlerIds(umgebungPruefen({ ...GUTE_UMGEBUNG, APP_URL: 'https://203.0.113.7' }, beispiele, ARTEFAKT)).includes('app-url'));
  });

  it('TRUSTED_PROXY_MODE=CLOUDFLARE ohne bestätigte Ursprungssperre ist ein Fehler; mit Bestätigung nicht', () => {
    assert.ok(fehlerIds(umgebungPruefen({ ...GUTE_UMGEBUNG, TRUSTED_PROXY_MODE: 'CLOUDFLARE' }, beispiele, ARTEFAKT)).includes('proxy'));
    assert.ok(!fehlerIds(umgebungPruefen({ ...GUTE_UMGEBUNG, TRUSTED_PROXY_MODE: 'CLOUDFLARE', CLENARIS_URSPRUNG_NUR_CLOUDFLARE: 'bestaetigt' }, beispiele, ARTEFAKT)).includes('proxy'));
    assert.ok(fehlerIds(umgebungPruefen({ ...GUTE_UMGEBUNG, TRUSTED_PROXY_MODE: 'CLOUDFARE' }, beispiele, ARTEFAKT)).includes('proxy'), 'Tippfehler');
    assert.ok(fehlerIds(umgebungPruefen({ ...GUTE_UMGEBUNG, TRUSTED_PROXY_MODE: '' }, beispiele, ARTEFAKT)).includes('proxy'), 'fehlend');
  });

  it('ohne Scanner kein Start; Release-Ausführer nur mit beiden Zugangsdaten', () => {
    assert.ok(fehlerIds(umgebungPruefen({ ...GUTE_UMGEBUNG, CLAMAV_HOST: '' }, beispiele, ARTEFAKT)).includes('scanner'));
    assert.ok(fehlerIds(umgebungPruefen({ ...GUTE_UMGEBUNG, RELEASE_EXECUTOR_TOKEN: 'x'.repeat(40) }, beispiele, ARTEFAKT)).includes('ausfuehrer'));
    const aus = umgebungPruefen(GUTE_UMGEBUNG, beispiele, ARTEFAKT).find((x) => x.id === 'ausfuehrer');
    assert.equal(aus?.stand, 'OK');
    assert.match(aus!.meldung, /abgeschaltet/);
  });

  it('ohne SECURITY_REPORT_TOKEN bleibt der Eingang zu — Warnung, kein Rückfall auf einen Standardwert', () => {
    const p = umgebungPruefen({ ...GUTE_UMGEBUNG, SECURITY_REPORT_TOKEN: '' }, beispiele, ARTEFAKT).find((x) => x.id === 'sicherheitsmeldung');
    assert.equal(p?.stand, 'WARNUNG');
  });

  // 2026-09-30, Production-V2-Härtung: Die Prüfreihe reicht der Instanz ein
  // festes Manifest herein — in einer Produktion hiesse das, jemand gibt ihr
  // eine Identität vor, die das Artefakt nicht trägt.
  it('CLENARIS_PRUEF_RELEASE_MANIFEST in der Produktion: Fehler', () => {
    assert.ok(
      fehlerIds(umgebungPruefen({ ...GUTE_UMGEBUNG, CLENARIS_PRUEF_RELEASE_MANIFEST: '/tmp/pruef-release.json' }, beispiele, ARTEFAKT)).includes(
        'schalter-clenaris_pruef_release_manifest',
      ),
    );
  });

  it('eigene Besuchsmessung: ohne „an" aus und bestanden, eingeschaltet eine Warnung (Rechtsprüfung TA-02)', () => {
    const aus = umgebungPruefen(GUTE_UMGEBUNG, beispiele, ARTEFAKT).find((x) => x.id === 'besuchsmessung');
    assert.equal(aus?.stand, 'OK');
    const an = umgebungPruefen({ ...GUTE_UMGEBUNG, CLENARIS_BESUCHSMESSUNG: 'an' }, beispiele, ARTEFAKT).find((x) => x.id === 'besuchsmessung');
    assert.equal(an?.stand, 'WARNUNG');
    assert.match(an!.meldung, /TA-02/);
  });

  // 2026-09-30, Production-V2-Härtung: Der Stand wird aus RELEASE.json und
  // BUILD_ID belegt (`src/lib/release/identitaet.ts`), nie mehr aus einer
  // Variablen. Gegen den alten Stand scheitern die ersten zwei Fälle: Ohne
  // RELEASE.json genügte ein APP_VERSION mit 40 Zeichen (Warnung), und die
  // BUILD_ID wurde gar nicht gelesen.
  it('ohne RELEASE.json ist der Stand nicht belegt — APP_VERSION genügt nicht', () => {
    const p = umgebungPruefen({ ...GUTE_UMGEBUNG, APP_VERSION: 'a'.repeat(40) }, beispiele, OHNE_MANIFEST).find((x) => x.id === 'release');
    assert.equal(p?.stand, 'FEHLER');
    assert.match(p!.meldung, /Kein RELEASE\.json/);
    assert.match(p!.meldung, /APP_VERSION genügt nicht/);
  });

  it('BUILD_ID passt nicht zu RELEASE.json: Fehler', () => {
    const d = pruefVerzeichnis({ buildId: 'anderer-bau-0009' });
    try {
      const p = umgebungPruefen(GUTE_UMGEBUNG, beispiele, d).find((x) => x.id === 'release');
      assert.equal(p?.stand, 'FEHLER');
      assert.match(p!.meldung, /BUILD_ID des Baus \(anderer-bau-0009\) weicht von RELEASE\.json/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('Probe, erfundene Auslieferbarkeit und Format 1 sind je ein Fehler', () => {
    const { format: _format, quelleZeitUtc: _zeit, ...ohneFormat } = pruefManifest();
    const faelle: [string, unknown, RegExp][] = [
      ['Probe', pruefManifest({ auslieferbar: false, ci: null }), /auslieferbar=false/],
      // Von Hand auf `true` gesetzt, aber ohne CI-Herkunft: Die Regel
      // (`auslieferbarNach`) entscheidet, nicht das Feld.
      ['erfundene Auslieferbarkeit', pruefManifest({ auslieferbar: true, ci: null }), /erfüllt die Regel aber nicht/],
      ['Format 1', { ...ohneFormat, format: 1, erstelltUtc: '2026-09-28T10:00:00.000Z' }, /Format 1/],
    ];
    for (const [name, manifest, grund] of faelle) {
      const d = pruefVerzeichnis({ manifest });
      try {
        const p = releasePruefen(d, GUTE_UMGEBUNG).find((x) => x.id === 'release');
        assert.equal(p?.stand, 'FEHLER', name);
        assert.match(p!.meldung, grund, name);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it('das Prüfmanifest der Prüfreihe wird von der Vorprüfung nie beachtet — auch nicht in der Umgebung test', () => {
    const pruef = join(OHNE_MANIFEST, 'pruef-release.json');
    writeFileSync(pruef, JSON.stringify(pruefManifest()));
    const p = releasePruefen(OHNE_MANIFEST, { ...GUTE_UMGEBUNG, CLENARIS_UMGEBUNG: 'test', CLENARIS_PRUEF_RELEASE_MANIFEST: pruef }).find(
      (x) => x.id === 'release',
    );
    assert.equal(p?.stand, 'FEHLER');
    assert.match(p!.meldung, /Kein RELEASE\.json/);
  });

  it('ein belegtes, auslieferbares Release besteht und nennt Version, Commit und Build', () => {
    const p = releasePruefen(ARTEFAKT, GUTE_UMGEBUNG).find((x) => x.id === 'release');
    assert.equal(p?.stand, 'OK');
    assert.ok(p!.meldung.includes(PRUEF_ARTEFAKT_COMMIT.slice(0, 12)) && p!.meldung.includes(PRUEF_BUILD_ID), p!.meldung);
  });

  it('--nur-umgebung ist nie ein Bestehen', () => {
    assert.equal(auswerten(umgebungPruefen(GUTE_UMGEBUNG, beispiele, ARTEFAKT), true).code, 3);
    assert.equal(auswerten([{ id: 'x', stand: 'FEHLER', meldung: 'y' }], true).code, 1);
  });

  it('als Kindprozess: kein Geheimnis in der Ausgabe — weder bestanden noch gescheitert', () => {
    const tsx = join(WURZEL, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const skript = join(WURZEL, 'scripts', 'production-preflight.ts');
    // Das Arbeitsverzeichnis ist das Release-Verzeichnis, wie auf dem Server:
    // Die Vorprüfung liest `RELEASE.json` und `.next/BUILD_ID` von dort.
    // Der dritte Fall zeigt dasselbe wie oben als Prozess: Ohne Manifest
    // rettet auch ein gesetztes APP_VERSION den Start nicht mehr.
    // Anders als auf dem Server liegt hier `.env.example` bei (siehe oben):
    // Das Artefakt schliesst jede `.env*` aus, dort greift allein das
    // Platzhaltermuster in `istBekannterWert` — es erkennt heute jeden
    // Beispielwert der Datei, der Abgleich ist die zweite Sicherung.
    for (const [env, erwartet, cwd] of [
      [GUTE_UMGEBUNG, 3, ARTEFAKT],
      [{ ...GUTE_UMGEBUNG, ALLOW_DEMO_SEED: 'ja', TRUSTED_PROXY_MODE: 'CLOUDFLARE', JWT_SECRET: 'zu-kurz-marker' }, 1, ARTEFAKT],
      [{ ...GUTE_UMGEBUNG, APP_VERSION: 'a'.repeat(40) }, 1, OHNE_MANIFEST],
    ] as const) {
      const lauf = spawnSync(process.execPath, [tsx, skript, '--nur-umgebung', '--ohne-dotenv'], {
        cwd,
        encoding: 'utf8',
        // Bewusst **nicht** `...process.env`: Die Vorprüfung soll nur sehen,
        // was hier steht — keine örtliche Konfiguration, die einen Fall grün
        // oder rot färbt.
        env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...env } as NodeJS.ProcessEnv,
      });
      assert.equal(lauf.status, erwartet, lauf.stdout + lauf.stderr);
      const ausgabe = lauf.stdout + lauf.stderr;
      for (const wert of [...Object.values(GEHEIM), 'zu-kurz-marker', 'vorpruefung-marker-dbpw']) {
        assert.ok(!ausgabe.includes(wert), `Ausgabe enthält einen Wert: ${wert.slice(0, 14)}…`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
//  4. Migrations-Verträglichkeit
// ---------------------------------------------------------------------------

describe('Migrations-Verträglichkeit (rein)', () => {
  const alt = new Set(['bookings', 'users']);

  it('DROP COLUMN und RENAME sind BRECHEND', () => {
    assert.equal(migrationEinstufen('m', 'ALTER TABLE "bookings" DROP COLUMN "x";', alt).einstufung, 'BRECHEND');
    assert.equal(migrationEinstufen('m', 'ALTER TABLE "bookings" RENAME COLUMN "a" TO "b";', alt).einstufung, 'BRECHEND');
  });

  it('neue Pflichtspalte ohne DEFAULT auf bestehender Tabelle verlangt den Programmwechsel', () => {
    assert.equal(migrationEinstufen('m', 'ALTER TABLE "users" ADD COLUMN "x" TEXT NOT NULL;', alt).einstufung, 'PROGRAMMWECHSEL');
    assert.equal(migrationEinstufen('m', 'ALTER TABLE "users" ADD COLUMN "x" TEXT NOT NULL DEFAULT \'a\';', alt).einstufung, 'RUECKWAERTSVERTRAEGLICH');
  });

  it('Schranken auf einer Tabelle, die dieselbe Migration anlegt, sind harmlos', () => {
    const sql = 'CREATE TABLE "neu" ("id" TEXT NOT NULL); CREATE UNIQUE INDEX "i" ON "neu"("id"); ALTER TABLE "neu" ADD CONSTRAINT "c" CHECK (true);';
    assert.equal(migrationEinstufen('m', sql, alt).einstufung, 'RUECKWAERTSVERTRAEGLICH');
  });

  it('das Tor weist eine nicht durchgesehene Migration und eine unbegründete Milderung ab', () => {
    const befunde = [migrationEinstufen('neu', 'ALTER TABLE "bookings" DROP COLUMN "x";', alt)];
    assert.equal(torPruefen(befunde, { stand: '', migrationen: {} }).fehler.length, 1);
    assert.equal(torPruefen(befunde, { stand: '', migrationen: { neu: { einstufung: 'RUECKWAERTSVERTRAEGLICH' } } }).fehler.length, 1);
    assert.equal(
      torPruefen(befunde, { stand: '', migrationen: { neu: { einstufung: 'RUECKWAERTSVERTRAEGLICH', begruendung: 'Spalte seit zwei Releases ungelesen' } } }).fehler.length,
      0,
    );
  });

  it('die Reihe im Repository ist vollständig durchgesehen', () => {
    const ergebnis = torPruefen(reiheEinstufen(join(WURZEL, 'prisma', 'migrations')), registerLesen(join(WURZEL, 'security', 'migrations-vertraeglichkeit.json')));
    assert.deepEqual(ergebnis.fehler, []);
  });

  it('eine offene Migration ohne Durchsicht gilt als BRECHEND', () => {
    assert.equal(strengsteEinstufung(['unbekannt'], { stand: '', migrationen: {} }), 'BRECHEND');
  });
});

// ---------------------------------------------------------------------------
//  5. Über HTTP: eine Produktionsinstanz ohne Prüfkennzeichen
// ---------------------------------------------------------------------------

function testdatenbankAdresse(): string | null {
  if (!process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL) loadEnvConfig(WURZEL, false, { info: () => {}, error: () => {} });
  const explizit = process.env.TEST_DATABASE_URL;
  const roh = explizit ?? process.env.DATABASE_URL;
  if (!roh) return null;
  let adresse = roh;
  if (!explizit) {
    const url = new URL(roh);
    const name = url.pathname.replace(/^\//, '');
    if (!name.endsWith('_test')) url.pathname = `/${name}_test`;
    adresse = url.toString();
  }
  return istTestdatenbank(databaseNameOf(adresse)) ? adresse : null;
}

function freierPort(): Promise<number> {
  return new Promise((ok, fehler) => {
    const server = createServer();
    server.once('error', fehler);
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      server.close(() => ok(port));
    });
  });
}

/** Neue Verbindung je Anfrage — siehe `laufzeit-konfiguration.test.ts`. */
function anfrage(port: number, pfad: string, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((ok, fehler) => {
    const daten = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: pfad,
        method: daten ? 'POST' : 'GET',
        agent: false,
        headers: daten ? { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'content-length': Buffer.byteLength(daten) } : {},
      },
      (res) => {
        let text = '';
        res.on('data', (d: Buffer) => (text += d.toString()));
        res.on('end', () => ok({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', fehler);
    if (daten) req.write(daten);
    req.end();
  });
}

describe('Anmeldung mit veröffentlichtem Passwort: Produktion weist ab, Prüfserver nicht', () => {
  const DIST = process.env.NEXT_DIST_DIR?.trim() || '.next';
  const bau = ['BUILD_ID', 'routes-manifest.json', 'prerender-manifest.json'].every((d) => existsSync(join(WURZEL, DIST, d)));
  const datenbank = testdatenbankAdresse();
  const grund = !bau ? `kein vollständiger Bau in ${DIST}` : !datenbank ? 'keine Testdatenbank' : null;

  let prozess: ChildProcess | null = null;
  let port = 0;
  let cacheDir = '';
  const protokoll: string[] = [];

  before(async () => {
    if (grund) return;
    port = await freierPort();
    cacheDir = mkdtempSync(join(tmpdir(), 'clenaris-produktion-'));
    prozess = spawn(process.execPath, [join(WURZEL, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(port), '-H', '127.0.0.1'], {
      cwd: WURZEL,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEXT_DIST_DIR: DIST,
        DATABASE_URL: datenbank!,
        DIRECT_URL: datenbank!,
        APP_URL: `http://127.0.0.1:${port}`,
        NEXT_PUBLIC_APP_URL: '',
        TRUSTED_PROXY_MODE: 'NONE',
        // Das ist der Punkt dieser Instanz: **kein** Prüfkennzeichen. Leer
        // statt weggelassen, damit `next start` es nicht aus `.env` nachlädt.
        CLENARIS_UMGEBUNG: '',
        // Nur für die Rate-Limit-Zähler als Dateien; die Anmeldesperre für
        // veröffentlichte Passwörter fragt dieses Merkmal nicht.
        CLENARIS_TEST_CACHE_DIR: cacheDir,
        RESEND_API_KEY: '',
        REDIS_URL: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    prozess.stdout?.on('data', (d: Buffer) => protokoll.push(d.toString()));
    prozess.stderr?.on('data', (d: Buffer) => protokoll.push(d.toString()));
    const bis = Date.now() + 90_000;
    while (Date.now() < bis) {
      if (prozess.exitCode !== null) break;
      try {
        if ((await anfrage(port, '/api/health')).status === 200) return;
      } catch {
        /* noch nicht bereit */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Produktionsinstanz kam nicht hoch:\n${protokoll.join('').slice(-3000)}`);
  });

  after(async () => {
    prozess?.kill();
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
    await testDbSchliessen();
  });

  it('die Produktionsinstanz weist die Betriebsleitung mit dem Demopasswort ab (401) und meldet es', async (t) => {
    if (grund) {
      if (IM_CI) assert.fail(`Nachweis im CI Pflicht: ${grund}`);
      t.skip(grund);
      return;
    }
    const seit = new Date();
    const antwort = await anfrage(port, '/api/auth/login', { email: ACCOUNTS.manager.email, password: ACCOUNTS.manager.password });
    assert.equal(antwort.status, 401, antwort.text);
    assert.match(antwort.text, /E-Mail-Adresse oder Passwort ist falsch/, 'dieselbe Meldung wie beim falschen Passwort — kein Orakel');
    assert.ok(!/clenaris_at=/.test(antwort.text));

    const db = testDb();
    if (db) {
      const ereignis = await db.securityEvent.findFirst({
        where: { kind: 'LOGIN_BLOCKED', occurredAt: { gte: seit }, summary: { contains: 'öffentlich bekannten Passwort' } },
        select: { summary: true },
      });
      assert.ok(ereignis, 'die Abweisung steht im Sicherheitszentrum');
      assert.ok(!ereignis.summary.includes(ACCOUNTS.manager.password), 'ohne das Passwort');
      const konto = await db.user.findUnique({ where: { email: ACCOUNTS.manager.email }, select: { failedLoginCount: true, lockedUntil: true } });
      assert.equal(konto?.lockedUntil, null, 'die Inhaberin wird dadurch nicht ausgesperrt');
    }
  });

  it('der Prüfserver (CLENARIS_UMGEBUNG=test, Testdatenbank) lässt dieselbe Anmeldung zu', async () => {
    await requireServer();
    const antwort = await post('/api/auth/login', { email: ACCOUNTS.manager.email, password: ACCOUNTS.manager.password });
    assert.equal(antwort.status, 200);
  });
});
