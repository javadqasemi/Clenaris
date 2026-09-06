import 'server-only';

import type { Booking, Frequency, Prisma } from '@prisma/client';

import { prisma, toNumber, type Tx } from '@/lib/db';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '@/lib/errors';
import { calculatePrice } from '@/lib/pricing/engine';
import { absoluteUrl, round2 } from '@/lib/utils';
import { orderByFor, resolveSort, type SortOrder } from '@/lib/sort';
import { randomToken } from '@/lib/auth/jwt';
import type { SessionUser } from '@/lib/auth/session';
import type { CreateBookingInput, UpdateBookingInput } from '@/lib/validation/booking';
import {
  bookingCancelledEmail,
  bookingConfirmedEmail,
  bookingReceivedEmail,
  bookingRescheduledEmail,
  newBookingInternalEmail,
} from '@/lib/email/templates';
import { smsTemplates } from '@/lib/sms/client';
import { audit } from '@/lib/audit';

import { nextNumber } from './numbering.service';
import { invalidateAvailability, isSlotBookable } from './availability.service';
import { notify, notifyStaff } from './notification.service';
import { createJobsForBooking } from './job.service';

/**
 * Buchungslogik.
 *
 * Architekturentscheide:
 *  1. Der Preis wird beim Anlegen serverseitig neu berechnet und als Snapshot
 *     an der Buchung gespeichert. Katalogänderungen dürfen bestehende Buchungen
 *     nie nachträglich verteuern.
 *  2. Buchung und daraus abgeleiteter Job entstehen in *einer* Transaktion.
 *     Eine bestätigte Buchung ohne Einsatz wäre ein Dispositionsloch.
 *  3. Serien werden rollierend materialisiert (12 Wochen im Voraus, per Cron
 *     nachgeführt) statt komplett — sonst entstehen bei „wöchentlich, unbefristet"
 *     unbegrenzt viele Datensätze.
 *  4. Stornofrist: 24 Stunden. Danach entscheidet das Büro manuell.
 */

const CANCELLATION_WINDOW_HOURS = 24;
const RECURRENCE_HORIZON_DAYS = 84; // 12 Wochen

export interface CreateBookingResult {
  booking: Booking;
  confirmationUrl: string;
  isNewCustomer: boolean;
}

/**
 * Legt eine Buchung an — funktioniert für eingeloggte Kunden und Gäste.
 */
