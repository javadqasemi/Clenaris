import 'server-only';

import { cookies } from 'next/headers';
import QRCode from 'qrcode';

import { prisma } from '@/lib/db';
import { audit, recordAudit } from '@/lib/audit';
import { recordSecurityEvent } from '@/lib/security/record';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { signAccessToken, verifyAccessToken } from '@/lib/auth/jwt';
import { createSession, revokeAllSessions } from '@/lib/auth/session';
import { BusinessRuleError, NotFoundError, UnauthorizedError } from '@/lib/errors';
import { CRYPTO_CONTEXT, decrypt, encrypt } from '@/lib/crypto';
import {
  generateRecoveryCodes,
  generateSecret,
  normalizeRecoveryCode,
  otpauthUrl,
  verifyToken,
} from '@/lib/auth/totp';

/**
 * Zwei-Faktor-Anmeldung.
 *
 * Architekturentscheide:
 *
 *  • **Die Einrichtung ist zweistufig.** Das Geheimnis wird erzeugt und
 *    gespeichert, aber `twoFactorEnabled` bleibt falsch, bis die Person einen
 *    gültigen Code eingegeben hat. Ohne diesen Schritt sperrt sich aus, wer
 *    den QR-Code scannt und dann das Telefon zurücksetzt — und niemand merkt
 *    es bis zur nächsten Anmeldung.
 *
 *  • **Zwischen Passwort und Code entsteht keine Sitzung.** Stimmt das
 *    Passwort, aber der zweite Faktor fehlt noch, wird ein kurzlebiger,
 *    signierter Zwischenschein ausgestellt — kein Zugangstoken. Wer den
 *    Zwischenschein abfängt, hat damit nichts: er trägt keine Rechte und
 *    läuft in fünf Minuten ab.
 *
 *  • **Wiederherstellungscodes sind gehasht.** Im Klartext wären sie zehn
 *    Ersatzpasswörter in derselben Zeile wie das TOTP-Geheimnis. Wer die
 *    Zeile liest, käme sonst an beidem vorbei.
 *
 *  • **Ein verbrauchter Wiederherstellungscode wird entfernt, nicht
 *    markiert.** Er soll kein zweites Mal funktionieren, und eine Liste mit
 *    „schon benutzt" wäre eine Liste, aus der man versehentlich wieder
 *    auswählt.
 *
 *  • **Das TOTP-Geheimnis liegt verschlüsselt in der Datenbank**
 *    (`src/lib/crypto.ts`). Gehasht ginge nicht — im Gegensatz zu einem
 *    Passwort muss die Anwendung es zurückbekommen, um den Code der
 *    Authenticator-App nachzurechnen. Im Klartext wäre die
 *    Zwei-Faktor-Anmeldung für jede Person, die einen Datenbankabzug in die
 *    Hand bekommt, nur noch ein zusätzliches Eingabefeld. Altbestand im
 *    Klartext bleibt lesbar und wandert beim nächsten Einrichten ins neue
 *    Format.
 */

/** Der Zwischenschein zwischen Passwort und Code. */
const MFA_COOKIE = 'clenaris_mfa';
const MFA_TTL_SECONDS = 300;

export interface TwoFactorSetup {
  /** Das Geheimnis zum Abtippen, falls die Kamera streikt. */
  secret: string;
  /** QR-Code als Data-URI. */
  qrCode: string;
  otpauthUrl: string;
}

/**
 * Schritt 1: Geheimnis erzeugen und QR-Code liefern.
 *
 * Ein bereits eingeschalteter zweiter Faktor wird nicht überschrieben — sonst
 * genügte ein Aufruf dieses Endpunkts, um den Schutz einer fremden Sitzung
 * unbrauchbar zu machen.
 */
