import 'server-only';

import type { Customer, Lead, Prisma } from '@prisma/client';

import { prisma, toNumber } from '@/lib/db';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { absoluteUrl } from '@/lib/utils';
import { orderByFor, resolveSort, type SortOrder } from '@/lib/sort';
import { randomToken } from '@/lib/auth/jwt';
import { audit } from '@/lib/audit';
import { sendEmail } from '@/lib/email/client';
import { contactAutoReplyEmail, newLeadInternalEmail } from '@/lib/email/templates';
import { hasIntegration } from '@/lib/env';
import { scoreLead } from '@/lib/ai/features';
import type {
  ContactFormInput,
  CreateCustomerInput,
  CreateLeadInput,
  QuoteRequestInput,
  UpdateCustomerInput,
  UpdateLeadInput,
} from '@/lib/validation/crm';

import { nextNumber } from './numbering.service';
import { notifyStaff } from './notification.service';
import { inviteUser } from './auth.service';
import { logger } from '@/lib/logger';

const log = logger('crm');

/**
 * CRM: Leads, Kunden, Objekte, Aktivitäten.
 *
 * Architekturentscheide:
 *  1. Jede Website-Anfrage wird zum Lead — auch das simple Kontaktformular.
 *     Ohne diese Disziplin gehen Anfragen im Postfach verloren und die
 *     Conversion-Rate lässt sich nicht messen.
 *  2. Die KI-Bewertung läuft *nach* der Antwort an die Kundschaft und darf
 *     fehlschlagen. Ein Ausfall des KI-Dienstes darf keine Anfrage verlieren.
 *  3. Leads werden nicht gelöscht, sondern als WON/LOST geschlossen — die
 *     Pipeline-Statistik braucht die Historie.
 */

// ---------------------------------------------------------------------------
//  Leads
// ---------------------------------------------------------------------------

export async function createLeadFromContactForm(params: {
  organizationId: string;
  input: ContactFormInput | QuoteRequestInput;
  ip?: string;
}): Promise<Lead> {
  const input = params.input;

  const stage = await prisma.pipelineStage.findFirst({
    where: { organizationId: params.organizationId, key: 'new' },
  });

  const lead = await prisma.$transaction(async (tx) => {
    const { number } = await nextNumber(tx, params.organizationId, 'lead');

    // Bestehende Kundschaft erkennen und verknüpfen.
    const existingCustomer = await tx.customer.findFirst({
      where: { organizationId: params.organizationId, email: input.email, deletedAt: null },
      select: { id: true },
    });

    return tx.lead.create({
      data: {
        organizationId: params.organizationId,
        number,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone ?? null,
        company: input.company ?? null,
        postalCode: input.postalCode ?? null,
        city: input.city ?? null,
        street: 'street' in input ? (input.street ?? null) : null,
        serviceKind: input.serviceKind ?? null,
        message: input.message,
        status: 'NEW',
        source: 'WEBSITE',
        stageId: stage?.id ?? null,
        customerId: existingCustomer?.id ?? null,
        utmSource: input.utmSource ?? null,
        utmMedium: input.utmMedium ?? null,
        utmCampaign: input.utmCampaign ?? null,
        referrerUrl: input.referrerUrl ?? null,
        landingPath: input.landingPath ?? null,
        // Erste Nachfassaktion am nächsten Werktag.
        nextFollowUpAt: nextBusinessDay(),
        activities: {
          create: {
            type: 'EMAIL',
            subject: 'Anfrage über die Website',
            body: input.message,
          },
        },
      },
    });
  });

  // Angehängte Dateien zuordnen (nur bei der Offertanfrage).
  if ('fileIds' in input && input.fileIds.length > 0) {
    await prisma.fileAsset.updateMany({
      where: { id: { in: input.fileIds }, organizationId: params.organizationId },
      data: { scope: 'OTHER' },
    });
  }

  // Eingangsbestätigung an die anfragende Person.
  const autoReply = contactAutoReplyEmail({ firstName: input.firstName });
  await sendEmail({
    to: input.email,
    subject: autoReply.subject,
    html: autoReply.html,
    templateKey: 'contact_auto_reply',
    entity: 'Lead',
    entityId: lead.id,
  });

  // Interne Benachrichtigung.
  await notifyStaff({
    organizationId: params.organizationId,
    title: 'Neue Anfrage',
    body: `${input.firstName} ${input.lastName} · ${input.email}`,
    link: `/admin/leads/${lead.id}`,
    emailContent: newLeadInternalEmail({
      name: `${input.firstName} ${input.lastName}`,
      email: input.email,
      phone: input.phone,
      serviceKind: input.serviceKind ?? undefined,
      message: input.message,
      adminUrl: absoluteUrl(`/admin/leads/${lead.id}`),
    }),
  });

  // KI-Bewertung im Hintergrund — Fehler bleiben folgenlos.
  if (hasIntegration('ai')) {
    void scoreLeadInBackground(lead.id, {
      message: input.message,
      serviceKind: input.serviceKind ?? null,
      squareMeters: 'squareMeters' in input ? (input.squareMeters ?? null) : null,
      isBusiness: Boolean(input.company),
      source: 'WEBSITE',
    });
  }

  await audit.created({
    organizationId: params.organizationId,
    entity: 'Lead',
    entityId: lead.id,
    summary: `Lead ${lead.number} über Website erfasst`,
    ip: params.ip,
  });

  return lead;
}

