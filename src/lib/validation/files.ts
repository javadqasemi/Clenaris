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

/**
 * Zwecke, die die Mediathek zeigt und zuordnen lässt. Stand bis 2026-09-27
 * doppelt als Konstante in `api/media/route.ts` und `api/media/[id]/route.ts`.
 */
export const MEDIA_SCOPES = [
  'BOOKING',
  'QUOTE',
  'INVOICE',
  'JOB',
  'CUSTOMER',
  'EMPLOYEE',
  'PROPERTY',
  'BLOG',
  'GALLERY',
  'APPLICATION',
  'EXPENSE',
  'MESSAGE',
  'OTHER',
] as const;

/** PATCH /api/media/:id — Dateiname und Zuordnung. */
export const mediaUpdateSchema = z.object({
  filename: z.string().trim().min(1).max(255).optional(),
  scope: z.enum(MEDIA_SCOPES).optional(),
});

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
  /**
   * Fachliche Zuordnung, etwa die Job- oder Buchungs-ID.
   *
   * Nur Kennungszeichen (2026-09-28). Der Wert wird ein Segment des
   * Speicherschlüssels (`storage/tickets.ts`), und vorher war jede Zeichenkette
   * bis 60 Zeichen erlaubt — auch anonym, für Bewerbungsunterlagen und
   * Buchungsfotos. `../../<x>/payslips` ergab einen Schlüssel ausserhalb des
   * Organisations- und Profilpräfixes. Überschreiben liess sich damit nichts
   * (das letzte Segment ist zufällig), aber jede Regel, die sich auf das
   * Präfix verlässt — eine Bucket-Richtlinie, ein Auflisten zum Aufräumen —,
   * wäre damit umgangen. Alle Aufrufer übergeben ohnehin eine cuid.
   */
  scopeId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,60}$/, 'Die Zuordnung enthält unzulässige Zeichen.')
    .optional(),
});
export type UploadUrlInput = z.infer<typeof uploadUrlSchema>;

/**
 * Der Abschluss eines Uploads.
 *
 * **Bemerkenswert ist, was hier fehlt.** Kein Pfad, keine Adresse, kein
 * MIME-Typ, keine Grösse, kein `isPublic`, kein Bereich. Alles davon stand
 * früher im Körper von `POST /api/media` und wurde übernommen, wie es kam —
 * womit sich jede beliebige Adresse als vertrauenswürdige Datei registrieren
 * liess.
 *
 * Übrig bleiben die Kennung des serverseitig ausgestellten Tickets und ein
 * Namensvorschlag. Alles andere schlägt der Server am Ticket nach oder
 * leitet es aus dem Upload-Profil ab.
 */
export const finalizeUploadSchema = z.object({
  ticketId: z.string().min(1).max(60),
  /**
   * Nur der Anzeigename. Er landet nie in einem Pfad — der steht längst am
   * Ticket — und wird beim Ausliefern zusätzlich entschärft.
   */
  filename: z.string().trim().min(1).max(255),
});
export type FinalizeUploadInput = z.infer<typeof finalizeUploadSchema>;
