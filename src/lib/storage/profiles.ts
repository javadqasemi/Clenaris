import 'server-only';

import { ValidationError } from '@/lib/errors';
import type { UploadProfileName } from '@/lib/validation/files';

/**
 * Was hochgeladen werden darf — unabhängig davon, *wohin*.
 *
 * Die Profile standen bis zur Einführung der eingebauten Rückfallebene im
 * Supabase-Modul. Sie gehören dort nicht hin: Welche Dateitypen eine Bewerbung
 * annimmt und wie gross ein Baustellenfoto sein darf, ist eine fachliche
 * Festlegung und keine Eigenschaft des Speicheranbieters. Stünden sie weiter
 * dort, müsste das lokale Modul das externe importieren — und damit dessen
 * Client-Bibliothek mitschleppen, auch wenn gar kein externer Speicher
 * eingerichtet ist.
 */

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic'];
const DOCUMENT_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
];

export const UPLOAD_PROFILES = {
  jobPhoto: { types: IMAGE_TYPES, maxBytes: 15 * 1024 * 1024, folder: 'jobs' },
  bookingPhoto: { types: IMAGE_TYPES, maxBytes: 15 * 1024 * 1024, folder: 'bookings' },
  avatar: { types: IMAGE_TYPES, maxBytes: 4 * 1024 * 1024, folder: 'avatars' },
  document: { types: [...DOCUMENT_TYPES, ...IMAGE_TYPES], maxBytes: 25 * 1024 * 1024, folder: 'documents' },
  receipt: { types: [...DOCUMENT_TYPES, ...IMAGE_TYPES], maxBytes: 15 * 1024 * 1024, folder: 'receipts' },
  cv: { types: DOCUMENT_TYPES, maxBytes: 15 * 1024 * 1024, folder: 'applications' },
  gallery: { types: IMAGE_TYPES, maxBytes: 20 * 1024 * 1024, folder: 'gallery' },
  invoice: { types: ['application/pdf'], maxBytes: 10 * 1024 * 1024, folder: 'invoices' },
  quote: { types: ['application/pdf'], maxBytes: 10 * 1024 * 1024, folder: 'quotes' },
} as const;

export type UploadProfile = keyof typeof UPLOAD_PROFILES;

/**
 * Die Zod-Schicht führt dieselbe Liste eigenständig (sie darf `server-only`
 * nicht importieren). Diese beiden Zuweisungen sind der Beweis, dass beide
 * Listen deckungsgleich sind — läuft eine auseinander, schlägt `tsc` fehl.
 */
const _profilesCoverSchema: UploadProfileName = '' as unknown as UploadProfile;
const _schemaCoversProfiles: UploadProfile = '' as unknown as UploadProfileName;
void _profilesCoverSchema;
void _schemaCoversProfiles;

/** Dateinamen entschärfen: Pfad-Traversal und Sonderzeichen entfernen. */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? 'datei';
  const cleaned = base
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 120);
  return cleaned || 'datei';
}

export function validateUpload(profile: UploadProfile, mimeType: string, sizeBytes: number) {
  const config = UPLOAD_PROFILES[profile];
  if (!config.types.includes(mimeType as never)) {
    throw new ValidationError(
      `Dieser Dateityp wird nicht unterstützt. Erlaubt sind: ${config.types
        .map((t) => t.split('/')[1].toUpperCase())
        .join(', ')}.`,
    );
  }
  if (sizeBytes > config.maxBytes) {
    throw new ValidationError(
      `Die Datei ist zu gross (max. ${Math.round(config.maxBytes / 1024 / 1024)} MB).`,
    );
  }
  return config;
}

export interface SignedUploadTarget {
  path: string;
  token: string;
  signedUrl: string;
  publicUrl: string;
  expiresIn: number;
}