export async function createBooking(params: {
  organizationId: string;
  input: CreateBookingInput;
  session: SessionUser | null;
  ip?: string;
}): Promise<CreateBookingResult> {
  const { organizationId, input, session } = params;

  // --- 1) Kunde auflösen oder anlegen --------------------------------------
  const { customerId, isNewCustomer, customerEmail, customerName, userId } =
    await resolveCustomer({ organizationId, input, session });

  // --- 2) Preis serverseitig berechnen -------------------------------------
  const customer = await prisma.customer.findUniqueOrThrow({
    where: { id: customerId },
    select: { discountPercent: true, blocked: true, blockedReason: true },
  });

  if (customer.blocked) {
    throw new BusinessRuleError(
      customer.blockedReason ??
        'Für dieses Kundenkonto sind zurzeit keine Online-Buchungen möglich. Bitte kontaktieren Sie uns.',
    );
  }

  const postalCode =
    input.address?.postalCode ??
    (input.addressId
      ? (await prisma.address.findUnique({ where: { id: input.addressId } }))?.postalCode
      : undefined);

  const breakdown = await calculatePrice(
    {
      serviceId: input.serviceId,
      squareMeters: input.squareMeters,
      rooms: input.rooms,
      bathrooms: input.bathrooms,
      windows: input.windows,
      propertyKind: input.propertyKind,
      frequency: input.frequency,
      extras: input.extras,
      scheduledStart: input.scheduledStart,
      postalCode: postalCode ?? null,
      hasPets: input.hasPets,
      manualHours: input.manualHours,
      couponCode: input.couponCode ?? null,
      customerDiscountPercent: toNumber(customer.discountPercent),
      urgent: input.urgent,
    },
    organizationId,
  );

  if (breakdown.onRequest) {
    throw new BusinessRuleError(
      'Für diese Dienstleistung erstellen wir eine individuelle Offerte. Bitte nutzen Sie das Offertformular.',
    );
  }

  // --- 3) Kapazität prüfen --------------------------------------------------
  const slotCheck = await isSlotBookable({
    organizationId,
    start: input.scheduledStart,
    durationMin: breakdown.durationMinutes,
    crewSize: breakdown.crewSize,
  });
  if (!slotCheck.ok) throw new BusinessRuleError(slotCheck.reason!);

  // --- 4) Buchung + Job in einer Transaktion -------------------------------
  const scheduledEnd = new Date(
    input.scheduledStart.getTime() + breakdown.durationMinutes * 60_000,
  );

  const booking = await prisma.$transaction(async (tx) => {
    const { number } = await nextNumber(tx, organizationId, 'booking');

    // Adresse übernehmen oder neu anlegen.
    const addressId = input.addressId ?? (await createAddress(tx, customerId, input));

    // Wiederholungsregel.
    let recurrenceRuleId: string | null = null;
    if (input.frequency !== 'ONCE' && input.recurrence) {
      const rule = await tx.recurrenceRule.create({
        data: {
          frequency: input.frequency,
          interval: input.recurrence.interval,
          weekdays: input.recurrence.weekdays,
          startDate: input.scheduledStart,
          endDate: input.recurrence.endDate ?? null,
          count: input.recurrence.count ?? null,
          generatedUntil: input.scheduledStart,
        },
      });
      recurrenceRuleId = rule.id;
    }

    const created = await tx.booking.create({
      data: {
        organizationId,
        number,
        customerId,
        addressId,
        propertyId: input.propertyId ?? null,
        status: 'PENDING',
        scheduledStart: input.scheduledStart,
        scheduledEnd,
        durationMin: breakdown.durationMinutes,
        crewSize: breakdown.crewSize,
        recurrenceRuleId,
        frequency: input.frequency,
        propertyKind: input.propertyKind,
        squareMeters: input.squareMeters ?? null,
        rooms: input.rooms ?? null,
        windows: input.windows ?? null,
        customerNote: input.customerNote ?? null,
        accessNote: input.accessNote ?? null,
        subtotal: breakdown.subtotal,
        extrasTotal: breakdown.extrasTotal,
        travelFee: breakdown.travelFee,
        discountAmount: Math.abs(breakdown.discountTotal),
        couponCode: input.couponCode ?? null,
        netTotal: breakdown.netTotal,
        vatRate: breakdown.vatRate,
        vatAmount: breakdown.vatAmount,
        grossTotal: breakdown.grossTotal,
        priceBreakdown: breakdown as unknown as Prisma.InputJsonValue,
        source: 'WEBSITE',
        bookedByIp: params.ip ?? null,
        confirmationToken: randomToken(24),
        items: {
          create: breakdown.lines
            .filter((line) => line.kind === 'base')
            .map((line, index) => ({
              serviceId: input.serviceId,
              name: line.label,
              quantity: line.quantity,
              unit: line.unit,
              unitPrice: line.unitPrice,
              vatRate: breakdown.vatRate,
              lineTotal: line.amount,
              durationMin: index === 0 ? breakdown.durationMinutes : 0,
              position: index,
            })),
        },
        extras: {
          create: input.extras.map((extra) => {
            const line = breakdown.lines.find(
              (l) => l.kind === 'extra' && l.meta?.extraId === extra.extraId,
            );
            return {
              extraId: extra.extraId,
              name: line?.label ?? 'Zusatzleistung',
              quantity: extra.quantity,
              unitPrice: line?.unitPrice ?? 0,
              lineTotal: line?.amount ?? 0,
            };
          }),
        },
      },
      include: { customer: true, address: true },
    });

    // Hochgeladene Fotos der Buchung zuordnen.
    if (input.fileIds.length > 0) {
      await tx.fileAsset.updateMany({
        where: { id: { in: input.fileIds }, organizationId },
        data: { bookingId: created.id, scope: 'BOOKING' },
      });
    }

    // Gutscheinzähler erhöhen.
    if (input.couponCode && breakdown.lines.some((l) => l.key === 'coupon')) {
      await tx.coupon.updateMany({
        where: { organizationId, code: input.couponCode.toUpperCase().trim() },
        data: { usageCount: { increment: 1 } },
      });
    }

    // Kundenstatistik nachführen.
    await tx.customer.update({
      where: { id: customerId },
      data: { totalBookings: { increment: 1 }, lastBookingAt: new Date() },
    });

    return created;
  });

  // --- 5) Folgeaktionen ausserhalb der Transaktion -------------------------
  await invalidateAvailability(organizationId, input.scheduledStart);

  const service = await prisma.service.findUnique({
    where: { id: input.serviceId },
    select: { name: true },
  });

  const addressLabel = await formatBookingAddress(booking.addressId);
  const confirmationUrl = absoluteUrl(`/buchung/${booking.confirmationToken}`);

  await notify({
    userId,
    email: customerEmail,
    channels: ['IN_APP', 'EMAIL'],
    title: 'Buchung eingegangen',
    body: `Ihre Buchung ${booking.number} wurde erfasst und wird geprüft.`,
    link: `/konto/buchungen/${booking.id}`,
    emailContent: bookingReceivedEmail({
      firstName: customerName.split(' ')[0],
      bookingNumber: booking.number,
      serviceName: service?.name ?? 'Reinigung',
      scheduledStart: booking.scheduledStart,
      scheduledEnd: booking.scheduledEnd,
      address: addressLabel,
      grossTotal: toNumber(booking.grossTotal),
      manageUrl: confirmationUrl,
    }),
    entity: 'Booking',
    entityId: booking.id,
  });

  await notifyStaff({
    organizationId,
    title: 'Neue Online-Buchung',
    body: `${customerName} · ${service?.name ?? 'Reinigung'} · ${booking.number}`,
    link: `/admin/buchungen/${booking.id}`,
    emailContent: newBookingInternalEmail({
      bookingNumber: booking.number,
      customerName,
      serviceName: service?.name ?? 'Reinigung',
      scheduledStart: booking.scheduledStart,
      grossTotal: toNumber(booking.grossTotal),
      adminUrl: absoluteUrl(`/admin/buchungen/${booking.id}`),
    }),
  });

  await audit.created({
    organizationId,
    userId: session?.id ?? null,
    entity: 'Booking',
    entityId: booking.id,
    summary: `Buchung ${booking.number} über die Website erstellt`,
    ip: params.ip,
  });

  return { booking, confirmationUrl, isNewCustomer };
}

