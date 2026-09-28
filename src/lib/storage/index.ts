import 'server-only';

import { hasIntegration } from '@/lib/env';
import { IntegrationError } from '@/lib/errors';

import * as remote from './supabase';
import * as local from './local';
import type { SignedUploadTarget, UploadProfile } from './profiles';
import { pruefeGeleseneBytes, type LesePruefung } from './pruefsumme';
import { servererzeugteAblageEntfernen, servererzeugteAblageFuehren } from './tickets';

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

/**
 * Eine servererzeugte Datei ablegen — PDF, Bericht, Signaturartefakt.
 *
 * **Seit F-09 c (2026-09-27) für beide Treiber gleich.** Vorher gab der
 * externe Weg weder `storedFileId` noch `checksum` zurück, und `publicUrl` war
 * die öffentliche Supabase-Adresse. Die Folgen waren drei: `verifyFileIntegrity`
 * hatte für servererzeugte Dateien nichts zu vergleichen, die bewachte Route
 * `/api/files/blob/…` fand zu ihnen keine Zeile, und gespeichert wurde eine
 * Adresse, die bei einem privaten Bucket nichts liefert und bei einem
 * öffentlichen alles.
 *
 * Jetzt entsteht in beiden Fällen eine `StoredFile`-Zeile mit der Prüfsumme
 * der hochgeladenen Bytes, und die zurückgegebene Adresse ist in beiden Fällen
 * die bewachte Route. Der Aufrufer kann nicht mehr versehentlich eine
 * öffentliche Adresse an ein privates Dokument schreiben — es gibt keine.
 */