async function scoreLeadInBackground(
  leadId: string,
  input: Parameters<typeof scoreLead>[0],
): Promise<void> {
  try {
    const result = await scoreLead(input);
    await prisma.lead.update({
      where: { id: leadId },
      data: {
        score: result.score,
        activities: {
          create: {
            type: 'SYSTEM',
            subject: `KI-Bewertung: ${result.score}/100 (Dringlichkeit ${result.urgency})`,
            body: `${result.reasoning}\n\nEmpfohlener nächster Schritt: ${result.suggestedNextStep}`,
          },
        },
      },
    });
  } catch (error) {
    log.error('KI-Lead-Bewertung fehlgeschlagen', { error });
  }
}

export async function createLead(params: {
  organizationId: string;
  input: CreateLeadInput;
  actorId: string;
}): Promise<Lead> {
  const lead = await prisma.$transaction(async (tx) => {
    const { number } = await nextNumber(tx, params.organizationId, 'lead');

    return tx.lead.create({
      data: {
        organizationId: params.organizationId,
        number,
        firstName: params.input.firstName,
        lastName: params.input.lastName,
        email: params.input.email,
        phone: params.input.phone ?? null,
        company: params.input.company ?? null,
        street: params.input.street ?? null,
        postalCode: params.input.postalCode ?? null,
        city: params.input.city ?? null,
        serviceKind: params.input.serviceKind ?? null,
        message: params.input.message ?? null,
        estimatedValue: params.input.estimatedValue ?? null,
        source: params.input.source,
        stageId: params.input.stageId ?? null,
        ownerId: params.input.ownerId ?? null,
        nextFollowUpAt: params.input.nextFollowUpAt ?? null,
        tags: {
          create: params.input.tagIds.map((tagId) => ({ tagId })),
        },
      },
    });
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Lead',
    entityId: lead.id,
    summary: `Lead ${lead.number} manuell erfasst`,
  });

  return lead;
}