// ---------------------------------------------------------------------------
//  Statusübergänge
// ---------------------------------------------------------------------------

export async function confirmBooking(params: {
  organizationId: string;
  bookingId: string;
  actorId?: string | null;
}): Promise<Booking> {
  const booking = await prisma.booking.findFirst({
    where: { id: params.bookingId, organizationId: params.organizationId, deletedAt: null },
    include: {
      customer: { include: { user: { select: { id: true } } } },
      address: true,
      items: { include: { service: { select: { id: true, name: true } } } },
    },
  });
  if (!booking) throw new NotFoundError('Buchung');

  if (booking.status === 'CONFIRMED') return booking;
  if (['CANCELLED', 'COMPLETED'].includes(booking.status)) {
    throw new BusinessRuleError('Diese Buchung kann nicht mehr bestätigt werden.');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.booking.update({
      where: { id: booking.id },
      data: { status: 'CONFIRMED', confirmedAt: new Date() },
    });

    // Einsatz (Job) für die Disposition anlegen.
    await createJobsForBooking(tx, booking.id);

    return result;
  });

  const serviceName = booking.items[0]?.service.name ?? 'Reinigung';
  const addressLabel = await formatBookingAddress(booking.addressId);

  await notify({
    userId: booking.customer.user?.id ?? null,
    email: booking.customer.email,
    phone: booking.customer.mobile ?? booking.customer.phone,
    channels: ['IN_APP', 'EMAIL', 'SMS'],
    title: 'Termin bestätigt',
    body: `Ihr Termin am ${booking.scheduledStart.toLocaleDateString('de-CH')} ist bestätigt.`,
    link: `/konto/buchungen/${booking.id}`,
    emailContent: bookingConfirmedEmail({
      firstName: booking.customer.firstName,
      bookingNumber: booking.number,
      serviceName,
      scheduledStart: booking.scheduledStart,
      scheduledEnd: booking.scheduledEnd,
      address: addressLabel,
      grossTotal: toNumber(booking.grossTotal),
      manageUrl: absoluteUrl(`/konto/buchungen/${booking.id}`),
    }),
    smsBody: smsTemplates.bookingConfirmed({
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

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Booking',
    entityId: booking.id,
    summary: `Buchung ${booking.number} bestätigt`,
  });

  return updated;
}

export async function cancelBooking(params: {
  organizationId: string;
  bookingId: string;
  reason: string;
  actorId?: string | null;
  /** true = Storno durch das Büro, Frist wird nicht geprüft. */
  byStaff?: boolean;
}): Promise<Booking> {
  const booking = await prisma.booking.findFirst({
    where: { id: params.bookingId, organizationId: params.organizationId, deletedAt: null },
    include: { customer: { include: { user: { select: { id: true } } } }, items: true },
  });
  if (!booking) throw new NotFoundError('Buchung');

  if (booking.status === 'CANCELLED') return booking;
  if (booking.status === 'COMPLETED') {
    throw new BusinessRuleError('Ein abgeschlossener Einsatz kann nicht storniert werden.');
  }

  const hoursUntilStart = (booking.scheduledStart.getTime() - Date.now()) / 3_600_000;
  if (!params.byStaff && hoursUntilStart < CANCELLATION_WINDOW_HOURS) {
    throw new BusinessRuleError(
      `Eine kostenlose Stornierung ist bis ${CANCELLATION_WINDOW_HOURS} Stunden vor dem Termin möglich. Bitte kontaktieren Sie uns telefonisch.`,
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.booking.update({
      where: { id: booking.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: params.reason },
    });

    // Zugehörige Einsätze absagen.
    await tx.job.updateMany({
      where: { bookingId: booking.id, status: { notIn: ['COMPLETED', 'VERIFIED'] } },
      data: { status: 'CANCELLED' },
    });

    await tx.customer.update({
      where: { id: booking.customerId },
      data: { totalBookings: { decrement: 1 } },
    });

    return result;
  });

  await invalidateAvailability(params.organizationId, booking.scheduledStart);

  await notify({
    userId: booking.customer.user?.id ?? null,
    email: booking.customer.email,
    channels: ['IN_APP', 'EMAIL'],
    title: 'Buchung storniert',
    body: `Ihre Buchung ${booking.number} wurde storniert.`,
    emailContent: bookingCancelledEmail({
      firstName: booking.customer.firstName,
      bookingNumber: booking.number,
      serviceName: booking.items[0]?.name ?? 'Reinigung',
      scheduledStart: booking.scheduledStart,
      reason: params.reason,
    }),
    entity: 'Booking',
    entityId: booking.id,
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Booking',
    entityId: booking.id,
    summary: `Buchung ${booking.number} storniert: ${params.reason}`,
  });

  return updated;
}

export async function rescheduleBooking(params: {
  organizationId: string;
  bookingId: string;
  newStart: Date;
  actorId?: string | null;
  byStaff?: boolean;
}): Promise<Booking> {
  const booking = await prisma.booking.findFirst({
    where: { id: params.bookingId, organizationId: params.organizationId, deletedAt: null },
    include: { customer: { include: { user: { select: { id: true } } } }, items: true },
  });
  if (!booking) throw new NotFoundError('Buchung');

  if (['CANCELLED', 'COMPLETED', 'IN_PROGRESS'].includes(booking.status)) {
    throw new BusinessRuleError('Diese Buchung kann nicht mehr verschoben werden.');
  }

  const hoursUntilStart = (booking.scheduledStart.getTime() - Date.now()) / 3_600_000;
  if (!params.byStaff && hoursUntilStart < CANCELLATION_WINDOW_HOURS) {
    throw new BusinessRuleError(
      `Eine Umbuchung ist bis ${CANCELLATION_WINDOW_HOURS} Stunden vor dem Termin möglich. Bitte kontaktieren Sie uns telefonisch.`,
    );
  }

  const check = await isSlotBookable({
    organizationId: params.organizationId,
    start: params.newStart,
    durationMin: booking.durationMin,
    crewSize: booking.crewSize,
  });
  if (!check.ok) throw new BusinessRuleError(check.reason!);

  const newEnd = new Date(params.newStart.getTime() + booking.durationMin * 60_000);

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.booking.update({
      where: { id: booking.id },
      data: {
        scheduledStart: params.newStart,
        scheduledEnd: newEnd,
        rescheduledFrom: booking.scheduledStart,
        reminder24hSentAt: null,
        reminder2hSentAt: null,
      },
    });

    await tx.job.updateMany({
      where: { bookingId: booking.id, status: { notIn: ['COMPLETED', 'VERIFIED', 'CANCELLED'] } },
      data: { scheduledStart: params.newStart, scheduledEnd: newEnd },
    });

    return result;
  });

  await Promise.all([
    invalidateAvailability(params.organizationId, booking.scheduledStart),
    invalidateAvailability(params.organizationId, params.newStart),
  ]);

  await notify({
    userId: booking.customer.user?.id ?? null,
    email: booking.customer.email,
    channels: ['IN_APP', 'EMAIL'],
    title: 'Termin verschoben',
    body: `Ihr Termin wurde auf den ${params.newStart.toLocaleDateString('de-CH')} verschoben.`,
    link: `/konto/buchungen/${booking.id}`,
    emailContent: bookingRescheduledEmail({
      firstName: booking.customer.firstName,
      bookingNumber: booking.number,
      serviceName: booking.items[0]?.name ?? 'Reinigung',
      scheduledStart: params.newStart,
      scheduledEnd: newEnd,
      address: await formatBookingAddress(booking.addressId),
      grossTotal: toNumber(booking.grossTotal),
      manageUrl: absoluteUrl(`/konto/buchungen/${booking.id}`),
    }),
    entity: 'Booking',
    entityId: booking.id,
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Booking',
    entityId: booking.id,
    summary: `Buchung ${booking.number} verschoben`,
    changes: { scheduledStart: { from: booking.scheduledStart, to: params.newStart } },
  });

  return updated;
}

