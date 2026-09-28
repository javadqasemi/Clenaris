import "server-only";

import { Prisma, type UserRole } from "@prisma/client";

import { prisma, type Tx } from "@/lib/db";
import { audit, diff, recordAuditInTx } from "@/lib/audit";
import { recordSecurityEvent } from "@/lib/security/record";
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@/lib/errors";
import { assignableRoles, ROLE_LABELS, type ActorRole } from "@/lib/auth/rbac";
import type { UpdateUserInput } from "@/lib/validation/users";

import { revokeAllSessions } from "@/lib/auth/session";

import { ensureCustomerProfile } from "./profile.service";

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
  status?: "PENDING" | "ACTIVE" | "SUSPENDED" | "DISABLED";
  includeDeleted?: boolean;
  /** Nur gelöschte Konten — der Papierkorb-Reiter der Maske. */
  nurGeloescht?: boolean;
  page?: number;
  pageSize?: number;
}

/**
 * Benutzerkonten, seitenweise (Phase 23, 2026-09-27).
 *
 * Bis hierher lud die Liste **alle** Konten samt gelöschten und trennte sie
 * erst im Speicher. Zu den Konten gehören auch die Kundschaft, die sich auf
 * der Website registriert — die Liste wächst also mit dem Kundenstamm, nicht
 * mit dem Personal. Jetzt entscheidet die Datenbank: Filter, Zählung und
 * eine Seite von höchstens 100 Konten.
 */
export async function listUsers(filter: UserListFilter): Promise<{ items: Awaited<ReturnType<typeof kontenLaden>>; total: number }> {
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 50));
  const page = Math.max(1, filter.page ?? 1);
  const where = kontenFilter(filter);
  const [items, total] = await Promise.all([kontenLaden(where, (page - 1) * pageSize, pageSize), prisma.user.count({ where })]);
  return { items, total };
}

