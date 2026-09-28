import { defineRoute } from '@/lib/api/handler';
import { supplierListQuery } from '@/lib/validation/queries';
import { created, ok } from '@/lib/api/response';
import { createSupplierSchema } from '@/lib/validation/finance';
import { getOrganizationId } from '@/server/services/organization.service';
import { createSupplier, listSuppliers } from '@/server/services/supplier.service';

export const runtime = 'nodejs';


/** GET /api/suppliers — Lieferanten mit der Zahl ihrer Belege. */
export const GET = defineRoute({
  permissions: ['supplier:read'],
  query: supplierListQuery,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const organizationId = await getOrganizationId();
    return ok(await listSuppliers(organizationId, query));
  },
});

/** POST /api/suppliers — Lieferant erfassen. */
export const POST = defineRoute({
  permissions: ['supplier:create'],
  body: createSupplierSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const organizationId = await getOrganizationId();
    const supplier = await createSupplier({ organizationId, actorId: session.id, ip, input: body });
    return created({ id: supplier.id, name: supplier.name });
  },
});
