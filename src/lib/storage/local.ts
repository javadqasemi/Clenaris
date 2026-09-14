import 'server-only';

import { nanoid } from 'nanoid';

import { prisma } from '@/lib/db';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { absoluteUrl } from '@/lib/utils';
import { describeUploadLimit } from '@/lib/validation/files';

import {
  sanitizeFilename,
  UPLOAD_PROFILES,
  validateUpload,
  type SignedUploadTarget,
  type UploadProfile,
} from './profiles';

/**
 * Eingebauter Dateispeicher — die Rückfallebene ohne externen Dienst.
 *
 * **Warum es ihn gibt.** Ohne eingerichteten Objektspeicher schlug jeder
 * Upload fehl: Profilbild, Einsatzfotos, Galerie, Bewerbungsunterlagen. Eine
 * Anwendung, die ohne fremdes Konto nicht benutzbar ist, ist im ersten Kontakt
 * kaputt — und die Fehlermeldung („Ein externer Dienst ist derzeit nicht
 * erreichbar") schickte auf die Suche nach einem Netzproblem, das es nie gab.
 *
 * **Der Kunstgriff: dieselbe Form wie der externe Speicher.** Der Browser
 * fordert eine Upload-Adresse an, lädt dorthin hoch und meldet die fertige
 * Datei. Diese Rückfallebene liefert einfach eine Adresse *auf diese
 * Anwendung* statt eine zu Supabase. Am Client ändert sich dadurch keine
 * einzige Zeile — und der Wechsel zum externen Speicher ist später eine
 * Umgebungsvariable, kein Umbau.
 *
 * **Die Platzhalter-Zeile ist die Berechtigung.** `createSignedUpload` legt
 * eine Zeile ohne Inhalt an; ihre ID ist eine nicht erratbare `cuid` und
 * zugleich die Adresse. Wer sie nicht hat, kann nicht hochladen; wer sie hat,
 * darf es genau einmal und nur bis `expiresAt`. Damit braucht die
 * Upload-Route keine eigene Sitzungsprüfung — die Prüfung ist beim Anfordern
 * der Adresse bereits passiert.
 */

/**
 * Obergrenze der Rückfallebene: 256 MiB.
 *
 * Die allgemeine Grenze liegt bei 1 GiB (`MAX_UPLOAD_BYTES`); die gilt für
 * den externen Objektspeicher. Die Rückfallebene kann sie nicht tragen, und
 * zwar aus der Technik heraus, nicht aus Vorsicht: Prisma überträgt `Bytes`
 * base64-kodiert als *eine* Zeichenkette an die Query-Engine, und V8 begrenzt
 * eine Zeichenkette auf rund 537 Millionen Zeichen. Base64 braucht vier
 * Zeichen je drei Byte — rechnerisch ist bei etwa 400 MB Schluss, und der
 * JSON-Rahmen darum herum kostet auch noch. Gemessen am 14. September 2026
 * gegen die laufende Anwendung: 256 MB werden angenommen und vollständig
 * zurückgelesen, 384 MB scheitern mit einem internen Fehler. Deshalb 256 —
 * die letzte Zweierpotenz, die nachweislich geht, mit Luft nach oben.
 *
 * Zwei weitere Gründe, die Grenze nicht auszureizen:
 *
 *  • **Serverlose Plattformen begrenzen den Anfragekörper**, bei Vercel auf
 *    4.5 MB. Dort kommt eine grosse Datei ohnehin nicht an, sondern scheitert
 *    mit einem Plattformfehler, den diese Anwendung nicht abfangen kann. Wer
 *    dort betreibt, richtet den externen Speicher ein.
 *
 *  • **Binärdaten liegen in den Sicherungen der Datenbank.** Ein paar
 *    Profilbilder fallen nicht auf, zweihundert Baustellenfotos zu je zwölf
 *    Megabyte schon — und ein einziges 256-MB-Video erst recht.
 */
export const LOCAL_MAX_BYTES = 256 * 1024 * 1024;

/** Wie lange eine angeforderte Upload-Adresse gültig bleibt. */
const UPLOAD_WINDOW_MS = 2 * 60 * 60 * 1000;

export function localUploadUrl(id: string): string {
  return `/api/files/blob/${id}`;
}

/**
 * Platzhalter anlegen und die Adresse zurückgeben.
 *
 * Die Signatur entspricht der des externen Speichers, damit der Aufrufer nicht
 * weiss, welcher Weg gerade gilt.
 */
export async function createLocalUpload(params: {
  profile: UploadProfile;
  organizationId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  scopeId?: string;
  uploadedById?: string | null;
}): Promise<SignedUploadTarget> {
  const config = validateUpload(params.profile, params.mimeType, params.sizeBytes);

  if (params.sizeBytes > LOCAL_MAX_BYTES) {
    throw new ValidationError(
      `Die Datei ist ${(params.sizeBytes / 1024 / 1024).toFixed(1)} MB gross. ` +
        `Ohne eingerichteten Dateispeicher nimmt die Anwendung höchstens ` +
        `${describeUploadLimit(LOCAL_MAX_BYTES)} je Datei an. ` +
        'Verkleinern Sie die Datei — oder richten Sie Supabase Storage ein, dann gelten wieder die vollen Grenzen.',
    );
  }

  const path = [
    params.organizationId,
    config.folder,
    params.scopeId,
    `${Date.now()}-${nanoid(10)}-${sanitizeFilename(params.filename)}`,
  ]
    .filter(Boolean)
    .join('/');

  const record = await prisma.storedFile.create({
    data: {
      organizationId: params.organizationId,
      path,
      mimeType: params.mimeType,
      // Die angekündigte Grösse ist eine Behauptung des Clients; verbindlich
      // geprüft wird beim Empfang gegen `maxBytes`.
      maxBytes: Math.min(config.maxBytes, LOCAL_MAX_BYTES),
      uploadedById: params.uploadedById ?? null,
      expiresAt: new Date(Date.now() + UPLOAD_WINDOW_MS),
    },
    select: { id: true },
  });

  return {
    path,
    token: record.id,
    signedUrl: absoluteUrl(localUploadUrl(record.id)),
    publicUrl: localUploadUrl(record.id),
    expiresIn: UPLOAD_WINDOW_MS / 1000,
  };
}

