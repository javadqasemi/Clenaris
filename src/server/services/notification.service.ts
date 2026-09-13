import 'server-only';

import type { NotificationChannel, UserRole } from '@prisma/client';

import { prisma } from '@/lib/db';
import { can, type Permission } from '@/lib/auth/rbac';
import { sendEmail } from '@/lib/email/client';
import { sendSms } from '@/lib/sms/client';
import type { EmailContent } from '@/lib/email/templates';

/**
 * Benachrichtigungs-Dispatcher.
 *
 * Architekturentscheid: Ein einziger Einstiegspunkt für alle ausgehenden
 * Nachrichten. Er respektiert die Kanalpräferenzen der Empfängerin bzw. des
 * Empfängers, protokolliert jeden Versand und schluckt Transportfehler.
 * Domänenservices rufen `notify()` auf und müssen weder Resend noch Twilio
 * kennen — das hält die Geschäftslogik testbar.
 */

/**
 * Wer im Betrieb arbeitet — die Vorgabe für interne Meldungen.
 *
 * Mitarbeitende stehen bewusst *nicht* darin: sie erhalten Meldungen zu ihren
 * eigenen Einsätzen (über `notifyAssignees`), nicht zu jedem Vorgang im Büro.
 */
const STAFF_ROLES: UserRole[] = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'];

export interface NotifyInput {
  userId?: string | null;
  /** Direkte Adressierung, wenn kein Benutzerkonto existiert (Gastbuchung). */
  email?: string | null;
  phone?: string | null;

  channels: NotificationChannel[];
  /** In-App-Titel und -Text. */
  title: string;
  body: string;
  link?: string | null;

  emailContent?: EmailContent | null;
  emailAttachments?: { filename: string; content: Buffer }[];
  smsBody?: string | null;

  entity?: string;
  entityId?: string;
  /** Marketing-Nachrichten nur mit Einwilligung. */
  isMarketing?: boolean;
}

export async function notify(input: NotifyInput): Promise<void> {
  const user = input.userId
    ? await prisma.user.findUnique({
        where: { id: input.userId },
        select: {
          id: true,
          email: true,
          phone: true,
          notifyByEmail: true,
          notifyBySms: true,
          marketingOptIn: true,
          status: true,
        },
      })
    : null;

  // Gesperrte Konten erhalten keine Nachrichten mehr.
  if (user && user.status !== 'ACTIVE') return;
  if (input.isMarketing && user && !user.marketingOptIn) return;

  const email = input.email ?? user?.email ?? null;
  const phone = input.phone ?? user?.phone ?? null;

  const tasks: Promise<unknown>[] = [];

  // --- In-App ---------------------------------------------------------------
  if (input.channels.includes('IN_APP') && user) {
    tasks.push(
      prisma.notification.create({
        data: {
          userId: user.id,
          channel: 'IN_APP',
          status: 'DELIVERED',
          title: input.title,
          body: input.body,
          link: input.link ?? null,
          sentAt: new Date(),
          meta: input.entity ? { entity: input.entity, entityId: input.entityId } : undefined,
        },
      }),
    );
  }

  // --- E-Mail ---------------------------------------------------------------
  const emailAllowed = !user || user.notifyByEmail;
  if (input.channels.includes('EMAIL') && email && emailAllowed && input.emailContent) {
    tasks.push(
      sendEmail({
        to: email,
        subject: input.emailContent.subject,
        html: input.emailContent.html,
        attachments: input.emailAttachments,
        entity: input.entity,
        entityId: input.entityId,
      }),
    );
  }

  // --- SMS ------------------------------------------------------------------
  const smsAllowed = !user || user.notifyBySms;
  if (input.channels.includes('SMS') && phone && smsAllowed && input.smsBody) {
    tasks.push(
      sendSms({
        to: phone,
        body: input.smsBody,
        entity: input.entity,
        entityId: input.entityId,
      }),
    );
  }

  await Promise.allSettled(tasks);
}

/**
 * Interne Benachrichtigung an das Büro (neue Buchung, neuer Lead, neue
 * Nachricht).
 *
 * Zwei Entscheide, die hier zusammenkommen:
 *
 *  • **SUPER_ADMIN ist Empfängerin, nicht Ausnahme.** Die Liste stand früher
 *    fest auf `['ADMIN', 'MANAGER']`. In kleinen Betrieben ist das einzige
 *    Verwaltungskonto aber ein SUPER_ADMIN — dort kam schlicht *nie* eine
 *    Meldung an, und das sah aus, als sei die Glocke kaputt. Wer alles darf,
 *    darf auch alles erfahren.
 *
 *  • **Wer die Sache nicht sehen darf, bekommt keine Meldung darüber.** Über
 *    `permission` lässt sich der Empfängerkreis an die Rechtematrix binden
 *    statt an eine ausgeschriebene Rollenliste. Eine Zahlungsmeldung mit
 *    `permission: 'payment:read'` erreicht damit niemanden, der Finanzen nicht
 *    einsehen darf — und sie erreicht ihn auch dann nicht, wenn morgen eine
 *    Rolle dazukommt. Eine Meldung, deren Link ins Leere führt, ist schlimmer
 *    als keine: sie erzeugt eine Handlung, die mit einem 403 endet.
 */
export async function notifyStaff(params: {
  organizationId: string;
  title: string;
  body: string;
  link?: string;
  emailContent?: EmailContent;
  /** Ohne Angabe: die gesamte Verwaltung inklusive Systemverantwortung. */
  roles?: UserRole[];
  /** Zusätzliche Einschränkung über die Rechtematrix. */
  permission?: Permission;
  /** Die auslösende Person selbst nicht benachrichtigen. */
  excludeUserId?: string;
}): Promise<void> {
  const roles = params.roles ?? STAFF_ROLES;

  const staff = await prisma.user.findMany({
    where: {
      organizationId: params.organizationId,
      role: { in: roles },
      status: 'ACTIVE',
      deletedAt: null,
      ...(params.excludeUserId ? { id: { not: params.excludeUserId } } : {}),
    },
    select: { id: true, role: true },
  });

  const recipients = params.permission
    ? staff.filter((member) => can(member.role, params.permission!))
    : staff;

  await Promise.allSettled(
    recipients.map((member) =>
      notify({
        userId: member.id,
        channels: params.emailContent ? ['IN_APP', 'EMAIL'] : ['IN_APP'],
        title: params.title,
        body: params.body,
        link: params.link,
        emailContent: params.emailContent,
      }),
    ),
  );
}

export async function markNotificationRead(userId: string, notificationId: string) {
  await prisma.notification.updateMany({
    where: { id: notificationId, userId, readAt: null },
    data: { readAt: new Date(), status: 'READ' },
  });
}

export async function markAllNotificationsRead(userId: string) {
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date(), status: 'READ' },
  });
}

export async function getUnreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null, channel: 'IN_APP' } });
}
