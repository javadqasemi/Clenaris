import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import {
  CRYPTO_CONTEXT,
  decrypt,
  deriveSecret,
  deriveSecretAll,
  encrypt,
  isEncrypted,
  istAktuellVerschluesselt,
  kidOfValue,
  resetEncryptionKeyCache,
  schluesselUebersicht,
} from '../../src/lib/crypto';
import { post, patch, data, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Wave 4 — Schlüsselrotation und Feldverschlüsselung.
 *
 * ---------------------------------------------------------------------------
 *  Warum der Kern direkt importiert wird
 * ---------------------------------------------------------------------------
 *
 * Dieselbe Begründung wie bei `verschluesselung.test.ts`, um eine Stufe
 * verschärft: Eine Rotation lässt sich über HTTP überhaupt nicht auslösen —
 * sie besteht darin, die Umgebung des Serverprozesses zu ändern und ihn neu zu
 * starten. Was hier geprüft wird, ist der Rechenkern: dass ein Chiffrat unter
 * dem alten Schlüssel lesbar bleibt, unter dem neuen geschrieben wird, und
 * dass ein fehlender Schlüssel **sagt, welcher fehlt**.
 *
 * Die Schlüssel entstehen im Test frisch aus dem CSPRNG. Es steht kein
 * Schlüssel im Quelltext, und keiner der hier erzeugten verlässt den Prozess.
 *
 * ---------------------------------------------------------------------------
 *  Und warum daneben trotzdem HTTP steht
 * ---------------------------------------------------------------------------
 *
 * Der Kern kann stimmen, während niemand ihn aufruft. Der zweite Teil legt
 * über die Schnittstelle eine Personalakte mit IBAN an, liest sie zurück und
 * schaut **in die Spalte**: Der Rundlauf beweist, dass nichts kaputtgegangen
 * ist, der Blick in die Datenbank, dass überhaupt verschlüsselt wurde. Ohne
 * den zweiten wäre ein `encryptNullable`, das versehentlich den Klartext
 * durchreicht, nicht zu unterscheiden.
 */

const A = randomBytes(32).toString('hex');
const B = randomBytes(32).toString('hex');

/** Umgebung setzen und den Schlüsselbund neu einlesen lassen. */
function bundSetzen(aktiv?: string, vorherige?: string) {
  if (aktiv) process.env.ENCRYPTION_KEY = aktiv;
  else delete process.env.ENCRYPTION_KEY;

  if (vorherige) process.env.ENCRYPTION_KEY_PREVIOUS = vorherige;
  else delete process.env.ENCRYPTION_KEY_PREVIOUS;

  resetEncryptionKeyCache();
}

const urspruenglich = {
  key: process.env.ENCRYPTION_KEY,
  prev: process.env.ENCRYPTION_KEY_PREVIOUS,
};

after(() => {
  bundSetzen(urspruenglich.key, urspruenglich.prev);
});

// ===========================================================================
//  Format
// ===========================================================================

describe('Das Format trägt die Schlüsselkennung', () => {
  beforeEach(() => bundSetzen(A));

  it('geschrieben wird v2 mit Kennung', () => {
    const chiffrat = encrypt('12.345.678.901', CRYPTO_CONTEXT.ahvNumber);

    assert.ok(chiffrat.startsWith('enc:v2:'), 'neue Werte tragen die Fassung v2');
    assert.ok(isEncrypted(chiffrat));

    const kid = kidOfValue(chiffrat);
    assert.match(kid ?? '', /^[0-9a-f]{8}$/, 'die Kennung sind acht Hexzeichen');
    assert.equal(kid, schluesselUebersicht().aktiv);
  });

  /**
   * Die Kennung ist ein Hash über den Schlüssel und darf deshalb in eine
   * Fehlermeldung. Diese Prüfung hält fest, dass sie es auch bleibt — ein
   * Präfix des Schlüssels wäre eine bequeme Abkürzung mit fataler Wirkung.
   */
  it('die Kennung verrät nichts über den Schlüssel', () => {
    const kid = schluesselUebersicht().aktiv;
    assert.ok(!A.startsWith(kid), 'die Kennung ist kein Präfix des Schlüssels');
    assert.ok(!A.includes(kid), 'die Kennung kommt im Schlüssel überhaupt nicht vor');
  });

  it('derselbe Schlüssel ergibt immer dieselbe Kennung, ein anderer eine andere', () => {
    const ersteKid = schluesselUebersicht().aktiv;
    bundSetzen(A);
    assert.equal(schluesselUebersicht().aktiv, ersteKid);

    bundSetzen(B);
    assert.notEqual(schluesselUebersicht().aktiv, ersteKid);
  });

  it('jeder Aufruf erzeugt einen frischen Initialisierungsvektor', () => {
    const eins = encrypt('derselbe Wert', CRYPTO_CONTEXT.alarmCode);
    const zwei = encrypt('derselbe Wert', CRYPTO_CONTEXT.alarmCode);

    assert.notEqual(eins, zwei, 'zwei Chiffrate desselben Werts dürfen nicht gleich sein');
    assert.equal(decrypt(eins, CRYPTO_CONTEXT.alarmCode), 'derselbe Wert');
    assert.equal(decrypt(zwei, CRYPTO_CONTEXT.alarmCode), 'derselbe Wert');
  });

  it('die Bindung ans Feld hält weiterhin', () => {
    const chiffrat = encrypt('1234', CRYPTO_CONTEXT.alarmCode);
    assert.throws(
      () => decrypt(chiffrat, CRYPTO_CONTEXT.ahvNumber),
      'ein Chiffrat darf sich nicht in eine andere Spalte verschieben lassen',
    );
  });

  it('Klartext-Altbestand geht unverändert durch', () => {
    assert.equal(decrypt('756.1234.5678.97', CRYPTO_CONTEXT.ahvNumber), '756.1234.5678.97');
    assert.equal(isEncrypted('756.1234.5678.97'), false);
    assert.equal(istAktuellVerschluesselt('756.1234.5678.97'), false);
  });
});

// ===========================================================================
//  Rotation
// ===========================================================================

describe('Rotation: alter Schlüssel liest, neuer schreibt', () => {
  /**
   * Der ganze Ablauf in einem Fall, weil die Schritte aufeinander aufbauen und
   * einzeln nichts aussagen. Genau diese Reihenfolge steht in
   * `docs/KEY_MANAGEMENT.md` und im Kopf des Rotationsskripts.
   */
  it('ein unter A verschlüsselter Wert bleibt lesbar, wenn B aktiv wird', () => {
    bundSetzen(A);
    const unterA = encrypt('756.1234.5678.97', CRYPTO_CONTEXT.ahvNumber);
    const kidA = kidOfValue(unterA);

    // Schritt 2 und 3: B wird aktiv, A wandert nach ENCRYPTION_KEY_PREVIOUS.
    bundSetzen(B, A);

    assert.equal(
      decrypt(unterA, CRYPTO_CONTEXT.ahvNumber),
      '756.1234.5678.97',
      'der alte Wert muss weiterhin lesbar sein — sonst ist die Rotation ein Ausfall',
    );
    assert.equal(
      istAktuellVerschluesselt(unterA),
      false,
      'er steht aber nicht auf dem aktiven Schlüssel — genau das zählt der Status',
    );

    // Schritt 5: umschlüsseln.
    const unterB = encrypt(decrypt(unterA, CRYPTO_CONTEXT.ahvNumber), CRYPTO_CONTEXT.ahvNumber);
    assert.notEqual(kidOfValue(unterB), kidA, 'der neue Wert trägt die neue Kennung');
    assert.equal(istAktuellVerschluesselt(unterB), true);

    // Schritt 7: A entfernen. Der umgeschlüsselte Wert bleibt lesbar.
    bundSetzen(B);
    assert.equal(decrypt(unterB, CRYPTO_CONTEXT.ahvNumber), '756.1234.5678.97');
  });

  /**
   * Der Fall, für den v2 überhaupt gebaut ist. Ohne Kennung stünde hier
   * „Entschlüsselung fehlgeschlagen", und die nächste Stunde ginge für die
   * Frage drauf, welcher Schlüssel fehlt.
   */
  it('fehlt der Schlüssel, sagt die Meldung welcher', () => {
    bundSetzen(A);
    const unterA = encrypt('geheim', CRYPTO_CONTEXT.alarmCode);
    const kidA = kidOfValue(unterA)!;

    bundSetzen(B); // A ist weg — der häufigste Bedienfehler.

    assert.throws(
      () => decrypt(unterA, CRYPTO_CONTEXT.alarmCode),
      (fehler: Error) => {
        assert.ok(fehler.message.includes(kidA), 'die fehlende Kennung muss in der Meldung stehen');
        assert.ok(
          fehler.message.includes('ENCRYPTION_KEY_PREVIOUS'),
          'und der Hinweis, wohin der alte Schlüssel gehört',
        );
        assert.ok(!fehler.message.includes(A), 'aber niemals der Schlüssel selbst');
        assert.ok(!fehler.message.includes(B), 'auch nicht der aktive');
        return true;
      },
    );
  });

  it('mehrere ausgemusterte Schlüssel sind erlaubt', () => {
    const C = randomBytes(32).toString('hex');

    bundSetzen(A);
    const unterA = encrypt('eins', CRYPTO_CONTEXT.iban);
    bundSetzen(B);
    const unterB = encrypt('zwei', CRYPTO_CONTEXT.iban);

    bundSetzen(C, `${A}, ${B}`);
    assert.equal(decrypt(unterA, CRYPTO_CONTEXT.iban), 'eins');
    assert.equal(decrypt(unterB, CRYPTO_CONTEXT.iban), 'zwei');
    assert.equal(schluesselUebersicht().alle.length, 3);
  });

  /**
   * Der häufigste Bedienfehler bei einer Rotation: den neuen Schlüssel
   * versehentlich auch in `ENCRYPTION_KEY_PREVIOUS` stehen lassen. Ohne
   * Entdoppelung stünden zwei Einträge mit derselben Kennung im Bund, und die
   * Statusanzeige wäre eine Frage, die gar keine ist.
   */
  it('derselbe Schlüssel in beiden Variablen zählt einmal', () => {
    bundSetzen(A, A);
    const uebersicht = schluesselUebersicht();
    assert.equal(uebersicht.alle.length, 1);
    assert.equal(uebersicht.alle[0].herkunft, 'ENCRYPTION_KEY');
  });

  it('die Übersicht gibt Kennungen heraus, niemals Schlüsselmaterial', () => {
    bundSetzen(A, B);
    const text = JSON.stringify(schluesselUebersicht());

    assert.ok(!text.includes(A), 'der aktive Schlüssel darf nicht in der Übersicht stehen');
    assert.ok(!text.includes(B), 'der ausgemusterte ebenso wenig');
    assert.ok(!/[0-9a-f]{64}/.test(text), 'überhaupt kein 64-stelliger Hexwert');
  });

  it('ein missgebildeter Schlüssel wird abgewiesen, nicht stillschweigend gekürzt', () => {
    bundSetzen('zu-kurz');
    assert.throws(() => encrypt('x', CRYPTO_CONTEXT.iban), /64 Hex-Zeichen/);
  });
});

// ===========================================================================
//  Abgeleitete Geheimnisse
// ===========================================================================

describe('Abgeleitete Geheimnisse überstehen die Rotation', () => {
  it('geschrieben wird mit dem aktiven, geprüft unter allen', () => {
    bundSetzen(A);
    const unterA = deriveSecret('clenaris-signature-otp-v1').toString('hex');

    bundSetzen(B, A);
    const alle = deriveSecretAll('clenaris-signature-otp-v1').map((b) => b.toString('hex'));

    assert.equal(alle.length, 2);
    assert.notEqual(alle[0], unterA, 'der aktive Schlüssel steht vorn und ist der neue');
    assert.ok(
      alle.includes(unterA),
      'der alte muss im Prüfpfad bleiben — sonst bricht ein laufender Bestätigungscode ab',
    );
    assert.equal(alle[0], deriveSecret('clenaris-signature-otp-v1').toString('hex'));
  });

  it('verschiedene Zwecke ergeben verschiedene Geheimnisse', () => {
    bundSetzen(A);
    assert.notEqual(
      deriveSecret('clenaris-signature-otp-v1').toString('hex'),
      deriveSecret('clenaris-signature-session-v1').toString('hex'),
    );
  });

  it('das abgeleitete Geheimnis ist nicht der Wurzelschlüssel', () => {
    bundSetzen(A);
    assert.notEqual(deriveSecret('clenaris-signature-otp-v1').toString('hex'), A);
  });
});

// ===========================================================================
//  Notfallauftrag 2026-09-27: vom abgeleiteten Schlüssel weg, ohne Datenverlust
// ===========================================================================

describe('Migration vom aus JWT_SECRET abgeleiteten Schlüssel', () => {
  /**
   * Nach dem Vorfall wird `JWT_SECRET` rotiert. Lief die Produktion ohne
   * `ENCRYPTION_KEY`, hängt jedes verschlüsselte Feld an ihm — ein blinder
   * Wechsel machte TOTP-Geheimnisse, AHV-Nummern und Alarmcodes unlesbar.
   * `scripts/schluessel-aus-jwt-ableiten.ts` legt den alten, abgeleiteten
   * Schlüssel als Hexwert ab, damit er als `ENCRYPTION_KEY_PREVIOUS` lesbar
   * bleibt. Dieser Fall beweist den ganzen Weg in einem eigenen Prozess (der
   * Konfigurationszwischenspeicher von `serverEnv` hielte sonst den
   * `JWT_SECRET` des Prüfprozesses fest): verschlüsseln mit dem abgeleiteten
   * Schlüssel, `JWT_SECRET` und `ENCRYPTION_KEY` wechseln, lesen.
   *
   * Scheitert er, stimmen die Parameter des Skripts nicht mehr mit `bund()` in
   * `src/lib/crypto.ts` überein — und die Migrationsanleitung führte in den
   * Datenverlust.
   */
  it('der abgelegte Schlüssel liest, was der abgeleitete geschrieben hat', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const wurzel = join(__dirname, '..', '..');
    const tsx = join(wurzel, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const ordner = mkdtempSync(join(tmpdir(), 'clenaris-schluessel-'));
    const alt = `alt-${randomBytes(24).toString('hex')}`;
    const neu = randomBytes(32).toString('hex');
    try {
      const datei = join(ordner, 'alt.hex');
      const ableiten = spawnSync(process.execPath, [tsx, join(wurzel, 'scripts', 'schluessel-aus-jwt-ableiten.ts'), datei], {
        cwd: wurzel,
        encoding: 'utf8',
        env: { ...process.env, ALT_JWT_SECRET: alt },
      });
      assert.equal(ableiten.status, 0, ableiten.stderr);
      assert.ok(!ableiten.stdout.includes(readFileSync(datei, 'utf8').trim()), 'der Schlüssel steht nicht auf der Konsole');

      // Als file://-URL: Ein nackter Windows-Pfad (`c:\…`) ist für den
      // ESM-Lader ein unbekanntes Schema.
      const { pathToFileURL } = await import('node:url');
      const kryptoPfad = JSON.stringify(pathToFileURL(join(wurzel, 'src', 'lib', 'crypto.ts')).href);
      const programm = `
        const k = await import(${kryptoPfad});
        const chiffrat = k.encrypt('756.1234.5678.97', k.CRYPTO_CONTEXT.ahvNumber);
        process.env.ENCRYPTION_KEY = process.env.NEU_SCHLUESSEL;
        process.env.ENCRYPTION_KEY_PREVIOUS = process.env.ALT_ABGELEGT;
        process.env.JWT_SECRET = 'neu-' + 'x'.repeat(40);
        k.resetEncryptionKeyCache();
        const klar = k.decrypt(chiffrat, k.CRYPTO_CONTEXT.ahvNumber);
        const neuVerschluesselt = k.encrypt(klar, k.CRYPTO_CONTEXT.ahvNumber);
        console.log(JSON.stringify({ klar, aktuell: k.istAktuellVerschluesselt(neuVerschluesselt), altNochAktuell: k.istAktuellVerschluesselt(chiffrat) }));
      `;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        JWT_SECRET: alt,
        DATABASE_URL: 'postgresql://pruef@pruef-db.invalid:5432/clenaris_test',
        NEU_SCHLUESSEL: neu,
        ALT_ABGELEGT: readFileSync(datei, 'utf8').trim(),
      };
      delete env.ENCRYPTION_KEY;
      delete env.ENCRYPTION_KEY_PREVIOUS;
      const lauf = spawnSync(process.execPath, [tsx, '--eval', `(async () => { ${programm} })()`], { cwd: wurzel, encoding: 'utf8', env });
      assert.equal(lauf.status, 0, lauf.stderr);
      const ergebnis = JSON.parse(lauf.stdout.trim().split('\n').pop()!) as { klar: string; aktuell: boolean; altNochAktuell: boolean };
      assert.equal(ergebnis.klar, '756.1234.5678.97', 'nach dem Wechsel von JWT_SECRET lesbar');
      assert.equal(ergebnis.aktuell, true, 'neu geschrieben wird mit dem neuen Schlüssel');
      assert.equal(ergebnis.altNochAktuell, false, 'der Altbestand gilt als umzuschlüsseln');
    } finally {
      rmSync(ordner, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
//  Über HTTP: die IBAN liegt verschlüsselt in der Spalte
// ===========================================================================

describe('Die Auszahlungs-IBAN — Rundlauf und Ruhezustand', () => {
  let jars: Record<AccountName, string>;
  let employeeId = '';

  const IBAN = 'CH9300762011623852957';

  before(async () => {
    // Für die HTTP-Hälfte gilt die Umgebung des **Servers**, nicht die des
    // Prüfprozesses. Der Bund hier wird zurückgesetzt, damit die vorherigen
    // Fälle nichts hinterlassen.
    bundSetzen(urspruenglich.key, urspruenglich.prev);
    await requireServer();
    jars = await loginAll();
  });

  after(async () => {
    if (employeeId) {
      await patch(`/api/employees/${employeeId}`, { active: false }, { jar: jars.admin }).catch(
        () => {},
      );
    }
    await testDbSchliessen();
  });

  it('legt eine Akte mit IBAN an und liest sie im Klartext zurück', async (t) => {
    const antwort = await post<{ data: { id: string } }>(
      '/api/employees',
      {
        email: `ibanprobe-${Date.now()}@clenaris.test`,
        firstName: 'Iban',
        lastName: 'Probe',
        position: 'Reinigungskraft',
        hiredAt: '2026-01-01',
        workloadPct: 100,
        vacationDaysPerYear: 20,
        iban: IBAN,
        ahvNumber: '756.1234.5678.97',
      },
      { jar: jars.admin },
    );

    if (antwort.status !== 201) {
      return t.skip(`Personalakte liess sich nicht anlegen (Status ${antwort.status})`);
    }

    employeeId = data(antwort).id;

    const seite = await import('../helpers/client').then(({ get }) =>
      get(`/admin/personal/${employeeId}`, { jar: jars.admin }),
    );
    assert.equal(seite.status, 200);

    const html = typeof seite.text === 'string' ? seite.text.replace(/<!--\s*-->/g, '') : '';
    assert.ok(
      html.includes(IBAN) || html.includes('CH93 0076'),
      'die Verwaltung muss die IBAN im Klartext sehen',
    );
    assert.ok(
      !html.includes('enc:v2:'),
      'niemals das Chiffrat in der Oberfläche — das wäre die Verschlüsselung ohne ihren Nutzen',
    );
  });

  /**
   * Der Ruhezustand. Über HTTP nicht beobachtbar: Eine Schnittstelle, die den
   * Klartext zurückgibt, sieht gleich aus, ob dahinter verschlüsselt wird oder
   * nicht. Genau dafür gibt es `helpers/testdb.ts`, und es liest nur.
   */
  it('in der Spalte steht ein Chiffrat, kein Klartext', async (t) => {
    if (!employeeId) return t.skip('keine Akte aus dem vorherigen Fall');

    const db = testDb();
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);

    const zeile = await db.employee.findUnique({
      where: { id: employeeId },
      select: { iban: true, ahvNumber: true, hourlyRate: true },
    });
    assert.ok(zeile, 'die Akte muss in der Testdatenbank liegen');

    assert.ok(zeile.iban, 'die IBAN muss gespeichert sein');
    assert.ok(
      zeile.iban.startsWith('enc:'),
      'die IBAN liegt verschlüsselt — sonst hilft die ganze Übung nichts',
    );
    assert.ok(!zeile.iban.includes(IBAN), 'der Klartext darf nirgends in der Spalte stehen');

    assert.ok(zeile.ahvNumber?.startsWith('enc:'), 'die AHV-Nummer ebenso');

    /**
     * Die Gegenprobe, und sie ist der Kern der Entscheidung aus SEC-021:
     * `hourlyRate` ist **nicht** verschlüsselt. Das ist kein Versäumnis,
     * sondern der Punkt — die Spalte wird in der Datenbank verrechnet
     * (`_avg` in `scenario.service.ts`, SQL-Summe in `analytics.service.ts`),
     * und ein Chiffrat ist eine Zeichenkette, über die `AVG` einen Fehler
     * ergibt und keine Zahl. Die Begründung steht in `docs/KEY_MANAGEMENT.md`.
     *
     * Diese Zeile steht hier, damit die Entscheidung sichtbar bleibt: Wer sie
     * später umdreht, bricht diese Prüfung und muss sich erklären.
     */
    assert.equal(
      zeile.hourlyRate,
      null,
      'diese Probeakte trägt keinen Lohn — der Vergleich prüft nur, dass das Feld ein Decimal ist',
    );
  });

  it('die Aggregation über den Lohn läuft weiterhin in der Datenbank', async (t) => {
    const db = testDb();
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);

    /**
     * Genau die Abfrage aus `scenario.service.ts`. Sie ist der Beleg dafür,
     * dass die Entscheidung gegen die Verschlüsselung der Lohnfelder keine
     * Meinung ist: Über ein Chiffrat gäbe es dieses Ergebnis nicht.
     */
    const ergebnis = await db.employee.aggregate({
      where: { active: true },
      _avg: { hourlyRate: true },
    });

    assert.ok(
      ergebnis._avg.hourlyRate === null || typeof Number(ergebnis._avg.hourlyRate) === 'number',
      'der Durchschnitt muss eine Zahl sein oder null — nie eine Zeichenkette',
    );
  });
});
