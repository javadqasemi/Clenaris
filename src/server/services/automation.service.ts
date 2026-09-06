import 'server-only';

import { prisma, toNumber } from '@/lib/db';
import { absoluteUrl } from '@/lib/utils';
import {
  birthdayEmail,
  bookingReminderEmail,
  reviewRequestEmail,
} from '@/lib/email/templates';
import { smsTemplates } from '@/lib/sms/client';

import { notify } from './notification.service';

/**
 * Zeitgesteuerte Abläufe.
 *
 * Architekturentscheid: Alle wiederkehrenden Aufgaben laufen über Vercel Cron
 * gegen `/api/cron/*` — kein eigener Worker, keine Queue. Bei einem KMU mit
 * einigen hundert Vorgängen pro Monat ist das die einfachste Lösung, die
 * funktioniert. Jeder Lauf ist idempotent: gesendete Erinnerungen sind am
 * Datensatz vermerkt, sodass ein doppelter Aufruf keine zweite E-Mail auslöst.
 */

// ---------------------------------------------------------------------------
//  Terminerinnerungen
// ---------------------------------------------------------------------------

export async function sendBookingReminders(organizationId: string): Promise<{
  reminded24h: number;
  reminded2h: number;
}> {
  const now = new Date();

  const [in24h, in2h] = await Promise.all([
    // Termine in 20–28 Stunden, die noch keine Tageserinnerung erhalten haben.
    prisma.booking.findMany({
      where: {
        organizationId,
        deletedAt: null,
        status: 'CONFIRMED',
        reminder24hSentAt: null,
        scheduledStart: {
          gte: new Date(now.getTime() + 20 * 3_600_000),
          lte: new Date(now.getTime() + 28 * 3_600_000),
        },
      },
      include: {
        customer: { include: { user: { select: { id: true } } } },
        address: true,
        items: { select: { name: true }, take: 1 },
      },
      take: 200,
    }),
    prisma.booking.findMany({
      where: {
        organizationId,
        deletedAt: null,
        status: 'CONFIRMED',
        reminder2hSentAt: null,
        scheduledStart: {
          gte: new Date(now.getTime() + 1 * 3_600_000),
          lte: new Date(now.getTime() + 3 * 3_600_000),
        },
      },
      include: {
        customer: { include: { user: { select: { id: true } } } },
        address: true,
        items: { select: { name: true }, take: 1 },
      },
      take: 100,
    }),
  ]);

  const sendReminder = async (
    booking: (typeof in24h)[number],
    hoursBefore: number,
  ): Promise<void> => {
    const address = booking.address
      ? `${booking.address.street} ${booking.address.streetNo ?? ''}, ${booking.address.postalCode} ${booking.address.city}`.replace(
          /\s+/g,
          ' ',
        )
      : '—';

    await notify({
      userId: booking.customer.user?.id ?? null,
      email: booking.customer.email,
      phone: booking.customer.mobile ?? booking.customer.phone,
      // Zwei Stunden vorher zusätzlich per SMS — E-Mail wird dann oft nicht mehr gelesen.
      channels: hoursBefore <= 3 ? ['IN_APP', 'SMS'] : ['IN_APP', 'EMAIL'],
      title: 'Terminerinnerung',
      body: `Ihr Reinigungstermin beginnt in ca. ${hoursBefore} Stunden.`,
      link: `/konto/buchungen/${booking.id}`,
      emailContent: bookingReminderEmail({
        firstName: booking.customer.firstName,
        bookingNumber: booking.number,
        serviceName: booking.items[0]?.name ?? 'Reinigung',
        scheduledStart: booking.scheduledStart,
        scheduledEnd: booking.scheduledEnd,
        address,
        grossTotal: toNumber(booking.grossTotal),
        manageUrl: absoluteUrl(`/buchung/${booking.confirmationToken}`),
        hoursBefore,
      }),
      smsBody: smsTemplates.bookingReminder({
        date: booking.scheduledStart.toLocaleDateString('de-CH'),
        time: booking.scheduledStart.toLocaleTimeString('de-CH', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Europe/Zurich',
        }),
        company: 'Clenaris',
      }),
      entity: 'Booking',
      entityId: booking.id,
    });
  };

  for (const booking of in24h) {
    await sendReminder(booking, 24);
    await prisma.booking.update({
      where: { id: booking.id },
      data: { reminder24hSentAt: new Date() },
    });
  }

  for (const booking of in2h) {
    await sendReminder(booking, 2);
    await prisma.booking.update({
      where: { id: booking.id },
      data: { reminder2hSentAt: new Date() },
    });
  }

  return { reminded24h: in24h.length, reminded2h: in2h.length };
}

