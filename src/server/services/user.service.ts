import 'server-only';

import { Prisma, type UserRole } from '@prisma/client';

import { prisma } from '@/lib/db';
import { audit, diff } from '@/lib/audit';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors';
import { assignableRoles, ROLE_LABELS, type ActorRole } from '@/lib/auth/rbac';
import type { UpdateUserInput } from '@/lib/validation/users';

import { revokeAllSessions } from '@/lib/auth/session';

/**
 * Benutzerkonten.
 *
 * Architekturentscheide:
 *
 *  • **Wer sich selbst aussperren könnte, tut es irgendwann.** Die eigene
 *    Rolle zu ändern, das eigene Konto zu sperren oder zu löschen ist
 *    ausgeschlossen — nicht aus Bevormundung, sondern weil der letzte
 *    Systemverantwortliche sonst versehentlich den Zugang zur eigenen
 *    Installation verliert und niemand ihn wiederherstellen kann.
 *
 *  • **Die letzte Systemverantwortung ist geschützt.** Dieselbe Überlegung,
 *    nur über mehrere Konten hinweg: es muss immer mindestens ein aktives
 *    Konto geben, das Rollen vergeben kann.
 *
 *  • **Sperren beendet alle Sitzungen.** Ein gesperrtes Konto mit gültigem
 *    Zugangstoken bliebe bis zu fünfzehn Minuten handlungsfähig. Bei einer
 *    Sperrung ist genau das der Zeitraum, den man nicht will.
 *
 *  • **Gelöscht wird weich.** Ein Benutzer hängt an Aktivitäten, Nachrichten,
 *    Bewertungen und Prüfprotokoll-Einträgen; ein hartes Löschen risse überall
 *    Lücken. `deletedAt` nimmt ihm den Zugang, lässt die Historie aber lesbar.
 */

export interface UserListFilter {
  organizationId: string;
  q?: string;
  role?: UserRole;
  status?: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
  includeDeleted?: boolean;
}

export async function listUsers(filter: UserListFilter) {
  const where: Prisma.UserWhereInput = {
    organizationId: filter.organizationId,
    ...(filter.includeDeleted ? {} : { deletedAt: null }),
    ...(filter.role ? { role: filter.role } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.q
      ? {
          OR: [
            { firstName: { contains: filter.q, mode: 'insensitive' } },
            { lastName: { contains: filter.q, mode: 'insensitive' } },
            { email: { contains: filter.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  return prisma.user.findMany({
    where,
    orderBy: [{ role: 'desc' }, { lastName: 'asc' }],
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      role: true,
      status: true,
      avatarUrl: true,
      locale: true,
      twoFactorEnabled: true,
      lastLoginAt: true,
      lockedUntil: true,
      createdAt: true,
      deletedAt: true,
      customer: { select: { id: true, number: true } },
      employee: { select: { id: true, employeeNumber: true } },
    },
  });
}

async function findOwn(organizationId: string, userId: string) {
  const user = await prisma.user.findFirst({ where: { id: userId, organizationId } });
  if (!user) throw new NotFoundError('Benutzerkonto');
  return user;
}

interface Actor {
  organizationId: string;
  actorId: string;
  actorRole: ActorRole;
  ip?: string | null;
}

export async function updateUser({
  organizationId,
  actorId,
  ip,
  userId,
  input,
}: Omit<Actor, 'actorRole'> & { userId: string; input: UpdateUserInput }) {
  const before = await findOwn(organizationId, userId);

  if (userId === actorId && input.status && input.status !== 'ACTIVE') {
    throw new BusinessRuleError(
      'Das eigene Konto lässt sich nicht sperren. Bitten Sie eine andere berechtigte Person darum.',
    );
  }

  if (input.status && input.status !== 'ACTIVE') {
    await assertNotLastSuperAdmin(organizationId, before.id, before.role);
  }

  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
        ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
        ...(input.phone !== undefined ? { phone: input.phone ?? null } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.notifyByEmail !== undefined ? { notifyByEmail: input.notifyByEmail } : {}),
        ...(input.notifyBySms !== undefined ? { notifyBySms: input.notifyBySms } : {}),
      },
    });

    // Eine Sperre muss sofort wirken, nicht erst nach Ablauf des Zugangstokens.
    if (input.status && input.status !== 'ACTIVE') {
      await revokeAllSessions(userId);
    }

    await audit.updated({
      organizationId,
      userId: actorId,
      entity: 'User',
      entityId: userId,
      summary: `Konto ${user.email} geändert`,
      changes: diff(
        before as unknown as Record<string, unknown>,
        user as unknown as Record<string, unknown>,
      ),
      ip,
    });

    return user;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictError('Diese E-Mail-Adresse ist bereits vergeben.');
    }
    throw error;
  }
}