export async function updateBooking(params: {
  organizationId: string;
  bookingId: string;
  input: UpdateBookingInput;
  actorId: string;
}): Promise<Booking> {
  const booking = await prisma.booking.findFirst({
    where: { id: params.bookingId, organizationId: params.organizationId, deletedAt: null },
  });
  if (!booking) throw new NotFoundError('Buchung');

  const data: Prisma.BookingUpdateInput = {};
  if (params.input.status) data.status = params.input.status;
  if (params.input.crewSize) data.crewSize = params.input.crewSize;
  if (params.input.internalNote !== undefined) data.internalNote = params.input.internalNote;
  if (params.input.customerNote !== undefined) data.customerNote = params.input.customerNote;
  if (params.input.accessNote !== undefined) data.accessNote = params.input.accessNote;

  if (params.input.scheduledStart || params.input.durationMin) {
    const start = params.input.scheduledStart ?? booking.scheduledStart;
    const duration = params.input.durationMin ?? booking.durationMin;
    data.scheduledStart = start;
    data.durationMin = duration;
    data.scheduledEnd = new Date(start.getTime() + duration * 60_000);
  }

  const updated = await prisma.booking.update({ where: { id: booking.id }, data });

  await invalidateAvailability(params.organizationId, updated.scheduledStart);

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Booking',
    entityId: booking.id,
    summary: `Buchung ${booking.number} bearbeitet`,
    changes: params.input,
  });

  return updated;
}

