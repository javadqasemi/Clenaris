import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  dateiname,
  sicherungsverzeichnis,
  sichern,
  aufraeumen,
  verbindungAus,
  werkzeugPfad,
} from '../../scripts/db-backup.js';
import { eindeutigkeitenAus, spaltenAusBedingung } from '../../scripts/migration-preflight.js';

/**
 * Die Datenbanksicherung vor einer Migration — die reine Rechnung.
 *
 * **Warum das hier steht und nicht über HTTP läuft.** Die übrigen Prüfungen
 * dieses Projekts fahren die laufende Anwendung an, weil dort die
 * Berechtigungen sitzen. Die Sicherung ist aber kein Endpunkt: Sie läuft auf
 * dem Server, bevor die Anwendung neu startet, und ihre Zusicherungen sind
 * Bedingungen, keine Statuscodes — dieselbe Ausnahme wie bei
 * `bi-rechenkerne` und `verschluesselung`.
 *
 * **Was hier bewiesen wird.** Vor allem, dass sie in jedem Zweifelsfall
 * **abbricht**. Eine Sicherung, die bei einem Fehler trotzdem „fertig" meldet,
 * ist schlimmer als keine: Sie lässt die Migration laufen und nimmt dem
 * Rückweg die Grundlage. Die Fälle unten sind deshalb überwiegend
 * Fehlerfälle.
 *
 * Ein echter `pg_dump` gegen eine echte Datenbank steht nicht hier — dafür
 * gibt es den Lauf gegen `clenaris_preview` samt Wiederherstellung
 * (`scripts/db-restore-verify.ts`). Hier geht es um die Logik darum herum.
 */

const tempOrdner = () => mkdtempSync(join(tmpdir(), 'clenaris-sicherung-'));

// ---------------------------------------------------------------------------
//  Verbindung: nichts Geheimes nach draussen
// ---------------------------------------------------------------------------

describe('Die Verbindung wird zerlegt, nicht weitergereicht', () => {
  it('trennt Host, Port, Benutzer, Passwort und Datenbank', () => {
    const v = verbindungAus('postgresql://max:geheim%2B17@db.example.ch:6543/clenaris?schema=public');
    assert.equal(v.host, 'db.example.ch');
    assert.equal(v.port, '6543');
    assert.equal(v.user, 'max');
    assert.equal(v.password, 'geheim+17', 'prozentkodierte Zeichen werden aufgelöst');
    assert.equal(v.database, 'clenaris');
  });

  it('nennt in der Beschreibung niemals Benutzer oder Passwort', () => {
    const v = verbindungAus('postgresql://max:sehr-geheim@db.example.ch:6543/clenaris');
    assert.equal(v.beschreibung, 'db.example.ch:6543/clenaris');
    assert.doesNotMatch(v.beschreibung, /sehr-geheim/);
    assert.doesNotMatch(v.beschreibung, /max/);
  });

  it('weist eine Adresse ohne Datenbanknamen ab', () => {
    assert.throws(() => verbindungAus('postgresql://max:geheim@db.example.ch:6543/'), /keine Datenbank/i);
  });
});

// ---------------------------------------------------------------------------
//  Dateiname und Ablageort
// ---------------------------------------------------------------------------

describe('Der Dateiname', () => {
  const zeitpunkt = new Date('2026-09-20T21:19:18.860Z');

  it('trägt Datum, UTC-Zeit und den Auslieferungsstand', () => {
    const name = dateiname(zeitpunkt, '4eb385f2b0320a57d0aadf4986d719ad5713ef83');
    assert.match(name, /^clenaris_2026-09-20T21-19-18-860Z_4eb385f2b032\.dump$/);
  });

  it('übernimmt keinen Wert ungeprüft in den Pfad', () => {
    for (const boshaft of ['../../etc/passwd', 'a; rm -rf /', '..\\..\\windows', '']) {
      const name = dateiname(zeitpunkt, boshaft);
      assert.match(name, /^clenaris_[0-9TZ-]+_ohne-commit\.dump$/, `abgewiesen: ${boshaft}`);
      assert.doesNotMatch(name, /[/\\;]/, 'kein Pfad- oder Befehlstrenner im Namen');
    }
  });
});