export async function beginTwoFactorSetup(params: {
  userId: string;
  issuer: string;
}): Promise<TwoFactorSetup> {
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { id: true, email: true, twoFactorEnabled: true },
  });
  if (!user) throw new NotFoundError('Benutzerkonto');

  if (user.twoFactorEnabled) {
    throw new BusinessRuleError(
      'Die Zwei-Faktor-Anmeldung ist bereits eingeschaltet. Schalten Sie sie zuerst aus, wenn Sie ein neues Gerät einrichten wollen.',
    );
  }

  const secret = generateSecret();
  const url = otpauthUrl({ secret, account: user.email, issuer: params.issuer });

  await prisma.user.update({
    where: { id: user.id },
    // Das Geheimnis wird gespeichert, der Schutz aber noch nicht scharf
    // gestellt: erst der bestätigte Code schaltet ihn ein.
    data: {
      twoFactorSecret: encrypt(secret, CRYPTO_CONTEXT.twoFactorSecret),
      twoFactorEnabled: false,
      twoFactorConfirmedAt: null,
    },
  });

  return {
    secret,
    otpauthUrl: url,
    qrCode: await QRCode.toDataURL(url, { margin: 1, width: 240 }),
  };
}

/**
 * Schritt 2: Code bestätigen und einschalten.
 *
 * Gibt die Wiederherstellungscodes zurück — **einmalig**. Danach existieren
 * sie nur noch als Hash; wer sie nicht notiert hat, muss den zweiten Faktor
 * zurücksetzen lassen.
 */
export async function confirmTwoFactor(params: {
  userId: string;
  token: string;
  ip?: string | null;
}): Promise<{ recoveryCodes: string[] }> {
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { id: true, email: true, organizationId: true, twoFactorSecret: true, twoFactorEnabled: true },
  });
  if (!user) throw new NotFoundError('Benutzerkonto');
  if (user.twoFactorEnabled) {
    throw new BusinessRuleError('Die Zwei-Faktor-Anmeldung ist bereits eingeschaltet.');
  }
  if (!user.twoFactorSecret) {
    throw new BusinessRuleError('Beginnen Sie mit der Einrichtung, bevor Sie einen Code bestätigen.');
  }

  if (!verifyToken(decrypt(user.twoFactorSecret, CRYPTO_CONTEXT.twoFactorSecret), params.token)) {
    throw new UnauthorizedError(
      'Der Code stimmt nicht. Prüfen Sie, ob die Uhrzeit Ihres Telefons stimmt — TOTP hängt daran.',
    );
  }

  const recoveryCodes = generateRecoveryCodes();
  const hashed = await Promise.all(
    recoveryCodes.map((code) => hashPassword(normalizeRecoveryCode(code))),
  );

  await prisma.user.update({
    where: { id: user.id },
    data: {
      twoFactorEnabled: true,
      twoFactorConfirmedAt: new Date(),
      twoFactorRecoveryCodes: hashed,
    },
  });

  await recordAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: 'PERMISSION_CHANGE',
    entity: 'User',
    entityId: user.id,
    summary: 'Zwei-Faktor-Anmeldung eingeschaltet',
    ip: params.ip,
  });

  await recordSecurityEvent({
    organizationId: user.organizationId,
    userId: user.id,
    kind: 'TWO_FACTOR_ENABLED',
    ip: params.ip,
  });

  return { recoveryCodes };
}

/**
 * Ausschalten.
 *
 * Verlangt das Passwort **und** einen gültigen Code. Nur das Passwort würde
 * genügen, wenn jemand eine offene Sitzung übernimmt — und dann wäre der
 * zweite Faktor genau in dem Moment weg, in dem er gebraucht wird.
 */
