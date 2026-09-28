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
 *     enc:v1:<base64(iv ‖ authTag ‖ ciphertext)>            — Altbestand, lesbar
 *     enc:v2:<kid>:<base64(iv ‖ authTag ‖ ciphertext)>      — wird geschrieben
 *
 * **Warum v2 eine Schlüsselkennung trägt.** v1 sagt nicht, mit welchem
 * Schlüssel es verschlüsselt wurde. Solange es nur einen gibt, fällt das nicht
 * auf; sobald rotiert wird, fehlt genau die Auskunft, auf die es ankommt:
 *
 *  • *Ist die Rotation fertig?* Ohne Kennung lässt sich das nicht beantworten
 *    — man kann nur alles blind neu verschlüsseln und hoffen.
 *  • *Warum geht dieser eine Wert nicht auf?* Mit Kennung: „Schlüssel a1b2c3d4
 *    ist nicht konfiguriert." Ohne: „Entschlüsselung fehlgeschlagen."
 *
 * Die Kennung sind die ersten acht Hexzeichen des SHA-256 über die
 * Schlüsselbytes. Sie ist damit ohne Konfiguration stabil und verrät nichts:
 * Aus einem Hash über 256 Zufallsbits lässt sich der Schlüssel nicht
 * zurückrechnen, und acht Zeichen reichen, um zwei bis drei gleichzeitig
 * gültige Schlüssel auseinanderzuhalten.
 *
 * Ein Wert **ohne** Präfix gilt als Altbestand im Klartext und wird
 * unverändert zurückgegeben. Das ist bewusst: Die Einführung darf keine
 * Datenmigration erzwingen und keine Anmeldung brechen.
 *
 * ---------------------------------------------------------------------------
 *  Schlüsselbund
 * ---------------------------------------------------------------------------
 *
 * `ENCRYPTION_KEY` (32 Byte als 64 Hex-Zeichen) ist der **aktive** Schlüssel.
 * Mit ihm wird geschrieben, und nur mit ihm.
 *
 * `ENCRYPTION_KEY_PREVIOUS` nimmt einen oder mehrere **ausgemusterte**
 * Schlüssel auf, durch Komma getrennt. Mit ihnen wird ausschliesslich gelesen.
 * Das ist die ganze Rotation: neuen Schlüssel aktiv setzen, alten nach
 * `ENCRYPTION_KEY_PREVIOUS` schieben, Bestand umschlüsseln
 * (`scripts/rotate-encryption-key.ts`), alten Schlüssel entfernen.
 *
 * Ohne diesen Lesepfad wäre eine Rotation ein Ausfall: In dem Moment, in dem
 * der neue Schlüssel aktiv wird, wäre jeder vorhandene Wert unlesbar — die
 * zweiten Faktoren aller Konten, alle AHV-Nummern, alle Alarmcodes. Man
 * *könnte* vorher umschlüsseln, aber dann gäbe es einen Zeitraum, in dem der
 * Bestand schon neu und die Anwendung noch alt ist. Es gibt keine Reihenfolge,
 * die ohne zweiten Lesepfad funktioniert.
 *
 * Fehlt `ENCRYPTION_KEY` ganz, wird der Schlüssel über HKDF-SHA256 aus
 * `JWT_SECRET` abgeleitet — nicht, weil das gleichwertig wäre, sondern weil
 * die Alternative schlechter ist: Ein harter Abbruch beim ersten Start nach
 * der Auslieferung hiesse, dass eine Sicherheitsverbesserung die Anwendung
 * umwirft. HKDF trennt den abgeleiteten Schlüssel kryptografisch vom
 * Signaturschlüssel, sodass der eine den anderen nicht preisgibt.
 *
 * **Betrieblich wichtig:** Ohne gesetzten `ENCRYPTION_KEY` hängen die
 * verschlüsselten Felder an `JWT_SECRET`. Wer den wechselt, macht sie
 * unlesbar. `docs/DEPLOYMENT.md` sagt ohnehin, dass `JWT_SECRET` nicht rotiert
 * wird; mit gesetztem `ENCRYPTION_KEY` ist die Frage endgültig entkoppelt.
 * Der ganze Ablauf steht in `docs/KEY_MANAGEMENT.md`.
 */

