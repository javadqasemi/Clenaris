import 'server-only';

import { sha256Hex } from '@/lib/crypto';
import { prisma } from '@/lib/db';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { absoluteUrl } from '@/lib/utils';
import { describeUploadLimit } from '@/lib/validation/files';

import {
  UPLOAD_PROFILES,
  validateUpload,
  verifyBytes,
  type SignedUploadTarget,
  type UploadProfile,
} from './profiles';
import { buildStoragePath, createTicket, UPLOAD_WINDOW_MS } from './tickets';

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
 * **Korrektur einer früheren Zusage an dieser Stelle.** Hier stand: „Die
 * Platzhalter-Zeile ist die Berechtigung … ihre ID ist eine nicht erratbare
 * `cuid` und zugleich die Adresse." Das war zweimal falsch.
 *
 * Erstens ist eine cuid kein Geheimnis. Nachgemessen an den Kennungen dieser
 * Datenbank: Von 25 Zeichen sind acht der auf die Millisekunde genaue
 * Erstellungszeitpunkt, vier ein laufender Zähler und vier ein pro Prozess
 * konstanter Fingerabdruck — über 36 Zeilen kamen genau zwei verschiedene
 * Werte vor. Zufällig sind die letzten acht Zeichen, rund 41 Bit. Das ist
 * eine Kennung, keine Berechtigung.
 *
 * Zweitens deckte die Aussage nur das *Schreiben* ab, wurde aber auch für das
 * *Lesen* in Anspruch genommen: Die Ausgaberoute gab jede Datei heraus, deren
 * Kennung jemand nannte — ohne Sitzung, ohne Kontingent, mit
 * `Cache-Control: public, immutable`. Darunter Lebensläufe und
 * Personaldokumente.
 *
 * Seit Gate 2 gilt: Die Kennung ist eine Kennung. Wer schreiben darf,
 * entscheidet das Ticket (`tickets.ts`); wer lesen darf, entscheidet das
 * zugehörige `FileAsset` und dessen Fachbeziehung (`file.service.ts`).
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

  const path = buildStoragePath({
    organizationId: params.organizationId,
    profile: params.profile,
    filename: params.filename,
    scopeId: params.scopeId,
  });

  const record = await createTicket({
    organizationId: params.organizationId,
    profile: params.profile,
    path,
    mimeType: params.mimeType,
    // Die angekündigte Grösse ist eine Behauptung des Clients; verbindlich
    // geprüft wird beim Empfang gegen `maxBytes`.
    maxBytes: Math.min(config.maxBytes, LOCAL_MAX_BYTES),
    driver: 'LOCAL',
    uploadedById: params.uploadedById,
  });

  return {
    path,
    ticketId: record.id,
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

  /**
   * Servererzeugte Dateien bekommen ihre Prüfsumme sofort. Es gibt hier
   * nichts zu verifizieren — die Bytes stammen aus dem eigenen Renderer, kein
   * Client war beteiligt —, aber der Integritätsnachweis soll für *jede*
   * gespeicherte Datei gelten, nicht nur für hochgeladene. Ohne ihn hätte
   * `verifyFileIntegrity` bei einem Rechnungs-PDF nichts zu vergleichen.
   */
  const checksum = sha256Hex(data);

  const record = existing
    ? await prisma.storedFile.update({
        where: { id: existing.id },
        data: {
          data,
          sizeBytes: data.byteLength,
          mimeType: params.contentType,
          checksum,
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
          checksum,
          driver: 'LOCAL',
          // Kein Upload-Profil: Diese Datei kam nicht durch ein Ticket.
          profile: null,
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
 * unbekanntes Ticket, bereits beschrieben (einmal und nicht öfter),
 * abgelaufen (ein altes Ticket taugt nicht als dauerhafter Schreibzugang),
 * zu gross (die angekündigte Grösse war gelogen).
 *
 * **Dass hier schon die Bytes geprüft werden, ist nicht die Sicherheitsgrenze.**
 * Die liegt im Abschluss (`file.service.ts`), und zwar für beide Treiber
 * gleich — sonst hätte der lokale Weg andere Regeln als der externe, und
 * zwei Regelwerke laufen auseinander. Die Prüfung steht *zusätzlich* hier,
 * damit gar nicht erst 256 MB fremder Daten in der Datenbank landen, die
 * ohnehin abgelehnt würden. Beide Stellen rufen dieselbe Funktion.
 */
export async function receiveLocalUpload(params: {
  id: string;
  data: Buffer;
  mimeType?: string | null;
}): Promise<{ url: string }> {
  const record = await prisma.storedFile.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      data: true,
      maxBytes: true,
      expiresAt: true,
      mimeType: true,
      profile: true,
      driver: true,
    },
  });

  if (!record) throw new NotFoundError('Upload-Adresse');

  if (record.driver !== 'LOCAL') {
    throw new ValidationError('Dieses Upload-Ticket gehört zu einem anderen Speicher.');
  }

  if (record.data !== null) {
    throw new ValidationError('Diese Upload-Adresse wurde bereits verwendet.');
  }

  if (record.expiresAt.getTime() < Date.now()) {
    throw new ValidationError('Diese Upload-Adresse ist abgelaufen. Bitte erneut versuchen.');
  }

  if (params.data.byteLength > record.maxBytes) {
    throw new ValidationError(
      `Die Datei überschreitet die zulässige Grösse von ${describeUploadLimit(record.maxBytes)}.`,
    );
  }

  /**
   * Ohne hinterlegtes Profil lässt sich nicht sagen, welche Dateitypen dieses
   * Ticket erlaubt. Solche Zeilen stammen aus der Zeit vor Gate 2 oder von
   * `putLocalBuffer`; in beiden Fällen ist ein Upload dagegen nicht
   * vorgesehen. Fail closed statt „irgendetwas annehmen".
   */
  if (!record.profile) {
    throw new ValidationError('Dieses Upload-Ticket ist nicht mehr gültig.');
  }

  // Wirft bei leerer Datei, falschem Typ oder nicht passender Signatur. Der
  // beim Anfordern gemeldete Typ ist massgebend, nicht der Kopf der
  // Übertragung: Jener wurde gegen das Profil geprüft, dieser nicht.
  verifyBytes(record.profile as UploadProfile, record.mimeType, params.data);

  await prisma.storedFile.update({
    where: { id: record.id },
    data: {
      // `Uint8Array` statt `Buffer`: Prisma erwartet für `Bytes` genau diesen
      // Typ, und `Buffer` erbt von einem `ArrayBufferLike`, das auch geteilten
      // Speicher zulässt — den Prisma nicht annimmt.
      data: new Uint8Array(params.data),
      sizeBytes: params.data.byteLength,
      uploadedAt: new Date(),
      // Bewusst *keine* Prüfsumme: Die schreibt allein der Abschluss. Solange
      // sie fehlt, ist die Datei kein gültiges Fachobjekt — auch wenn die
      // Bytes hier bereits in Ordnung waren.
    },
  });

  return { url: localUploadUrl(record.id) };
}

/** Die rohen Bytes einer lokal gespeicherten Datei — für den Abschluss. */
export async function readLocalBytes(id: string): Promise<Buffer | null> {
  const record = await prisma.storedFile.findUnique({
    where: { id },
    select: { data: true },
  });
  return record?.data ? Buffer.from(record.data) : null;
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

/**
 * Abgelaufene, nie abgeschlossene Tickets aufräumen — vom täglichen Lauf.
 *
 * **Die Bedingung `checksum: null` ist die wichtige.** Vorher genügte
 * `data: null`, weil eine Zeile ohne Bytes zwangsläufig ein unbenutzter
 * Platzhalter war. Seit der externe Treiber ebenfalls Tickets ausstellt,
 * stimmt das nicht mehr: Bei `SUPABASE` liegen die Bytes im Objektspeicher
 * und `data` bleibt dauerhaft leer. Ohne diese Bedingung hätte der Nachtlauf
 * jede abgeschlossene externe Datei zwei Stunden nach dem Upload gelöscht.
 *
 * `checksum: null` heisst dagegen genau das Richtige: nie abgeschlossen, von
 * keinem `FileAsset` beansprucht, fachlich nicht existent.
 */
export async function purgeExpiredUploads(): Promise<number> {
  const result = await prisma.storedFile.deleteMany({
    where: {
      checksum: null,
      expiresAt: { lt: new Date() },
      // Doppelt gesichert: Eine Zeile, an der ein Asset hängt, wird nie
      // aufgeräumt — auch dann nicht, wenn die Prüfsumme aus irgendeinem
      // Grund fehlt. Löschen ist nicht umkehrbar, die Bedingung ist billig.
      asset: null,
    },
  });
  return result.count;
}

/** Für Fehlermeldungen: Welche Profile passen überhaupt noch in die Rückfallebene? */
export function localLimitFor(profile: UploadProfile): number {
  return Math.min(UPLOAD_PROFILES[profile].maxBytes, LOCAL_MAX_BYTES);
}
