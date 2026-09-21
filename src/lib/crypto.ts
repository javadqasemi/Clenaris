import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

import { serverEnv } from '@/lib/env';

/**
 * Verschlüsselung besonders schützenswerter Felder — AES-256-GCM.
 *
 * ---------------------------------------------------------------------------
 *  Warum es das gibt
 * ---------------------------------------------------------------------------
 *
 * Drei Spalten tragen Werte, die ein Datenbankabzug nicht preisgeben darf:
 *
 *   • `User.twoFactorSecret` — wer es hat, erzeugt für jedes Konto gültige
 *     zweite Faktoren. Ein Klartext-Geheimnis macht die Zwei-Faktor-Anmeldung
 *     zu einer Zierde.
 *   • `Employee.ahvNumber` — eindeutige Personenkennung, nach DSG besonders
 *     schützenswert.
 *   • `Property.alarmCode` — physischer Zugang zu fremden Wohnungen und Büros.
 *
 * Das Schema behauptete die Verschlüsselung seit der ersten Migration und
 * verwies auf dieses Modul; es existierte nur nicht. Das ist gefährlicher als
 * ein fehlender Kommentar: Wer die Datei liest, hält die Frage für beantwortet.
 *
 * ---------------------------------------------------------------------------
 *  Was hier *nicht* geschützt wird
 * ---------------------------------------------------------------------------
 *
 * Gegen jemanden, der die laufende Anwendung samt Umgebung kontrolliert, hilft
 * das nichts — der Schlüssel liegt im selben Prozess. Geschützt ist genau das,
 * was in der Praxis abhandenkommt: eine Sicherungskopie, ein Datenbankabzug
 * für die Fehlersuche, ein versehentlich offener Pooler. Das ist ein
 * eingeschränktes, aber reales Schutzversprechen — und es ist das einzige, das
 * eine Anwendung ohne Hardware-Schlüsselspeicher halten kann.
 *
 * Passwörter gehören *nicht* hierher: die werden gehasht (`auth/password.ts`),
 * nicht verschlüsselt. Verschlüsselt wird nur, was die Anwendung im Klartext
 * zurückbrauchen muss.
 *
 * ---------------------------------------------------------------------------
 *  Format
 * ---------------------------------------------------------------------------
 *
 *     enc:v1:<base64(iv ‖ authTag ‖ ciphertext)>
 *
 * Das Präfix trägt eine Fassungsnummer, damit ein späterer Wechsel des
 * Verfahrens den Bestand nicht entwertet: `decrypt()` kann dann beide lesen.
 *
 * Ein Wert **ohne** Präfix gilt als Altbestand im Klartext und wird
 * unverändert zurückgegeben. Das ist bewusst: Die Einführung darf keine
 * Datenmigration erzwingen und keine Anmeldung brechen. Jeder Wert wandert
 * beim nächsten Schreiben von selbst ins neue Format — bei 2FA also beim
 * nächsten Einrichten, bei der AHV-Nummer bei der nächsten Änderung.
 *
 * Ein Skript, das den Bestand sofort umstellt, gibt es **nicht**. Hier stand
 * ein Verweis auf `scripts/encrypt-existing.ts`; die Datei existierte nie.
 * Der Verweis ist gefährlicher als sein Fehlen: Wer ihn liest, hält die Frage
 * für beantwortet und plant eine Umstellung ein, die niemand geschrieben hat.
 * Dasselbe gilt für die Schlüsselrotation weiter unten.
 *
 * ---------------------------------------------------------------------------
 *  Schlüssel
 * ---------------------------------------------------------------------------
 *
 * `ENCRYPTION_KEY` (32 Byte als 64 Hex-Zeichen) ist der vorgesehene Weg.
 * Fehlt er, wird der Schlüssel über HKDF-SHA256 aus `JWT_SECRET` abgeleitet —
 * nicht, weil das gleichwertig wäre, sondern weil die Alternative schlechter
 * ist: Ein harter Abbruch beim ersten Start nach der Auslieferung hiesse, dass
 * eine Sicherheitsverbesserung die Anwendung umwirft. HKDF trennt den
 * abgeleiteten Schlüssel kryptografisch vom Signaturschlüssel, sodass der eine
 * den anderen nicht preisgibt.
 *
 * **Betrieblich wichtig:** Ohne gesetzten `ENCRYPTION_KEY` hängen die
 * verschlüsselten Felder an `JWT_SECRET`. Wer den wechselt, macht sie
 * unlesbar — betroffen wären die zweiten Faktoren (neu einrichten), die
 * AHV-Nummern und die Alarmcodes. `docs/DEPLOYMENT.md` sagt ohnehin, dass
 * `JWT_SECRET` nicht rotiert wird; mit gesetztem `ENCRYPTION_KEY` ist die
 * Frage endgültig entkoppelt.
 */

