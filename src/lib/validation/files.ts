import { z } from 'zod';

/**
 * Datei-Uploads.
 *
 * Die Profilnamen stehen hier als eigenständige Liste und nicht als Ableitung
 * aus `UPLOAD_PROFILES`: jenes Modul trägt `server-only` und liesse sich weder
 * aus einem Client-Bundle noch aus der OpenAPI-Erzeugung importieren. Die
 * Kopplung ist über den Typtest darunter abgesichert — läuft die Liste
 * auseinander, schlägt `tsc` fehl, nicht erst die Laufzeit.
 */

export const UPLOAD_PROFILE_NAMES = [
  'jobPhoto',
  'bookingPhoto',
  'avatar',
  'document',
  'receipt',
  'cv',
  'gallery',
  'invoice',
  'quote',
] as const;

export type UploadProfileName = (typeof UPLOAD_PROFILE_NAMES)[number];

export const uploadUrlSchema = z.object({
  profile: z.enum(UPLOAD_PROFILE_NAMES),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(3).max(120),
  /** 50 MiB — die Obergrenze über alle Profile; das Profil selbst ist strenger. */
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(50 * 1024 * 1024),
  /** Fachliche Zuordnung, etwa die Job- oder Buchungs-ID. */
  scopeId: z.string().max(60).optional(),
});
export type UploadUrlInput = z.infer<typeof uploadUrlSchema>;
