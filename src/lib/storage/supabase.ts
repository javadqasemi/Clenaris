import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { nanoid } from 'nanoid';

import { hasIntegration, serverEnv } from '@/lib/env';
import { ConfigurationError, IntegrationError } from '@/lib/errors';

import {
  sanitizeFilename,
  validateUpload,
  type SignedUploadTarget,
  type UploadProfile,
} from './profiles';

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

let admin: SupabaseClient | null = null;

function supabaseAdmin(): SupabaseClient {
  if (!hasIntegration('supabase')) {
    // Nennt beim Namen, was fehlt. Die vorherige Meldung („Ein externer Dienst
    // ist derzeit nicht erreichbar") schickte auf die Suche nach einem
    // Netzproblem, das es nie gab.
    const missing = [
      process.env.NEXT_PUBLIC_SUPABASE_URL ? null : 'NEXT_PUBLIC_SUPABASE_URL',
      process.env.SUPABASE_SERVICE_ROLE_KEY ? null : 'SUPABASE_SERVICE_ROLE_KEY',
    ].filter(Boolean);

    throw new ConfigurationError(
      'Supabase',
      `Der Dateispeicher ist nicht eingerichtet — ${missing.join(' und ')} fehlt in der Umgebung. ` +
        'Ohne ihn lassen sich keine Bilder und Dokumente hochladen.',
    );
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