const PREFIX_V1 = 'enc:v1:';
const PREFIX_V2 = 'enc:v2:';
const IV_BYTES = 12; // GCM-Norm: 96 Bit
const TAG_BYTES = 16;

export interface Schluessel {
  /** Die ersten acht Hexzeichen von SHA-256 über die Schlüsselbytes. */
  kid: string;
  bytes: Buffer;
  /** Woher er stammt — für die Anzeige im Rotationsskript. */
  herkunft: 'ENCRYPTION_KEY' | 'ENCRYPTION_KEY_PREVIOUS' | 'JWT_SECRET (abgeleitet)';
}

let cachedBund: { aktiv: Schluessel; alle: Schluessel[] } | null = null;

function kidOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 8);
}

function parseHexKey(wert: string, quelle: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(wert)) {
    throw new Error(
      `${quelle} muss 64 Hex-Zeichen (32 Byte) lang sein — erzeugen mit: openssl rand -hex 32`,
    );
  }
  return Buffer.from(wert, 'hex');
}

function bund(): { aktiv: Schluessel; alle: Schluessel[] } {
  if (cachedBund) return cachedBund;

  const konfiguriert = process.env.ENCRYPTION_KEY?.trim();

  const aktiv: Schluessel = konfiguriert
    ? {
        bytes: parseHexKey(konfiguriert, 'ENCRYPTION_KEY'),
        kid: kidOf(parseHexKey(konfiguriert, 'ENCRYPTION_KEY')),
        herkunft: 'ENCRYPTION_KEY',
      }
    : (() => {
        /**
         * `hkdfSync` liefert einen `ArrayBuffer`; `Buffer.from` übernimmt ihn
         * ohne Kopie. Das `info`-Feld bindet die Ableitung an diesen Zweck:
         * Derselbe `JWT_SECRET` ergäbe mit einem anderen `info` einen anderen
         * Schlüssel.
         */
        const bytes = Buffer.from(
          hkdfSync(
            'sha256',
            serverEnv().JWT_SECRET,
            'clenaris-feldverschluesselung',
            'aes-256-gcm-v1',
            32,
          ),
        );
        return { bytes, kid: kidOf(bytes), herkunft: 'JWT_SECRET (abgeleitet)' as const };
      })();

  /**
   * Die ausgemusterten Schlüssel. Doppelte werden verworfen — der häufigste
   * Bedienfehler bei einer Rotation ist, den neuen Schlüssel *auch* in
   * `ENCRYPTION_KEY_PREVIOUS` stehen zu lassen. Ohne Entdoppelung entstünden
   * daraus zwei Einträge mit derselben Kennung, und die Fehlersuche liefe auf
   * eine Frage hinaus, die gar keine ist.
   */
  const alte = (process.env.ENCRYPTION_KEY_PREVIOUS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map<Schluessel>((wert) => {
      const bytes = parseHexKey(wert, 'ENCRYPTION_KEY_PREVIOUS');
      return { bytes, kid: kidOf(bytes), herkunft: 'ENCRYPTION_KEY_PREVIOUS' };
    });

  const gesehen = new Set([aktiv.kid]);
  const alle = [aktiv];
  for (const k of alte) {
    if (gesehen.has(k.kid)) continue;
    gesehen.add(k.kid);
    alle.push(k);
  }

  cachedBund = { aktiv, alle };
  return cachedBund;
}

function key(): Buffer {
  return bund().aktiv.bytes;
}

/**
 * Der Schlüsselbund, für Rotationsskript und Betriebsanzeige.
 *
 * Gibt **Kennungen und Herkunft** zurück, nie Schlüsselbytes. Ein Helfer, der
 * den Schlüssel herausgibt, wird irgendwann von etwas aufgerufen, das ihn
 * protokolliert.
 */
export function schluesselUebersicht(): {
  aktiv: string;
  alle: { kid: string; herkunft: Schluessel['herkunft'] }[];
} {
  const b = bund();
  return {
    aktiv: b.aktiv.kid,
    alle: b.alle.map(({ kid, herkunft }) => ({ kid, herkunft })),
  };
}

/** Nur für Tests: erzwingt, dass der Schlüsselbund neu gelesen wird. */
export function resetEncryptionKeyCache(): void {
  cachedBund = null;
}

/**
 * Ein zweckgebundenes Geheimnis aus dem **aktiven** Wurzelschlüssel ableiten.
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

/**
 * Dasselbe Geheimnis unter **allen** Schlüsseln des Bundes — aktiver zuerst.
 *
 * ---------------------------------------------------------------------------
 *  Warum es das braucht
 * ---------------------------------------------------------------------------
 *
 * Die abgeleiteten Geheimnisse schützen zwei Dinge, die zum Zeitpunkt einer
 * Rotation **unterwegs** sein können:
 *
 *  • den HMAC über einen Bestätigungscode (`signature-otp.ts`) — der steht als
 *    Argon2-Hash in der Datenbank und lässt sich nur mit demselben
 *    abgeleiteten Schlüssel prüfen, der ihn erzeugt hat;
 *  • den Signaturschlüssel der Unterzeichnungssitzung
 *    (`signature-session.ts`) — ein bereits ausgestelltes Cookie ist mit dem
 *    alten Schlüssel signiert.
 *
 * Ohne diesen Weg bräche eine Rotation genau das: Wer gerade einen Vertrag
 * unterzeichnet und den Code schon per SMS bekommen hat, sähe „Der Code stimmt
 * nicht" — und zwar ohne jeden Hinweis darauf, warum. Beides ist
 * kurzlebig (zehn Minuten, eine Sitzung), aber „kurzlebig" ist kein Trost für
 * die Person, die gerade unterschreibt.
 *
 * **Geschrieben wird weiterhin nur mit dem aktiven Schlüssel** (`deriveSecret`).
 * Diese Liste ist ein reiner Prüfpfad, und sie ist genau so lang wie der
 * Schlüsselbund — also im Normalbetrieb ein Eintrag.
 */
export function deriveSecretAll(context: string, bytes = 32): Buffer[] {
  return bund().alle.map((k) =>
    Buffer.from(hkdfSync('sha256', k.bytes, 'clenaris-abgeleitet', context, bytes)),
  );
}

/** Ist dieser Wert bereits verschlüsselt? */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX_V1) || value.startsWith(PREFIX_V2);
}

