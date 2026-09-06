import { z } from 'zod';

import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { createSupplierSchema } from '@/lib/validation/finance';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  includeInactive: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
});

/** GET /api/suppliers — Lieferanten mit der Zahl ihrer Belege. */
export const GET = defineRoute({
  permissions: ['supplier:read'],
  query: listQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const organizationId = await getOrganizationId();
    return ok(
      await prisma.supplier.findMany({
        where: {
          organizationId,
          ...(query.includeInactive ? {} : { active: true }),
          ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
        },
        orderBy: { name: 'asc' },
        include: { _count: { select: { expenses: true } } },
      }),
    );
  },
});

/** POST /api/suppliers — Lieferant erfassen. */
export const POST = defineRoute({
  permissions: ['supplier:create'],
  body: createSupplierSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const organizationId = await getOrganizationId();

    const empty = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : null);

    const supplier = await prisma.supplier.create({
      data: {
        organizationId,
        name: body.name,
        contactName: empty(body.contactName),
        email: empty(body.email),
        phone: empty(body.phone),
        street: empty(body.street),
        postalCode: empty(body.postalCode),
        city: empty(body.city),
        country: body.country,
        vatNumber: empty(body.vatNumber),
        iban: empty(body.iban),
        paymentTermDays: body.paymentTermDays,
        notes: empty(body.notes),
      },
    });

    await audit.created({
      organizationId,
      userId: session.id,
      entity: 'Supplier',
      entityId: supplier.id,
      summary: `Lieferant „${supplier.name}" erfasst`,
      ip,
    });

    return created({ id: supplier.id, name: supplier.name });
  },
});