export async function disableTwoFactor(params: {
  userId: string;
  password: string;
  token: string;
  ip?: string | null;
}): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: {
      id: true,
      organizationId: true,
      passwordHash: true,
      twoFactorEnabled: true,
      twoFactorSecret: true,
      twoFactorRecoveryCodes: true,
    },
  });
  if (!user) throw new NotFoundError('Benutzerkonto');
  if (!user.twoFactorEnabled || !user.twoFactorSecret) {
    throw new BusinessRuleError('Die Zwei-Faktor-Anmeldung ist nicht eingeschaltet.');
  }

  if (!(await verifyPassword(user.passwordHash, params.password))) {
    throw new UnauthorizedError('Das Passwort stimmt nicht.');
  }

  const byToken = verifyToken(
    decrypt(user.twoFactorSecret, CRYPTO_CONTEXT.twoFactorSecret),
    params.token,
  );
  const byRecovery = byToken ? false : await matchRecoveryCode(user.twoFactorRecoveryCodes, params.token);

  if (!byToken && byRecovery === null) {
    throw new UnauthorizedError('Der Code stimmt nicht.');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      twoFactorEnabled: false,
      twoFactorSecret: null,
      twoFactorConfirmedAt: null,
      twoFactorRecoveryCodes: [],
    },
  });

  await recordAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: 'PERMISSION_CHANGE',
    entity: 'User',
    entityId: user.id,
    summary: 'Zwei-Faktor-Anmeldung ausgeschaltet',
    ip: params.ip,
  });

  /**
   * `CRITICAL` — siehe die Begründung im Katalog. Das Abschalten ist regulär
   * und verlangt Passwort *und* Code; trotzdem ist es der Schritt, den jemand
   * als Erstes geht, der ein Konto übernommen hat. Wer es selbst getan hat,
   * bestätigt den Eintrag in zehn Sekunden.
   */
  await recordSecurityEvent({
    organizationId: user.organizationId,
    userId: user.id,
    kind: 'TWO_FACTOR_DISABLED',
    ip: params.ip,
  });
}

/**
 * Prüft einen Wiederherstellungscode gegen die gehashte Liste.
 *
 * Gibt den Index des passenden Hashes zurück oder `null`. Die Schleife läuft
 * bewusst über alle Einträge — ein vorzeitiger Abbruch verriete über die
 * Laufzeit, an welcher Stelle der Code steht.
 */
async function matchRecoveryCode(hashes: string[], input: string): Promise<number | null> {
  const normalized = normalizeRecoveryCode(input);
  if (normalized.length < 8) return null;

  let found: number | null = null;
  for (const [index, hash] of hashes.entries()) {
    if (await verifyPassword(hash, normalized)) found = index;
  }
  return found;
}

// ---------------------------------------------------------------------------
//  Anmeldung in zwei Schritten
// ---------------------------------------------------------------------------

/**
 * Zwischenschein ausstellen.
 *
 * Er trägt nur die Benutzer-ID und läuft in fünf Minuten ab. Bewusst kein
 * Zugangstoken: Rolle und Rechte stehen nicht darin, und die Middleware
 * erkennt ihn nicht als Sitzung.
 */
export async function issueMfaChallenge(userId: string, persistent = false): Promise<void> {
  const token = await signAccessToken({
    sub: userId,
    org: 'mfa-pending',
    role: 'CUSTOMER',
    email: '',
    name: '',
    mfa: true,
    // Die Wahl „Angemeldet bleiben" aus dem ersten Schritt — signiert, damit
    // sie zwischen den Schritten niemand setzen kann.
    ...(persistent ? { rem: true } : {}),
  } as never);

  const store = await cookies();
  store.set(MFA_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MFA_TTL_SECONDS,
  });
}

/**
 * Zweiter Schritt: Code prüfen und die eigentliche Sitzung erzeugen.
 *
 * Akzeptiert ein TOTP-Kennwort oder einen Wiederherstellungscode. Ein
 * verbrauchter Wiederherstellungscode wird aus der Liste entfernt — er soll
 * kein zweites Mal funktionieren.
 */
