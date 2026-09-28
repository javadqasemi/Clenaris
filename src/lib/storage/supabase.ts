import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { hasIntegration, serverEnv } from '@/lib/env';
import { ConfigurationError, IntegrationError } from '@/lib/errors';
import { supabaseAdresse } from '@/lib/laufzeit-konfiguration';

import { validateUpload, type SignedUploadTarget, type UploadProfile } from './profiles';
import { sha256HexVon } from './pruefsumme';
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
      supabaseAdresse() ? null : 'NEXT_PUBLIC_SUPABASE_URL',
      process.env.SUPABASE_SERVICE_ROLE_KEY ? null : 'SUPABASE_SERVICE_ROLE_KEY',
    ].filter(Boolean);

    throw new ConfigurationError(
      'Supabase',
      `Der Dateispeicher ist nicht eingerichtet — ${missing.join(' und ')} fehlt in der Umgebung. ` +
        'Ohne ihn lassen sich keine Bilder und Dokumente hochladen.',
    );
  }
  admin ??= createClient(
    supabaseAdresse()!,
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

/** Was beim Lesen eines Objekts herauskommt — drei Fälle, nicht zwei. */
export type ObjektLesen =
  | { status: 'ok'; bytes: Buffer }
  /** Der Speicher sagt ausdrücklich: Dieses Objekt gibt es nicht. */
  | { status: 'fehlt' }
  /**
   * Der Speicher hat nicht geantwortet oder etwas anderes als „gibt es
   * nicht" gesagt: Netz, Schlüssel, Bucket, 5xx. Die Meldung ist für das
   * Protokoll, nie für die Antwort an den Browser.
   */
  | { status: 'fehler'; meldung: string };

/**
 * Sagt der Fehler „dieses Objekt gibt es nicht"?
 *
 * Supabase meldet das je nach Fassung als HTTP 404 oder als HTTP 400 mit
 * `statusCode: "404"` im Rumpf; `storage-js` legt beides in `status` bzw.
 * `statusCode` ab. Alles andere ist **kein** „fehlt": Ein abgelaufener
 * Schlüssel, der als „fehlt" gälte, liesse einen Ausfall wie eine gelöschte
 * Datei aussehen — und niemand suchte nach dem Schlüssel.
 */
function istNichtGefunden(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { status?: unknown; statusCode?: unknown };
  return e.status === 404 || e.statusCode === '404' || e.statusCode === 404 || e.statusCode === 'NoSuchKey';
}

/**
 * Ein Objekt **authentifiziert** lesen — über den Dienstschlüssel, nie über
 * die öffentliche Adresse (F-09 c, 2026-09-27).
 *
 * `download` ruft `GET /storage/v1/object/<bucket>/<pfad>` mit dem
 * Dienstschlüssel auf. Das funktioniert bei einem privaten Bucket, und darauf
 * kommt es an: Die Anwendung setzt einen **nicht öffentlichen** Bucket voraus
 * (`docs/MALWARE_PROTECTION.md`, Abschnitt 7). Ein Leseweg über
 * `/object/public/…` ginge nur, wenn der Bucket öffentlich wäre — und dann
 * läge jede Lohnabrechnung ohne Anmeldung im Netz.
 *
 * Die Unterscheidung „fehlt" gegen „Fehler" ist neu. `downloadObject` machte
 * aus beidem `null`; für den Abschluss ist das richtig (siehe dort), für die
 * Auslieferung nicht: Dort soll ein Speicherausfall als Ausfall erkennbar
 * sein und nicht als verschwundene Datei.
 */
export async function holeObjekt(path: string): Promise<ObjektLesen> {
  // Der Klient entsteht ausserhalb des `try`: Ein fehlender Schlüssel ist ein
  // `ConfigurationError` mit eigener, benannter Meldung und soll als solcher
  // ankommen, nicht als „Speicher antwortet nicht".
  const speicher = supabaseAdmin().storage.from(bucket());
  try {
    const { data, error } = await speicher.download(path);
    if (error) {
      return istNichtGefunden(error) ? { status: 'fehlt' } : { status: 'fehler', meldung: error.message };
    }
    if (!data) return { status: 'fehlt' };
    return { status: 'ok', bytes: Buffer.from(await data.arrayBuffer()) };
  } catch (fehler) {
    // `storage-js` wirft nur, wenn `throwOnError` gesetzt ist, oder wenn das
    // Lesen des Rumpfs abreisst. Beides ist kein „fehlt".
    return { status: 'fehler', meldung: fehler instanceof Error ? fehler.message : String(fehler) };
  }
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
 *
 * Ein fehlendes Objekt ist hier kein Integrationsfehler, sondern der häufigste
 * ehrliche Fall: Der Abschluss kam, der Upload aber nie an. Auch ein Ausfall
 * ergibt `null` — absichtlich: Abschluss und Prüflauf behandeln „keine Bytes"
 * bereits richtig (kein Asset bzw. `ERROR/NO_BYTES`, später erneut versucht);
 * eine Ausnahme liesse dagegen den Nachlauf mitten in der Reihe abbrechen und
 * die Datei in `SCANNING` stehen. Wer den Unterschied braucht, ruft
 * `holeObjekt`.
 */
export async function downloadObject(path: string): Promise<Buffer | null> {
  const gelesen = await holeObjekt(path);
  return gelesen.status === 'ok' ? gelesen.bytes : null;
}

/**
 * Serverseitiger Upload (PDFs, generierte Exporte).
 *
 * **Gibt keine öffentliche Adresse mehr zurück** (F-09 c, 2026-09-27). Bis
 * dahin lieferte diese Funktion `publicUrl` =
 * `…/storage/v1/object/public/<bucket>/<pfad>`, und Signaturartefakte,
 * Führungsberichte und Rechnungs-PDF speicherten diese Adresse. Bei einem
 * privaten Bucket führte sie ins Leere, bei einem versehentlich öffentlichen
 * zu einer Lohnabrechnung ohne Anmeldung. Welche Adresse eine Datei in der
 * Anwendung trägt, entscheidet jetzt `uploadBuffer` in `index.ts` — und dort
 * ist es für beide Treiber dieselbe bewachte Route.
 *
 * Die Prüfsumme wird aus den Bytes gebildet, **die hochgeladen werden**, nicht
 * aus einer Antwort des Dienstes: Supabase meldet nur Pfad und Kennung zurück,
 * und selbst eine gemeldete Prüfsumme wäre eine Aussage des Speichers über
 * sich selbst.
 */
export async function uploadBuffer(params: {
  path: string;
  content: Buffer | Uint8Array;
  contentType: string;
  upsert?: boolean;
}): Promise<{ path: string; checksum: string; sizeBytes: number }> {
  const bytes = Buffer.from(params.content);
  const { error } = await supabaseAdmin()
    .storage.from(bucket())
    .upload(params.path, bytes, {
      contentType: params.contentType,
      upsert: params.upsert ?? true,
      cacheControl: '3600',
    });

  if (error) throw new IntegrationError('Supabase', error.message);

  return { path: params.path, checksum: sha256HexVon(bytes), sizeBytes: bytes.byteLength };
}

/**
 * Öffentliche Adresse eines Objekts — **nur** für Dateien, die ausdrücklich
 * öffentlich sein sollen, und nur bei einem Bucket, der das überhaupt zulässt.
 * Kein privater Leseweg dieser Anwendung benutzt sie (F-09 c).
 */
export function getPublicUrl(path: string): string {
  // Zur Laufzeit (V2-1) — je Umgebung ein eigenes Supabase-Projekt ist denkbar.
  const base = supabaseAdresse();
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
