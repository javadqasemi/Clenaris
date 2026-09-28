import { z } from 'zod';

import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { priceAdjustmentDecisionSchema } from '@/lib/validation/contracts';
import { decidePriceAdjustment } from '@/server/services/contract-amendment.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

const adjustmentParams = z.object({ id: z.string().min(1), adjustmentId: z.string().min(1) });

/**
 * POST /api/contracts/{id}/price-adjustments/{adjustmentId}/decision —
 * freigeben oder ablehnen.
 *
 * Dieselbe Trennung wie beim Änderungsantrag: Vorschlagen kann die
 * Betriebsleitung, freigeben nicht — und wer vorgeschlagen hat, kann nicht
 * selbst zustimmen (422). Bei einer Preiserhöhung ist das keine Formsache: Sie
 * geht an die Kundschaft hinaus.
 */
export const POST = defineRoute({
  permissions: ['contract:approve'],
  params: adjustmentParams,
  body: priceAdjustmentDecisionSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await decidePriceAdjustment({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        adjustmentId: params.adjustmentId,
        actorId: session.id,
        ip,
        entscheidung: body.entscheidung,
        reason: body.reason,
      }),
    ),
});