export async function uploadBuffer(params: {
  organizationId: string;
  path: string;
  content: Buffer | Uint8Array;
  contentType: string;
  upsert?: boolean;
}): Promise<{
  path: string;
  /**
   * Der Name ist geblieben, damit die Aufrufer unverändert bleiben — der
   * Inhalt ist es nicht: **keine** öffentliche Adresse, sondern
   * `/api/files/blob/<Ablagekennung>`, also die Route, die bei jedem Abruf
   * Sitzung, Fachbeziehung und Prüfstand verlangt. Für eine Datei ohne
   * `FileAsset` (Rechnungs-PDF) liefert sie nichts; erreichbar ist so eine
   * Datei nur über ihre Fachroute.
   */
  publicUrl: string;
  /** Die Ablagezeile, an die ein `FileAsset` gehängt werden kann — für beide Treiber. */
  storedFileId: string;
  /** SHA-256 der abgelegten Bytes, dieselbe Grösse wie `StoredFile.checksum`. */
  checksum: string;
}> {
  if (usesRemoteStorage()) {
    const objekt = await remote.uploadBuffer({
      path: params.path,
      content: params.content,
      contentType: params.contentType,
      upsert: params.upsert,
    });
    /*
      Die Zeile entsteht **nach** dem Objekt, nicht davor. Umgekehrt gäbe es
      bei einem gescheiterten Upload eine Zeile mit Prüfsumme und ohne Bytes —
      einen abgeschlossenen Eintrag für eine Datei, die nie ankam. So bleibt
      im schlimmsten Fall ein Objekt ohne Zeile übrig: unerreichbar, weil
      jeder Leseweg über die Zeile führt, und damit harmlos.
    */
    const zeile = await servererzeugteAblageFuehren({
      organizationId: params.organizationId,
      path: objekt.path,
      mimeType: params.contentType,
      sizeBytes: objekt.sizeBytes,
      checksum: objekt.checksum,
    });
    return {
      path: objekt.path,
      publicUrl: local.localUploadUrl(zeile.id),
      storedFileId: zeile.id,
      checksum: objekt.checksum,
    };
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
 * Wie eine nicht-öffentliche Datei die anfragende Person erreicht.
 *
 * **Der Befund, der diesen Typ erzwungen hat (Gate 4D.1).** Die beiden
 * Download-Routen der Unternehmensführung riefen `createSignedDownloadUrl` und
 * leiteten auf das Ergebnis weiter. Mit Supabase ist das Ergebnis eine
 * vollständige, befristete Adresse und alles stimmt. **Ohne** Supabase gibt
 * dieselbe Funktion den Ablagepfad zurück — `<orgId>/documents/<datei>.pdf` —,
 * und daraus wurde eine Weiterleitung auf eine Adresse, die es in dieser
 * Anwendung nicht gibt. Jeder Klick auf „Herunterladen" landete auf einer
 * 404-Seite, in der Entwicklung wie im Betrieb, weil die Rückfallebene die
 * Vorgabe ist.
 *
 * Aufgefallen ist es erst im Browser: Die HTTP-Prüfung stellte fest, dass die
 * Route mit 302 antwortet, und folgte der Weiterleitung nie. Ein Statuscode
 * ist eben keine Datei.
 *
 * Die Rückfallebene *kann* keine befristete Adresse ausstellen — ihre Bytes
 * liegen in der Datenbank, und die einzige Route, die sie ausliefert
 * (`/api/files/blob/…`), prüfte damals gröber als die Fachdienste: Sie
 * kannte `document:read`, aber nicht `EMPLOYEE_PRIVATE` und die betroffene
 * Person. Seit 2026-09-27 prüft sie für Dokumentfassungen dieselbe
 * Sichtbarkeit (`darfLesen` in `file.service.ts`). Der Fachdienst liefert die
 * Bytes trotzdem selbst aus: Er protokolliert den Download als Export, und
 * eine Weiterleitung auf die Dateiroute wäre ein Umweg ohne Gewinn.
 *
 * Dieser Typ macht die Unterscheidung sichtbar, statt sie einer Zeichenkette
 * zu überlassen, der man nicht ansieht, ob sie Adresse oder Pfad ist.
 */
export type Dateiauslieferung =
  | { art: 'weiterleitung'; url: string; filename: string; mimeType: string }
  | { art: 'bytes'; bytes: Buffer; filename: string; mimeType: string };

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

/**
 * Die Bytes eines `FileAsset` — **ein** Weg für beide Treiber (2026-09-27).
 *
 * Servererzeugte Dateien (Lohnabrechnung, Lohnausweis) hatten beim externen
 * Speicher bis F-09 c keine Ablagezeile. Die Lesefunktion der Lohndokumente
 * kannte bis dahin nur die Ablagezeile und die lokale Blob-Adresse: Mit
 * Supabase wurde jede Lohnabrechnung geschrieben und liess sich nie mehr
 * lesen. Jetzt entscheidet hier, woher gelesen wird — Ablagezeile, lokaler
 * Altbestand oder der externe Speicher über den Pfad. Der letzte Fall bleibt
 * für Fassungen, die vor F-09 c ohne Zeile abgelegt wurden; neue tragen eine
 * (`uploadBuffer`).
 */
export async function readAssetBytes(asset: {
  path: string;
  url: string;
  storedFile: { id: string; path: string; driver: 'LOCAL' | 'SUPABASE' } | null;
}): Promise<Buffer | null> {
  if (asset.storedFile) return readStoredBytes(asset.storedFile);
  const lokal = /^\/api\/files\/blob\/([A-Za-z0-9_-]+)$/.exec(asset.url);
  if (lokal) return local.readLocalBytes(lokal[1]!);
  if (usesRemoteStorage()) return remote.downloadObject(asset.path);
  return null;
}

/**
 * Die Bytes hinter einer Ablagezeile lesen **und gegen die Prüfsumme halten**
 * — der eine Leseweg der Auslieferung, für beide Treiber (F-09 c, 2026-09-27).
 *
 * **Der Befund.** Die Blob-Route las ausschliesslich lokal
 * (`readLocalFile`). Eine private Datei im Supabase-Bucket hatte damit keinen
 * berechtigten Leseweg: Die Route fand für sie keine Bytes, und der einzige
 * andere Weg wäre eine öffentliche Adresse gewesen — genau das, was ein
 * privater Bucket verhindern soll. Die Berechtigung entscheidet weiterhin
 * `authorizeStoredFile`; hier wird nur entschieden, **woher** die Bytes kommen
 * und ob es noch die richtigen sind.
 *
 * **Warum gepuffert und nicht durchgereicht.** Fail closed bei einer
 * abweichenden Prüfsumme heisst: Die Entscheidung fällt, bevor das erste Byte
 * hinausgeht. Ein Durchreichen mit mitlaufendem Hash wüsste erst am Ende, dass
 * es die falsche Datei ausgeliefert hat — zu spät für eine 404 und zu spät,
 * um sie zurückzuholen. Die Bytes werden deshalb serverseitig vollständig
 * gelesen, geprüft und erst dann ausgeliefert. Die Grössen, um die es geht
 * (Belege, Fotos, PDF), tragen das; die Rückfallebene tut seit jeher dasselbe.
 *
 * `fehlt` und die beiden Abweichungen sind Ergebnisse, kein Ausnahmefall —
 * der Aufrufer (`file.service.ts`) entscheidet, was sie auslösen. Ein Ausfall
 * des externen Speichers dagegen ist ein `IntegrationError`: Er soll als
 * Ausfall erscheinen (502), nicht als verschwundene Datei.
 */
export type GepruefteBytes =
  | { status: 'ok'; bytes: Buffer; pruefung: 'ok' | 'ungeprueft' }
  | { status: 'fehlt' }
  | Extract<LesePruefung, { status: 'abweichung' | 'widerspruch' }>;

export async function leseAblageGeprueft(
  ablage: { id: string; path: string; driver: 'LOCAL' | 'SUPABASE'; checksum: string | null },
  assetChecksum?: string | null,
): Promise<GepruefteBytes> {
  let bytes: Buffer | null;
  if (ablage.driver === 'SUPABASE') {
    const gelesen = await remote.holeObjekt(ablage.path);
    if (gelesen.status === 'fehler') {
      throw new IntegrationError('Supabase', `Datei nicht lesbar: ${gelesen.meldung}`);
    }
    bytes = gelesen.status === 'ok' ? gelesen.bytes : null;
  } else {
    bytes = await local.readLocalBytes(ablage.id);
  }
  if (!bytes) return { status: 'fehlt' };

  const befund = pruefeGeleseneBytes(bytes, { ablage: ablage.checksum, asset: assetChecksum });
  if (befund.status === 'ok' || befund.status === 'ungeprueft') {
    return { status: 'ok', bytes, pruefung: befund.status };
  }
  return befund;
}

export async function deleteFile(path: string): Promise<void> {
  if (usesRemoteStorage()) {
    await remote.deleteFile(path);
    // Die Zeile aus `uploadBuffer` mit — sonst bliebe eine abgeschlossene
    // Ablage stehen, deren Objekt es nicht mehr gibt.
    await servererzeugteAblageEntfernen(path);
    return;
  }
  return local.deleteLocalFile(path);
}

export async function deleteFiles(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  if (usesRemoteStorage()) {
    await remote.deleteFiles(paths);
    await Promise.all(paths.map((path) => servererzeugteAblageEntfernen(path)));
    return;
  }
  await Promise.all(paths.map((path) => local.deleteLocalFile(path)));
}

export { purgeExpiredUploads, readLocalBytes, readLocalFile, receiveLocalUpload } from './local';
