import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { audit } from '@/lib/audit';
import { computeHealth, getHealthHistory, snapshotHealth } from '@/server/services/health.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** GET /api/bi/cockpit/health — aktueller Gesundheitswert mit Herleitung und Verlauf. */
export const GET = defineRoute({
  permissions: ['cockpit:view'],
  rateLimit: 'apiRead',
  handler: async () => {
    const organizationId = await getOrganizationId();
    const [current, history] = await Promise.all([computeHealth(organizationId), getHealthHistory(organizationId, 365)]);
    return ok({ ...current, history });
  },
});

/** POST /api/bi/cockpit/health — heutigen Wert festschreiben (sonst macht das der Nachtlauf). */
export const POST = defineRoute({
  permissions: ['kpi:manage'],
  rateLimit: 'apiWrite',
  handler: async ({ session }) => {
    const organizationId = await getOrganizationId();
    const result = await snapshotHealth(organizationId);
    await audit.created({ organizationId, userId: session.id, entity: 'HealthSnapshot', summary: `Gesundheitswert ${result.score ?? '—'} festgeschrieben` });
    return ok(result);
  },
});