// ---------------------------------------------------------------------------
//  Serien
// ---------------------------------------------------------------------------

const FREQUENCY_DAYS: Record<Frequency, number> = {
  ONCE: 0,
  WEEKLY: 7,
  BIWEEKLY: 14,
  MONTHLY: 30,
  QUARTERLY: 91,
  SEMIANNUAL: 182,
  ANNUAL: 365,
  CUSTOM: 0,
};

/**
 * Materialisiert die nächsten Instanzen wiederkehrender Buchungen.
 * Wird vom Cron-Job `/api/cron/recurring` täglich aufgerufen.
 */
export async function generateRecurringBookings(organizationId: string): Promise<number> {
  const horizon = new Date(Date.now() + RECURRENCE_HORIZON_DAYS * 86_400_000);

  const templates = await prisma.booking.findMany({
    where: {
      organizationId,
      deletedAt: null,
      parentBookingId: null,
      recurrenceRuleId: { not: null },
      status: { in: ['CONFIRMED', 'COMPLETED'] },
      recurrenceRule: { active: true },
    },
    include: {
      recurrenceRule: true,
      items: true,
      extras: true,
      childBookings: { orderBy: { scheduledStart: 'desc' }, take: 1 },
    },
  });

  let created = 0;

  for (const template of templates) {
    const rule = template.recurrenceRule!;
    const stepDays = FREQUENCY_DAYS[rule.frequency] * rule.interval;
    if (stepDays <= 0) continue;

    const last = template.childBookings[0]?.scheduledStart ?? template.scheduledStart;
    let cursor = new Date(last.getTime() + stepDays * 86_400_000);

    const existingCount = await prisma.booking.count({
      where: { parentBookingId: template.id },
    });
    let generated = existingCount;

    while (cursor <= horizon) {
      if (rule.endDate && cursor > rule.endDate) break;
      if (rule.count && generated + 1 >= rule.count) break;

      const end = new Date(cursor.getTime() + template.durationMin * 60_000);
      const instanceStart = new Date(cursor);

      await prisma.$transaction(async (tx) => {
        const { number } = await nextNumber(tx, organizationId, 'booking');

        const instance = await tx.booking.create({
          data: {
            organizationId,
            number,
            customerId: template.customerId,
            addressId: template.addressId,
            propertyId: template.propertyId,
            parentBookingId: template.id,
            recurrenceRuleId: rule.id,
            frequency: template.frequency,
            status: 'CONFIRMED',
            scheduledStart: instanceStart,
            scheduledEnd: end,
            durationMin: template.durationMin,
            crewSize: template.crewSize,
            propertyKind: template.propertyKind,
            squareMeters: template.squareMeters,
            rooms: template.rooms,
            windows: template.windows,
            customerNote: template.customerNote,
            accessNote: template.accessNote,
            subtotal: template.subtotal,
            extrasTotal: template.extrasTotal,
            travelFee: template.travelFee,
            discountAmount: template.discountAmount,
            netTotal: template.netTotal,
            vatRate: template.vatRate,
            vatAmount: template.vatAmount,
            grossTotal: template.grossTotal,
            priceBreakdown: template.priceBreakdown ?? undefined,
            source: template.source,
            confirmedAt: new Date(),
            confirmationToken: randomToken(24),
            items: {
              create: template.items.map((item) => ({
                serviceId: item.serviceId,
                name: item.name,
                description: item.description,
                quantity: item.quantity,
                unit: item.unit,
                unitPrice: item.unitPrice,
                vatRate: item.vatRate,
                lineTotal: item.lineTotal,
                durationMin: item.durationMin,
                position: item.position,
              })),
            },
            extras: {
              create: template.extras.map((extra) => ({
                extraId: extra.extraId,
                name: extra.name,
                quantity: extra.quantity,
                unitPrice: extra.unitPrice,
                lineTotal: extra.lineTotal,
                durationMin: extra.durationMin,
              })),
            },
          },
        });

        await createJobsForBooking(tx, instance.id);
        await tx.recurrenceRule.update({
          where: { id: rule.id },
          data: { generatedUntil: instanceStart },
        });
      });

      created++;
      generated++;
      cursor = new Date(cursor.getTime() + stepDays * 86_400_000);
    }
  }

  return created;
}

