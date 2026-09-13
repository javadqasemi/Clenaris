import 'server-only';

import { headers } from 'next/headers';
import type { UserRole } from '@prisma/client';

import { prisma } from '@/lib/db';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { hashToken, randomToken } from '@/lib/auth/jwt';
import { clientIpFrom, createSession, revokeAllSessions } from '@/lib/auth/session';
import { BusinessRuleError, ConflictError, UnauthorizedError } from '@/lib/errors';
import { absoluteUrl } from '@/lib/utils';
import { audit, recordAudit } from '@/lib/audit';
import { sendEmail } from '@/lib/email/client';
import {
  passwordResetEmail,
  staffInviteEmail,
  verifyEmailTemplate,
  welcomeEmail,
} from '@/lib/email/templates';
import { checkRateLimit, resetRateLimit } from '@/lib/rate-limit';
import type { LoginInput, RegisterInput } from '@/lib/validation/auth';

import { nextNumber } from './numbering.service';
import { logger } from '@/lib/logger';
import { ROLE_LABELS } from '@/lib/auth/rbac';

const log = logger('auth');

/**
 * Authentifizierung.
 *
 * Sicherheitsentscheide:
 *  • Account-Lockout nach 8 Fehlversuchen für 15 Minuten, zusätzlich zum
 *    IP-Rate-Limit. Beides zusammen bremst sowohl verteiltes Credential-Stuffing
 *    als auch gezielte Angriffe auf ein einzelnes Konto.
 *  • Login-Fehler sind bewusst ununterscheidbar ("E-Mail oder Passwort falsch"),
 *    damit keine Konten aufgezählt werden können.
 *  • Passwort-Reset und E-Mail-Bestätigung antworten immer gleich, unabhängig
 *    davon, ob die Adresse existiert.
 *  • Bei Passwortwechsel werden alle bestehenden Sessions widerrufen.
 */

const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;
const RESET_TOKEN_TTL_MINUTES = 60;
const INVITE_TOKEN_TTL_DAYS = 7;