/**
 * Mit welchem Schlüssel wurde dieser Wert verschlüsselt?
 *
 * `null` für Klartext-Altbestand und für v1 — dort steht es schlicht nicht
 * drin. Das Rotationsskript zählt damit, wie weit es ist; ein v1-Wert gilt
 * dabei als „muss noch".
 */
export function kidOfValue(value: string): string | null {
  if (!value.startsWith(PREFIX_V2)) return null;
  const rest = value.slice(PREFIX_V2.length);
  const trenner = rest.indexOf(':');
  return trenner > 0 ? rest.slice(0, trenner) : null;
}

/** Steht dieser Wert schon unter dem aktiven Schlüssel? */
export function istAktuellVerschluesselt(value: string): boolean {
  return kidOfValue(value) === bund().aktiv.kid;
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
  const aktiv = bund().aktiv;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', aktiv.bytes, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const nutzlast = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  return `${PREFIX_V2}${aktiv.kid}:${nutzlast}`;
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

  const b = bund();

  if (stored.startsWith(PREFIX_V2)) {
    const rest = stored.slice(PREFIX_V2.length);
    const trenner = rest.indexOf(':');
    if (trenner <= 0) throw new Error('Verschlüsselter Wert ist unvollständig.');

    const kid = rest.slice(0, trenner);
    const schluessel = b.alle.find((k) => k.kid === kid);

    /**
     * Die Meldung nennt die Kennung. Das ist der ganze Sinn von v2: Ohne sie
     * stünde hier „Entschlüsselung fehlgeschlagen", und die nächste Stunde
     * ginge für die Frage drauf, *welcher* Schlüssel fehlt. Die Kennung ist
     * ein Hash über den Schlüssel, kein Schlüsselmaterial — sie darf in eine
     * Fehlermeldung.
     */
    if (!schluessel) {
      throw new Error(
        `Für diesen Wert fehlt der Schlüssel ${kid}. ` +
          `Vorhanden: ${b.alle.map((k) => k.kid).join(', ')}. ` +
          'Der ausgemusterte Schlüssel gehört nach ENCRYPTION_KEY_PREVIOUS.',
      );
    }

    return oeffne(rest.slice(trenner + 1), schluessel.bytes, context);
  }

  /**
   * v1 trägt keine Kennung — hier bleibt nur, die Schlüssel der Reihe nach zu
   * versuchen. Das ist nicht teuer: Der GCM-Prüfwert schlägt sofort fehl, und
   * der Bund hat im Normalbetrieb einen Eintrag.
   *
   * Der **aktive zuerst**, weil er im Normalfall passt. Erst wenn kein
   * Schlüssel greift, ist es ein echter Fehler.
   */
  const nutzlast = stored.slice(PREFIX_V1.length);
  for (const schluessel of b.alle) {
    try {
      return oeffne(nutzlast, schluessel.bytes, context);
    } catch {
      // Nächster Schlüssel. Der Fehler nach dem letzten wird geworfen.
    }
  }

  throw new Error(
    'Verschlüsselter Wert (v1) liess sich mit keinem konfigurierten Schlüssel öffnen. ' +
      `Versucht: ${b.alle.map((k) => k.kid).join(', ')}.`,
  );
}

