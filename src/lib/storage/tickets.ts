import 'server-only';

import { nanoid } from 'nanoid';

import { prisma } from '@/lib/db';

import { sanitizeFilename, UPLOAD_PROFILES, type UploadProfile } from './profiles';

/**
 * Das Upload-Ticket — eine serverseitig ausgestellte Erlaubnis, genau eine
 * Datei an genau einen Pfad zu legen.
 *
 * **Warum es das für beide Treiber gibt.** Die Rückfallebene kannte so etwas
 * schon: `createLocalUpload` legte eine leere `StoredFile`-Zeile an, deren
 * Adresse zugleich das Upload-Ziel war. Der externe Weg hatte nichts
 * dergleichen — `createSignedUpload` bat Supabase um eine signierte Adresse
 * und schrieb selbst keine Zeile.
 *
 * Damit liess sich beim Abschluss nichts mehr überprüfen. Der Client meldete
 * Pfad, Typ und Grösse, und der Server hatte keine Aufzeichnung, gegen die er
 * das hätte halten können: Nicht, ob dieser Pfad je genehmigt worden war,
 * nicht für welches Profil, nicht für welche Organisation, nicht von wem. Das
 * war der Grund, warum `POST /api/media` eine beliebige Adresse als
 * vertrauenswürdige Datei registrieren konnte.
 *
 * Jetzt entsteht die Zeile in beiden Fällen, und sie ist die Aufzeichnung.
 * Bei `LOCAL` nimmt sie zusätzlich die Bytes auf; bei `SUPABASE` bleibt
 * `data` leer und der Pfad zeigt in den Objektspeicher.
 */

/** Wie lange eine ausgestellte Upload-Adresse gültig bleibt. */
export const UPLOAD_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Den Ablagepfad bestimmen — ausschliesslich serverseitig.
 *
 * Organisation und Ordner kommen aus dem Profil, der Dateiname wird
 * entschärft, und ein Zeitstempel mit Zufallsteil verhindert, dass zwei
 * Uploads desselben Namens einander überschreiben. Der Client hat auf keinen
 * Bestandteil Einfluss ausser dem Namensvorschlag.
 */
export function buildStoragePath(params: {
  organizationId: string;
  profile: UploadProfile;
  filename: string;
  scopeId?: string;
}): string {
  const config = UPLOAD_PROFILES[params.profile];
  return [
    params.organizationId,
    config.folder,
    params.scopeId,
    `${Date.now()}-${nanoid(10)}-${sanitizeFilename(params.filename)}`,
  ]
    .filter(Boolean)
    .join('/');
}

export async function createTicket(params: {
  organizationId: string;
  profile: UploadProfile;
  path: string;
  mimeType: string;
  maxBytes: number;
  driver: 'LOCAL' | 'SUPABASE';
  uploadedById?: string | null;
}): Promise<{ id: string }> {
  return prisma.storedFile.create({
    data: {
      organizationId: params.organizationId,
      path: params.path,
      // Der angemeldete Typ. Beim Abschluss wird er gegen die Bytes geprüft;
      // bis dahin ist er eine Behauptung und wird auch so behandelt.
      mimeType: params.mimeType,
      maxBytes: params.maxBytes,
      driver: params.driver,
      profile: params.profile,
      uploadedById: params.uploadedById ?? null,
      expiresAt: new Date(Date.now() + UPLOAD_WINDOW_MS),
    },
    select: { id: true },
  });
}

/**
 * Ein Ticket samt allem, was der Abschluss zum Prüfen braucht.
 *
 * Bewusst ohne `data`: Die Bytes können 256 MB sein, und für die
 * Zulässigkeitsprüfung werden sie nicht gebraucht.
 */
export async function loadTicket(id: string) {
  return prisma.storedFile.findUnique({
    where: { id },
    select: {
      id: true,
      organizationId: true,
      path: true,
      mimeType: true,
      maxBytes: true,
      driver: true,
      profile: true,
      checksum: true,
      sizeBytes: true,
      uploadedById: true,
      uploadedAt: true,
      expiresAt: true,
      asset: { select: { id: true } },
    },
  });
}

export type Ticket = NonNullable<Awaited<ReturnType<typeof loadTicket>>>;

/**
 * Ist dieses Ticket abgeschlossen?
 *
 * Die Invariante von Gate 2 in einer Zeile: `checksum` wird ausschliesslich
 * nach bestandener Byteprüfung geschrieben. Ein Ticket ohne Prüfsumme ist
 * kein gültiges Fachobjekt, gleichgültig ob Bytes vorliegen.
 */
export function istAbgeschlossen(ticket: { checksum: string | null }): boolean {
  return ticket.checksum !== null;
}
