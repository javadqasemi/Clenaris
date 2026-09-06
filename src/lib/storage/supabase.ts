import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { nanoid } from 'nanoid';

import { hasIntegration, serverEnv } from '@/lib/env';
import { IntegrationError, ValidationError } from '@/lib/errors';
import type { UploadProfileName } from '@/lib/validation/files';

/**
 * Datei-Ablage über Supabase Storage.
 *
 * Architekturentscheid: Uploads laufen *nicht* durch die Next.js-Route.
 * Der Server erstellt eine signierte Upload-URL, der Browser lädt direkt zu
 * Supabase hoch. Damit umgehen wir das 4.5-MB-Limit für Vercel-Function-Bodies,
 * sparen Bandbreite und halten den Upload auch bei grossen Baustellenfotos
 * schnell. Der Server behält die Kontrolle: er bestimmt Pfad, Grösse und
 * erlaubte MIME-Typen und legt erst nach dem Upload den `FileAsset`-Datensatz an.
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

let admin: SupabaseClient | null = null;

function supabaseAdmin(): SupabaseClient {
  if (!hasIntegration('supabase')) {
    throw new IntegrationError('Supabase', 'Storage ist nicht konfiguriert.');
  }
  admin ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serverEnv().SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return admin;
}

function bucket(): string {
  return serverEnv().SUPABASE_STORAGE_BUCKET;
}

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

/** Erzeugt eine signierte Upload-URL für einen Direkt-Upload aus dem Browser. */
export async function createSignedUpload(params: {
  profile: UploadProfile;
  organizationId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Optionaler Unterordner, z. B. die Job-ID. */
  scopeId?: string;
}): Promise<SignedUploadTarget> {
  const config = validateUpload(params.profile, params.mimeType, params.sizeBytes);
  const safeName = sanitizeFilename(params.filename);
  const path = [
    params.organizationId,
    config.folder,
    params.scopeId,
    `${Date.now()}-${nanoid(10)}-${safeName}`,
  ]
    .filter(Boolean)
    .join('/');

  const { data, error } = await supabaseAdmin()
    .storage.from(bucket())
    .createSignedUploadUrl(path);

  if (error || !data) {
    throw new IntegrationError('Supabase', error?.message ?? 'Upload-URL konnte nicht erstellt werden.');
  }

  return {
    path,
    token: data.token,
    signedUrl: data.signedUrl,
    publicUrl: getPublicUrl(path),
    expiresIn: 7200,
  };
}

/** Serverseitiger Upload (PDFs, generierte Exporte). */
export async function uploadBuffer(params: {
  path: string;
  content: Buffer | Uint8Array;
  contentType: string;
  upsert?: boolean;
}): Promise<{ path: string; publicUrl: string }> {
  const { error } = await supabaseAdmin()
    .storage.from(bucket())
    .upload(params.path, params.content, {
      contentType: params.contentType,
      upsert: params.upsert ?? true,
      cacheControl: '3600',
    });

  if (error) throw new IntegrationError('Supabase', error.message);

  return { path: params.path, publicUrl: getPublicUrl(params.path) };
}

export function getPublicUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return path;
  return `${base}/storage/v1/object/public/${bucket()}/${path}`;
}

/** Zeitlich begrenzter Zugriff auf nicht-öffentliche Dateien (Rechnungen, Lohnabrechnungen). */
export async function createSignedDownloadUrl(path: string, expiresIn = 3600): Promise<string> {
  const { data, error } = await supabaseAdmin()
    .storage.from(bucket())
    .createSignedUrl(path, expiresIn);

  if (error || !data) {
    throw new IntegrationError('Supabase', error?.message ?? 'Download-Link konnte nicht erstellt werden.');
  }
  return data.signedUrl;
}

export async function deleteFile(path: string): Promise<void> {
  const { error } = await supabaseAdmin().storage.from(bucket()).remove([path]);
  if (error) throw new IntegrationError('Supabase', error.message);
}

export async function deleteFiles(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await supabaseAdmin().storage.from(bucket()).remove(paths);
  if (error) throw new IntegrationError('Supabase', error.message);
}