export async function register(params: {
  organizationId: string;
  input: RegisterInput;
  ip?: string;
}) {
  const email = params.input.email.toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new ConflictError(
      'Für diese E-Mail-Adresse besteht bereits ein Konto. Bitte melden Sie sich an oder setzen Sie Ihr Passwort zurück.',
    );
  }

  const passwordHash = await hashPassword(params.input.password);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        organizationId: params.organizationId,
        email,
        passwordHash,
        firstName: params.input.firstName,
        lastName: params.input.lastName,
        phone: params.input.phone ?? null,
        locale: params.input.locale,
        role: 'CUSTOMER',
        status: 'ACTIVE',
        marketingOptIn: params.input.marketingOptIn,
        consents: {
          create: [
            { type: 'TERMS', granted: true, ip: params.ip ?? null },
            { type: 'PRIVACY', granted: true, ip: params.ip ?? null },
            ...(params.input.marketingOptIn
              ? [{ type: 'MARKETING_EMAIL' as const, granted: true, ip: params.ip ?? null }]
              : []),
          ],
        },
      },
    });

    // Bestehendes Kundenprofil (z. B. aus einer Gastbuchung) verknüpfen.
    const existingCustomer = await tx.customer.findFirst({
      where: { organizationId: params.organizationId, email, userId: null, deletedAt: null },
    });

    if (existingCustomer) {
      await tx.customer.update({
        where: { id: existingCustomer.id },
        data: { userId: created.id },
      });
    } else {
      const { number } = await nextNumber(tx, params.organizationId, 'customer');
      await tx.customer.create({
        data: {
          organizationId: params.organizationId,
          number,
          userId: created.id,
          firstName: params.input.firstName,
          lastName: params.input.lastName,
          email,
          phone: params.input.phone ?? null,
          language: params.input.locale,
          referralCode: randomToken(4).toUpperCase(),
        },
      });
    }

    return created;
  });

  // E-Mail-Bestätigung versenden.
  const verifyToken = randomToken(32);
  await prisma.verificationToken.create({
    data: {
      userId: user.id,
      email,
      tokenHash: await hashToken(verifyToken),
      purpose: 'EMAIL_VERIFY',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  const content = welcomeEmail({ firstName: user.firstName });
  await sendEmail({
    to: email,
    subject: content.subject,
    html: content.html,
    templateKey: 'welcome',
    entity: 'User',
    entityId: user.id,
  });

  const verify = verifyEmailTemplate({
    firstName: user.firstName,
    verifyUrl: absoluteUrl(`/auth/verifizieren?token=${verifyToken}`),
  });
  await sendEmail({
    to: email,
    subject: verify.subject,
    html: verify.html,
    templateKey: 'verify_email',
    entity: 'User',
    entityId: user.id,
  });

  await createSession({ userId: user.id });

  await audit.created({
    organizationId: params.organizationId,
    userId: user.id,
    entity: 'User',
    entityId: user.id,
    summary: `Registrierung ${email}`,
    ip: params.ip,
  });

  return user;
}

export async function login(params: { input: LoginInput; ip: string }) {
  const email = params.input.email.toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      role: true,
      status: true,
      failedLoginCount: true,
      lockedUntil: true,
      organizationId: true,
      deletedAt: true,
      mustChangePassword: true,
      twoFactorEnabled: true,
    },
  });

  // Dummy-Verifikation gegen Timing-Angriffe: der Ablauf dauert gleich lang,
  // egal ob das Konto existiert.
  if (!user || user.deletedAt) {
    await verifyPassword(
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000',
      params.input.password,
    );
    throw new UnauthorizedError('E-Mail-Adresse oder Passwort ist falsch.');
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    throw new UnauthorizedError(
      `Das Konto ist aus Sicherheitsgründen gesperrt. Bitte versuchen Sie es in ${minutes} Minuten erneut.`,
    );
  }

  if (user.status === 'SUSPENDED' || user.status === 'DISABLED') {
    throw new UnauthorizedError(
      'Dieses Konto ist deaktiviert. Bitte kontaktieren Sie uns, wenn Sie Fragen haben.',
    );
  }

  const valid = await verifyPassword(user.passwordHash, params.input.password);

  if (!valid) {
    const failedCount = user.failedLoginCount + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failedCount,
        lockedUntil:
          failedCount >= MAX_FAILED_LOGINS
            ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
            : null,
      },
    });

    await audit.denied({
      organizationId: user.organizationId,
      userId: user.id,
      entity: 'User',
      entityId: user.id,
      summary: `Fehlgeschlagener Login (${failedCount}/${MAX_FAILED_LOGINS})`,
      ip: params.ip,
    });

    throw new UnauthorizedError('E-Mail-Adresse oder Passwort ist falsch.');
  }

  const hdrs = await headers();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: clientIpFrom(hdrs),
    },
  });

  // Nur der IP-Zähler wird zurückgesetzt — einen Zähler je Adresse gibt es
  // nicht, das Konto schützt die Sperre nach acht Fehlversuchen.
  await resetRateLimit('login', params.ip);

  /**
   * Zweiter Faktor: hier endet der erste Schritt.
   *
   * Statt einer Sitzung wird ein kurzlebiger Zwischenschein ausgestellt. Das
   * ist der entscheidende Punkt: gäbe es an dieser Stelle bereits ein
   * Zugangstoken, wäre der zweite Faktor eine Anzeige und keine Schranke —
   * wer das Token abfängt, käme an der Codeabfrage vorbei.
   */
  if (user.twoFactorEnabled) {
    const { issueMfaChallenge } = await import('./two-factor.service');
    await issueMfaChallenge(user.id);

    await recordAudit({
      organizationId: user.organizationId,
      userId: user.id,
      action: 'LOGIN',
      entity: 'User',
      entityId: user.id,
      summary: 'Passwort bestätigt, zweiter Faktor ausstehend',
      ip: params.ip,
    });

    return { user: null, mustChangePassword: false, twoFactorRequired: true as const };
  }

  const session = await createSession({ userId: user.id });

  await recordAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: 'LOGIN',
    entity: 'User',
    entityId: user.id,
    summary: 'Erfolgreiche Anmeldung',
    ip: params.ip,
  });

  return {
    user: session.user,
    mustChangePassword: user.mustChangePassword,
    twoFactorRequired: false as const,
  };
}