export async function completeMfaLogin(params: {
  token: string;
  ip?: string | null;
}): Promise<{ userId: string; usedRecoveryCode: boolean; remainingCodes: number }> {
  const store = await cookies();
  const challenge = store.get(MFA_COOKIE)?.value;
  if (!challenge) {
    throw new UnauthorizedError('Die Anmeldung ist abgelaufen. Bitte melden Sie sich erneut an.');
  }

  const claims = await verifyAccessToken(challenge);
  if (!claims || (claims as unknown as { mfa?: boolean }).mfa !== true) {
    throw new UnauthorizedError('Die Anmeldung ist abgelaufen. Bitte melden Sie sich erneut an.');
  }

  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: {
      id: true,
      organizationId: true,
      twoFactorEnabled: true,
      twoFactorSecret: true,
      twoFactorRecoveryCodes: true,
      status: true,
      deletedAt: true,
    },
  });
  if (!user || user.deletedAt || user.status !== 'ACTIVE' || !user.twoFactorEnabled || !user.twoFactorSecret) {
    throw new UnauthorizedError('Anmeldung nicht möglich.');
  }

  const byToken = verifyToken(
    decrypt(user.twoFactorSecret, CRYPTO_CONTEXT.twoFactorSecret),
    params.token,
  );
  const recoveryIndex = byToken ? null : await matchRecoveryCode(user.twoFactorRecoveryCodes, params.token);

  /**
   * Den Ersatzcode verbrauchen, **bevor** eine Sitzung entsteht — und nur,
   * wenn er in diesem Augenblick noch im Vorrat steht.
   *
   * Früher stand hier: Liste lesen, Hash prüfen, gefilterte Liste
   * zurückschreiben. Zwischen Lesen und Schreiben liegen zehn Argon2-Prüfungen,
   * also Hunderte Millisekunden. Fünf gleichzeitige Anfragen mit demselben
   * Code lasen alle denselben Vorrat, fanden alle den Code, schrieben alle
   * dieselbe „Liste ohne ihn" — und bekamen alle eine Sitzung. Ein
   * Einmalcode, der fünfmal öffnet, ist kein Einmalcode.
   *
   * Deshalb entscheidet die Datenbank in *einer* Anweisung: Entfernt wird nur,
   * solange der Hash noch enthalten ist; genau eine Anfrage findet ihn, alle
   * anderen ändern keine Zeile und gelten als falscher Code. `array_remove`
   * statt „gefilterte Liste zurückschreiben", damit zwei *verschiedene* Codes,
   * gleichzeitig eingelöst, einander nicht wiederbeleben — eine Liste aus
   * einem alten Stand stellte den anderen, eben verbrauchten Code wieder her.
   * Die Hashes sind gesalzen und damit eindeutig; `array_remove` trifft nur
   * diesen einen.
   */
  let remainingAfterRecovery: number | null = null;
  if (recoveryIndex !== null) {
    const hash = user.twoFactorRecoveryCodes[recoveryIndex];
    const rows = await prisma.$queryRaw<{ rest: number }[]>`
      UPDATE "users"
         SET "twoFactorRecoveryCodes" = array_remove("twoFactorRecoveryCodes", ${hash})
       WHERE "id" = ${user.id}
         AND ${hash} = ANY("twoFactorRecoveryCodes")
      RETURNING cardinality("twoFactorRecoveryCodes")::int AS rest`;
    remainingAfterRecovery = rows[0]?.rest ?? null;
  }

  if (!byToken && remainingAfterRecovery === null) {
    await audit.denied({
      organizationId: user.organizationId,
      userId: user.id,
      entity: 'User',
      entityId: user.id,
      summary: 'Zweiter Faktor falsch',
      ip: params.ip,
    });

    /**
     * Wiegt schwerer als ein falsches Passwort und wird trotzdem gleich
     * eingestuft — die Aussage steckt in der Häufung, nicht im Einzelfall.
     * Wer hier landet, hat das Passwort bereits gehabt; eine Reihe solcher
     * Einträge auf ein Konto ist deshalb der deutlichste Hinweis auf ein
     * abgeflossenes Passwort, den dieses System überhaupt geben kann.
     */
    await recordSecurityEvent({
      organizationId: user.organizationId,
      userId: user.id,
      kind: 'TWO_FACTOR_FAILED',
      summary: 'Zweiter Faktor falsch — das Passwort war richtig',
      ip: params.ip,
    });

    throw new UnauthorizedError('Der Code stimmt nicht.');
  }

  const remaining = remainingAfterRecovery ?? user.twoFactorRecoveryCodes.length;

  store.delete(MFA_COOKIE);
  await createSession({ userId: user.id, persistent: claims.rem === true });

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  await recordAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: 'LOGIN',
    entity: 'User',
    entityId: user.id,
    summary:
      recoveryIndex !== null
        ? `Anmeldung mit Wiederherstellungscode (${remaining} verbleibend)`
        : 'Anmeldung mit zweitem Faktor',
    ip: params.ip,
  });

  await recordSecurityEvent({
    organizationId: user.organizationId,
    userId: user.id,
    kind: 'LOGIN_SUCCEEDED',
    summary:
      recoveryIndex !== null
        ? `Anmeldung mit Wiederherstellungscode (${remaining} verbleibend)`
        : 'Anmeldung mit zweitem Faktor',
    // Die Zahl der verbleibenden Codes gehört in den Zusammenhang: Wer bei
    // null ankommt, sperrt sich aus, und das soll vorher jemand sehen.
    context: recoveryIndex !== null ? { verbleibendeCodes: remaining } : undefined,
    ip: params.ip,
  });

  return { userId: user.id, usedRecoveryCode: recoveryIndex !== null, remainingCodes: remaining };
}

