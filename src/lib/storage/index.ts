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
  verifyBytes,
  type ByteBefund,
  type SignedUploadTarget,
  type UploadProfile,
} from './profiles';

export { erkenneFormat, pruefeSignatur, type ErkanntesFormat } from './signatures';
export { istAbgeschlossen, loadTicket, type Ticket } from './tickets';

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
 * **Korrektur einer früheren Zusage.** Hier stand, die Rückfallebene brauche
 * keine ablaufenden Verweise, weil „die Adresse eine nicht erratbare `cuid`
 * und damit selbst das Geheimnis" sei. Das war dieselbe falsche Zusicherung
 * wie an zwei weiteren Stellen: Eine cuid ist eine Kennung, kein Geheimnis
 * (die Herleitung steht in `local.ts`).
 *
 * Die Rückfallebene braucht trotzdem keinen befristeten Verweis — aber aus
 * einem anderen Grund als dem angegebenen: Ihre Ausgaberoute prüft seit
 * Gate 2 bei jedem Abruf die Sitzung und die Fachbeziehung. Der Schutz liegt
 * in der Prüfung, nicht in der Adresse.
 */
export async function createSignedDownloadUrl(path: string, expiresIn = 3600): Promise<string> {
  if (usesRemoteStorage()) return remote.createSignedDownloadUrl(path, expiresIn);
  return path;
}

/**
 * Die tatsächlich gespeicherten Bytes einer Datei lesen — treiberunabhängig.
 *
 * Das ist die eine Stelle, an der der Abschluss erfährt, was wirklich abgelegt
 * wurde. Bei `SUPABASE` ein Download, bei `LOCAL` ein Lesen aus der
 * Datenbankzeile; in beiden Fällen genau einmal je Abschluss.
 *
 * `null` heisst: Es liegt nichts da. Der häufigste ehrliche Fall ist ein
 * Abschluss, dessen Upload nie ankam.
 */
export async function readStoredBytes(ticket: {
  id: string;
  path: string;
  driver: 'LOCAL' | 'SUPABASE';
}): Promise<Buffer | null> {
  if (ticket.driver === 'SUPABASE') return remote.downloadObject(ticket.path);
  return local.readLocalBytes(ticket.id);
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

export { purgeExpiredUploads, readLocalBytes, readLocalFile, receiveLocalUpload } from './local';