export async function updateLead(params: {
  organizationId: string;
  leadId: string;
  input: UpdateLeadInput;
  actorId: string;
}): Promise<Lead> {
  const lead = await prisma.lead.findFirst({
    where: { id: params.leadId, organizationId: params.organizationId, deletedAt: null },
  });
  if (!lead) throw new NotFoundError('Lead');

  const { tagIds, ...rest } = params.input;

  const updated = await prisma.lead.update({
    where: { id: lead.id },
    data: {
      ...rest,
      ...(rest.status === 'WON' && !lead.convertedAt ? { convertedAt: new Date() } : {}),
      ...(tagIds
        ? { tags: { deleteMany: {}, create: tagIds.map((tagId) => ({ tagId })) } }
        : {}),
    },
  });

  // Statuswechsel als Aktivität festhalten — die Historie ist im CRM zentral.
  if (rest.status && rest.status !== lead.status) {
    await prisma.activity.create({
      data: {
        leadId: lead.id,
        authorId: params.actorId,
        type: 'STATUS_CHANGE',
        subject: `Status geändert: ${lead.status} → ${rest.status}`,
        body: rest.lostReason ?? null,
      },
    });
  }

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Lead',
    entityId: lead.id,
    summary: `Lead ${lead.number} bearbeitet`,
    changes: params.input,
  });

  return updated;
}

/** Lead in einen Kunden überführen. */
export async function convertLeadToCustomer(params: {
  organizationId: string;
  leadId: string;
  actorId: string;
}): Promise<Customer> {
  const lead = await prisma.lead.findFirst({
    where: { id: params.leadId, organizationId: params.organizationId, deletedAt: null },
  });
  if (!lead) throw new NotFoundError('Lead');

  if (lead.customerId) {
    return prisma.customer.findUniqueOrThrow({ where: { id: lead.customerId } });
  }

  const existing = await prisma.customer.findFirst({
    where: { organizationId: params.organizationId, email: lead.email, deletedAt: null },
  });

  if (existing) {
    await prisma.lead.update({
      where: { id: lead.id },
      data: { customerId: existing.id, status: 'WON', convertedAt: new Date() },
    });
    return existing;
  }

  const customer = await prisma.$transaction(async (tx) => {
    const { number } = await nextNumber(tx, params.organizationId, 'customer');

    const created = await tx.customer.create({
      data: {
        organizationId: params.organizationId,
        number,
        type: lead.company ? 'BUSINESS' : 'PRIVATE',
        companyName: lead.company,
        firstName: lead.firstName,
        lastName: lead.lastName,
        email: lead.email,
        phone: lead.phone,
        referralCode: randomToken(4).toUpperCase(),
        ...(lead.street && lead.postalCode && lead.city
          ? {
              addresses: {
                create: {
                  label: 'Hauptadresse',
                  street: lead.street,
                  postalCode: lead.postalCode,
                  city: lead.city,
                  isDefault: true,
                  isBilling: true,
                },
              },
            }
          : {}),
      },
    });

    await tx.lead.update({
      where: { id: lead.id },
      data: { customerId: created.id, status: 'WON', convertedAt: new Date() },
    });

    // Aktivitäten des Leads am Kunden weiterführen.
    await tx.activity.updateMany({
      where: { leadId: lead.id },
      data: { customerId: created.id },
    });

    return created;
  });

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Customer',
    entityId: customer.id,
    summary: `Lead ${lead.number} in Kunde ${customer.number} umgewandelt`,
  });

  return customer;
}

/** Spalten, nach denen die Anfrageliste sortiert werden darf. */
export const LEAD_SORT_FIELDS = [
  'number',
  'lastName',
  'createdAt',
  'score',
  'estimatedValue',
  'status',
  'nextFollowUpAt',
] as const;