// ---------------------------------------------------------------------------
//  Abfragen
// ---------------------------------------------------------------------------

export interface BookingListFilter {
  organizationId: string;
  customerId?: string;
  status?: Booking['status'];
  from?: Date;
  to?: Date;
  q?: string;
  page: number;
  pageSize: number;
  sort?: string;
  order?: SortOrder;
}

/** Spalten, nach denen die Buchungsliste sortiert werden darf. */
export const BOOKING_SORT_FIELDS = [
  'number',
  'scheduledStart',
  'createdAt',
  'grossTotal',
  'status',
] as const;

export async function listBookings(filter: BookingListFilter) {
  const where: Prisma.BookingWhereInput = {
    organizationId: filter.organizationId,
    deletedAt: null,
    ...(filter.customerId ? { customerId: filter.customerId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.from || filter.to
      ? {
          scheduledStart: {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lte: filter.to } : {}),
          },
        }
      : {}),
    ...(filter.q
      ? {
          OR: [
            { number: { contains: filter.q, mode: 'insensitive' } },
            { customer: { lastName: { contains: filter.q, mode: 'insensitive' } } },
            { customer: { companyName: { contains: filter.q, mode: 'insensitive' } } },
            { customer: { email: { contains: filter.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const sorting = resolveSort({ sort: filter.sort, order: filter.order }, BOOKING_SORT_FIELDS, {
    sort: 'scheduledStart',
    order: 'desc',
  });

  const [items, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      orderBy: orderByFor(sorting, 'number'),
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
      include: {
        customer: {
          select: { id: true, firstName: true, lastName: true, companyName: true, email: true },
        },
        address: { select: { street: true, streetNo: true, postalCode: true, city: true } },
        items: { select: { name: true }, take: 1 },
        jobs: { select: { id: true, number: true, status: true } },
      },
    }),
    prisma.booking.count({ where }),
  ]);

  return { items, total };
}

export async function getBookingDetail(params: {
  organizationId: string;
  bookingId: string;
  /** Bei Kundenzugriff: erzwingt die Eigentümerprüfung. */
  customerId?: string;
}) {
  const booking = await prisma.booking.findFirst({
    where: {
      id: params.bookingId,
      organizationId: params.organizationId,
      deletedAt: null,
      ...(params.customerId ? { customerId: params.customerId } : {}),
    },
    include: {
      customer: true,
      address: true,
      property: true,
      items: { include: { service: true } },
      extras: { include: { extra: true } },
      jobs: {
        include: {
          assignments: {
            include: {
              employee: {
                include: { user: { select: { firstName: true, lastName: true, avatarUrl: true } } },
              },
            },
          },
          photos: true,
        },
      },
      invoices: { select: { id: true, number: true, status: true, grossTotal: true, balance: true } },
      files: true,
      reviews: true,
    },
  });

  if (!booking) throw new NotFoundError('Buchung');
  return booking;
}

/** Zugriff über den Magic-Link-Token (Gastbuchung ohne Konto). */
export async function getBookingByToken(token: string) {
  const booking = await prisma.booking.findUnique({
    where: { confirmationToken: token },
    include: {
      customer: { select: { firstName: true, lastName: true, email: true } },
      address: true,
      items: { include: { service: { select: { name: true, slug: true } } } },
      extras: true,
    },
  });
  if (!booking || booking.deletedAt) throw new NotFoundError('Buchung');
  return booking;
}

// ---------------------------------------------------------------------------
//  Hilfsfunktionen
// ---------------------------------------------------------------------------

async function resolveCustomer(params: {
  organizationId: string;
  input: CreateBookingInput;
  session: SessionUser | null;
}): Promise<{
  customerId: string;
  isNewCustomer: boolean;
  customerEmail: string;
  customerName: string;
  userId: string | null;
}> {
  const { organizationId, input, session } = params;

  // Fall 1: eingeloggter Kunde
  if (session?.role === 'CUSTOMER' && session.profileId) {
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: session.profileId },
      select: { id: true, email: true, firstName: true, lastName: true, userId: true },
    });
    return {
      customerId: customer.id,
      isNewCustomer: false,
      customerEmail: customer.email,
      customerName: `${customer.firstName} ${customer.lastName}`,
      userId: customer.userId,
    };
  }

  // Fall 2: Mitarbeitende buchen im Namen eines Kunden — dann muss die
  // Kunden-ID aus einer bestehenden Adresse oder Liegenschaft hervorgehen.
  if (session && session.role !== 'CUSTOMER' && input.addressId) {
    const address = await prisma.address.findUnique({
      where: { id: input.addressId },
      include: { customer: { select: { id: true, email: true, firstName: true, lastName: true, userId: true } } },
    });
    if (!address) throw new NotFoundError('Adresse');
    return {
      customerId: address.customer.id,
      isNewCustomer: false,
      customerEmail: address.customer.email,
      customerName: `${address.customer.firstName} ${address.customer.lastName}`,
      userId: address.customer.userId,
    };
  }

  // Fall 3: Gastbuchung — Kontaktangaben sind Pflicht.
  if (!input.email || !input.firstName || !input.lastName || !input.phone) {
    throw new BusinessRuleError(
      'Bitte geben Sie Vorname, Nachname, E-Mail und Telefonnummer an oder melden Sie sich an.',
    );
  }

  const existing = await prisma.customer.findFirst({
    where: { organizationId, email: input.email, deletedAt: null },
    select: { id: true, email: true, firstName: true, lastName: true, userId: true },
  });

  if (existing) {
    return {
      customerId: existing.id,
      isNewCustomer: false,
      customerEmail: existing.email,
      customerName: `${existing.firstName} ${existing.lastName}`,
      userId: existing.userId,
    };
  }

  const customer = await prisma.$transaction(async (tx) => {
    const { number } = await nextNumber(tx, organizationId, 'customer');
    return tx.customer.create({
      data: {
        organizationId,
        number,
        type: input.companyName ? 'BUSINESS' : 'PRIVATE',
        companyName: input.companyName ?? null,
        firstName: input.firstName!,
        lastName: input.lastName!,
        email: input.email!,
        phone: input.phone!,
        referralCode: randomToken(4).toUpperCase(),
      },
    });
  });

  return {
    customerId: customer.id,
    isNewCustomer: true,
    customerEmail: customer.email,
    customerName: `${customer.firstName} ${customer.lastName}`,
    userId: null,
  };
}

