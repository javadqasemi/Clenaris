import 'server-only';

import { hasIntegration } from '@/lib/env';

import * as remote from './supabase';
import * as local from './local';
import type { SignedUploadTarget, UploadProfile } from './profiles';

/**
 * Der Zugang zum Dateispeicher — mit oder ohne externen Dienst.
 *
 * **Die Regel ist eine Zeile:** Ist Supabase eingerichtet, gilt Supabase; sonst
 * die eingebaute Rückfallebene. Sie steht genau hier und nirgends sonst. Jede
 * Aufrufstelle — Profilbild, Einsatzfotos, Rechnungs-PDF, Mediathek — ruft
 * dieselben Funktionen und weiss nicht, welcher Weg gerade gilt.
 *
 * **Warum überhaupt zwei Wege.** Der externe Speicher ist der bessere: Der
 * Browser lädt an der Anwendung vorbei hoch, was das Body-Limit serverloser
 * Funktionen umgeht und bei einem 12-MB-Baustellenfoto den Unterschied
 * ausmacht. Er ist aber eine Voraussetzung, die man erst schaffen muss — und
 * ohne sie war bisher jeder Upload kaputt, vom Profilbild bis zur Bewerbung.
 * Eine Anwendung, die ohne fremdes Konto nicht benutzbar ist, ist im ersten
 * Kontakt kaputt.
 *
 * **Die Rückfallebene ist nicht die empfohlene Betriebsart.** Sie legt
 * Binärdaten in die Datenbank, wo sie in jeder Sicherung mitwandern, und ist
 * deshalb auf kleine Dateien begrenzt. Für den Betrieb mit vielen
 * Einsatzfotos richtet man Supabase Storage ein — dann gelten wieder die
 * vollen Grenzen, ohne dass eine Zeile Code sich ändert.
 */

export {
  UPLOAD_PROFILES,
  sanitizeFilename,
  validateUpload,
  type SignedUploadTarget,
  type UploadProfile,
} from './profiles';

export { LOCAL_MAX_BYTES } from './local';

/** Steht ein externer Objektspeicher zur Verfügung? */
export function usesRemoteStorage(): boolean {
  return hasIntegration('supabase');
}

export async function createSignedUpload(params: {
  profile: UploadProfile;
  organizationId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  scopeId?: string;
  uploadedById?: string | null;
}): Promise<SignedUploadTarget> {
  if (usesRemoteStorage()) return remote.createSignedUpload(params);
  return local.createLocalUpload(params);
}

export async function uploadBuffer(params: {
  organizationId: string;
  path: string;
  content: Buffer | Uint8Array;
  contentType: string;
  upsert?: boolean;
}): Promise<{ path: string; publicUrl: string }> {
  if (usesRemoteStorage()) {
    return remote.uploadBuffer({
      path: params.path,
      content: params.content,
      contentType: params.contentType,
      upsert: params.upsert,
    });
  }
  return local.putLocalBuffer({
    organizationId: params.organizationId,
    path: params.path,
    content: params.content,
    contentType: params.contentType,
  });
}

export function getPublicUrl(path: string): string {
  if (usesRemoteStorage()) return remote.getPublicUrl(path);
  // Ohne externen Speicher ist die Adresse bereits die fertige Route; sie
  // entsteht beim Ablegen und wird dort zurückgegeben.
  return path;
}

/**
 * Zeitlich begrenzter Zugriff auf nicht-öffentliche Dateien.
 *
 * Die Rückfallebene kennt keine ablaufenden Verweise: Die Adresse ist eine
 * nicht erratbare `cuid` und damit selbst das Geheimnis. Das ist schwächer als
 * ein befristeter Verweis und wird hier ausdrücklich in Kauf genommen — sie
 * ist die Notlösung, nicht die Zielarchitektur.
 */
export async function createSignedDownloadUrl(path: string, expiresIn = 3600): Promise<string> {
  if (usesRemoteStorage()) return remote.createSignedDownloadUrl(path, expiresIn);
  return path;
}

export async function deleteFile(path: string): Promise<void> {
  if (usesRemoteStorage()) return remote.deleteFile(path);
  return local.deleteLocalFile(path);
}

export async function deleteFiles(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  if (usesRemoteStorage()) return remote.deleteFiles(paths);
  await Promise.all(paths.map((path) => local.deleteLocalFile(path)));
}

export { purgeExpiredUploads, readLocalFile, receiveLocalUpload } from './local';
