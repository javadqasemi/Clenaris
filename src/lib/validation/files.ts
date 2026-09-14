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

/**
 * Obergrenze je Datei über alle Upload-Wege: 1 GiB.
 *
 * Hier und nicht in `storage/profiles.ts`, weil die Zahl an drei Orten
 * gebraucht wird, die `server-only` nicht importieren dürfen: in den
 * Zod-Schemas (also auch in der OpenAPI-Beschreibung), in den
 * Client-Komponenten für die Vorprüfung und die Hinweistexte, und in den
 * Profilen selbst. Eine Zahl, drei Verbraucher — sonst stünde in der
 * Fehlermeldung eine andere Grenze als im Formular.
 *
 * Gilt für den externen Speicher. Die eingebaute Rückfallebene in der
 * Datenbank hat einen eigenen, tieferen Deckel (`LOCAL_MAX_BYTES`), den die
 * Technik vorgibt, nicht die Fachlichkeit.
 */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

/** Eine Bytezahl als Grenze lesbar machen: „1 GB", „256 MB", „4 MB". */
export function describeUploadLimit(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 1) return `${Number(gib.toFixed(1))} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export const uploadUrlSchema = z.object({
  profile: z.enum(UPLOAD_PROFILE_NAMES),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(3).max(120),
  /** Die Obergrenze über alle Profile; das Profil selbst kann strenger sein. */
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  /** Fachliche Zuordnung, etwa die Job- oder Buchungs-ID. */
  scopeId: z.string().max(60).optional(),
});
export type UploadUrlInput = z.infer<typeof uploadUrlSchema>;