/** Passwort-Reset anfordern — antwortet immer erfolgreich. */
export async function requestPasswordReset(email: string, ip: string): Promise<void> {
  const normalized = email.toLowerCase();

  // Zusätzliche Bremse pro E-Mail-Adresse, nicht nur pro IP.
  const limit = await checkRateLimit('passwordReset', normalized);
  if (!limit.success) return;

  const user = await prisma.user.findUnique({
    where: { email: normalized },
    select: { id: true, firstName: true, status: true, deletedAt: true },
  });

  if (!user || user.deletedAt || user.status !== 'ACTIVE') return;

  // Ältere, noch offene Tokens entwerten.
  await prisma.verificationToken.updateMany({
    where: { email: normalized, purpose: 'PASSWORD_RESET', usedAt: null },
    data: { usedAt: new Date() },
  });

  const token = randomToken(32);
  await prisma.verificationToken.create({
    data: {
      userId: user.id,
      email: normalized,
      tokenHash: await hashToken(token),
      purpose: 'PASSWORD_RESET',
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000),
    },
  });

  const content = passwordResetEmail({
    firstName: user.firstName,
    resetUrl: absoluteUrl(`/auth/passwort-neu?token=${token}`),
  });

  await sendEmail({
    to: normalized,
    subject: content.subject,
    html: content.html,
    templateKey: 'password_reset',
    entity: 'User',
    entityId: user.id,
  });

  // Adresse und IP werden vom Logger maskiert — ein Protokoll, das Monate
  // aufbewahrt wird, darf keine Klartext-Personendaten enthalten (DSG/DSGVO).
  log.info('Passwort-Reset angefordert', { email: normalized, ip });
}

export async function resetPassword(params: {
  token: string;
  password: string;
  ip?: string;
}): Promise<void> {
  const tokenHash = await hashToken(params.token);

  const record = await prisma.verificationToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, organizationId: true, email: true } } },
  });

  if (
    !record ||
    record.purpose !== 'PASSWORD_RESET' ||
    record.usedAt ||
    record.expiresAt < new Date() ||
    !record.user
  ) {
    throw new BusinessRuleError(
      'Dieser Link ist ungültig oder abgelaufen. Bitte fordern Sie einen neuen an.',
    );
  }

  const passwordHash = await hashPassword(params.password);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.user.id },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
        mustChangePassword: false,
        emailVerified: new Date(),
      },
    }),
    prisma.verificationToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
  ]);

  // Sicherheitsmassnahme: alle bestehenden Sessions beenden.
  await revokeAllSessions(record.user.id);

  await recordAudit({
    organizationId: record.user.organizationId,
    userId: record.user.id,
    action: 'PASSWORD_RESET',
    entity: 'User',
    entityId: record.user.id,
    summary: 'Passwort über Reset-Link geändert',
    ip: params.ip,
  });
}

export async function changePassword(params: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  ip?: string;
}): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: params.userId },
    select: { id: true, passwordHash: true, organizationId: true },
  });

  const valid = await verifyPassword(user.passwordHash, params.currentPassword);
  if (!valid) throw new UnauthorizedError('Das aktuelle Passwort ist nicht korrekt.');

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(params.newPassword),
      passwordChangedAt: new Date(),
      mustChangePassword: false,
    },
  });

  await revokeAllSessions(user.id);
  // Nach dem Widerruf sofort eine neue Session ausstellen, damit die aktuelle
  // Sitzung weiterläuft.
  await createSession({ userId: user.id });

  await recordAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: 'PASSWORD_RESET',
    entity: 'User',
    entityId: user.id,
    summary: 'Passwort geändert',
    ip: params.ip,
  });
}

