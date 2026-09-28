import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CRYPTO_CONTEXT,
  decrypt,
  decryptNullable,
  encrypt,
  encryptNullable,
  isEncrypted,
  resetEncryptionKeyCache,
} from '../../src/lib/crypto';

/**
 * Feldverschlüsselung — AES-256-GCM mit festem Verhalten.
 *
 * Zweite Datei neben `bi-rechenkerne.test.ts`, die Anwendungscode direkt
 * importiert, und aus demselben Grund: Das hier sind reine Funktionen. Über
 * HTTP liesse sich nur beobachten, dass ein Wert zurückkommt — nicht, dass er
 * verschlüsselt *hinging*, dass der Kontext bindet und dass Altbestand im
 * Klartext lesbar bleibt. Genau diese drei Eigenschaften tragen die
 * Einführung; brechen sie, sperrt sich jede Person mit zweitem Faktor aus.
 *
 * Der Schlüssel wird für diesen Lauf festgesetzt, damit das Ergebnis nicht an
 * der Umgebung hängt.
 */

process.env.ENCRYPTION_KEY = 'a'.repeat(64);
resetEncryptionKeyCache();

describe('Feldverschlüsselung', () => {
  it('verschlüsselt und entschlüsselt verlustfrei', () => {
    const wert = '756.1234.5678.97';
    const chiffrat = encrypt(wert, CRYPTO_CONTEXT.ahvNumber);

    assert.ok(isEncrypted(chiffrat), 'trägt das Präfix');
    assert.ok(!chiffrat.includes(wert), 'der Klartext steht nicht mehr drin');
    assert.equal(decrypt(chiffrat, CRYPTO_CONTEXT.ahvNumber), wert);
  });

  it('erzeugt für denselben Wert zwei verschiedene Chiffrate', () => {
    // Ohne frischen Initialisierungsvektor verriete die Datenbank, welche
    // zwei Personen denselben Alarmcode haben.
    const a = encrypt('1234', CRYPTO_CONTEXT.alarmCode);
    const b = encrypt('1234', CRYPTO_CONTEXT.alarmCode);
    assert.notEqual(a, b);
    assert.equal(decrypt(a, CRYPTO_CONTEXT.alarmCode), decrypt(b, CRYPTO_CONTEXT.alarmCode));
  });

  it('bindet das Chiffrat an seine Spalte', () => {
    // Ein in die eine Spalte geschriebener Wert darf in einer anderen nicht
    // aufgehen — sonst wäre das Verschieben eines Chiffrats mit reinem
    // Datenbankzugriff ein lautloser Angriff.
    const chiffrat = encrypt('123456', CRYPTO_CONTEXT.twoFactorSecret);
    assert.throws(() => decrypt(chiffrat, CRYPTO_CONTEXT.alarmCode));
  });

  it('erkennt Manipulation am Chiffrat', () => {
    const chiffrat = encrypt('geheim', CRYPTO_CONTEXT.alarmCode);
    const roh = Buffer.from(chiffrat.slice('enc:v1:'.length), 'base64');
    roh[roh.length - 1] ^= 0xff;
    assert.throws(() => decrypt(`enc:v1:${roh.toString('base64')}`, CRYPTO_CONTEXT.alarmCode));
  });

  it('lässt Altbestand im Klartext unverändert durch', () => {
    // Die Einführung darf keine Datenmigration erzwingen: Ein Wert ohne
    // Präfix stammt aus der Zeit davor und muss weiter lesbar sein, sonst
    // wäre die erste Anmeldung nach der Auslieferung die letzte.
    const alt = 'JBSWY3DPEHPK3PXP';
    assert.equal(isEncrypted(alt), false);
    assert.equal(decrypt(alt, CRYPTO_CONTEXT.twoFactorSecret), alt);
  });

  it('behandelt leer und fehlend als «kein Wert»', () => {
    assert.equal(encryptNullable(null, CRYPTO_CONTEXT.alarmCode), null);
    assert.equal(encryptNullable(undefined, CRYPTO_CONTEXT.alarmCode), null);
    assert.equal(encryptNullable('   ', CRYPTO_CONTEXT.alarmCode), null);
    assert.equal(decryptNullable(null, CRYPTO_CONTEXT.alarmCode), null);
  });

  it('schneidet Leerraum weg, bevor es verschlüsselt', () => {
    const chiffrat = encryptNullable('  1234  ', CRYPTO_CONTEXT.alarmCode);
    assert.ok(chiffrat);
    assert.equal(decrypt(chiffrat, CRYPTO_CONTEXT.alarmCode), '1234');
  });

  it('weist einen Schlüssel falscher Länge zurück', () => {
    const vorher = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'zukurz';
    resetEncryptionKeyCache();
    assert.throws(() => encrypt('x', CRYPTO_CONTEXT.alarmCode), /64 Hex-Zeichen/);
    process.env.ENCRYPTION_KEY = vorher;
    resetEncryptionKeyCache();
  });

  it('kommt mit Umlauten und Sonderzeichen zurecht', () => {
    const wert = 'Türcode: 1234#ä — Hintereingang';
    assert.equal(
      decrypt(encrypt(wert, CRYPTO_CONTEXT.alarmCode), CRYPTO_CONTEXT.alarmCode),
      wert,
    );
  });
});
