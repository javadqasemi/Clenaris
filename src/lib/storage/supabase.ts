import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { hasIntegration, serverEnv } from '@/lib/env';
import { ConfigurationError, IntegrationError } from '@/lib/errors';

import { validateUpload, type SignedUploadTarget, type UploadProfile } from './profiles';
import { buildStoragePath, createTicket } from './tickets';

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

/**
 * Erzeugt eine signierte Upload-URL für einen Direkt-Upload aus dem Browser.
 *
 * **Neu seit Gate 2: Es entsteht dabei ein Ticket.** Vorher schrieb diese
 * Funktion keine Zeile — der Server bat Supabase um eine Adresse und vergass
 * sie. Beim Abschluss liess sich deshalb nicht mehr feststellen, ob ein
 * gemeldeter Pfad je genehmigt worden war, für welches Profil und für wen.
 * Die Kennung des Tickets ist jetzt das, was der Client zurückmeldet; den
 * Pfad bestimmt allein der Server.
 */
export async function createSignedUpload(params: {
  profile: UploadProfile;
  organizationId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Optionaler Unterordner, z. B. die Job-ID. */
  scopeId?: string;
  uploadedById?: string | null;
}): Promise<SignedUploadTarget> {
  const config = validateUpload(params.profile, params.mimeType, params.sizeBytes);
  const path = buildStoragePath({
    organizationId: params.organizationId,
    profile: params.profile,
    filename: params.filename,
    scopeId: params.scopeId,
  });

  const { data, error } = await supabaseAdmin()
    .storage.from(bucket())
    .createSignedUploadUrl(path);

  if (error || !data) {
    throw new IntegrationError('Supabase', error?.message ?? 'Upload-URL konnte nicht erstellt werden.');
  }

  const ticket = await createTicket({
    organizationId: params.organizationId,
    profile: params.profile,
    path,
    mimeType: params.mimeType,
    maxBytes: config.maxBytes,
    driver: 'SUPABASE',
    uploadedById: params.uploadedById,
  });

  return {
    path,
    ticketId: ticket.id,
    token: data.token,
    signedUrl: data.signedUrl,
    // Keine öffentliche Leseadresse im Ticket — Begründung bei
    // `SignedUploadTarget` in `profiles.ts`.
    expiresIn: 7200,
  };
}

/**
 * Ein gespeichertes Objekt serverseitig zurücklesen.
 *
 * Der Abschluss braucht die *tatsächlich abgelegten* Bytes: Grösse, Signatur
 * und Prüfsumme sollen die Datei beschreiben, die später ausgeliefert wird,
 * nicht die, die der Browser zu schicken behauptete. Den Metadaten von
 * Supabase wird dafür nicht geglaubt — `content-type` und `size` stammen dort
 * aus demselben Upload, den wir gerade prüfen wollen.
 *
 * Gelesen wird genau einmal je Abschluss.
 */
export async function downloadObject(path: string): Promise<Buffer | null> {
  const { data, error } = await supabaseAdmin().storage.from(bucket()).download(path);

  // Ein fehlendes Objekt ist kein Integrationsfehler, sondern der häufigste
  // ehrliche Fall: Der Abschluss kam, der Upload aber nie an.
  if (error || !data) return null;

  return Buffer.from(await data.arrayBuffer());
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
