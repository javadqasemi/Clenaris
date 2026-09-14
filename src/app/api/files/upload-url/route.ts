import { definePublicRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { UnauthorizedError } from '@/lib/errors';
import { createSignedUpload } from '@/lib/storage';
import { uploadUrlSchema } from '@/lib/validation/files';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/files/upload-url
 *
 * Liefert eine signierte Adresse für den Direkt-Upload zu Supabase Storage.
 *
 * Architekturentscheid: Dateien laufen nicht durch die Applikation. Das
 * umgeht das 4.5-MB-Limit für Vercel-Function-Bodies, spart Bandbreite und
 * hält Baustellenfotos schnell. Der Server behält die Kontrolle: er bestimmt
 * Pfad, Grösse und erlaubte Dateitypen — der Client kann nur an die Adresse
 * schreiben, die er bekommt.
 *
 * Nicht angemeldete Personen dürfen ausschliesslich in die Profile hochladen,
 * die zum öffentlichen Buchungs- und Bewerbungsformular gehören.
 */
const PUBLIC_PROFILES = ['bookingPhoto', 'cv'] as const;

export const POST = definePublicRoute({
  body: uploadUrlSchema,
  rateLimit: 'fileUpload',
  handler: async ({ body, session }) => {
    if (!session && !PUBLIC_PROFILES.includes(body.profile as (typeof PUBLIC_PROFILES)[number])) {
      throw new UnauthorizedError('Für diesen Upload ist eine Anmeldung erforderlich.');
    }

    const organizationId = await getOrganizationId();

    const target = await createSignedUpload({
      profile: body.profile,
      organizationId,
      filename: body.filename,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      scopeId: body.scopeId,
      uploadedById: session?.id ?? null,
    });

    return created(target);
  },
});