/** Der reine AES-GCM-Teil, für beide Fassungen gleich. */
function oeffne(base64: string, schluessel: Buffer, context: string): string {
  const raw = Buffer.from(base64, 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new Error('Verschlüsselter Wert ist unvollständig.');
  }

  const decipher = createDecipheriv('aes-256-gcm', schluessel, raw.subarray(0, IV_BYTES));
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
  /**
   * Die Auszahlungs-IBAN der Mitarbeitenden — seit Wave 4.
   *
   * **Warum sie dazukommt und die Lohnbeträge nicht.** Eine IBAN ist eine
   * Kennung: Sie wird gespeichert, angezeigt und weitergegeben, aber in dieser
   * Anwendung nirgends gerechnet, sortiert, gefiltert oder aggregiert. Die
   * Verschlüsselung kostet sie nichts.
   *
   * `hourlyRate` und `monthlySalary` sind `Decimal(12,2)` und werden **in der
   * Datenbank** verrechnet — `prisma.employee.aggregate({ _avg: { hourlyRate }})`
   * in `scenario.service.ts` und die SQL-Summe über `TimeEntry.hourlyRate` in
   * `analytics.service.ts`. Ein Chiffrat ist eine Zeichenkette; `AVG` darüber
   * ergibt einen Fehler, keine Zahl. Die vollständige Abwägung samt der
   * geprüften Alternativen steht in `docs/KEY_MANAGEMENT.md`.
   *
   * **Wichtig: nur `Employee.iban`.** `Organization.iban` und
   * `Organization.qrIban` bleiben Klartext — sie stehen auf jeder Rechnung und
   * in jedem Einzahlungsschein. Etwas zu verschlüsseln, das man selbst
   * veröffentlicht, ist keine Massnahme, sondern eine Behauptung.
   */
  iban: 'employee.iban',
} as const;