const PREFIX = 'enc:v1:';
const IV_BYTES = 12; // GCM-Norm: 96 Bit
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;

  const configured = process.env.ENCRYPTION_KEY?.trim();
  if (configured) {
    if (!/^[0-9a-fA-F]{64}$/.test(configured)) {
      throw new Error(
        'ENCRYPTION_KEY muss 64 Hex-Zeichen (32 Byte) lang sein — erzeugen mit: openssl rand -hex 32',
      );
    }
    cachedKey = Buffer.from(configured, 'hex');
    return cachedKey;
  }

  /**
   * `hkdfSync` liefert einen `ArrayBuffer`; `Buffer.from` übernimmt ihn ohne
   * Kopie. Das `info`-Feld bindet die Ableitung an diesen Zweck: Derselbe
   * `JWT_SECRET` ergäbe mit einem anderen `info` einen anderen Schlüssel.
   */
  const derived = hkdfSync('sha256', serverEnv().JWT_SECRET, 'clenaris-feldverschluesselung', 'aes-256-gcm-v1', 32);
  cachedKey = Buffer.from(derived);
  return cachedKey;
}

/** Nur für Tests: erzwingt, dass der Schlüssel neu gelesen wird. */
export function resetEncryptionKeyCache(): void {
  cachedKey = null;
}

/**
 * Ein zweckgebundenes Geheimnis aus dem Wurzelschlüssel ableiten.
 *
 * **Warum nicht der Wurzelschlüssel selbst.** `ENCRYPTION_KEY` ist der
 * AES-Schlüssel der Feldverschlüsselung. Ihn zusätzlich als HMAC-Schlüssel
 * für Einmalcodes zu verwenden hiesse, ein Geheimnis in zwei Konstruktionen
 * zu stecken — und eine Schwäche in der einen träfe die andere. HKDF mit
 * einem eigenen `info` (dem Kontext) ergibt je Zweck einen anderen
 * Schlüssel, aus dem sich der Wurzelschlüssel nicht zurückrechnen lässt.
 *
 * Der Kontext ist Teil des Namens (`…-v1`), damit ein späterer Wechsel des
 * Verfahrens einen neuen Schlüssel bekommt, statt den alten umzudeuten.
 */
export function deriveSecret(context: string, bytes = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', key(), 'clenaris-abgeleitet', context, bytes));
}

/** Ist dieser Wert bereits verschlüsselt? */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * Verschlüsselt einen Wert.
 *
 * `context` wandert als zusätzliche authentifizierte Daten (AAD) in die
 * Berechnung. Damit lässt sich ein Chiffrat nicht von einer Spalte in eine
 * andere verschieben: Ein in `users.two_factor_secret` geschriebener Wert
 * entschlüsselt in `employees.ahv_number` nicht, weil die AAD nicht passt.
 * Ohne AAD wäre genau das ein lautloser Angriff mit reinem Datenbankzugriff.
 */
export function encrypt(plaintext: string, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/**
 * Entschlüsselt einen Wert — oder gibt ihn unverändert zurück, wenn er aus dem
 * Klartext-Altbestand stammt (siehe Kopfkommentar).
 *
 * Ein Wert *mit* Präfix, der sich nicht entschlüsseln lässt, wirft dagegen.
 * Das ist Absicht: Dieser Fall bedeutet einen falschen Schlüssel oder
 * manipulierte Daten, und beides still zu übergehen — etwa mit `null` — hiesse,
 * eine Zwei-Faktor-Anmeldung stillschweigend abzuschalten.
 */
export function decrypt(stored: string, context: string): string {
  if (!isEncrypted(stored)) return stored;

  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new Error('Verschlüsselter Wert ist unvollständig.');
  }

  const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Bequemlichkeit für Felder, die `null` sein dürfen — und das sind alle drei.
 * Ein leerer String wird zu `null`: Ein Chiffrat von "" wäre ein Wert, der wie
 * einer aussieht und keiner ist.
 */
export function encryptNullable(value: string | null | undefined, context: string): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : encrypt(trimmed, context);
}

export function decryptNullable(value: string | null | undefined, context: string): string | null {
  if (value === null || value === undefined) return null;
  return decrypt(value, context);
}

/**
 * Namen der AAD-Kontexte an einer Stelle.
 *
 * Sie stehen fest verdrahtet hier und nicht als Zeichenkette an der
 * Verwendungsstelle: Ein Tippfehler im Kontext macht ein Chiffrat unlesbar,
 * und zwar erst beim Entschlüsseln — also Wochen später.
 */
/**
 * SHA-256 als Hexzeichenkette.
 *
 * Für zwei Dinge gedacht, die beide *keine* Passwörter sind: das Ablegen von
 * Zugriffstokens (`PublicAccessToken.tokenHash`) und der Integritätsnachweis
 * über Dateibytes.
 *
 * **Warum hier kein Argon2.** Ein Passwort ist kurz und von Menschen
 * gewählt — dagegen hilft nur ein absichtlich langsames Verfahren mit Salz.
 * Ein Token aus 32 Zufallsbytes hat 256 Bit Entropie; es lässt sich nicht
 * erraten, auch nicht mit einer Regenbogentabelle, und ein Salz brächte
 * nichts ausser dass die Suche über den Hash nicht mehr in einem Index läge.
 * Genau dieselbe Überlegung steht hinter `RefreshToken.tokenHash`.
 */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export const CRYPTO_CONTEXT = {
  twoFactorSecret: 'user.twoFactorSecret',
  ahvNumber: 'employee.ahvNumber',
  alarmCode: 'property.alarmCode',
} as const;
