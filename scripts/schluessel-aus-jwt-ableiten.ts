/**
 * Den aus `JWT_SECRET` abgeleiteten Feldschlüssel als Hexwert in eine Datei
 * schreiben — für die Schlüsselmigration nach einem Vorfall.
 *
 *   ALT_JWT_SECRET=… npx tsx scripts/schluessel-aus-jwt-ableiten.ts <zieldatei>
 *
 * ---------------------------------------------------------------------------
 *  Wozu
 * ---------------------------------------------------------------------------
 *
 * Fehlt `ENCRYPTION_KEY`, leitet `src/lib/crypto.ts` den Feldschlüssel über
 * HKDF aus `JWT_SECRET` ab. Die verschlüsselten Felder (TOTP-Geheimnis,
 * AHV-Nummer, IBAN, Alarmcode) hängen dann am `JWT_SECRET` — und genau der
 * wird nach dem Notfallauftrag vom 2026-09-27 rotiert. Ein blindes Rotieren
 * machte diese Felder unlesbar.
 *
 * `docs/KEY_MANAGEMENT.md` hielt fest, der abgeleitete Schlüssel lasse sich
 * nicht in `ENCRYPTION_KEY_PREVIOUS` eintragen. Er lässt sich — man muss ihn
 * nur mit denselben Parametern ableiten. Das tut dieses Skript, und nichts
 * sonst:
 *
 *   1. alter abgeleiteter Schlüssel → diese Datei → `ENCRYPTION_KEY_PREVIOUS`
 *   2. neuer `ENCRYPTION_KEY` (openssl rand -hex 32), neuer `JWT_SECRET`
 *   3. `scripts/rotate-encryption-key.ts` schlüsselt jeden Wert um
 *   4. `--status` bis alles auf dem neuen Schlüssel steht, dann
 *      `ENCRYPTION_KEY_PREVIOUS` und diese Datei entfernen
 *
 * **Nie auf die Konsole:** Der Wert ist ein Schlüssel. Er geht in eine Datei
 * mit Modus 600, die es vorher nicht geben darf, und das Skript meldet nur die
 * Schlüsselkennung (die ersten acht Hexzeichen seiner SHA-256 — dieselbe
 * Kennung, die `enc:v2:<kid>:` in der Datenbank trägt). So lässt sich prüfen,
 * dass es der richtige ist, ohne ihn zu zeigen.
 *
 * Der alte `JWT_SECRET` kommt aus `ALT_JWT_SECRET`, nicht aus `JWT_SECRET`:
 * Wer dieses Skript in einer Umgebung aufruft, die schon den neuen Wert trägt,
 * soll nicht versehentlich den neuen ableiten.
 */

import { createHash, hkdfSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

function main(): void {
  const ziel = process.argv[2];
  if (!ziel) throw new Error('Zieldatei fehlt: npx tsx scripts/schluessel-aus-jwt-ableiten.ts <zieldatei>');
  if (existsSync(ziel)) throw new Error('Die Zieldatei existiert bereits — nichts überschrieben.');
  const alt = process.env.ALT_JWT_SECRET;
  if (!alt || alt.length < 32) throw new Error('ALT_JWT_SECRET fehlt oder ist kürzer als 32 Zeichen.');

  // Dieselben Parameter wie `bund()` in `src/lib/crypto.ts` — ändern sie sich
  // dort, stimmt diese Ableitung nicht mehr (`schluesselrotation.test.ts`
  // prüft beide gegeneinander).
  const bytes = Buffer.from(hkdfSync('sha256', alt, 'clenaris-feldverschluesselung', 'aes-256-gcm-v1', 32));
  writeFileSync(ziel, `${bytes.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  const kid = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  console.log(`Abgeleiteter Schlüssel geschrieben (Kennung ${kid}). Datei nach der Migration löschen.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Abgebrochen.');
  process.exit(1);
}