/**
 * Zweiten Faktor für ein fremdes Konto zurücksetzen.
 *
 * Der Notausgang, wenn jemand Telefon *und* Wiederherstellungscodes verloren
 * hat. Nur die Systemverantwortung darf das — es ist die einzige Handlung, die
 * einen Schutz von aussen entfernt. Alle Sitzungen der Person werden beendet:
 * ist das Konto tatsächlich übernommen worden, endet der Zugriff damit.
 */
export async function resetTwoFactorFor(params: {
  organizationId: string;
  actorId: string;
  userId: string;
  ip?: string | null;
}): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { id: params.userId, organizationId: params.organizationId },
    select: { id: true, email: true, twoFactorEnabled: true },
  });
  if (!user) throw new NotFoundError('Benutzerkonto');
  if (!user.twoFactorEnabled) {
    throw new BusinessRuleError('Für dieses Konto ist keine Zwei-Faktor-Anmeldung eingeschaltet.');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      twoFactorEnabled: false,
      twoFactorSecret: null,
      twoFactorConfirmedAt: null,
      twoFactorRecoveryCodes: [],
    },
  });
  await revokeAllSessions(user.id);

  await recordAudit({
    organizationId: params.organizationId,
    userId: params.actorId,
    action: 'PERMISSION_CHANGE',
    entity: 'User',
    entityId: user.id,
    summary: `Zwei-Faktor-Anmeldung von ${user.email} zurückgesetzt und alle Sitzungen beendet`,
    ip: params.ip,
  });

  /**
   * Zwei Ereignisse, weil zwei Dinge geschehen sind — und beide betreffen
   * dasselbe Konto, nicht die handelnde Person. `userId` ist deshalb `user.id`
   * und nicht `params.actorId`; wer es getan hat, steht im Zusammenhang. Die
   * Übersicht filtert nach dem betroffenen Konto, und genau dort sollen beide
   * Zeilen auftauchen.
   */
  await recordSecurityEvent({
    organizationId: params.organizationId,
    userId: user.id,
    kind: 'TWO_FACTOR_DISABLED',
    summary: 'Zweiter Faktor durch die Systemverantwortung zurückgesetzt',
    context: { durch: params.actorId },
    ip: params.ip,
  });

  await recordSecurityEvent({
    organizationId: params.organizationId,
    userId: user.id,
    kind: 'SESSIONS_REVOKED',
    summary: 'Alle Sitzungen beendet — Rücksetzung des zweiten Faktors',
    context: { durch: params.actorId },
    ip: params.ip,
  });
}

/** Zustand für die Profilseite. */
export async function getTwoFactorStatus(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { twoFactorEnabled: true, twoFactorConfirmedAt: true, twoFactorRecoveryCodes: true },
  });
  return {
    enabled: user?.twoFactorEnabled ?? false,
    confirmedAt: user?.twoFactorConfirmedAt ?? null,
    remainingRecoveryCodes: user?.twoFactorRecoveryCodes.length ?? 0,
  };
}