export async function listLeads(filter: {
  organizationId: string;
  status?: Lead['status'];
  ownerId?: string;
  q?: string;
  page: number;
  pageSize: number;
  sort?: string;
  order?: SortOrder;
}) {
  const where: Prisma.LeadWhereInput = {
    organizationId: filter.organizationId,
    deletedAt: null,
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.ownerId ? { ownerId: filter.ownerId } : {}),
    ...(filter.q
      ? {
          OR: [
            { number: { contains: filter.q, mode: 'insensitive' } },
            { firstName: { contains: filter.q, mode: 'insensitive' } },
            { lastName: { contains: filter.q, mode: 'insensitive' } },
            { email: { contains: filter.q, mode: 'insensitive' } },
            { company: { contains: filter.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  /**
   * Ohne ausdrücklichen Wunsch nach Bewertung, dann nach Eingang: die
   * aussichtsreichste Anfrage soll zuoberst stehen, nicht die zufällig
   * neueste.
   */
  const sorting = resolveSort({ sort: filter.sort, order: filter.order }, LEAD_SORT_FIELDS, {
    sort: 'score',
    order: 'desc',
  });

  const [items, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      orderBy: orderByFor(sorting, 'createdAt'),
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
      include: {
        stage: true,
        owner: { include: { user: { select: { firstName: true, lastName: true } } } },
        tags: { include: { tag: true } },
        _count: { select: { quotes: true, activities: true } },
      },
    }),
    prisma.lead.count({ where }),
  ]);

  return { items, total };
}

/** Kanban-Ansicht: Leads nach Pipeline-Stufe gruppiert. */
export async function getLeadPipeline(organizationId: string) {
  const [stages, leads] = await Promise.all([
    prisma.pipelineStage.findMany({
      where: { organizationId },
      orderBy: { position: 'asc' },
    }),
    prisma.lead.findMany({
      where: {
        organizationId,
        deletedAt: null,
        status: { notIn: ['WON', 'LOST'] },
      },
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
      include: {
        owner: { include: { user: { select: { firstName: true, lastName: true } } } },
        tags: { include: { tag: true } },
      },
      take: 300,
    }),
  ]);

  return stages.map((stage) => {
    const stageLeads = leads.filter((lead) => lead.stageId === stage.id);
    return {
      stage,
      leads: stageLeads,
      count: stageLeads.length,
      value: stageLeads.reduce((sum, lead) => sum + toNumber(lead.estimatedValue), 0),
    };
  });
}

// ---------------------------------------------------------------------------
//  Kunden
// ---------------------------------------------------------------------------

export async function createCustomer(params: {
  organizationId: string;
  input: CreateCustomerInput;
  actorId: string;
}): Promise<Customer> {
  const existing = await prisma.customer.findFirst({
    where: { organizationId: params.organizationId, email: params.input.email, deletedAt: null },
  });
  if (existing) {
    throw new ConflictError('Für diese E-Mail-Adresse existiert bereits ein Kundendatensatz.');
  }

  const customer = await prisma.$transaction(async (tx) => {
    const { number } = await nextNumber(tx, params.organizationId, 'customer');

    return tx.customer.create({
      data: {
        organizationId: params.organizationId,
        number,
        type: params.input.type,
        companyName: params.input.companyName ?? null,
        firstName: params.input.firstName,
        lastName: params.input.lastName,
        email: params.input.email,
        phone: params.input.phone ?? null,
        mobile: params.input.mobile ?? null,
        vatNumber: params.input.vatNumber ?? null,
        language: params.input.language,
        birthday: params.input.birthday ?? null,
        notes: params.input.notes ?? null,
        internalNotes: params.input.internalNotes ?? null,
        paymentTermDays: params.input.paymentTermDays,
        discountPercent: params.input.discountPercent,
        creditLimit: params.input.creditLimit ?? null,
        taxExempt: params.input.taxExempt,
        referralCode: randomToken(4).toUpperCase(),
        tags: { create: params.input.tagIds.map((tagId) => ({ tagId })) },
        ...(params.input.address
          ? {
              addresses: {
                create: {
                  label: params.input.address.label ?? 'Hauptadresse',
                  street: params.input.address.street,
                  streetNo: params.input.address.streetNo ?? null,
                  addition: params.input.address.addition ?? null,
                  postalCode: params.input.address.postalCode,
                  city: params.input.address.city,
                  canton: params.input.address.canton,
                  country: params.input.address.country,
                  lat: params.input.address.lat ?? null,
                  lng: params.input.address.lng ?? null,
                  isDefault: true,
                  isBilling: true,
                },
              },
            }
          : {}),
      },
    });
  });

  if (params.input.createLogin) {
    await inviteUser({
      organizationId: params.organizationId,
      email: params.input.email,
      firstName: params.input.firstName,
      lastName: params.input.lastName,
      role: 'CUSTOMER',
      actorId: params.actorId,
    });

    const user = await prisma.user.findUnique({ where: { email: params.input.email } });
    if (user) {
      await prisma.customer.update({ where: { id: customer.id }, data: { userId: user.id } });
    }
  }

  await audit.created({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Customer',
    entityId: customer.id,
    summary: `Kunde ${customer.number} erstellt`,
  });

  return customer;
}

export async function updateCustomer(params: {
  organizationId: string;
  customerId: string;
  input: UpdateCustomerInput;
  actorId: string;
}): Promise<Customer> {
  const customer = await prisma.customer.findFirst({
    where: { id: params.customerId, organizationId: params.organizationId, deletedAt: null },
  });
  if (!customer) throw new NotFoundError('Kunde');

  const { tagIds, ...rest } = params.input;

  const updated = await prisma.customer.update({
    where: { id: customer.id },
    data: {
      ...rest,
      ...(tagIds
        ? { tags: { deleteMany: {}, create: tagIds.map((tagId) => ({ tagId })) } }
        : {}),
    },
  });

  await audit.updated({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Customer',
    entityId: customer.id,
    summary: `Kunde ${customer.number} bearbeitet`,
    changes: params.input,
  });

  return updated;
}

/**
 * DSG/DSGVO-konforme Löschung.
 * Belege bleiben aus buchhalterischen Gründen bestehen (10 Jahre
 * Aufbewahrungspflicht), die personenbezogenen Stammdaten werden anonymisiert.
 */
export async function anonymizeCustomer(params: {
  organizationId: string;
  customerId: string;
  actorId: string;
}): Promise<void> {
  const customer = await prisma.customer.findFirst({
    where: { id: params.customerId, organizationId: params.organizationId },
    include: { user: { select: { id: true } } },
  });
  if (!customer) throw new NotFoundError('Kunde');

  const anonymous = `geloescht-${customer.number.toLowerCase()}@anonymisiert.local`;

  await prisma.$transaction(async (tx) => {
    await tx.customer.update({
      where: { id: customer.id },
      data: {
        firstName: 'Gelöscht',
        lastName: customer.number,
        companyName: null,
        email: anonymous,
        phone: null,
        mobile: null,
        birthday: null,
        notes: null,
        internalNotes: 'Auf Wunsch der betroffenen Person anonymisiert.',
        vatNumber: null,
        deletedAt: new Date(),
      },
    });

    await tx.address.updateMany({
      where: { customerId: customer.id },
      data: { firstName: null, lastName: null, company: null, accessNote: null },
    });

    await tx.property.updateMany({
      where: { customerId: customer.id },
      data: { keyLocation: null, alarmCode: null, accessNote: null, notes: null },
    });

    if (customer.user) {
      await tx.user.update({
        where: { id: customer.user.id },
        data: {
          email: anonymous,
          firstName: 'Gelöscht',
          lastName: customer.number,
          phone: null,
          avatarUrl: null,
          status: 'DISABLED',
          deletedAt: new Date(),
        },
      });
      await tx.refreshToken.updateMany({
        where: { userId: customer.user.id },
        data: { revokedAt: new Date() },
      });
    }
  });

  await audit.deleted({
    organizationId: params.organizationId,
    userId: params.actorId,
    entity: 'Customer',
    entityId: customer.id,
    summary: `Kunde ${customer.number} auf Löschbegehren anonymisiert (DSG Art. 32)`,
  });
}

/** Spalten, nach denen die Kundenliste sortiert werden darf. */
export const CUSTOMER_SORT_FIELDS = [
  'number',
  'lastName',
  'companyName',
  'createdAt',
  'lifetimeValue',
  'totalBookings',
  'lastBookingAt',
] as const;

export async function listCustomers(filter: {
  organizationId: string;
  type?: Customer['type'];
  q?: string;
  page: number;
  pageSize: number;
  sort?: string;
  order?: SortOrder;
}) {
  const where: Prisma.CustomerWhereInput = {
    organizationId: filter.organizationId,
    deletedAt: null,
    ...(filter.type ? { type: filter.type } : {}),
    ...(filter.q
      ? {
          OR: [
            { number: { contains: filter.q, mode: 'insensitive' } },
            { firstName: { contains: filter.q, mode: 'insensitive' } },
            { lastName: { contains: filter.q, mode: 'insensitive' } },
            { companyName: { contains: filter.q, mode: 'insensitive' } },
            { email: { contains: filter.q, mode: 'insensitive' } },
            { phone: { contains: filter.q } },
          ],
        }
      : {}),
  };

  const sorting = resolveSort({ sort: filter.sort, order: filter.order }, CUSTOMER_SORT_FIELDS, {
    sort: 'createdAt',
    order: 'desc',
  });

  const [items, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: orderByFor(sorting, 'number'),
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
      include: {
        addresses: { where: { isDefault: true }, take: 1 },
        tags: { include: { tag: true } },
        _count: { select: { bookings: true, invoices: true, properties: true } },
      },
    }),
    prisma.customer.count({ where }),
  ]);

  return { items, total };
}