/** Serverseitig erzeugte Datei (PDF, Export) direkt ablegen. */
export async function putLocalBuffer(params: {
  organizationId: string;
  path: string;
  content: Buffer | Uint8Array;
  contentType: string;
}): Promise<{ path: string; publicUrl: string }> {
  const data = Buffer.from(params.content);

  if (data.byteLength > LOCAL_MAX_BYTES) {
    throw new ValidationError(
      `Die erzeugte Datei ist zu gross für den eingebauten Speicher (max. ${describeUploadLimit(
        LOCAL_MAX_BYTES,
      )}).`,
    );
  }

  /**
   * Gleicher Pfad, gleiche Zeile: Ein neu erzeugtes Rechnungs-PDF ersetzt das
   * vorherige, statt eine zweite Fassung unter derselben Adresse zu erzeugen.
   */
  const existing = await prisma.storedFile.findFirst({
    where: { organizationId: params.organizationId, path: params.path },
    select: { id: true },
  });

  const record = existing
    ? await prisma.storedFile.update({
        where: { id: existing.id },
        data: {
          data,
          sizeBytes: data.byteLength,
          mimeType: params.contentType,
          uploadedAt: new Date(),
        },
        select: { id: true },
      })
    : await prisma.storedFile.create({
        data: {
          organizationId: params.organizationId,
          path: params.path,
          mimeType: params.contentType,
          maxBytes: LOCAL_MAX_BYTES,
          data,
          sizeBytes: data.byteLength,
          uploadedAt: new Date(),
          expiresAt: new Date(Date.now() + UPLOAD_WINDOW_MS),
        },
        select: { id: true },
      });

  return { path: params.path, publicUrl: localUploadUrl(record.id) };
}

/**
 * Hochgeladene Daten entgegennehmen.
 *
 * Die Prüfungen in dieser Reihenfolge, und jede aus einem eigenen Grund:
 * unbekannte ID (die Adresse ist die Berechtigung), bereits beschrieben
 * (einmal und nicht öfter), abgelaufen (eine alte Adresse taugt nicht als
 * dauerhafter Schreibzugang), zu gross (die angekündigte Grösse war gelogen).
 */
export async function receiveLocalUpload(params: {
  id: string;
  data: Buffer;
  mimeType?: string | null;
}): Promise<{ url: string }> {
  const record = await prisma.storedFile.findUnique({
    where: { id: params.id },
    select: { id: true, data: true, maxBytes: true, expiresAt: true, mimeType: true },
  });

  if (!record) throw new NotFoundError('Upload-Adresse');

  if (record.data !== null) {
    throw new ValidationError('Diese Upload-Adresse wurde bereits verwendet.');
  }

  if (record.expiresAt.getTime() < Date.now()) {
    throw new ValidationError('Diese Upload-Adresse ist abgelaufen. Bitte erneut versuchen.');
  }

  if (params.data.byteLength === 0) {
    throw new ValidationError('Die übertragene Datei ist leer.');
  }

  if (params.data.byteLength > record.maxBytes) {
    throw new ValidationError(
      `Die Datei überschreitet die zulässige Grösse von ${describeUploadLimit(record.maxBytes)}.`,
    );
  }

  await prisma.storedFile.update({
    where: { id: record.id },
    data: {
      // `Uint8Array` statt `Buffer`: Prisma erwartet für `Bytes` genau diesen
      // Typ, und `Buffer` erbt von einem `ArrayBufferLike`, das auch geteilten
      // Speicher zulässt — den Prisma nicht annimmt.
      data: new Uint8Array(params.data),
      sizeBytes: params.data.byteLength,
      // Der beim Anfordern gemeldete Typ bleibt massgebend: Er wurde gegen das
      // Upload-Profil geprüft, der Kopf der Übertragung nicht.
      uploadedAt: new Date(),
    },
  });

  return { url: localUploadUrl(record.id) };
}

/** Datei ausliefern. */
export async function readLocalFile(id: string) {
  const record = await prisma.storedFile.findUnique({
    where: { id },
    select: { data: true, mimeType: true, sizeBytes: true, path: true, uploadedAt: true },
  });

  if (!record?.data || !record.uploadedAt) throw new NotFoundError('Datei');
  return record;
}

export async function deleteLocalFile(pathOrId: string): Promise<void> {
  // Aufrufer halten mal die ID (aus der Adresse), mal den logischen Pfad.
  await prisma.storedFile.deleteMany({
    where: { OR: [{ id: pathOrId }, { path: pathOrId }] },
  });
}

/** Nie beschriebene Platzhalter aufräumen — vom täglichen Lauf aufgerufen. */
export async function purgeExpiredUploads(): Promise<number> {
  const result = await prisma.storedFile.deleteMany({
    where: { data: null, expiresAt: { lt: new Date() } },
  });
  return result.count;
}

/** Für Fehlermeldungen: Welche Profile passen überhaupt noch in die Rückfallebene? */
export function localLimitFor(profile: UploadProfile): number {
  return Math.min(UPLOAD_PROFILES[profile].maxBytes, LOCAL_MAX_BYTES);
}