// ---------------------------------------------------------------------------
//  Erinnerungen für das Team
// ---------------------------------------------------------------------------

export async function sendCrewReminders(organizationId: string): Promise<number> {
  const now = new Date();

  const jobs = await prisma.job.findMany({
    where: {
      organizationId,
      deletedAt: null,
      status: { in: ['SCHEDULED', 'DISPATCHED'] },
      scheduledStart: {
        gte: new Date(now.getTime() + 1 * 3_600_000),
        lte: new Date(now.getTime() + 2 * 3_600_000),
      },
    },
    include: {
      address: true,
      assignments: { include: { employee: { include: { user: { select: { id: true, phone: true } } } } } },
    },
    take: 100,
  });

  let sent = 0;

  for (const job of jobs) {
    const address = job.address
      ? `${job.address.street} ${job.address.streetNo ?? ''}, ${job.address.postalCode} ${job.address.city}`.replace(
          /\s+/g,
          ' ',
        )
      : '—';

    for (const assignment of job.assignments) {
      await notify({
        userId: assignment.employee.user.id,
        channels: ['IN_APP', 'SMS'],
        title: 'Einsatz beginnt bald',
        body: `${job.title} · ${address}`,
        link: `/portal/einsaetze/${job.id}`,
        smsBody: smsTemplates.jobReminder({
          time: job.scheduledStart.toLocaleTimeString('de-CH', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Europe/Zurich',
          }),
          address,
        }),
        entity: 'Job',
        entityId: job.id,
      });
      sent++;
    }
  }

  return sent;
}

// ---------------------------------------------------------------------------
//  Bewertungsanfragen
// ---------------------------------------------------------------------------

export async function requestReviews(organizationId: string): Promise<number> {
  const now = new Date();

  // 24 bis 72 Stunden nach Abschluss — früh genug für die Erinnerung,
  // spät genug, damit die Kundschaft das Ergebnis gesehen hat.
  const bookings = await prisma.booking.findMany({
    where: {
      organizationId,
      deletedAt: null,
      status: 'COMPLETED',
      completedAt: {
        gte: new Date(now.getTime() - 72 * 3_600_000),
        lte: new Date(now.getTime() - 24 * 3_600_000),
      },
      reviews: { none: {} },
    },
    include: {
      customer: { include: { user: { select: { id: true } } } },
      items: { select: { name: true }, take: 1 },
    },
    take: 100,
  });

  let sent = 0;

  for (const booking of bookings) {
    // Doppelte Anfragen verhindern: nur eine Bitte pro Buchung.
    const alreadyAsked = await prisma.emailLog.findFirst({
      where: { entity: 'Booking', entityId: booking.id, templateKey: 'review_request' },
    });
    if (alreadyAsked) continue;

    await notify({
      userId: booking.customer.user?.id ?? null,
      email: booking.customer.email,
      channels: ['IN_APP', 'EMAIL'],
      title: 'Wie war unsere Reinigung?',
      body: 'Ihre Rückmeldung dauert eine Minute und hilft uns weiter.',
      link: `/konto/bewertungen/neu?buchung=${booking.id}`,
      emailContent: reviewRequestEmail({
        firstName: booking.customer.firstName,
        serviceName: booking.items[0]?.name ?? 'Reinigung',
        reviewUrl: absoluteUrl(`/konto/bewertungen/neu?buchung=${booking.id}`),
      }),
      entity: 'Booking',
      entityId: booking.id,
    });

    sent++;
  }

  return sent;
}

// ---------------------------------------------------------------------------
//  Geburtstage
// ---------------------------------------------------------------------------