/**
 * Rolle zuweisen.
 *
 * Drei Sperren, die alle denselben Zweck haben — verhindern, dass sich jemand
 * Rechte verschafft oder die Installation unbedienbar macht:
 *  1. Nur bis zur eigenen Stufe (`assignableRoles`).
 *  2. Nicht die eigene Rolle.
 *  3. Nicht die letzte aktive Systemverantwortung herabstufen.
 */
export async function assignRole({
  organizationId,
  actorId,
  actorRole,
  ip,
  userId,
  role,
}: Actor & { userId: string; role: UserRole }) {
  const target = await findOwn(organizationId, userId);

  if (userId === actorId) {
    throw new BusinessRuleError(
      'Die eigene Rolle lässt sich nicht ändern — sonst könnte man sich selbst höherstufen.',
    );
  }

  const allowed = assignableRoles(actorRole);
  if (!allowed.includes(role)) {
    throw new ForbiddenError(
      `Sie können höchstens die Rolle „${ROLE_LABELS[allowed[allowed.length - 1] ?? 'CUSTOMER']}" vergeben.`,
    );
  }
  if (!allowed.includes(target.role)) {
    throw new ForbiddenError(
      `Konten mit der Rolle „${ROLE_LABELS[target.role]}" können Sie nicht ändern.`,
    );
  }

  if (target.role === 'SUPER_ADMIN' && role !== 'SUPER_ADMIN') {
    await assertNotLastSuperAdmin(organizationId, target.id, target.role);
  }

  const user = await prisma.user.update({ where: { id: userId }, data: { role } });

  // Die Rolle steckt im Zugangstoken. Ohne Widerruf behielte die Person ihre
  // alten Rechte bis zu fünfzehn Minuten — bei einer Herabstufung genau die
  // Zeit, die man nicht will.
  await revokeAllSessions(userId);

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'User',
    entityId: userId,
    summary: `Rolle von ${user.email}: ${ROLE_LABELS[target.role]} → ${ROLE_LABELS[role]}`,
    changes: { role: { from: target.role, to: role } },
    ip,
  });

  return user;
}

export async function deleteUser({
  organizationId,
  actorId,
  ip,
  userId,
}: Omit<Actor, 'actorRole'> & { userId: string }) {
  const user = await findOwn(organizationId, userId);

  if (userId === actorId) {
    throw new BusinessRuleError('Das eigene Konto lässt sich nicht löschen.');
  }
  if (user.deletedAt) throw new BusinessRuleError('Dieses Konto liegt bereits im Papierkorb.');

  await assertNotLastSuperAdmin(organizationId, user.id, user.role);

  await prisma.user.update({
    where: { id: userId },
    data: { deletedAt: new Date(), status: 'DISABLED' },
  });
  await revokeAllSessions(userId);

  await audit.deleted({
    organizationId,
    userId: actorId,
    entity: 'User',
    entityId: userId,
    summary: `Konto ${user.email} gelöscht (wiederherstellbar)`,
    ip,
  });
}

export async function restoreUser({
  organizationId,
  actorId,
  ip,
  userId,
}: Omit<Actor, 'actorRole'> & { userId: string }) {
  const user = await findOwn(organizationId, userId);
  if (!user.deletedAt) throw new BusinessRuleError('Dieses Konto liegt nicht im Papierkorb.');

  const restored = await prisma.user.update({
    where: { id: userId },
    // Gesperrt zurück: wer wiederherstellt, soll bewusst entsperren.
    data: { deletedAt: null, status: 'SUSPENDED' },
  });

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: 'User',
    entityId: userId,
    summary: `Konto ${user.email} wiederhergestellt (gesperrt)`,
    ip,
  });

  return restored;
}

/**
 * Es muss immer mindestens ein aktives Konto geben, das Rollen vergeben kann.
 *
 * Ohne diese Prüfung liesse sich die einzige Systemverantwortung sperren,
 * herabstufen oder löschen — und danach könnte niemand mehr Rollen vergeben,
 * also auch niemand den Zustand beheben. Der einzige Ausweg wäre ein Eingriff
 * in die Datenbank.
 */
async function assertNotLastSuperAdmin(
  organizationId: string,
  userId: string,
  role: UserRole,
): Promise<void> {
  if (role !== 'SUPER_ADMIN') return;

  const others = await prisma.user.count({
    where: {
      organizationId,
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      deletedAt: null,
      id: { not: userId },
    },
  });

  if (others === 0) {
    throw new BusinessRuleError(
      'Dies ist die letzte aktive Systemverantwortung. Ernennen Sie zuerst eine weitere — sonst kann danach niemand mehr Rollen vergeben.',
    );
  }
}