export async function verifyEmail(token: string): Promise<void> {
  const tokenHash = await hashToken(token);
  const record = await prisma.verificationToken.findUnique({ where: { tokenHash } });

  if (
    !record ||
    record.purpose !== 'EMAIL_VERIFY' ||
    record.usedAt ||
    record.expiresAt < new Date()
  ) {
    throw new BusinessRuleError('Dieser Bestätigungslink ist ungültig oder abgelaufen.');
  }

  await prisma.$transaction([
    prisma.user.updateMany({
      where: { email: record.email },
      data: { emailVerified: new Date() },
    }),
    prisma.verificationToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
  ]);
}

/** Mitarbeitenden- oder Kundenkonto einladen (Passwort wird selbst gesetzt). */
export async function inviteUser(params: {
  organizationId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  actorId: string;
}): Promise<{ userId: string; inviteUrl: string }> {
  const email = params.email.toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new ConflictError('Für diese E-Mail-Adresse besteht bereits ein Konto.');
  }

  // Zufälliges Startpasswort — wird nie kommuniziert, der Invite-Link zählt.
  const temporaryPassword = randomToken(24);

  const user = await prisma.user.create({
    data: {
      organizationId: params.organizationId,
      email,
      passwordHash: await hashPassword(temporaryPassword),
      firstName: params.firstName,
      lastName: params.lastName,
      role: params.role,
      status: 'PENDING',
      mustChangePassword: true,
    },
  });

  const token = randomToken(32);
  await prisma.verificationToken.create({
    data: {
      userId: user.id,
      email,
      tokenHash: await hashToken(token),
      purpose: 'INVITE',
      expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_DAYS * 86_400_000),
    },
  });

  const inviteUrl = absoluteUrl(`/auth/einladung?token=${token}`);

  // Beschriftungen kommen aus der Rollendefinition — eine Quelle für
  // Oberfläche, E-Mails und Prüfprotokoll.
  const roleLabels = ROLE_LABELS;

  const content = staffInviteEmail({
    firstName: params.firstName,
    inviteUrl,
    role: roleLabels[params.role],
  });

  await sendEmail({
    to: email,
    subject: content.subject,
    html: content.html,
    templateKey: 'staff_invite',
    entity: 'User',
    entityId: user.id,
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'User',
    entityId: user.id,
    summary: `Benutzer ${email} als ${params.role} eingeladen`,
  });

  return { userId: user.id, inviteUrl };
}

/** Einladung annehmen: Passwort setzen und Konto aktivieren. */
export async function acceptInvite(params: { token: string; password: string }): Promise<string> {
  const tokenHash = await hashToken(params.token);
  const record = await prisma.verificationToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (
    !record ||
    record.purpose !== 'INVITE' ||
    record.usedAt ||
    record.expiresAt < new Date() ||
    !record.user
  ) {
    throw new BusinessRuleError('Diese Einladung ist ungültig oder abgelaufen.');
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.user.id },
      data: {
        passwordHash: await hashPassword(params.password),
        status: 'ACTIVE',
        emailVerified: new Date(),
        mustChangePassword: false,
        passwordChangedAt: new Date(),
      },
    }),
    prisma.verificationToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
  ]);

  await createSession({ userId: record.user.id });
  return record.user.id;
}

/** Abgelaufene Tokens und Sessions aufräumen (Cron, täglich). */
export async function cleanupExpiredTokens(): Promise<{ tokens: number; sessions: number }> {
  const now = new Date();

  const [tokens, sessions] = await Promise.all([
    prisma.verificationToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { lt: new Date(now.getTime() - 30 * 86_400_000) } }] },
    }),
    prisma.refreshToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: new Date(now.getTime() - 7 * 86_400_000) } }] },
    }),
  ]);

  return { tokens: tokens.count, sessions: sessions.count };
}