export async function sendBirthdayGreetings(organizationId: string): Promise<number> {
  const today = new Date();
  const month = today.getMonth() + 1;
  const day = today.getDate();

  // `EXTRACT` statt Datumsvergleich: das Geburtsjahr spielt keine Rolle.
  const customers = await prisma.$queryRaw<
    { id: string; firstName: string; email: string; userId: string | null }[]
  >`
    SELECT c.id, c."firstName", c.email, c."userId"
    FROM customers c
    JOIN users u ON u.id = c."userId"
    WHERE c."organizationId" = ${organizationId}
      AND c."deletedAt" IS NULL
      AND c.birthday IS NOT NULL
      AND EXTRACT(MONTH FROM c.birthday) = ${month}
      AND EXTRACT(DAY FROM c.birthday) = ${day}
      AND u."marketingOptIn" = true
    LIMIT 100
  `;

  let sent = 0;

  for (const customer of customers) {
    await notify({
      userId: customer.userId,
      email: customer.email,
      channels: ['EMAIL'],
      title: 'Alles Gute zum Geburtstag',
      body: 'Wir wünschen Ihnen alles Gute.',
      emailContent: birthdayEmail({
        firstName: customer.firstName,
        couponCode: 'WILLKOMMEN20',
      }),
      entity: 'Customer',
      entityId: customer.id,
      // Geburtstagsgrüsse sind Werbung — nur mit Einwilligung.
      isMarketing: true,
    });
    sent++;
  }

  return sent;
}

// ---------------------------------------------------------------------------
//  Nachfassen bei stillen Leads
// ---------------------------------------------------------------------------

export async function createFollowUpTasks(organizationId: string): Promise<number> {
  const threshold = new Date(Date.now() - 3 * 86_400_000);

  const leads = await prisma.lead.findMany({
    where: {
      organizationId,
      deletedAt: null,
      status: { in: ['NEW', 'CONTACTED'] },
      createdAt: { lt: threshold },
      tasks: { none: { status: { in: ['OPEN', 'IN_PROGRESS'] } } },
    },
    include: { owner: { select: { userId: true } } },
    take: 50,
  });

  if (leads.length === 0) return 0;

  // Ohne zugewiesene Person landet die Aufgabe bei der Administration.
  const fallback = await prisma.user.findFirst({
    where: { organizationId, role: { in: ['ADMIN', 'MANAGER'] }, status: 'ACTIVE' },
    select: { id: true },
  });

  await prisma.task.createMany({
    data: leads.map((lead) => ({
      title: `Nachfassen: ${lead.company ?? `${lead.firstName} ${lead.lastName}`}`,
      description: `Die Anfrage ist seit ${Math.floor((Date.now() - lead.createdAt.getTime()) / 86_400_000)} Tagen offen. Bitte telefonisch nachfassen.`,
      priority: lead.score >= 70 ? 'HIGH' : 'NORMAL',
      dueAt: new Date(Date.now() + 86_400_000),
      leadId: lead.id,
      assigneeId: lead.owner?.userId ?? fallback?.id ?? null,
    })),
  });

  return leads.length;
}

// ---------------------------------------------------------------------------
//  Fällige Aufgaben
// ---------------------------------------------------------------------------

export async function sendTaskReminders(): Promise<number> {
  const now = new Date();

  const tasks = await prisma.task.findMany({
    where: {
      status: { in: ['OPEN', 'IN_PROGRESS'] },
      reminderSent: false,
      assigneeId: { not: null },
      OR: [
        { reminderAt: { lte: now } },
        { reminderAt: null, dueAt: { lte: new Date(now.getTime() + 86_400_000), gte: now } },
      ],
    },
    take: 100,
  });

  for (const task of tasks) {
    await notify({
      userId: task.assigneeId,
      channels: ['IN_APP'],
      title: 'Aufgabe fällig',
      body: task.title,
      link: '/admin/aufgaben',
      entity: 'Task',
      entityId: task.id,
    });

    await prisma.task.update({ where: { id: task.id }, data: { reminderSent: true } });
  }

  return tasks.length;
}
