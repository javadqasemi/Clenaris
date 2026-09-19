import 'server-only';

import { sha256Hex } from '@/lib/crypto';
import { ValidationError } from '@/lib/errors';
import {
  MAX_UPLOAD_BYTES,
  describeUploadLimit,
  type UploadProfileName,
} from '@/lib/validation/files';

import { pruefeSignatur } from './signatures';

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

/**
 * Alle Profile teilen sich die eine Obergrenze von 1 GiB (`MAX_UPLOAD_BYTES`).
 * Früher hatte jedes Profil eine eigene (4 bis 25 MB); die Staffelung kam
 * aus der Zeit, als Uploads durch die Anwendung liefen und Bilder in der
 * Datenbank landeten. Mit dem direkten Upload zum Objektspeicher bleibt nur
 * der Dateityp eine fachliche Frage — die Grösse begrenzt der Speicher.
 */
export const UPLOAD_PROFILES = {
  jobPhoto: { types: IMAGE_TYPES, maxBytes: MAX_UPLOAD_BYTES, folder: 'jobs' },
  bookingPhoto: { types: IMAGE_TYPES, maxBytes: MAX_UPLOAD_BYTES, folder: 'bookings' },
  avatar: { types: IMAGE_TYPES, maxBytes: MAX_UPLOAD_BYTES, folder: 'avatars' },
  document: { types: [...DOCUMENT_TYPES, ...IMAGE_TYPES], maxBytes: MAX_UPLOAD_BYTES, folder: 'documents' },
  receipt: { types: [...DOCUMENT_TYPES, ...IMAGE_TYPES], maxBytes: MAX_UPLOAD_BYTES, folder: 'receipts' },
  cv: { types: DOCUMENT_TYPES, maxBytes: MAX_UPLOAD_BYTES, folder: 'applications' },
  gallery: { types: IMAGE_TYPES, maxBytes: MAX_UPLOAD_BYTES, folder: 'gallery' },
  invoice: { types: ['application/pdf'], maxBytes: MAX_UPLOAD_BYTES, folder: 'invoices' },
  quote: { types: ['application/pdf'], maxBytes: MAX_UPLOAD_BYTES, folder: 'quotes' },
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

/**
 * Vorprüfung beim Anfordern einer Upload-Adresse.
 *
 * Arbeitet ausschliesslich mit dem, was der Client *behauptet* — mehr liegt
 * zu diesem Zeitpunkt nicht vor. Das ist Bequemlichkeit, keine Sicherheit:
 * Sie erspart den Upload einer Datei, die ohnehin abgelehnt würde. Verbindlich
 * ist allein `verifyBytes` nach dem Upload.
 */
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
      `Die Datei ist zu gross (max. ${describeUploadLimit(config.maxBytes)}).`,
    );
  }
  return config;
}

export interface ByteBefund {
  /** SHA-256 der geprüften Bytes, hexadezimal in Kleinschrift. */
  checksum: string;
  /** Die *tatsächliche* Grösse — nicht die angekündigte. */
  sizeBytes: number;
  /** Der bestätigte MIME-Typ; identisch mit dem angemeldeten. */
  mimeType: string;
}

/**
 * Die zentrale Byteprüfung. Jede angenommene Benutzerdatei geht hier durch.
 *
 * **Die Reihenfolge ist Absicht.** Erst leer, dann zu gross, dann Typ gegen
 * Profil, dann Signatur — die billigen Prüfungen zuerst, und die Signatur
 * zuletzt, weil ihre Fehlermeldung die aufschlussreichste ist und sonst von
 * einer banaleren verdeckt würde.
 *
 * **Was hier als Tatsache gilt und was nicht.** `bytes.length` ist die
 * Grösse; die Angabe des Clients wird nicht einmal übergeben. Die
 * Dateiendung kommt nicht vor. Der angemeldete MIME-Typ wird geprüft, nicht
 * geglaubt: Er muss im Profil stehen *und* zur Signatur passen.
 *
 * Es wird nie protokolliert, was in der Datei steht — nur, welches Format
 * erkannt wurde.
 */
export function verifyBytes(
  profile: UploadProfile,
  mimeType: string,
  bytes: Buffer,
): ByteBefund {
  const config = UPLOAD_PROFILES[profile];

  if (bytes.byteLength === 0) {
    throw new ValidationError('Die Datei ist leer.');
  }

  if (bytes.byteLength > config.maxBytes) {
    throw new ValidationError(
      `Die Datei ist zu gross (max. ${describeUploadLimit(config.maxBytes)}).`,
    );
  }

  if (!config.types.includes(mimeType as never)) {
    throw new ValidationError(
      `Dieser Dateityp wird nicht unterstützt. Erlaubt sind: ${config.types
        .map((t) => t.split('/')[1].toUpperCase())
        .join(', ')}.`,
    );
  }

  const befund = pruefeSignatur(mimeType, bytes);
  if (!befund.passt) {
    throw new ValidationError(
      `Der Inhalt der Datei passt nicht zum angegebenen Typ. ${befund.grund ?? ''}`.trim(),
    );
  }

  return {
    checksum: sha256Hex(bytes),
    sizeBytes: bytes.byteLength,
    mimeType,
  };
}

export interface SignedUploadTarget {
  path: string;
  /**
   * Die Kennung des Upload-Tickets — das Einzige, was der Client beim
   * Abschluss zurückmelden muss.
   *
   * Pfad, Profil, Organisation und Obergrenze stehen serverseitig am Ticket.
   * Damit gibt es nichts mehr, das der Client über seine Datei behaupten
   * könnte: Er nennt eine Kennung, alles andere schlägt der Server nach.
   */
  ticketId: string;
  token: string;
  signedUrl: string;
  publicUrl: string;
  expiresIn: number;
}
