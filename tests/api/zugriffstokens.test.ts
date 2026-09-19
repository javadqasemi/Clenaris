import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { sha256Hex } from '../../src/lib/crypto';
import { randomToken } from '../../src/lib/auth/jwt';

/**
 * Öffentliche Zugriffstokens — die Eigenschaften, auf die es ankommt.
 *
 * Dritte Datei neben `bi-rechenkerne` und `verschluesselung`, die
 * Anwendungscode direkt importiert, und aus demselben Grund: Entropie und
 * Hashing sind reine Rechnung. Über HTTP liesse sich nur beobachten, dass ein
 * Link funktioniert — nicht, dass er unerratbar *ist*.
 *
 * Der Anlass steht in `access-token.service.ts`: `Quote.publicToken` war ein
 * cuid, und die Route dazu behauptete, das sei „unerratbar". Diese Datei hält
 * den Unterschied fest, damit die Behauptung nie wieder ohne Substanz
 * dasteht.
 */

describe('Öffentliche Zugriffstokens — Erzeugung und Hashing', () => {
  it('liefert 256 Bit aus dem Zufallsgenerator', () => {
    const roh = randomToken(32);
    assert.equal(roh.length, 64, '32 Byte hexadezimal');
    assert.match(roh, /^[0-9a-f]{64}$/, 'URL-sicher ohne weitere Kodierung');
  });

  it('erzeugt keinen gemeinsamen Präfix — anders als cuid', () => {
    /**
     * Der eigentliche Befund in Zahlen. cuid v1 beginnt mit `c` und einem
     * Zeitstempel; zwei kurz nacheinander erzeugte Werte teilen deshalb einen
     * langen Kopf. Ein Zufallstoken teilt im Erwartungswert kein Zeichen.
     *
     * Geprüft wird über 200 Werte: Dass davon *alle* im ersten Zeichen
     * übereinstimmen, hat eine Wahrscheinlichkeit von 16^-199 — das passiert
     * nicht zufällig, sondern nur, wenn jemand die Erzeugung kaputt macht.
     */
    const werte = Array.from({ length: 200 }, () => randomToken(32));
    let gemeinsam = 0;
    while (gemeinsam < werte[0]!.length && werte.every((w) => w[gemeinsam] === werte[0]![gemeinsam])) {
      gemeinsam++;
    }
    assert.equal(gemeinsam, 0, `kein gemeinsamer Präfix, gefunden: ${gemeinsam} Zeichen`);
  });

  it('erzeugt keine Wiederholungen', () => {
    const werte = new Set(Array.from({ length: 500 }, () => randomToken(32)));
    assert.equal(werte.size, 500);
  });

  it('nutzt das volle Hexalphabet', () => {
    const zeichen = new Set(Array.from({ length: 50 }, () => randomToken(32)).join(''));
    assert.equal(zeichen.size, 16, 'alle 16 Hexziffern kommen vor');
  });

  it('hasht stabil und einwegig', () => {
    const roh = randomToken(32);
    const hash = sha256Hex(roh);

    assert.equal(hash.length, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(sha256Hex(roh), hash, 'derselbe Wert ergibt denselben Hash');
    assert.notEqual(hash, roh, 'der Hash ist nicht der Token');
    assert.ok(!hash.includes(roh.slice(0, 16)), 'der Hash verrät den Anfang nicht');
  });

  it('ergibt für zwei Tokens zwei Hashes', () => {
    assert.notEqual(sha256Hex(randomToken(32)), sha256Hex(randomToken(32)));
  });

  it('ändert den Hash bei einem einzigen abweichenden Zeichen vollständig', () => {
    const a = 'a'.repeat(64);
    const b = `${'a'.repeat(63)}b`;
    const hashA = sha256Hex(a);
    const hashB = sha256Hex(b);

    let gleich = 0;
    for (let i = 0; i < hashA.length; i++) if (hashA[i] === hashB[i]) gleich++;
    // Bei 64 Hexzeichen sind im Erwartungswert 4 zufällig gleich. Mehr als
    // ein Drittel wäre ein Hinweis auf eine kaputte Ableitung.
    assert.ok(gleich < 22, `zu viele übereinstimmende Stellen: ${gleich}`);
  });
});