describe('Der Ablageort', () => {
  it('liegt ausserhalb des Anwendungsverzeichnisses', () => {
    const app = join(tmpdir(), 'irgendwo', 'clenaris', 'app');
    const ziel = sicherungsverzeichnis(app);
    assert.ok(!ziel.startsWith(app), `„${ziel}" darf nicht in „${app}" liegen`);
    assert.match(ziel, /backups/);
  });

  it('lässt sich über die Umgebung festlegen', () => {
    const vorher = process.env.CLENARIS_BACKUP_DIR;
    process.env.CLENARIS_BACKUP_DIR = join(tmpdir(), 'eigener-ort');
    try {
      assert.equal(sicherungsverzeichnis('/beliebig'), join(tmpdir(), 'eigener-ort'));
    } finally {
      if (vorher === undefined) delete process.env.CLENARIS_BACKUP_DIR;
      else process.env.CLENARIS_BACKUP_DIR = vorher;
    }
  });
});

// ---------------------------------------------------------------------------
//  Abbruch in jedem Zweifelsfall
// ---------------------------------------------------------------------------

describe('Die Sicherung bricht ab, statt etwas Unbrauchbares zu hinterlassen', () => {
  /**
   * Ein Werkzeug, das es nirgends gibt — weder im `PATH`, noch unter `PG_BIN`,
   * noch in einer Windows-Installation. `pg_dump` selbst taugt dafür nicht:
   * Auf einem Arbeitsplatz mit installiertem PostgreSQL findet der
   * Rückfallpfad es auch ohne `PATH`, und das ist Absicht — sonst liesse sich
   * dieser Mechanismus örtlich gar nicht prüfen, bevor er Production anfasst.
   */
  it('bei fehlendem Werkzeug', () => {
    assert.throws(() => werkzeugPfad('pg_dump_gibt_es_nicht'), /wurde nicht gefunden/i);
  });

  it('bei einer Datenbank, die es nicht gibt', () => {
    const ordner = tempOrdner();
    try {
      assert.throws(
        () =>
          sichern({
            // Ein Port, auf dem nichts lauscht: Die Versionsabfrage scheitert,
            // und zwar bevor irgendetwas geschrieben wird.
            url: 'postgresql://niemand:nichts@127.0.0.1:1/gibt-es-nicht',
            verzeichnis: ordner,
            commit: 'abcdef1234567890',
            protokoll: () => undefined,
          }),
        /./,
        'eine unerreichbare Datenbank muss zum Abbruch führen',
      );
      assert.equal(readdirSync(ordner).length, 0, 'und darf keine Datei hinterlassen');
    } finally {
      rmSync(ordner, { recursive: true, force: true });
    }
  });

  it('meldet keinen Zugang in der Fehlermeldung', () => {
    const ordner = tempOrdner();
    const passwort = 'streng-geheimes-passwort';
    try {
      sichern({
        url: `postgresql://max:${passwort}@127.0.0.1:1/gibt-es-nicht`,
        verzeichnis: ordner,
        commit: 'abcdef1234567890',
        protokoll: () => undefined,
      });
      assert.fail('hätte abbrechen müssen');
    } catch (fehler) {
      const text = fehler instanceof Error ? `${fehler.message}\n${fehler.stack ?? ''}` : String(fehler);
      assert.doesNotMatch(text, new RegExp(passwort), 'das Passwort darf nirgends auftauchen');
    } finally {
      rmSync(ordner, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
//  Aufbewahrung
// ---------------------------------------------------------------------------

describe('Die Aufbewahrung räumt vorsichtig', () => {
  function ordnerMit(namen: string[]): string {
    const ordner = tempOrdner();
    namen.forEach((n, i) => {
      const pfad = join(ordner, n);
      writeFileSync(pfad, 'x');
      // Älter machen, je weiter hinten in der Liste.
      const zeit = new Date(Date.now() - i * 86_400_000);
      utimesSync(pfad, zeit, zeit);
    });
    return ordner;
  }

  it('behält die jüngsten und entfernt nur ältere', () => {
    const namen = ['clenaris_e.dump', 'clenaris_d.dump', 'clenaris_c.dump', 'clenaris_b.dump', 'clenaris_a.dump'];
    const ordner = ordnerMit(namen);
    try {
      const entfernt = aufraeumen(ordner, 2, join(ordner, 'clenaris_e.dump'));
      assert.deepEqual(entfernt.sort(), ['clenaris_a.dump', 'clenaris_b.dump', 'clenaris_c.dump']);
      assert.deepEqual(readdirSync(ordner).sort(), ['clenaris_d.dump', 'clenaris_e.dump']);
    } finally {
      rmSync(ordner, { recursive: true, force: true });
    }
  });

  it('löscht die neue Sicherung nie — auch nicht bei einer Obergrenze von null', () => {
    const ordner = ordnerMit(['clenaris_neu.dump', 'clenaris_alt.dump']);
    try {
      aufraeumen(ordner, 0, join(ordner, 'clenaris_neu.dump'));
      assert.ok(readdirSync(ordner).includes('clenaris_neu.dump'), 'die geschützte Datei bleibt');
    } finally {
      rmSync(ordner, { recursive: true, force: true });
    }
  });

  it('fasst nichts an, was nicht wie eine Sicherung heisst', () => {
    const ordner = ordnerMit([
      'clenaris_a.dump',
      'clenaris_b.dump',
      'clenaris_c.dump',
      'wichtig.txt',
      'notizen.dump.txt',
      '.env',
    ]);
    try {
      aufraeumen(ordner, 1, join(ordner, 'clenaris_a.dump'));
      const rest = readdirSync(ordner);
      for (const fremd of ['wichtig.txt', 'notizen.dump.txt', '.env']) {
        assert.ok(rest.includes(fremd), `${fremd} darf nicht entfernt werden`);
      }
    } finally {
      rmSync(ordner, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
//  Migrations-Vorprüfung: erkennt sie, was sie erkennen muss?
// ---------------------------------------------------------------------------

describe('Die Migrations-Vorprüfung liest die Eindeutigkeiten aus den Migrationen', () => {
  it('findet einen gewöhnlichen eindeutigen Index', () => {
    const treffer = eindeutigkeitenAus(
      'probe',
      'CREATE UNIQUE INDEX "file_assets_storedFileId_key" ON "file_assets"("storedFileId");',
    );
    assert.equal(treffer.length, 1);
    assert.equal(treffer[0]!.tabelle, 'file_assets');
    assert.deepEqual(treffer[0]!.spalten, ['storedFileId']);
    assert.equal(treffer[0]!.bedingung, null);
  });

  it('findet einen Teilindex samt Bedingung', () => {
    const treffer = eindeutigkeitenAus(
      'probe',
      `CREATE UNIQUE INDEX "x" ON "signature_requests" ("quoteId")
         WHERE "quoteId" IS NOT NULL AND "status" IN ('DRAFT', 'PENDING');`,
    );
    assert.equal(treffer.length, 1);
    assert.match(treffer[0]!.bedingung ?? '', /status/);
    assert.deepEqual(spaltenAusBedingung(treffer[0]!.bedingung).sort(), ['quoteId', 'status']);
  });

  it('übersieht einen auskommentierten Index', () => {
    assert.equal(eindeutigkeitenAus('probe', '-- CREATE UNIQUE INDEX "x" ON "y"("z");').length, 0);
  });

  it('findet eine Eindeutigkeit als Tabellenbedingung', () => {
    const treffer = eindeutigkeitenAus('probe', 'ALTER TABLE "a" ADD CONSTRAINT "a_b_key" UNIQUE ("b", "c");');
    assert.equal(treffer.length, 1);
    assert.deepEqual(treffer[0]!.spalten, ['b', 'c']);
  });

  /**
   * Der Fall, wegen dem es die Vorprüfung gibt: `file_assets` ist eine
   * **bestehende** Tabelle, und `datei_integritaet` verlangt dort
   * Eindeutigkeit. Findet der Leser diese Bedingung nicht, prüft die
   * Auslieferung genau das nicht, worauf es ankommt.
   */
  it('findet die Eindeutigkeit auf der bestehenden Tabelle `file_assets`', () => {
    const sql = readFileSync(
      join(process.cwd(), 'prisma', 'migrations', '20260919190000_datei_integritaet', 'migration.sql'),
      'utf8',
    );
    const treffer = eindeutigkeitenAus('20260919190000_datei_integritaet', sql);
    const aufFileAssets = treffer.find((t) => t.tabelle === 'file_assets');
    assert.ok(aufFileAssets, 'die Bedingung auf file_assets muss gefunden werden');
    assert.deepEqual(aufFileAssets.spalten, ['storedFileId']);
  });

  it('findet die drei Teilindizes der Signaturmigrationen', () => {
    const namen: string[] = [];
    for (const m of ['20260920100000_signatur_kern', '20260920160000_offert_annahme_eindeutig', '20260920190000_vor_ort_abnahme']) {
      const sql = readFileSync(join(process.cwd(), 'prisma', 'migrations', m, 'migration.sql'), 'utf8');
      namen.push(...eindeutigkeitenAus(m, sql).map((t) => t.name));
    }
    for (const erwartet of [
      'signature_requests_offene_annahme_je_offerte',
      'signature_requests_offene_abnahme_je_einsatz',
      'device_handoff_sessions_eine_aktive_je_familie',
    ]) {
      assert.ok(namen.includes(erwartet), `${erwartet} fehlt`);
    }
  });
});
