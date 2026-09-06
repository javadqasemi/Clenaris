import 'server-only';

import type { NotificationChannel } from '@prisma/client';

import { prisma } from '@/lib/db';
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

/** Interne Benachrichtigung an alle Admins/Manager (neue Buchung, neuer Lead). */
export async function notifyStaff(params: {
  organizationId: string;
  title: string;
  body: string;
  link?: string;
  emailContent?: EmailContent;
  roles?: ('ADMIN' | 'MANAGER')[];
}): Promise<void> {
  const staff = await prisma.user.findMany({
    where: {
      organizationId: params.organizationId,
      role: { in: params.roles ?? ['ADMIN', 'MANAGER'] },
      status: 'ACTIVE',
      deletedAt: null,
    },
    select: { id: true, email: true },
  });

  await Promise.allSettled(
    staff.map((member) =>
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