function kontenFilter(filter: UserListFilter): Prisma.UserWhereInput {
  return {
    organizationId: filter.organizationId,
    ...(filter.nurGeloescht ? { deletedAt: { not: null } } : filter.includeDeleted ? {} : { deletedAt: null }),
    ...(filter.role ? { role: filter.role } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.q
      ? {
          OR: [
            { firstName: { contains: filter.q, mode: "insensitive" } },
            { lastName: { contains: filter.q, mode: "insensitive" } },
            { email: { contains: filter.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
}

function kontenLaden(where: Prisma.UserWhereInput, skip: number, take: number) {
  return prisma.user.findMany({
    where,
    skip,
    take,
    // Nach Name, nicht nach Rolle. Die Liste war nach Rolle gruppiert, und
    // das hatte eine tückische Folge: Ein Rollenwechsel verschob die Zeile an
    // eine andere Stelle, alle anderen rückten nach — und die Tabelle sah
    // aus, als hätte *jedes* Konto die Rolle gewechselt. Wer danach „die
    // Zeile" korrigieren wollte, traf eine andere Person. Ein Name bleibt, wo
    // er ist; die Rolle steht in der Spalte daneben.
    // `id` zuletzt: Zwei „Anna Keller" hätten sonst beim Blättern keine feste
    // Reihenfolge, und dieselbe Person erschiene auf zwei Seiten.
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
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
  const user = await prisma.user.findFirst({
    where: { id: userId, organizationId },
  });
  if (!user) throw new NotFoundError("Benutzerkonto");
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
}: Omit<Actor, "actorRole"> & { userId: string; input: UpdateUserInput }) {
  const before = await findOwn(organizationId, userId);

  if (userId === actorId && input.status && input.status !== "ACTIVE") {
    throw new BusinessRuleError(
      "Das eigene Konto lässt sich nicht sperren. Bitten Sie eine andere berechtigte Person darum.",
    );
  }

  try {
    const user = await prisma.$transaction(async (tx) => {
      if (input.status && input.status !== "ACTIVE") {
        await assertNotLastSuperAdmin(tx, organizationId, before.id);
      }
      return tx.user.update({
        where: { id: userId },
        data: {
          ...(input.firstName !== undefined
            ? { firstName: input.firstName }
            : {}),
          ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
          ...(input.phone !== undefined ? { phone: input.phone ?? null } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.locale !== undefined ? { locale: input.locale } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.notifyByEmail !== undefined
            ? { notifyByEmail: input.notifyByEmail }
            : {}),
          ...(input.notifyBySms !== undefined
            ? { notifyBySms: input.notifyBySms }
            : {}),
          ...(input.avatarUrl !== undefined
            ? { avatarUrl: input.avatarUrl || null }
            : {}),
          ...(input.mustChangePassword !== undefined
            ? { mustChangePassword: input.mustChangePassword }
            : {}),
        },
      });
    });

    // Eine Sperre muss sofort wirken, nicht erst nach Ablauf des Zugangstokens.
    // Dasselbe gilt für den erzwungenen Passwortwechsel: Er greift bei der
    // nächsten Anmeldung — die es ohne Sitzungsende erst in einer Viertelstunde
    // gäbe.
    if (
      (input.status && input.status !== "ACTIVE") ||
      input.mustChangePassword === true
    ) {
      await revokeAllSessions(userId);
    }

    await audit.updated({
      organizationId,
      userId: actorId,
      entity: "User",
      entityId: userId,
      summary: `Konto ${user.email} geändert`,
      changes: diff(
        before as unknown as Record<string, unknown>,
        user as unknown as Record<string, unknown>,
      ),
      ip,
    });

    /**
     * Nur der Statuswechsel erzeugt ein Sicherheitsereignis, nicht jede
     * Änderung an einem Konto.
     *
     * Eine geänderte Telefonnummer gehört ins Prüfprotokoll und nirgendwo
     * sonst hin. Stilllegen und Wiederaktivieren sind etwas anderes: Sie
     * entscheiden, ob sich jemand anmelden kann, und beide Richtungen sind
     * interessant — die Sperre, weil sie jemanden aussperrt, die Aufhebung,
     * weil sie jemandem den Zugang zurückgibt.
     */
    if (input.status !== undefined && input.status !== before.status) {
      await recordSecurityEvent({
        organizationId,
        userId,
        kind: input.status === "ACTIVE" ? "USER_REACTIVATED" : "USER_SUSPENDED",
        summary:
          input.status === "ACTIVE"
            ? "Konto wieder aktiviert"
            : `Konto stillgelegt (${input.status})`,
        context: { von: before.status, zu: input.status, durch: actorId },
        ip,
      });
    }

    return user;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ConflictError("Diese E-Mail-Adresse ist bereits vergeben.");
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
 *
 * Und eine vierte mit anderem Zweck — Konto und Profil zusammenhalten:
 *  4. **Nicht auf Kundschaft, solange die Personalakte aktiv ist.** Die Rolle
 *     allein nimmt die Person nicht aus dem Plan; dafür gibt es das
 *     Stilllegen der Akte, das geplante Einsätze prüft und den Zugang
 *     entzieht. Wer die Reihenfolge umgeht, hätte Kundschaft im Team.
 *     Umgekehrt bekommt ein Konto, das Kundschaft wird, einen Kundendatensatz
 *     — sonst stünde es im Kundenbereich vor einer leeren Tür.
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
      "Die eigene Rolle lässt sich nicht ändern — sonst könnte man sich selbst höherstufen.",
    );
  }

  const allowed = assignableRoles(actorRole);
  if (!allowed.includes(role)) {
    throw new ForbiddenError(
      `Sie können höchstens die Rolle „${ROLE_LABELS[allowed[allowed.length - 1] ?? "CUSTOMER"]}" vergeben.`,
    );
  }
  if (!allowed.includes(target.role)) {
    throw new ForbiddenError(
      `Konten mit der Rolle „${ROLE_LABELS[target.role]}" können Sie nicht ändern.`,
    );
  }

  if (role === "CUSTOMER") {
    const activeEmployee = await prisma.employee.findFirst({
      where: { userId, active: true },
      select: { employeeNumber: true },
    });
    if (activeEmployee) {
      throw new BusinessRuleError(
        `Dieses Konto hat eine aktive Personalakte (${activeEmployee.employeeNumber}). ` +
          "Solange sie aktiv ist, stünde die Person weiterhin in Einsatzplanung und Team. " +
          "Legen Sie die Personalakte zuerst still (Mitarbeitende → Akte → Stilllegen), " +
          "dann lässt sich die Rolle auf Kundschaft setzen.",
      );
    }
  }

  const user = await prisma.$transaction(async (tx) => {
    if (role !== "SUPER_ADMIN")
      await assertNotLastSuperAdmin(tx, organizationId, target.id);
    const updated = await tx.user.update({
      where: { id: userId },
      data: { role },
    });
    if (role === "CUSTOMER") {
      await ensureCustomerProfile(tx, { organizationId, userId });
    }
    // Eine vergebene Rolle ohne Protokolleintrag darf es nicht geben — der
    // Eintrag steht deshalb in derselben Transaktion (`recordAuditInTx`).
    await recordAuditInTx(tx, {
      organizationId,
      userId: actorId,
      action: "PERMISSION_CHANGE",
      entity: "User",
      entityId: userId,
      summary: `Rolle von ${updated.email}: ${ROLE_LABELS[target.role]} → ${ROLE_LABELS[role]}`,
      changes: { role: { from: target.role, to: role } },
      ip,
    });
    return updated;
  });

  // Die Rolle steckt im Zugangstoken. Ohne Widerruf behielte die Person ihre
  // alten Rechte bis zu fünfzehn Minuten — bei einer Herabstufung genau die
  // Zeit, die man nicht will.
  await revokeAllSessions(userId);

  /**
   * `CRITICAL` und damit bestätigungspflichtig — auch bei einer Herabstufung.
   *
   * Der Gedanke „nur Höherstufungen sind interessant" ist naheliegend und
   * falsch: Eine Herabstufung, die niemand veranlasst hat, ist genauso ein
   * Zeichen wie eine Höherstufung, und wer die Rechteverwaltung übernommen
   * hat, probiert beide Richtungen. Die Zeile steht am **betroffenen** Konto,
   * wer sie ausgelöst hat, steht im Zusammenhang.
   */
  await recordSecurityEvent({
    organizationId,
    userId,
    kind: "ROLE_ASSIGNED",
    summary: `Rolle geändert: ${ROLE_LABELS[target.role]} → ${ROLE_LABELS[role]}`,
    context: { von: target.role, zu: role, durch: actorId },
    ip,
  });

  await recordSecurityEvent({
    organizationId,
    userId,
    kind: "SESSIONS_REVOKED",
    summary: "Alle Sitzungen beendet — Rollenänderung",
    context: { durch: actorId },
    ip,
  });

  return user;
}

export async function deleteUser({
  organizationId,
  actorId,
  ip,
  userId,
}: Omit<Actor, "actorRole"> & { userId: string }) {
  const user = await findOwn(organizationId, userId);

  if (userId === actorId) {
    throw new BusinessRuleError("Das eigene Konto lässt sich nicht löschen.");
  }
  if (user.deletedAt)
    throw new BusinessRuleError("Dieses Konto liegt bereits im Papierkorb.");

  await prisma.$transaction(async (tx) => {
    await assertNotLastSuperAdmin(tx, organizationId, user.id);
    await tx.user.update({
      where: { id: userId },
      data: { deletedAt: new Date(), status: "DISABLED" },
    });
    // Ein Konto verschwindet nicht ohne Eintrag — in derselben Transaktion.
    await recordAuditInTx(tx, {
      organizationId,
      userId: actorId,
      action: "DELETE",
      entity: "User",
      entityId: userId,
      summary: `Konto ${user.email} gelöscht (wiederherstellbar)`,
      ip,
    });
  });
  await revokeAllSessions(userId);
}

export async function restoreUser({
  organizationId,
  actorId,
  ip,
  userId,
}: Omit<Actor, "actorRole"> & { userId: string }) {
  const user = await findOwn(organizationId, userId);
  if (!user.deletedAt)
    throw new BusinessRuleError("Dieses Konto liegt nicht im Papierkorb.");

  const restored = await prisma.user.update({
    where: { id: userId },
    // Gesperrt zurück: wer wiederherstellt, soll bewusst entsperren.
    data: { deletedAt: null, status: "SUSPENDED" },
  });

  await audit.updated({
    organizationId,
    userId: actorId,
    entity: "User",
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
  tx: Tx,
  organizationId: string,
  userId: string,
): Promise<void> {
  /**
   * In der Transaktion, hinter einer Sperre je Organisation (2026-09-27).
   *
   * Die Prüfung lief vorher vor dem Schreiben und ohne Sperre. Zwei
   * Systemverantwortliche, die sich gleichzeitig gegenseitig herabstufen,
   * sahen beide die andere Person noch als aktiv, beide schrieben — und es gab
   * keine mehr (nachgewiesen in `rbac.test.ts`: 200, 200). Jetzt nimmt jede
   * Änderung an einer Systemverantwortung zuerst dieselbe Sperre, liest den
   * Bestand danach und schreibt in derselben Transaktion. Die zweite Anfrage
   * wartet und sieht die erste als geschehen. Die Rolle des Ziels wird hier
   * ebenfalls frisch gelesen — die von vor der Transaktion kann überholt sein.
   */
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`systemverantwortung:${organizationId}`}))`;
  const ziel = await tx.user.findFirst({
    where: { id: userId, organizationId },
    select: { role: true },
  });
  if (ziel?.role !== "SUPER_ADMIN") return;

  const others = await tx.user.count({
    where: {
      organizationId,
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      deletedAt: null,
      id: { not: userId },
    },
  });

  if (others === 0) {
    throw new BusinessRuleError(
      "Dies ist die letzte aktive Systemverantwortung. Ernennen Sie zuerst eine weitere — sonst kann danach niemand mehr Rollen vergeben.",
    );
  }
}