async function createAddress(tx: Tx, customerId: string, input: CreateBookingInput): Promise<string> {
  const address = input.address!;
  const created = await tx.address.create({
    data: {
      customerId,
      label: address.label ?? 'Einsatzadresse',
      street: address.street,
      streetNo: address.streetNo ?? null,
      addition: address.addition ?? null,
      postalCode: address.postalCode,
      city: address.city,
      canton: address.canton,
      country: address.country,
      lat: address.lat ?? null,
      lng: address.lng ?? null,
      placeId: address.placeId ?? null,
      accessNote: input.accessNote ?? address.accessNote ?? null,
      isDefault: true,
      isBilling: true,
    },
  });
  return created.id;
}

async function formatBookingAddress(addressId: string | null): Promise<string> {
  if (!addressId) return '—';
  const address = await prisma.address.findUnique({ where: { id: addressId } });
  if (!address) return '—';
  return `${address.street} ${address.streetNo ?? ''}, ${address.postalCode} ${address.city}`.replace(
    /\s+/g,
    ' ',
  );
}

/** Prüft, ob eine Kundin/ein Kunde auf eine Buchung zugreifen darf. */
export async function assertBookingOwnership(bookingId: string, customerId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { customerId: true },
  });
  if (!booking) throw new NotFoundError('Buchung');
  if (booking.customerId !== customerId) {
    throw new ForbiddenError('Diese Buchung gehört nicht zu Ihrem Konto.');
  }
}

export { round2 };