export async function getCustomerDetail(params: {
  organizationId: string;
  customerId: string;
}) {
  const customer = await prisma.customer.findFirst({
    where: { id: params.customerId, organizationId: params.organizationId, deletedAt: null },
    include: {
      user: { select: { id: true, email: true, lastLoginAt: true, status: true } },
      addresses: { orderBy: { isDefault: 'desc' } },
      properties: { where: { deletedAt: null } },
      contacts: { orderBy: { isPrimary: 'desc' } },
      tags: { include: { tag: true } },
      bookings: {
        where: { deletedAt: null },
        orderBy: { scheduledStart: 'desc' },
        take: 10,
        include: { items: { select: { name: true }, take: 1 } },
      },
      invoices: {
        where: { deletedAt: null },
        orderBy: { issueDate: 'desc' },
        take: 10,
      },
      quotes: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 10 },
      activities: { orderBy: { occurredAt: 'desc' }, take: 50, include: { author: { select: { firstName: true, lastName: true } } } },
      tasks: { where: { status: { in: ['OPEN', 'IN_PROGRESS'] } }, orderBy: { dueAt: 'asc' } },
      reviews: true,
      files: { orderBy: { createdAt: 'desc' }, take: 20 },
      paymentMethods: true,
    },
  });

  if (!customer) throw new NotFoundError('Kunde');

  // Offene Posten separat aggregieren.
  const outstanding = await prisma.invoice.aggregate({
    where: { customerId: customer.id, deletedAt: null, balance: { gt: 0 } },
    _sum: { balance: true },
    _count: true,
  });

  return {
    customer,
    stats: {
      outstandingAmount: toNumber(outstanding._sum.balance),
      outstandingCount: outstanding._count,
      lifetimeValue: toNumber(customer.lifetimeValue),
      totalBookings: customer.totalBookings,
    },
  };
}

// ---------------------------------------------------------------------------
//  Hilfsfunktionen
// ---------------------------------------------------------------------------

/** Nächster Werktag um 09:00 Uhr — Standard für die erste Nachfassaktion. */
function nextBusinessDay(): Date {
  const date = new Date();
  date.setHours(9, 0, 0, 0);
  date.setDate(date.getDate() + 1);
  while (date.getDay() === 0 || date.getDay() === 6) {
    date.setDate(date.getDate() + 1);
  }
  return date;
}
